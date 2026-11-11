/**
 * Peer-gateway wire format (PG-1, tasks/peer-gateway/PG-1.md). The 28-byte
 * big-endian routing header and the ≤1200B sealed frame built on
 * {@link PeerSessionCiphers} from `./crypto.js`. Pure codec — no I/O, no
 * third-party deps.
 *
 * Why the split: a relay gateway must route frames it cannot read. The
 * header (magic, version, type, src/dst nodeId halves, streamId, seq,
 * ack) stays PLAINTEXT so the relay's routing decision is a single
 * `decodeFrameHeader` away; the payload is aes-256-gcm sealed with
 * the header as AAD, so the same relay — or any man in the middle —
 * cannot flip one routing bit without the receiver answering `null`.
 * 1200 bytes total keeps a sealed frame inside one encrypted-transport
 * (WSS/QUIC-friendly) datagram with room to spare.
 */
/** `'ZR'` — every frame starts with it; anything else is not ours. */
export const PEER_FRAME_MAGIC = 0x5a52;
export const PEER_FRAME_VERSION = 0x01;
/** Fixed plaintext routing header size. */
export const PEER_HEADER_BYTES = 28;
/** aes-256-gcm auth tag size appended after the ciphertext. */
export const PEER_AEAD_TAG_BYTES = 16;
/** Hard ceiling for one sealed frame (single-datagram friendly). */
export const PEER_MAX_FRAME_BYTES = 1200;
/** Plaintext budget per frame = 1200 − 28 header − 16 tag. */
export const PEER_MAX_PLAINTEXT_BYTES = PEER_MAX_FRAME_BYTES - PEER_HEADER_BYTES - PEER_AEAD_TAG_BYTES;
/** Smallest possible sealed frame: header + tag (empty plaintext). */
const MIN_FRAME_BYTES = PEER_HEADER_BYTES + PEER_AEAD_TAG_BYTES;
export const PeerFrameType = {
    HELLO: 0x01,
    ACK: 0x02,
    DATA: 0x03,
    SACK: 0x04,
    PING: 0x05,
    PONG: 0x06,
    RST: 0x07,
};
const FRAME_TYPE_MIN = PeerFrameType.HELLO;
const FRAME_TYPE_MAX = PeerFrameType.RST;
const NODE_ID_PATTERN = /^[0-9a-f]{8}$/;
function requireNodeIdHex(value, name) {
    if (typeof value !== 'string' || !NODE_ID_PATTERN.test(value.toLowerCase())) {
        throw new TypeError(`${name} must be 8 lowercase hex characters (4 bytes)`);
    }
    return value.toLowerCase();
}
function requireUint32(value, name) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError(`${name} must be an integer in [0, 2^32)`);
    }
    return value;
}
function requireSeq(value, name) {
    if (typeof value !== 'bigint' || value < 0n || value > (1n << 64n) - 1n) {
        throw new RangeError(`${name} must be a bigint in [0, 2^64)`);
    }
    return value;
}
/**
 * Encode one 28-byte big-endian header. Layout:
 * `[0..1] magic · [2] version · [3] frameType · [4..7] srcNodeId ·
 * [8..11] dstNodeId · [12..15] streamId · [16..23] seq(u64) · [24..27] ack`.
 * Throws TypeError/RangeError on invalid fields — the caller composes
 * headers from its own state, a malformed one is a programming bug.
 */
export function encodeFrameHeader(header) {
    if (header.magic !== PEER_FRAME_MAGIC) {
        throw new TypeError(`header.magic must be ${PEER_FRAME_MAGIC} (0x5a52 'ZR')`);
    }
    if (header.version !== PEER_FRAME_VERSION) {
        throw new TypeError(`header.version must be ${PEER_FRAME_VERSION}`);
    }
    if (typeof header.frameType !== 'number' || !Number.isInteger(header.frameType)
        || header.frameType < FRAME_TYPE_MIN || header.frameType > FRAME_TYPE_MAX) {
        throw new RangeError(`header.frameType must be an integer in [${FRAME_TYPE_MIN}, ${FRAME_TYPE_MAX}]`);
    }
    const srcNodeId = requireNodeIdHex(header.srcNodeId, 'header.srcNodeId');
    const dstNodeId = requireNodeIdHex(header.dstNodeId, 'header.dstNodeId');
    const streamId = requireUint32(header.streamId, 'header.streamId');
    const seq = requireSeq(header.seq, 'header.seq');
    const ack = requireUint32(header.ack, 'header.ack');
    const buf = Buffer.alloc(PEER_HEADER_BYTES);
    buf.writeUInt16BE(header.magic, 0);
    buf.writeUInt8(header.version, 2);
    buf.writeUInt8(header.frameType, 3);
    buf.write(srcNodeId, 4, 'hex');
    buf.write(dstNodeId, 8, 'hex');
    buf.writeUInt32BE(streamId, 12);
    buf.writeBigUInt64BE(seq, 16);
    buf.writeUInt32BE(ack, 24);
    return buf;
}
/**
 * Read the plaintext routing prefix of a frame. Answers `null` for ANY
 * malformed prefix (short buffer, wrong magic/version, unknown frameType)
 * and NEVER throws — the relay gateway runs this on every incoming chunk
 * to pick a route, so garbage input is the expected case, an exception
 * would be a crash. Uppercase hex nodeIds are normalized to lowercase.
 */
export function decodeFrameHeader(buf) {
    if (!ArrayBuffer.isView(buf) || buf.byteLength < PEER_HEADER_BYTES)
        return null;
    const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const magic = view.readUInt16BE(0);
    if (magic !== PEER_FRAME_MAGIC)
        return null;
    const version = view.readUInt8(2);
    if (version !== PEER_FRAME_VERSION)
        return null;
    const frameType = view.readUInt8(3);
    if (frameType < FRAME_TYPE_MIN || frameType > FRAME_TYPE_MAX)
        return null;
    return {
        magic,
        version,
        frameType,
        srcNodeId: view.subarray(4, 8).toString('hex'),
        dstNodeId: view.subarray(8, 12).toString('hex'),
        streamId: view.readUInt32BE(12),
        seq: view.readBigUInt64BE(16),
        ack: view.readUInt32BE(24),
    };
}
/**
 * Assemble the 28B header, seal `plaintext` under it (header as AAD, seq
 * from the header) and return the full frame `header || ciphertext ||
 * tag`. Oversized plaintext throws RangeError — callers segment streams
 * well below the budget; it must never silently truncate.
 */
export function packEncryptedFrame(header, plaintext, ciphers) {
    if (!ArrayBuffer.isView(plaintext) || plaintext.byteLength > PEER_MAX_PLAINTEXT_BYTES) {
        throw new RangeError(`plaintext must be at most ${PEER_MAX_PLAINTEXT_BYTES} bytes per frame, got ${ArrayBuffer.isView(plaintext) ? plaintext.byteLength : String(plaintext)}`);
    }
    const headerBuf = encodeFrameHeader({ magic: PEER_FRAME_MAGIC, version: PEER_FRAME_VERSION, ...header });
    const sealed = ciphers.seal(headerBuf, plaintext, header.seq);
    return Buffer.concat([headerBuf, Buffer.from(sealed)]);
}
/**
 * Route-check and open one sealed frame: length bounds, header decode,
 * then AEAD open with the frame's own seq. Every failure path — short or
 * oversized frame, bad magic/version/type, replayed or forged payload —
 * answers `null`; on a datagram socket garbage frames are routine and
 * the caller just drops them. Never throws.
 */
export function unpackEncryptedFrame(frame, ciphers) {
    if (!ArrayBuffer.isView(frame))
        return null;
    if (frame.byteLength < MIN_FRAME_BYTES || frame.byteLength > PEER_MAX_FRAME_BYTES)
        return null;
    const header = decodeFrameHeader(frame);
    if (!header)
        return null;
    const view = Buffer.isBuffer(frame) ? frame : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    const plaintext = ciphers.open(view.subarray(0, PEER_HEADER_BYTES), view.subarray(PEER_HEADER_BYTES), header.seq);
    if (!plaintext)
        return null;
    return { header, plaintext };
}
//# sourceMappingURL=wire.js.map