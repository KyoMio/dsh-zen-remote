import type { ClientContext } from '../compat/types.ts';
/**
 * The remote-session marker (T41b): the CURRENT main-view session id, read
 * the way the official uiSession `publishMain` reads it (RT
 * dsh-client-ui-session lib/client.js:279-291), stamped onto <html> as
 * `data-zr-remote-session="1"` while it is a virtual (relay) id and removed
 * otherwise. remote-session.css.ts turns the attribute into the hiding of
 * every open-on-the-server-machine entry, so the decision lives at the one
 * place that knows the session and never inside component DOM.
 *
 * The official tie-break is kept verbatim: when the previous answer is still
 * mainView-retained it STAYS the answer, and only otherwise does the first
 * mainView-retained row in catalog order win — so two simultaneously
 * retained rows are decided by "current", never by iteration order. The
 * current value comes from the uiSession service's own main binding source
 * (`current.value.key`); where the service has not registered yet the scan
 * (compat/types.ts mainSessionIdOf) stands in, and a later list or main
 * change re-decides — which is why BOTH sources are subscribed below.
 *
 * Kept outside React for the same reason the header status dot is: the
 * attribute must track the current session regardless of which panel is
 * mounted, and an attribute + stylesheet survives every re-render untouched.
 */
export declare function installRemoteSessionGuard(ctx: ClientContext): void;
//# sourceMappingURL=remote-session.d.ts.map