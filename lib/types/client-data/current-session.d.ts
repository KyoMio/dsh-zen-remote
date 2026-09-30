/**
 * T62: the browser half's current-session parsing, as pure functions — the
 * readable core of the reporter (src/client/current-session-report.ts) and
 * the one place its rules are unit-tested without a DOM.
 *
 * The host DSH persists its selection (the session its UI has open) to
 * localStorage under `dsh.sessions.current` as a JSON object carrying
 * `sessionId` (dsh-client-ui-workspace's snapshot store, `replaceMain` /
 * `clearMain`). The reporter re-reads that key and POSTs it to the backend
 * whenever it CHANGES; the backend's intercept layer judges close frames
 * against it — a closed session the user has open keeps its page and its
 * 「远程已关闭」 banner, anything else hides. The vocabulary mirrors the
 * intercept side's `CurrentSessionRead`:
 * - `unavailable`: the key is absent or the value unreadable — NEVER
 *   report; the backend keeps its conservative tombstone behavior;
 * - `none`: readable, no session open — report `{sessionId: null}`;
 * - `open`: a session id — report `{sessionId}`.
 */
export type CurrentSessionReport = {
    kind: 'unavailable';
} | {
    kind: 'none';
} | {
    kind: 'open';
    sessionId: string;
};
/** Mirror of src/intercept.ts's key (the client build cannot import the
 * host file). The host's selection store persists under this exact name. */
export declare const CURRENT_SESSION_STORAGE_KEY = "dsh.sessions.current";
/** Parse one raw localStorage read. `null` / `undefined` (the key is absent
 * — the host store only starts persisting with its first write) and any
 * value that does not parse into an object with a usable shape are
 * `unavailable`: no signal, never a guess. An object WITHOUT a `sessionId`
 * (the host's `clearMain` writes `{}`) is a real, reportable "nothing is
 * open". */
export declare function parseCurrentSessionStorage(raw: string | null | undefined): CurrentSessionReport;
/** Whether one report differs from another — the reporter posts only on a
 * change, so this compares content, never object identity: kind first, then
 * the session id. */
export declare function currentSessionReportEquals(a: CurrentSessionReport, b: CurrentSessionReport): boolean;
//# sourceMappingURL=current-session.d.ts.map