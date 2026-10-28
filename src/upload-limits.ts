/**
 * The one home of every upload/body ceiling this plugin enforces (the
 * upload unification, 2026-10-28). Three paths move bytes through the
 * plugin, each with its own number, and the numbers used to live beside
 * their enforcement sites — where they drifted: the docs still said
 * 100 MiB, the nginx snippet capped at 128m under a 500 MiB relay, and
 * the better-sidebar adapter hand-copied the relay budget (kept in step
 * only by a paired test). Defining them here once makes each number
 * greppable to exactly one place; scripts/check-upload-limits.mjs pins
 * the rest — no second MiB-scale constant definition anywhere in src/,
 * and the docs / nginx snippet stay in sync with MAX_UPLOAD_BYTES.
 *
 * Pure constants, ZERO imports (the virtual-id.ts precedent): the relay
 * server, the phone-upload route, the sub-client's fetch-route intercept,
 * the adapter core and the adapters themselves all import from here — an
 * adapter may only lean on pure utility modules, so anything less pure
 * would have kept the hand-copies alive.
 */

/**
 * Body ceiling for the binary upload channel alone (T51): a shared session's
 * non-image file attachments. DSH's own upload route has NO byte cap — the
 * host stores the stream verbatim (`saveFileStreamVerbatim` →
 * `publishImmutableObjectStream`, RT dsh-attachment-local lib/index.js
 * ~699-716; the 20 MiB `maxImageBytes` there covers INLINE images only), so
 * there is no host number to mirror and this relay picks its own: 500 MiB
 * per upload, checked first against `Content-Length` (refused before a byte
 * moves) and then counted while the stream is pumped (a chunked body has no
 * length header — the sub-client's undici forbids hand-set length headers,
 * so the streaming count is the path its uploads normally take). Past the
 * cap the forward is aborted, the rest of the request is drained and the
 * answer is 413 `payload-too-large`.
 *
 * SLOW-LINK BOUND (T51-fix, for the docs): a single legitimate upload is
 * also bounded in TIME. The sub-client's own round-trip budget now caps at
 * 15 minutes (relay-client.ts, the T31-fix rule), but the HOST's HTTP server
 * keeps Node's default 300 s request deadline — that is the binding limit:
 * a 500 MiB body needs roughly 14 Mbps sustained end to end, and a slower
 * link fails the call (the client-side refusal keeps the connection state)
 * rather than hanging. Raising the cap past what that deadline can carry
 * would only move the failure, so 500 MiB is the honest ceiling for the
 * current transport.
 */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024

/**
 * Body cap when the plugin row sets no `maxUploadBytes`. This governs ONLY
 * the phone composer's attachment upload (`/_dsh/mobile-nav/upload`) — the
 * remote relay channel reads {@link MAX_UPLOAD_BYTES} and must never be
 * sized from this: `maxUploadBytes` is a user-facing knob for phone picks
 * (default 20 MB), and wiring it into the relay would drop remote
 * attachments from 500 MiB back down to it (a regression the README's
 * 500 MiB promise forbids).
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/**
 * Body ceiling for the relay's invoke route alone: the prompt routes carry
 * inline images in their content blocks (`session/prompt` / `subagents/prompt`
 * take base64 `image` parts; DSH admits one image up to 20 MiB by default —
 * `maxImageBytes`, dsh-attachment-local — which base64 inflates to ~27 MiB),
 * so one full-size inline image plus its envelope needs 32 MiB. It is NOT
 * sized for `fileUploads/upload`: the UI's real file uploads ride the HTTP
 * route `api/session/uploadFileBinary` (T41b), not this JSON relay. The
 * buffer only ever grows to the REAL body size; the cap decides
 * accept/refuse, and a body that outgrows it is drained and answered 413
 * like any other oversized read.
 */
export const MAX_INVOKE_BODY_BYTES = 32 * 1024 * 1024
