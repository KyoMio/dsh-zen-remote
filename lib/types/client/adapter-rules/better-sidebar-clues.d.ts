import type { RemoteFetchBlockRule } from '../remote-fetch.ts';
/**
 * URL prefixes for `dsh-better-sidebar`'s workspace-keyed clue surface.
 * Calls under these paths target local clue storage and are refused in remote
 * sessions, while local sessions on client/peer nodes annotate them with the
 * panel-session header so the backend deny hook sees the same-frame session
 * state.
 */
export declare const CLUE_API_PREFIX = "/sidebar/api/clues.";
export declare const CLUE_API_EXACT = "/sidebar/api/clues";
export declare const CLUE_SHARE_PREFIX = "/sidebar/clues/share/";
/**
 * Whether one parsed pathname belongs to `dsh-better-sidebar`'s browser clue
 * surface (`/sidebar/api/clues.*`, `/sidebar/api/clues`, and
 * `/sidebar/clues/share/*`).
 * @param pathname - URL pathname resolved against the page origin.
 * @returns true when the pathname targets a workspace-keyed clue route.
 */
export declare function isCluePath(pathname: string): boolean;
/**
 * Synthetic refusal envelope matching `dsh-better-sidebar`'s `readEnvelope`
 * error contract so a blocked remote clue call degrades through the panel's
 * standard error path.
 * @returns serialized JSON error payload.
 */
export declare function clueBlockedBody(): string;
/** Fetch block/annotation rule for `dsh-better-sidebar`'s clue routes. */
export declare const BETTER_SIDEBAR_CLUES_RULE: RemoteFetchBlockRule;
//# sourceMappingURL=better-sidebar-clues.d.ts.map