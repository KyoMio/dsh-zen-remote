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
 *
 * Admission is bounded (256KiB/stream, 4MiB/session, 128 live streams by
 * default). Large callers use tryWrite + waitWritable in bounded pieces;
 * write still confirms delivery, but rejects rather than queues over budget.
 * RST payload 1 requests an ACK, 2 acknowledges; empty remains legacy RST.
 * DATA with no cumulative progress and RST retries expire after 30s; idle
 * streams have no deadline. Retired IDs never reopen in this session.
 * Final ACKs are cached for 60s (4096 reserved records/ranges). A legacy peer
 * retrying FIN later receives RST, not successful completion; legacy RST
 * has no confirmation, so remote cleanup cannot be guaranteed. Capacity
 * exhaustion refuses new streams instead of evicting fresh terminal state.
 * Cancel/refusal IDs are retired even when the active-stream limit is full.
 * If permanent history itself cannot reserve another ID, admission closes
 * permanently (existing streams continue), reports onAdmissionClosed, and
 * new local writes explicitly require leaving/rejoining the peer network.
 * No timer or range eviction silently reopens that admission boundary.
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
    // Rejection safety net (PG-8): a stream teardown (RST / closeAll) rejects
    // EVERY waiter it finds — including ones whose consumer raced away or has
    // not attached its own handler yet. One no-op catch makes the rejection
    // never "unhandled" at the process level; callers' own await/catch still
    // see the error exactly as before (Node counts handlers, and this no-op
    // does not swallow their observation of the rejection).
    promise.catch(() => { });
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
    onStreamClosed;
    onAdmissionClosed;
    admissionClosed = false;
    retryTimeoutMs;
    terminalTtlMs;
    maxStreams;
    maxRetiredRanges;
    maxTerminalRecords;
    maxStreamBytes;
    maxSessionBytes;
    sendBytes = 0;
    receiveBytes = 0;
    writable = new Map();
    active = new Set();
    // Permanent, parity-separated intervals: old implementations retransmit forever.
    retired = [[], []];
    terminal = new Map();
    resets = new Map();
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
        this.onStreamClosed = options.onStreamClosed;
        this.onAdmissionClosed = options.onAdmissionClosed;
        this.retryTimeoutMs = options.retryTimeoutMs ?? 30_000;
        this.terminalTtlMs = options.terminalTtlMs ?? 60_000;
        this.maxStreams = options.maxStreams ?? 128;
        this.maxRetiredRanges = options.maxRetiredRanges ?? 4096;
        this.maxTerminalRecords = options.maxTerminalRecords ?? 4096;
        this.maxStreamBytes = options.maxStreamBytes ?? 256 * 1024;
        this.maxSessionBytes = options.maxSessionBytes ?? 4 * 1024 * 1024;
        for (const value of [this.retryTimeoutMs, this.terminalTtlMs, this.maxStreams, this.maxRetiredRanges, this.maxTerminalRecords, this.maxStreamBytes, this.maxSessionBytes]) {
            if (!Number.isSafeInteger(value) || value < 1)
                throw new RangeError('ARQ limits must be positive integers');
        }
        if (this.terminalTtlMs < this.retryTimeoutMs)
            throw new RangeError('terminal TTL must cover retry timeout');
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
        if (!this.admit(sid))
            return Promise.reject(this.admissionError());
        const tx = this.ensureTx(sid);
        if (tx.finQueued)
            return Promise.reject(new Error(`stream ${sid} already finished`));
        const data = asBufferView(bytes);
        if (data.byteLength === 0)
            return Promise.resolve();
        if (!this.hasCapacity(sid, data.byteLength))
            return Promise.reject(new Error('ARQ byte budget exhausted; split writes and await admission'));
        const waiter = makeWaiter();
        const byteLength = data.byteLength; // do not retain the caller's potentially huge backing buffer
        tx.pendingBytes += byteLength;
        tx.pendingWrites++;
        this.sendBytes += byteLength;
        const release = () => {
            tx.pendingBytes -= byteLength;
            tx.pendingWrites--;
            this.sendBytes -= byteLength;
            this.wakeWritable();
        };
        void waiter.promise.then(release, release);
        waiter.remaining = 0;
        for (let offset = 0; offset < data.byteLength; offset += this.chunkSize) {
            const slice = data.subarray(offset, Math.min(offset + this.chunkSize, data.byteLength));
            const tail = tx.queue.length > 0 ? tx.queue[tx.queue.length - 1] : null;
            if (tail && !tail.fin && tail.data.byteLength + slice.byteLength <= this.chunkSize) {
                tail.data = Buffer.concat([tail.data, slice]);
                tail.waiters.push(waiter);
                waiter.remaining += 1;
            }
            else {
                tx.queue.push({
                    data: Buffer.from(slice),
                    fin: false,
                    waiters: [waiter],
                    finWaiter: null,
                });
                waiter.remaining += 1;
            }
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
        if (!this.admit(sid))
            return Promise.reject(this.admissionError());
        const tx = this.ensureTx(sid);
        if (tx.finQueued)
            return tx.finPromise; // same completion, not premature success
        tx.finQueued = true;
        const finWaiter = makeWaiter();
        tx.finPromise = finWaiter.promise;
        finWaiter.remaining = 1;
        const last = tx.queue.length > 0 ? tx.queue[tx.queue.length - 1] : null;
        if (last && !last.fin) {
            last.fin = true;
            last.finWaiter = finWaiter;
        }
        else {
            tx.queue.push({ data: Buffer.alloc(0), fin: true, waiters: [], finWaiter });
        }
        this.pump(sid, tx);
        return finWaiter.promise;
    }
    /** Abortive close: reject this stream's pending writes and tell the peer. */
    reset(streamId) {
        const sid = requireStreamId(streamId);
        if (this.closed)
            return;
        if (this.isRetired(sid))
            return;
        if (!this.admit(sid)) {
            this.rememberRetired(sid);
            this.trySendFrame(PeerFrameType.RST, sid, Buffer.alloc(0), 0);
            return;
        }
        this.retire(sid, new Error(`stream ${sid} reset`));
        this.startReset(sid);
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
        const ackValue = typeof ack === 'number' && Number.isInteger(ack) && ack >= 0 ? ack : 0;
        if (frameType === PeerFrameType.RST) {
            if (streamId === 0)
                return;
            if (!ArrayBuffer.isView(payload) || payload.byteLength > 1)
                return;
            const kind = payload[0] ?? 0;
            if (kind === 2) {
                const reset = this.resets.get(streamId);
                if (reset)
                    this.clock.clearTimeout(reset.timer);
                this.resets.delete(streamId);
                return;
            }
            if (kind !== 0 && kind !== 1)
                return;
            if (this.active.has(streamId)) {
                this.retire(streamId, new Error(`stream ${streamId} reset by peer`));
                this.onStreamReset?.(streamId);
            }
            else {
                const retired = this.isRetired(streamId);
                this.rememberRetired(streamId);
                if (!retired && this.isRetired(streamId))
                    this.onStreamReset?.(streamId);
            }
            if (kind === 1)
                this.trySendFrame(PeerFrameType.RST, streamId, Buffer.from([2]), 0);
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
        for (const sid of [...this.active])
            this.retire(sid, new Error('arq session closed'));
        for (const reset of this.resets.values())
            this.clock.clearTimeout(reset.timer);
        this.resets.clear();
        this.terminal.clear();
        this.retired[0].length = this.retired[1].length = 0;
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
    /**
     * Immediately retransmit all unacked in-flight fragments and reset their RTO
     * timers to `rtoMs` (called when a physical path transitions from `'none'` to
     * ready so fragments queued during initial handshake fly without waiting for
     * backed-off RTO timers).
     */
    flushInflight() {
        if (this.closed)
            return;
        for (const [streamId, tx] of this.txStreams) {
            for (const [seq, frag] of tx.inflight) {
                this.clock.clearTimeout(frag.timer);
                frag.rto = this.rtoMs;
                frag.timer = this.clock.setTimeout(() => this.onRto(streamId, seq), frag.rto);
                this.trySendFrame(PeerFrameType.DATA, streamId, frag.payload, this.currentAck(streamId));
            }
            this.pump(streamId, tx);
        }
    }
    /** Whole-block admission. false accepts no bytes; terminal/capacity errors throw. */
    tryWrite(streamId, bytes) {
        requireStreamId(streamId);
        if (!(bytes instanceof Uint8Array))
            throw new TypeError('bytes must be a Uint8Array');
        if (!this.admit(streamId))
            throw this.admissionError();
        if (this.txStreams.get(streamId)?.finQueued)
            throw new Error('ARQ stream already finished');
        if (!this.hasCapacity(streamId, bytes.byteLength))
            return false;
        // Completion errors are delivered through onStreamClosed. write() itself
        // remains available to callers requiring per-write ACK confirmation.
        void this.write(streamId, bytes).catch(() => { });
        return true;
    }
    /** One admission waiter per stream; callers serialize writes, not ACKs. */
    waitWritable(streamId, bytes = 1) {
        if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > Math.min(this.maxStreamBytes, this.maxSessionBytes))
            return Promise.reject(new Error('ARQ write exceeds byte budget'));
        if (!this.admit(requireStreamId(streamId)))
            return Promise.reject(this.admissionError());
        if (this.hasCapacity(streamId, bytes))
            return Promise.resolve();
        let pending = this.writable.get(streamId);
        if (!pending) {
            pending = { bytes, waiter: makeWaiter() };
            this.writable.set(streamId, pending);
        }
        return pending.waiter.promise;
    }
    bufferedSendBytes() { return this.sendBytes; }
    bufferedReceiveBytes() { return this.receiveBytes; }
    hasCapacity(id, bytes) {
        const tx = this.txStreams.get(id);
        return (tx?.pendingBytes ?? 0) + bytes <= this.maxStreamBytes && this.sendBytes + bytes <= this.maxSessionBytes && (tx?.pendingWrites ?? 0) < 1024;
    }
    wakeWritable() {
        for (const [id, pending] of this.writable) {
            if (this.hasCapacity(id, pending.bytes)) {
                this.writable.delete(id);
                pending.waiter.resolve();
            }
        }
    }
    /** Retry a previously refused delivery after consumer pull/read. */
    resume(streamId) {
        const rx = this.rxStreams.get(streamId);
        if (!rx)
            return;
        this.flush(streamId, rx);
        this.sendSack(streamId, rx);
    }
    isRetired(id) {
        return this.retired[id & 1].some(([lo, hi]) => id >= lo && id <= hi);
    }
    admit(id) {
        if (this.closed || this.isRetired(id))
            return false;
        if (this.active.has(id))
            return true;
        if (this.admissionClosed)
            return false;
        const now = this.clock.now();
        for (const [sid, entry] of this.terminal)
            if (entry.until <= now)
                this.terminal.delete(sid);
        // Reserve one terminal record and worst-case interval for every active stream.
        if (this.active.size >= this.maxStreams || this.terminal.size + this.active.size >= this.maxTerminalRecords ||
            this.retired[0].length + this.retired[1].length + this.active.size >= this.maxRetiredRanges)
            return false;
        this.active.add(id);
        return true;
    }
    retire(id, error) {
        if (!this.active.delete(id))
            return;
        const ack = error ? 0 : this.currentAck(id);
        this.teardownTx(id, this.txStreams.get(id), error ?? new Error('stream finished'));
        const rx = this.rxStreams.get(id);
        if (rx)
            for (const fragment of rx.buffered.values())
                this.receiveBytes -= fragment.data.length;
        this.rxStreams.delete(id);
        const pending = this.writable.get(id);
        this.writable.delete(id);
        pending?.waiter.reject(error ?? new Error('stream finished'));
        this.rememberRetired(id);
        this.terminal.set(id, { ack, until: this.clock.now() + this.terminalTtlMs });
        this.onStreamClosed?.(id, error);
    }
    admissionError() {
        return new Error(this.admissionClosed
            ? 'ARQ admission exhausted; leave and rejoin the peer network'
            : 'ARQ stream retired or capacity exhausted');
    }
    /** Refused/cancelled IDs need permanent history, but no active-stream slot. */
    rememberRetired(id) {
        if (this.isRetired(id) || this.admissionClosed)
            return;
        if (this.retired[0].length + this.retired[1].length + this.active.size >= this.maxRetiredRanges) {
            this.admissionClosed = true;
            this.onAdmissionClosed?.(this.admissionError());
            return;
        }
        const ranges = this.retired[id & 1];
        ranges.push([id, id]);
        ranges.sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < ranges.length;) {
            if (ranges[i][0] <= ranges[i - 1][1] + 2) {
                ranges[i - 1][1] = Math.max(ranges[i - 1][1], ranges[i][1]);
                ranges.splice(i, 1);
            }
            else
                i++;
        }
    }
    maybeClose(id) {
        const tx = this.txStreams.get(id);
        if (tx?.finAcked && !tx.queue.length && !tx.inflight.size && this.rxStreams.get(id)?.gotFin)
            this.retire(id);
    }
    armProgress(id, tx) {
        this.clock.clearTimeout(tx.progressTimer);
        tx.progressTimer = this.clock.setTimeout(() => {
            if (this.txStreams.get(id) !== tx)
                return;
            this.retire(id, new Error(`stream ${id} DATA no-progress timeout`));
            this.startReset(id);
        }, this.retryTimeoutMs);
    }
    startReset(id) {
        if (this.closed || this.resets.has(id))
            return;
        const state = { timer: null, until: this.clock.now() + this.retryTimeoutMs, rto: this.rtoMs };
        this.resets.set(id, state);
        const send = () => {
            if (this.resets.get(id) !== state)
                return;
            if (this.clock.now() >= state.until) {
                this.resets.delete(id);
                return;
            }
            state.timer = this.clock.setTimeout(send, Math.min(state.rto, state.until - this.clock.now()));
            state.rto = Math.min(state.rto * 2, this.rtoMaxMs);
            this.trySendFrame(PeerFrameType.RST, id, Buffer.from([1]), 0);
        };
        send();
    }
    // -- internals -------------------------------------------------------------------
    trySendFrame(frameType, streamId, payload, ack) {
        try {
            this.sendFrame(frameType, streamId, payload, ack);
        }
        catch {
            // Physical path not ready or transiently unavailable; RTO / flushInflight recovers.
        }
    }
    ensureTx(streamId) {
        let tx = this.txStreams.get(streamId);
        if (!tx) {
            tx = { nextSeq: 0, queue: [], inflight: new Map(), finQueued: false, finPromise: null, finAcked: false, cumulative: 0, progressTimer: null, pendingBytes: 0, pendingWrites: 0 };
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
        while (tx.inflight.size < this.windowSize && tx.nextSeq - tx.cumulative < this.windowSize && tx.queue.length > 0) {
            const queued = tx.queue.shift();
            const seq = tx.nextSeq++;
            const subheader = Buffer.alloc(STREAM_HEADER_BYTES);
            subheader[0] = queued.fin ? STREAM_FLAG_FIN : 0;
            subheader.writeUInt32BE(seq, 1);
            const frag = {
                seq,
                payload: Buffer.concat([subheader, queued.data]),
                waiters: queued.waiters,
                finWaiter: queued.finWaiter,
                rto: this.rtoMs,
                timer: null,
            };
            frag.timer = this.clock.setTimeout(() => this.onRto(streamId, seq), frag.rto);
            tx.inflight.set(seq, frag);
            if (tx.progressTimer === null)
                this.armProgress(streamId, tx);
            this.trySendFrame(PeerFrameType.DATA, streamId, frag.payload, this.currentAck(streamId));
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
        frag.timer = this.clock.setTimeout(() => this.onRto(streamId, seq), frag.rto);
        this.trySendFrame(PeerFrameType.DATA, streamId, frag.payload, this.currentAck(streamId));
    }
    onData(streamId, payload, piggyAck) {
        if (piggyAck > 0)
            this.applyCumulative(streamId, piggyAck);
        if (!ArrayBuffer.isView(payload) || payload.byteLength < STREAM_HEADER_BYTES || payload.byteLength > PEER_MAX_PLAINTEXT_BYTES)
            return;
        if (this.isRetired(streamId) || (this.admissionClosed && !this.active.has(streamId))) {
            const terminal = this.terminal.get(streamId);
            if (terminal && terminal.until > this.clock.now() && terminal.ack > 0) {
                this.trySendFrame(PeerFrameType.SACK, streamId, Buffer.alloc(8), terminal.ack);
            }
            else
                this.trySendFrame(PeerFrameType.RST, streamId, Buffer.alloc(0), 0);
            return;
        }
        if (!this.admit(streamId)) {
            this.rememberRetired(streamId);
            this.trySendFrame(PeerFrameType.RST, streamId, Buffer.alloc(0), 0);
            return;
        }
        const view = asBufferView(payload);
        const flags = view[0];
        const seq = view.readUInt32BE(1);
        const data = view.subarray(STREAM_HEADER_BYTES);
        const fin = (flags & STREAM_FLAG_FIN) !== 0;
        let rx = this.rxStreams.get(streamId);
        if (!rx) {
            rx = { expected: 0, buffered: new Map(), gotFin: false, flushing: false };
            this.rxStreams.set(streamId, rx);
        }
        if (rx.gotFin || seq < rx.expected) {
            // Post-FIN junk or an old duplicate: just re-advertise our progress.
            this.sendSack(streamId, rx);
            return;
        }
        if (!rx.buffered.has(seq)) {
            // Out-of-order SACKed bytes cannot be discarded. Reserve headroom for
            // every stream's missing head so aggregate buffering cannot deadlock.
            const reserve = seq === rx.expected ? 0 : Math.min(this.maxSessionBytes, this.maxStreams * ARQ_CHUNK_MAX_BYTES);
            if (rx.buffered.size >= RX_BUFFER_MAX - (seq === rx.expected ? 0 : 1) ||
                this.receiveBytes + data.length > this.maxSessionBytes - reserve) {
                this.sendSack(streamId, rx);
                return;
            }
            rx.buffered.set(seq, { data: Buffer.from(data), fin });
            this.receiveBytes += data.length;
        }
        this.flush(streamId, rx);
        this.sendSack(streamId, rx);
    }
    flush(streamId, rx) {
        if (rx.flushing)
            return;
        rx.flushing = true;
        try {
            for (;;) {
                const next = rx.buffered.get(rx.expected);
                if (!next)
                    return;
                if (this.onStreamData?.(streamId, next.data, next.fin) === false)
                    return;
                if (this.rxStreams.get(streamId) !== rx)
                    return; // delivery may synchronously cancel
                rx.buffered.delete(rx.expected);
                this.receiveBytes -= next.data.length;
                rx.expected += 1;
                const final = next.fin;
                if (final) {
                    rx.gotFin = true;
                    for (const fragment of rx.buffered.values())
                        this.receiveBytes -= fragment.data.length;
                    rx.buffered.clear(); // anything after FIN is junk
                }
                if (final) {
                    this.maybeClose(streamId);
                    return;
                }
            }
        }
        finally {
            rx.flushing = false;
        }
    }
    sendSack(streamId, rx) {
        const bitmap = Buffer.alloc(SACK_BITMAP_BYTES);
        for (const [seq, fragment] of rx.buffered) {
            const delta = seq - rx.expected;
            if (!fragment.fin && delta > 0 && delta < SACK_BITMAP_BITS)
                bitmap[delta >> 3] |= 1 << (delta & 7);
        }
        this.trySendFrame(PeerFrameType.SACK, streamId, bitmap, rx.expected);
    }
    onSack(streamId, payload, ack) {
        this.applyCumulative(streamId, ack);
        if (!ArrayBuffer.isView(payload) || ack < 0)
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
        if (!tx || ack > tx.nextSeq)
            return;
        if (ack > tx.cumulative) {
            tx.cumulative = ack;
            this.armProgress(streamId, tx);
        }
        for (const [seq, frag] of tx.inflight) {
            if (seq < ack) {
                this.clock.clearTimeout(frag.timer);
                tx.inflight.delete(seq);
                this.settle(tx, frag);
            }
        }
        this.pump(streamId, tx);
        if (tx.inflight.size === 0 && tx.queue.length === 0) {
            this.clock.clearTimeout(tx.progressTimer);
            tx.progressTimer = null;
        }
        this.maybeClose(streamId);
    }
    settleFragment(streamId, seq) {
        const tx = this.txStreams.get(streamId);
        const frag = tx?.inflight.get(seq);
        if (!tx || !frag || frag.finWaiter)
            return; // FIN needs cumulative delivery confirmation
        this.clock.clearTimeout(frag.timer);
        tx.inflight.delete(seq);
        this.settle(tx, frag);
        this.pump(streamId, tx);
    }
    settle(tx, frag) {
        for (const waiter of frag.waiters) {
            waiter.remaining -= 1;
            if (waiter.remaining <= 0)
                waiter.resolve();
        }
        frag.waiters = [];
        if (frag.finWaiter) {
            tx.finAcked = true;
            frag.finWaiter.remaining -= 1;
            if (frag.finWaiter.remaining <= 0)
                frag.finWaiter.resolve();
            frag.finWaiter = null;
        }
    }
    teardownTx(streamId, tx, error) {
        if (!tx)
            return;
        this.clock.clearTimeout(tx.progressTimer);
        for (const frag of tx.inflight.values())
            this.clock.clearTimeout(frag.timer);
        for (const frag of tx.inflight.values()) {
            for (const waiter of frag.waiters)
                waiter.reject(error);
            frag.finWaiter?.reject(error);
        }
        for (const queued of tx.queue) {
            for (const waiter of queued.waiters)
                waiter.reject(error);
            queued.finWaiter?.reject(error);
        }
        tx.inflight.clear();
        tx.queue.length = 0;
        this.txStreams.delete(streamId);
    }
}
//# sourceMappingURL=arq.js.map