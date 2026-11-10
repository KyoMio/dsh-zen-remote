/**
 * Peer-gateway wire format (PG-1, tasks/peer-gateway/PG-1.md). The 28-byte
 * big-endian routing header and the ≤1200B sealed frame built on
 * {@link PeerSessionCiphers} from `./crypto.js`. Pure codec — no I/O, no
 * third-party deps.
 *
 * Why the split: a relay gateway must route frames it cannot read. The
 * header (magic, version, type, src/dst nodeId halves, streamId, seq,
 * ack) stays PLAINTEXT so the relay's routing decision is a single
 * `decodeFrameHeader` away; the payload is chacha20-poly1305 sealed with
 * the header as AAD, so the same relay — or any man in the middle —
 * cannot flip one routing bit without the receiver answering `null`.
 * 1200 bytes total keeps a sealed frame inside one encrypted-transport
 * (WSS/QUIC-friendly) datagram with room to spare.
 */
import type { PeerSessionCiphers } from './crypto.js';
/** `'ZR'` — every frame starts with it; anything else is not ours. */
export declare const PEER_FRAME_MAGIC = 23122;
export declare const PEER_FRAME_VERSION = 1;
/** Fixed plaintext routing header size. */
export declare const PEER_HEADER_BYTES = 28;
/** chacha20-poly1305 auth tag size appended after the ciphertext. */
export declare const PEER_AEAD_TAG_BYTES = 16;
/** Hard ceiling for one sealed frame (single-datagram friendly). */
export declare const PEER_MAX_FRAME_BYTES = 1200;
/** Plaintext budget per frame = 1200 − 28 header − 16 tag. */
export declare const PEER_MAX_PLAINTEXT_BYTES: number;
export declare const PeerFrameType: {
    readonly HELLO: 1;
    readonly ACK: 2;
    readonly DATA: 3;
    readonly SACK: 4;
    readonly PING: 5;
    readonly PONG: 6;
    readonly RST: 7;
};
export type PeerFrameTypeValue = typeof PeerFrameType[keyof typeof PeerFrameType];
/** One 28-byte routing header, decoded or about to be encoded. */
export interface PeerFrameHeader {
    magic: number;
    version: number;
    frameType: number;
    /** 8 lowercase hex chars (`nodeId` half). */
    srcNodeId: string;
    /** 8 lowercase hex chars (`nodeId` half). */
    dstNodeId: string;
    streamId: number;
    seq: bigint;
    ack: number;
}
/**
 * Encode one 28-byte big-endian header. Layout:
 * `[0..1] magic · [2] version · [3] frameType · [4..7] srcNodeId ·
 * [8..11] dstNodeId · [12..15] streamId · [16..23] seq(u64) · [24..27] ack`.
 * Throws TypeError/RangeError on invalid fields — the caller composes
 * headers from its own state, a malformed one is a programming bug.
 */
export declare function encodeFrameHeader(header: PeerFrameHeader): Buffer;
/**
 * Read the plaintext routing prefix of a frame. Answers `null` for ANY
 * malformed prefix (short buffer, wrong magic/version, unknown frameType)
 * and NEVER throws — the relay gateway runs this on every incoming chunk
 * to pick a route, so garbage input is the expected case, an exception
 * would be a crash. Uppercase hex nodeIds are normalized to lowercase.
 */
export declare function decodeFrameHeader(buf: Uint8Array): PeerFrameHeader | null;
/**
 * Assemble the 28B header, seal `plaintext` under it (header as AAD, seq
 * from the header) and return the full frame `header || ciphertext ||
 * tag`. Oversized plaintext throws RangeError — callers segment streams
 * well below the budget; it must never silently truncate.
 */
export declare function packEncryptedFrame(header: Omit<PeerFrameHeader, 'magic' | 'version'>, plaintext: Uint8Array, ciphers: PeerSessionCiphers): Buffer;
/**
 * Route-check and open one sealed frame: length bounds, header decode,
 * then AEAD open with the frame's own seq. Every failure path — short or
 * oversized frame, bad magic/version/type, replayed or forged payload —
 * answers `null`; on a datagram socket garbage frames are routine and
 * the caller just drops them. Never throws.
 */
export declare function unpackEncryptedFrame(frame: Uint8Array, ciphers: PeerSessionCiphers): {
    header: PeerFrameHeader;
    plaintext: Uint8Array;
} | null;
//# sourceMappingURL=wire.d.ts.map