/**
 * Peer-gateway ARQ (PG-7, tasks/peer-gateway/PG-7.md): a lightweight
 * reliable ordered stream running on top of the ≤1200B sealed frames of
 * `./wire.js`. Pure state machine — no I/O, no third-party deps; every
 * outgoing byte leaves through the `sendFrame` callback and every
 * incoming byte enters through `handleFrame`.
 *
 * Each bidirectional logical stream is identified by `streamId`
 * (uint32 ≥ 1; 0 is reserved for the punch layer's PING/PONG). The
 * session sits on ONE frame-sending interface
 * `(frameType, streamId, payload, ack) => void` that both physical
 * paths share — UDP direct and the gateway WS relay seal the same
 * frames — so when the physical path swaps mid-flight, unacked
 * fragments retransmit over the new path and the byte stream never
 * notices. That is why `sendFrame` is read at every (re)transmit:
 * swapping the property is the hot-switch.
 *
 * Wire layout inside one frame payload:
 *
 *     [flags:1B][streamSeq:4B BE][data…]      DATA  (≤ 5 + 1151 = 1156B)
 *     [bitmap:8B]                             SACK  (bit i = cumAck + i seen)
 *
 * `flags` bit 0 is FIN. Reliability: the receiver caches out-of-order
 * fragments, delivers them in strict streamSeq order and answers every
 * DATA with a SACK whose header `ack` is the cumulative progress (next
 * expected seq — everything below is confirmed) plus a 64-bit selective
 * bitmap for the buffered gaps. Senders keep ≤ windowSize (default 64)
 * unacked fragments in flight — `write()` returns a backpressure
 * Promise that resolves only once every fragment of that write is
 * confirmed — and each in-flight fragment carries an RTO timer
 * (default 120ms, ×2 exponential backoff, 1000ms cap). FIN half-closes
 * the stream (merged onto the last queued fragment when one exists, a
 * dedicated zero-length fragment otherwise); RST aborts; `closeAll()`
 * clears every timer and rejects every pending write.
 */
import { PeerFrameType, PEER_MAX_PLAINTEXT_BYTES } from './wire.js';
/** In-stream subheader: `[flags:1B][streamSeq:4B]`. */
export const STREAM_HEADER_BYTES = 5;
/** `flags` bit 0 — graceful half-close, riding on the final fragment. */
export const STREAM_FLAG_FIN = 0x01;
/** Largest data chunk that still fits one 1200B frame: 1156 − 5. */
export const ARQ_CHUNK_MAX_BYTES = PEER_MAX_PLAINTEXT_BYTES - STREAM_HEADER_BYTES;
/** Default data chunk size (spec: ~1100B, comfortably inside the budget). */
export const ARQ_DEFAULT_CHUNK_BYTES = 1100;
/** Default send window: unconfirmed fragments in flight per stream. */
export const ARQ_DEFAULT_WINDOW = 64;
/** Default retransmission timeout. */
export const ARQ_DEFAULT_RTO_MS = 120;
/** RTO exponential backoff ceiling. */
export const ARQ_DEFAULT_RTO_MAX_MS = 1000;
/** SACK bitmap depth: 64 window bits, 8 bytes, bit i = cumAck + i. */
const SACK_BITMAP_BYTES = 8;
const SACK_BITMAP_BITS = SACK_BITMAP_BYTES * 8;
/** Upper bound on out-of-order fragments buffered per receive stream. */
const RX_BUFFER_MAX = 256;
const realClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
};
function makeWaiter() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    const waiter = {
        promise,
        remaining: 0,
        settled: false,
        resolve() {
            if (waiter.settled)
                return;
            waiter.settled = true;
            resolve();
        },
        reject(err) {
            if (waiter.settled)
                return;
            waiter.settled = true;
            reject(err);
        },
    };
    return waiter;
}
function requireStreamId(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 0xffffffff) {
        throw new RangeError('streamId must be an integer in [1, 2^32)');
    }
    return value;
}
function asBufferView(bytes) {
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
/**
 * One ARQ session: many bidirectional streams over one frame-sending
 * seam. Create one per peer session; feed every opened frame from the
 * physical path into {@link handleFrame} and hand
 * {@link PeerArqOptions.sendFrame} to the path as the send callback.
 */
export class PeerArqSession {
    /**
     * The current physical-path sender. Read at every (re)transmit —
     * assign a new function to hot-swap paths mid-flight (gateway WS ↔
     * UDP direct); in-flight fragments automatically follow.
     */
    sendFrame;
    clock;
    chunkSize;
    windowSize;
    rtoMs;
    rtoMaxMs;
    onStreamData;
    onStreamReset;
    txStreams = new Map();
    rxStreams = new Map();
    closed = false;
    constructor(options) {
        if (typeof options.sendFrame !== 'function')
            throw new TypeError('sendFrame must be a function');
        const chunkSize = options.chunkSize ?? ARQ_DEFAULT_CHUNK_BYTES;
        if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > ARQ_CHUNK_MAX_BYTES) {
            throw new RangeError(`chunkSize must be an integer in [1, ${ARQ_CHUNK_MAX_BYTES}]`);
        }
        const windowSize = options.windowSize ?? ARQ_DEFAULT_WINDOW;
        if (!Number.isInteger(windowSize) || windowSize < 1)
            throw new RangeError('windowSize must be an integer ≥ 1');
        const rtoMs = options.rtoMs ?? ARQ_DEFAULT_RTO_MS;
        if (!Number.isInteger(rtoMs) || rtoMs < 1)
            throw new RangeError('rtoMs must be an integer ≥ 1');
        const rtoMaxMs = options.rtoMaxMs ?? ARQ_DEFAULT_RTO_MAX_MS;
        if (!Number.isInteger(rtoMaxMs) || rtoMaxMs < rtoMs) {
            throw new RangeError('rtoMaxMs must be an integer ≥ rtoMs');
        }
        this.sendFrame = options.sendFrame;
        this.clock = options.clock ?? realClock;
        this.chunkSize = chunkSize;
        this.windowSize = windowSize;
        this.rtoMs = rtoMs;
        this.rtoMaxMs = rtoMaxMs;
        this.onStreamData = options.onStreamData;
        this.onStreamReset = options.onStreamReset;
    }
    /**
     * Queue `bytes` on the stream and resolve once every fragment of this
     * write is confirmed by the peer (cumulative or selective). Backpressure:
     * the send window (`windowSize` unacked fragments) throttles the pump.
     */
    write(streamId, bytes) {
        const sid = requireStreamId(streamId);
        if (!ArrayBuffer.isView(bytes))
            throw new TypeError('bytes must be a Uint8Array');
        if (this.closed)
            return Promise.reject(new Error('arq session closed'));
        const tx = this.ensureTx(sid);
        if (tx.finQueued)
            return Promise.reject(new Error(`stream ${sid} already finished`));
        const data = asBufferView(bytes);
        if (data.byteLength === 0)
            return Promise.resolve();
        const fragments = Math.ceil(data.byteLength / this.chunkSize);
        const waiter = makeWaiter();
        waiter.remaining = fragments;
        for (let offset = 0; offset < data.byteLength; offset += this.chunkSize) {
            tx.queue.push({
                data: data.subarray(offset, Math.min(offset + this.chunkSize, data.byteLength)),
                fin: false,
                waiter,
                finWaiter: null,
            });
        }
        this.pump(sid, tx);
        return waiter.promise;
    }
    /**
     * Graceful half-close: delivers a FIN after everything previously
     * queued on the stream. Merges onto the last queued fragment when the
     * window is holding data back, otherwise sends a dedicated
     * zero-length FIN fragment. Writes after this are rejected.
     */
    finish(streamId) {
        const sid = requireStreamId(streamId);
        if (this.closed)
            return Promise.reject(new Error('arq session closed'));
        const tx = this.ensureTx(sid);
        if (tx.finQueued)
            return Promise.resolve(); // idempotent
        tx.finQueued = true;
        const finWaiter = makeWaiter();
        finWaiter.remaining = 1;
        const last = tx.queue.length > 0 ? tx.queue[tx.queue.length - 1] : null;
        if (last && !last.fin) {
            last.fin = true;
            last.finWaiter = finWaiter;
        }
        else {
            tx.queue.push({ data: Buffer.alloc(0), fin: true, waiter: null, finWaiter });
        }
        this.pump(sid, tx);
        return finWaiter.promise;
    }
    /** Abortive close: reject this stream's pending writes and tell the peer. */
    reset(streamId) {
        const sid = requireStreamId(streamId);
        if (this.closed)
            return;
        const tx = this.txStreams.get(sid);
        if (tx)
            this.teardownTx(sid, tx, new Error(`stream ${sid} reset`));
        this.rxStreams.delete(sid);
        this.sendFrame(PeerFrameType.RST, sid, Buffer.alloc(0), 0);
    }
    /**
     * Feed one opened frame from the physical path. Recognizes DATA /
     * SACK / RST (and treats the legacy ACK type as a pure cumulative
     * ack); ignores everything else (HELLO / PING / PONG belong to the
     * punch layer). Malformed input is dropped, never thrown.
     */
    handleFrame(frameType, streamId, payload, ack) {
        if (this.closed)
            return;
        if (typeof streamId !== 'number' || !Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff)
            return;
        const ackValue = typeof ack === 'number' && Number.isInteger(ack) && ack > 0 ? ack : 0;
        if (frameType === PeerFrameType.RST) {
            if (streamId === 0)
                return;
            this.teardownTx(streamId, this.txStreams.get(streamId), new Error(`stream ${streamId} reset by peer`));
            this.rxStreams.delete(streamId);
            this.onStreamReset?.(streamId);
            return;
        }
        if (streamId === 0)
            return;
        switch (frameType) {
            case PeerFrameType.DATA:
                this.onData(streamId, payload, ackValue);
                return;
            case PeerFrameType.SACK:
                this.onSack(streamId, payload, ackValue);
                return;
            case PeerFrameType.ACK:
                this.applyCumulative(streamId, ackValue);
                return;
            default:
                return;
        }
    }
    /**
     * Tear the whole session down: every retransmit timer is cleared and
     * every pending backpressure write rejects. The session is dead
     * afterwards — frames in and writes out are both refused.
     */
    closeAll() {
        if (this.closed)
            return;
        this.closed = true;
        for (const [sid, tx] of this.txStreams) {
            this.teardownTx(sid, tx, new Error('arq session closed'));
        }
        this.txStreams.clear();
        this.rxStreams.clear();
    }
    /** Unconfirmed fragments currently in flight across all streams. */
    inflightTotal() {
        let total = 0;
        for (const tx of this.txStreams.values())
            total += tx.inflight.size;
        return total;
    }
    /** Fragments queued but not yet admitted to the send window. */
    queuedTotal() {
        let total = 0;
        for (const tx of this.txStreams.values())
            total += tx.queue.length;
        return total;
    }
    // -- internals -------------------------------------------------------------------
    ensureTx(streamId) {
        let tx = this.txStreams.get(streamId);
        if (!tx) {
            tx = { nextSeq: 0, queue: [], inflight: new Map(), finQueued: false };
            this.txStreams.set(streamId, tx);
        }
        return tx;
    }
    currentAck(streamId) {
        return this.rxStreams.get(streamId)?.expected ?? 0;
    }
    pump(streamId, tx) {
        if (this.closed)
            return;
        while (tx.inflight.size < this.windowSize && tx.queue.length > 0) {
            const queued = tx.queue.shift();
            const seq = tx.nextSeq++;
            const subheader = Buffer.alloc(STREAM_HEADER_BYTES);
            subheader[0] = queued.fin ? STREAM_FLAG_FIN : 0;
            subheader.writeUInt32BE(seq, 1);
            const frag = {
                seq,
                payload: Buffer.concat([subheader, queued.data]),
                waiter: queued.waiter,
                finWaiter: queued.finWaiter,
                rto: this.rtoMs,
                timer: null,
            };
            frag.timer = this.clock.setTimeout(() => this.onRto(streamId, seq), frag.rto);
            tx.inflight.set(seq, frag);
            this.sendFrame(PeerFrameType.DATA, streamId, frag.payload, this.currentAck(streamId));
        }
    }
    onRto(streamId, seq) {
        if (this.closed)
            return;
        const tx = this.txStreams.get(streamId);
        const frag = tx?.inflight.get(seq);
        if (!tx || !frag)
            return;
        frag.rto = Math.min(frag.rto * 2, this.rtoMaxMs);
        this.sendFrame(PeerFrameType.DATA, streamId, frag.payload, this.currentAck(streamId));
        frag.timer = this.clock.setTimeout(() => this.onRto(streamId, seq), frag.rto);
    }
    onData(streamId, payload, piggyAck) {
        if (piggyAck > 0)
            this.applyCumulative(streamId, piggyAck);
        if (!ArrayBuffer.isView(payload) || payload.byteLength < STREAM_HEADER_BYTES)
            return;
        const view = asBufferView(payload);
        const flags = view[0];
        const seq = view.readUInt32BE(1);
        const data = view.subarray(STREAM_HEADER_BYTES);
        const fin = (flags & STREAM_FLAG_FIN) !== 0;
        let rx = this.rxStreams.get(streamId);
        if (!rx) {
            rx = { expected: 0, buffered: new Map(), gotFin: false };
            this.rxStreams.set(streamId, rx);
        }
        if (rx.gotFin || seq < rx.expected) {
            // Post-FIN junk or an old duplicate: just re-advertise our progress.
            this.sendSack(streamId, rx);
            return;
        }
        if (!rx.buffered.has(seq)) {
            if (rx.buffered.size >= RX_BUFFER_MAX) {
                this.sendSack(streamId, rx);
                return;
            }
            rx.buffered.set(seq, { data: Buffer.from(data), fin });
        }
        this.flush(streamId, rx);
        this.sendSack(streamId, rx);
    }
    flush(streamId, rx) {
        for (;;) {
            const next = rx.buffered.get(rx.expected);
            if (!next)
                return;
            rx.buffered.delete(rx.expected);
            rx.expected += 1;
            const final = next.fin;
            if (final) {
                rx.gotFin = true;
                rx.buffered.clear(); // anything after FIN is junk
            }
            this.onStreamData?.(streamId, next.data, final);
            if (final)
                return;
        }
    }
    sendSack(streamId, rx) {
        const bitmap = Buffer.alloc(SACK_BITMAP_BYTES);
        for (const seq of rx.buffered.keys()) {
            const delta = seq - rx.expected;
            if (delta >= 0 && delta < SACK_BITMAP_BITS)
                bitmap[delta >> 3] |= 1 << (delta & 7);
        }
        this.sendFrame(PeerFrameType.SACK, streamId, bitmap, rx.expected);
    }
    onSack(streamId, payload, ack) {
        this.applyCumulative(streamId, ack);
        if (!ArrayBuffer.isView(payload) || ack <= 0)
            return;
        const view = asBufferView(payload);
        for (let bit = 0; bit < SACK_BITMAP_BITS; bit++) {
            const byte = view[bit >> 3] ?? 0;
            if ((byte & (1 << (bit & 7))) !== 0)
                this.settleFragment(streamId, ack + bit);
        }
    }
    applyCumulative(streamId, ack) {
        if (ack <= 0)
            return;
        const tx = this.txStreams.get(streamId);
        if (!tx)
            return;
        for (const [seq, frag] of tx.inflight) {
            if (seq < ack) {
                this.clock.clearTimeout(frag.timer);
                tx.inflight.delete(seq);
                this.settle(tx, frag);
            }
        }
        this.pump(streamId, tx);
    }
    settleFragment(streamId, seq) {
        const tx = this.txStreams.get(streamId);
        const frag = tx?.inflight.get(seq);
        if (!tx || !frag)
            return;
        this.clock.clearTimeout(frag.timer);
        tx.inflight.delete(seq);
        this.settle(tx, frag);
        this.pump(streamId, tx);
    }
    settle(tx, frag) {
        for (const waiter of [frag.waiter, frag.finWaiter]) {
            if (!waiter)
                continue;
            waiter.remaining -= 1;
            if (waiter.remaining <= 0)
                waiter.resolve();
        }
        frag.waiter = null;
        frag.finWaiter = null;
    }
    teardownTx(streamId, tx, error) {
        if (!tx)
            return;
        for (const frag of tx.inflight.values())
            this.clock.clearTimeout(frag.timer);
        for (const frag of tx.inflight.values()) {
            frag.waiter?.reject(error);
            frag.finWaiter?.reject(error);
        }
        for (const queued of tx.queue) {
            queued.waiter?.reject(error);
            queued.finWaiter?.reject(error);
        }
        tx.inflight.clear();
        tx.queue.length = 0;
        this.txStreams.delete(streamId);
    }
}
//# sourceMappingURL=arq.js.map