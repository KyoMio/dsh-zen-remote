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
/** In-stream subheader: `[flags:1B][streamSeq:4B]`. */
export declare const STREAM_HEADER_BYTES = 5;
/** `flags` bit 0 — graceful half-close, riding on the final fragment. */
export declare const STREAM_FLAG_FIN = 1;
/** Largest data chunk that still fits one 1200B frame: 1156 − 5. */
export declare const ARQ_CHUNK_MAX_BYTES: number;
/** Default data chunk size (spec: ~1100B, comfortably inside the budget). */
export declare const ARQ_DEFAULT_CHUNK_BYTES = 1100;
/** Default send window: unconfirmed fragments in flight per stream. */
export declare const ARQ_DEFAULT_WINDOW = 64;
/** Default retransmission timeout. */
export declare const ARQ_DEFAULT_RTO_MS = 120;
/** RTO exponential backoff ceiling. */
export declare const ARQ_DEFAULT_RTO_MAX_MS = 1000;
/**
 * Injectable clock so tests can drive RTO/window timing deterministically.
 * Defaults to the real event loop.
 */
export interface ArqClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
/**
 * The one-frame-sending seam between the ARQ session and whatever
 * physical path is current (UDP direct socket or gateway WS relay).
 * Read at every (re)transmit — replace the property to hot-swap paths;
 * unconfirmed fragments then retransmit over the new path untouched.
 */
export type ArqFrameSender = (frameType: number, streamId: number, payload: Uint8Array, ack: number) => void;
export interface PeerArqOptions {
    sendFrame: ArqFrameSender;
    /** Ordered delivery of received stream chunks; `final` marks the FIN. */
    onStreamData?: (streamId: number, chunk: Uint8Array, final: boolean) => boolean | void;
    /** Once per admitted stream, after duplex FIN or any abort. */
    onStreamClosed?: (streamId: number, error?: Error) => void;
    /** Permanent admission failure; existing streams continue. Rejoin to recover. */
    onAdmissionClosed?: (error: Error) => void;
    /** Outstanding DATA with no cumulative progress; idle streams have no deadline. */
    retryTimeoutMs?: number;
    terminalTtlMs?: number;
    maxStreams?: number;
    maxRetiredRanges?: number;
    maxTerminalRecords?: number;
    maxStreamBytes?: number;
    maxSessionBytes?: number;
    /** The peer sent RST for this stream; all state for it is gone. */
    onStreamReset?: (streamId: number) => void;
    clock?: ArqClock;
    chunkSize?: number;
    windowSize?: number;
    rtoMs?: number;
    rtoMaxMs?: number;
}
/**
 * One ARQ session: many bidirectional streams over one frame-sending
 * seam. Create one per peer session; feed every opened frame from the
 * physical path into {@link handleFrame} and hand
 * {@link PeerArqOptions.sendFrame} to the path as the send callback.
 */
export declare class PeerArqSession {
    /**
     * The current physical-path sender. Read at every (re)transmit —
     * assign a new function to hot-swap paths mid-flight (gateway WS ↔
     * UDP direct); in-flight fragments automatically follow.
     */
    sendFrame: ArqFrameSender;
    private readonly clock;
    private readonly chunkSize;
    private readonly windowSize;
    private readonly rtoMs;
    private readonly rtoMaxMs;
    private readonly onStreamData;
    private readonly onStreamReset;
    private readonly txStreams;
    private readonly rxStreams;
    private closed;
    private readonly onStreamClosed;
    private readonly onAdmissionClosed;
    private admissionClosed;
    private readonly retryTimeoutMs;
    private readonly terminalTtlMs;
    private readonly maxStreams;
    private readonly maxRetiredRanges;
    private readonly maxTerminalRecords;
    private readonly maxStreamBytes;
    private readonly maxSessionBytes;
    private sendBytes;
    private receiveBytes;
    private readonly writable;
    private readonly active;
    private readonly retired;
    private readonly terminal;
    private readonly resets;
    constructor(options: PeerArqOptions);
    /**
     * Queue `bytes` on the stream and resolve once every fragment of this
     * write is confirmed by the peer (cumulative or selective). Backpressure:
     * the send window (`windowSize` unacked fragments) throttles the pump.
     */
    write(streamId: number, bytes: Uint8Array): Promise<void>;
    /**
     * Graceful half-close: delivers a FIN after everything previously
     * queued on the stream. Merges onto the last queued fragment when the
     * window is holding data back, otherwise sends a dedicated
     * zero-length FIN fragment. Writes after this are rejected.
     */
    finish(streamId: number): Promise<void>;
    /** Abortive close: reject this stream's pending writes and tell the peer. */
    reset(streamId: number): void;
    /**
     * Feed one opened frame from the physical path. Recognizes DATA /
     * SACK / RST (and treats the legacy ACK type as a pure cumulative
     * ack); ignores everything else (HELLO / PING / PONG belong to the
     * punch layer). Malformed input is dropped, never thrown.
     */
    handleFrame(frameType: number, streamId: number, payload: Uint8Array, ack: number): void;
    /**
     * Tear the whole session down: every retransmit timer is cleared and
     * every pending backpressure write rejects. The session is dead
     * afterwards — frames in and writes out are both refused.
     */
    closeAll(): void;
    /** Unconfirmed fragments currently in flight across all streams. */
    inflightTotal(): number;
    /** Fragments queued but not yet admitted to the send window. */
    queuedTotal(): number;
    /**
     * Immediately retransmit all unacked in-flight fragments and reset their RTO
     * timers to `rtoMs` (called when a physical path transitions from `'none'` to
     * ready so fragments queued during initial handshake fly without waiting for
     * backed-off RTO timers).
     */
    flushInflight(): void;
    /** Whole-block admission. false accepts no bytes; terminal/capacity errors throw. */
    tryWrite(streamId: number, bytes: Uint8Array): boolean;
    /** One admission waiter per stream; callers serialize writes, not ACKs. */
    waitWritable(streamId: number, bytes?: number): Promise<void>;
    bufferedSendBytes(): number;
    bufferedReceiveBytes(): number;
    private hasCapacity;
    private wakeWritable;
    /** Retry a previously refused delivery after consumer pull/read. */
    resume(streamId: number): void;
    private isRetired;
    private admit;
    private retire;
    private admissionError;
    /** Refused/cancelled IDs need permanent history, but no active-stream slot. */
    private rememberRetired;
    private maybeClose;
    private armProgress;
    private startReset;
    private trySendFrame;
    private ensureTx;
    private currentAck;
    private pump;
    private onRto;
    private onData;
    private flush;
    private sendSack;
    private onSack;
    private applyCumulative;
    private settleFragment;
    private settle;
    private teardownTx;
}
//# sourceMappingURL=arq.d.ts.map