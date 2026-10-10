/**
 * The adapter-author face of the plugin bridge's adapter framework
 * (PB-11). An adapter is zen-remote-internal code for ONE third-party
 * plugin at its EXACT version: it declares which of that plugin's routes
 * carry a session id and WHERE, and — optionally — hooks the two ends to
 * refuse, strip or rewrite what the pure id relocation cannot express.
 * Everything here sits on the framework shapes from
 * `../plugin-adapter-core.js`; the framework itself never imports this
 * file (only `src/index.ts` imports the ADAPTERS array from
 * `./adapters/index.js`), which is what makes the whole directory
 * removable without touching any other feature.
 *
 * An adapter implementation may import `types.ts` and pure utilities such
 * as `../virtual-id.js` — nothing else.
 */
import type { AdapterRoute, AdapterRequestContext, AdapterResponseContext, AdapterVerdict } from '../plugin-adapter-core.js';
export type { AdapterRoute, AdapterRequestContext, AdapterResponseContext, AdapterVerdict };
/** One pluggable adapter. `versions` lists the EXACT plugin versions this
 * adapter was written against — the installed version must be among them
 * or the adapter does not register at all (a best-guess rewrite against a
 * moving schema is how ids get corrupted). A plugin that registers its OWN
 * cooperative declaration always wins; the adapter yields. */
export interface BridgeAdapter {
    /** The target plugin's npm package name. */
    plugin: string;
    /** The checked exact versions; an installed version outside this list
     * means "not adapted". */
    versions: readonly string[];
    routes: readonly AdapterRoute[];
    /** The sub-client half: rewrite or refuse on the way OUT to the relay,
     * and map the answer's real session ids back to virtual form. */
    client?: {
        request?(ctx: AdapterRequestContext): AdapterVerdict;
        response?(ctx: AdapterResponseContext): unknown;
    };
    /** The main-server half: refuse or strip (e.g. a `cwd` field) before
     * the loopback reaches the plugin. */
    server?: {
        request?(ctx: AdapterRequestContext): AdapterVerdict;
    };
}
//# sourceMappingURL=types.d.ts.map