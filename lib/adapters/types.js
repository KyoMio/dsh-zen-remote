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
export {};
//# sourceMappingURL=types.js.map