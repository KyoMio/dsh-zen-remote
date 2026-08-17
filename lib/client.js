window.__ModuleLoader__.load({ id: "@dsh-external/dsh-mobile-nav", factory: (require) => {
var __modules = {};
__modules["MobileNavToggle.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MobileNavToggle = MobileNavToggle;
const jsx_runtime_1 = require("react/jsx-runtime");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
/**
 * Mobile-only icon buttons next to the session title:
 * - toggle: opens the directory drawer on narrow screens.
 * - files: toggles the dsh-web-ui explorer sheet directly — one tap opens,
 *   a second tap closes it, no drawer round-trip. (The drawer footer keeps
 *   a Files entry for the hero/blank phases where this header does not
 *   exist.)
 * Hidden entirely on wide screens (CSS media query).
 */
function MobileNavToggle({ toggleSidebar, t }) {
    const toggleExplorer = () => {
        const frame = document.querySelector('[data-mobile-nav="frame"]');
        if (frame === null)
            return;
        if (frame.hasAttribute('data-aionui-explorer-open')) {
            frame.removeAttribute('data-aionui-explorer-open');
        }
        else {
            frame.setAttribute('data-aionui-explorer-open', '');
        }
    };
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "toggle", "aria-label": t('open'), title: t('open'), onClick: () => toggleSidebar(), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPanelLeftOutline16, { size: 16 }) }), (0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "files", "aria-label": t('files'), title: t('files'), onClick: toggleExplorer, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconFolderOpenOutline16, { size: 16 }) })] }));
}
};
__modules["MobileNavOverlay.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MobileNavOverlay = MobileNavOverlay;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
/** Same breakpoint as the shell's SIDEBAR_AUTO_COLLAPSE (viewport < 1024). */
const MOBILE_QUERY = '(max-width: 1023px)';
/**
 * The tablet range, where the sidebar is still a drawer. Below 768px the
 * phone app shell (MobileHome) replaced the drawer entirely — the sidebar is
 * display:none there, so every drawer affordance below (backdrop, floating
 * opener, Escape, close-on-navigate) would operate an invisible panel.
 */
const TABLET_QUERY = '(min-width: 768px) and (max-width: 1023px)';
/**
 * Live matchMedia hook.
 * @param query - the media query to follow.
 * @returns whether it currently matches.
 */
function useMedia(query) {
    const [matches, setMatches] = (0, react_1.useState)(() => window.matchMedia(query).matches);
    (0, react_1.useEffect)(() => {
        const list = window.matchMedia(query);
        const onChange = (event) => setMatches(event.matches);
        setMatches(list.matches);
        list.addEventListener('change', onChange);
        return () => list.removeEventListener('change', onChange);
    }, [query]);
    return matches;
}
/** The AppFrame element: direct parent of the shell overlay layer. */
function findFrame() {
    return document.querySelector('[data-shell-overlay]')?.parentElement ?? null;
}
/**
 * Mobile shell overlay: owns the `data-mobile-nav` marker on the AppFrame
 * element (the CSS restructure keys off it), mirrors the frame's collapsed
 * state into React state, and renders the dimmed backdrop plus a floating
 * directory button for the hero/blank phases that have no session header.
 */
function MobileNavOverlay({ toggleSidebar, t }) {
    const mobile = useMedia(MOBILE_QUERY);
    const tablet = useMedia(TABLET_QUERY);
    const [open, setOpen] = (0, react_1.useState)(false);
    const [fabVisible, setFabVisible] = (0, react_1.useState)(false);
    // Frame ownership + open-state mirror. On wide screens this effect is inert:
    // the marker is never set, so the layout is untouched.
    (0, react_1.useLayoutEffect)(() => {
        if (!mobile) {
            setOpen(false);
            return;
        }
        const frame = findFrame();
        if (frame === null)
            return;
        frame.setAttribute('data-mobile-nav', 'frame');
        const sync = () => setOpen(!frame.hasAttribute('data-sidebar-collapsed'));
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
        return () => {
            observer.disconnect();
            frame.removeAttribute('data-mobile-nav');
            frame.removeAttribute('data-mobile-preview-full');
        };
    }, [mobile]);
    // The floating button is a fallback for surfaces without a session header:
    // phase "active" means the header (and its toggle) is rendered already.
    // Tablet only — on a phone the home screen owns navigation.
    (0, react_1.useEffect)(() => {
        if (!tablet) {
            setFabVisible(false);
            return;
        }
        const sync = () => setFabVisible(document.querySelector('[data-phase="active"]') === null);
        sync();
        const observer = new MutationObserver(sync);
        // childList: the conversation root can be replaced wholesale on session
        // switches, so attribute-only observation would miss the new phase.
        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['data-phase'],
        });
        return () => observer.disconnect();
    }, [tablet]);
    // Escape closes the drawer — but yields to an open modal dialog (e.g. the
    // settings panel), which owns its own Escape handling.
    (0, react_1.useEffect)(() => {
        if (!tablet || !open)
            return;
        const onKeyDown = (event) => {
            if (event.key === 'Escape' && document.querySelector('[aria-modal="true"]') === null)
                toggleSidebar();
        };
        // Capture phase: run before the settings panel's own document-bubble Escape
        // handler, so the modal is still present when we yield to it.
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [tablet, open, toggleSidebar]);
    // Navigation inside the drawer closes it: tapping a session row or a
    // plugin takeover entry (task board / ssh) must hand the screen to the
    // content it just opened. Capture phase — the drawer closes before the
    // shell or a plugin processes the click, so takeover panels never render
    // under the open drawer.
    //
    // Deliberately NOT closed by this rule:
    // - Settings / Session log: their dialogs render INSIDE the drawer DOM
    //   (portaled into the sidebar); closing the drawer would slide the dialog
    //   off-screen with it.
    // - Workspace folder chevrons, the logo: pure UI toggles, not navigation.
    // - Anything while a modal dialog is open: the dialog owns the screen.
    (0, react_1.useEffect)(() => {
        if (!tablet || !open)
            return;
        const onDrawerClick = (event) => {
            if (document.querySelector('[aria-modal="true"]') !== null)
                return;
            const target = event.target;
            if (target === null)
                return;
            const drawer = document.querySelector('[data-mobile-nav="frame"] > :first-child');
            if (drawer === null || !drawer.contains(target))
                return;
            // A session row's own action buttons — the "Session actions" kebab
            // (delete / rename), revealed on hover / long-press — open an edit
            // menu. Tapping one must NOT count as tapping the row, or the drawer
            // would close and take the just-opened menu with it.
            if (target.closest('[class*="sessionRow"] button') !== null)
                return;
            const navigates = target.closest('button[data-dsh-taskboard-entry], button[data-dsh-ssh-entry], [class*="newSession"], [class*="sessionRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"]');
            if (navigates !== null)
                toggleSidebar();
        };
        document.addEventListener('click', onDrawerClick, true);
        return () => document.removeEventListener('click', onDrawerClick, true);
    }, [tablet, open, toggleSidebar]);
    // Fullscreen toggle for the aionui preview sheet. The button is appended
    // INTO the preview column (position: absolute against it), so it rides
    // the sheet's own motion — open animation, geometry transition — locked
    // by construction instead of matching transition curves, and it hides
    // with the sheet automatically. The suite's React re-renders the column
    // content, so a MutationObserver re-appends the button whenever it is
    // wiped. (The sheet is z-index 56, above the overlay layer's z-20
    // stacking context, so a button inside the sheet is never covered.)
    // Clicking toggles the frame's `data-mobile-preview-full` marker; the
    // two SVG icons swap via CSS.
    (0, react_1.useEffect)(() => {
        if (!mobile)
            return;
        let button = null;
        let observer = null;
        const onClick = () => {
            findFrame()?.toggleAttribute('data-mobile-preview-full');
        };
        const ensure = () => {
            const col = document.querySelector('[data-aionui-preview-col]');
            if (col === null)
                return;
            if (button === null) {
                button = document.createElement('button');
                button.type = 'button';
                button.dataset.mobileNav = 'preview-full-toggle';
                button.setAttribute('aria-label', t('previewFullscreen'));
                button.title = t('previewFullscreen');
                button.innerHTML = [
                    '<svg class="dsh-mobile-nav-full-in" viewBox="0 0 16 16" fill="none" aria-hidden="true">',
                    '<path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
                    '</svg>',
                    '<svg class="dsh-mobile-nav-full-out" viewBox="0 0 16 16" fill="none" aria-hidden="true">',
                    '<path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
                    '</svg>',
                ].join('');
                button.addEventListener('click', onClick);
            }
            if (button.parentElement !== col)
                col.appendChild(button);
        };
        ensure();
        observer = new MutationObserver(ensure);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
            observer.disconnect();
            button?.remove();
        };
    }, [mobile, t]);
    // Move the git branch chip (conversation.input.dock) INTO the composer
    // card on mobile: it reads as a stray capsule floating between the dock
    // rows and the input card. Reparenting into the card lets CSS pin it to
    // the card's top-left (the card is position: relative) and give the card
    // a chip row via padding-top. The dock's React re-render restores the
    // chip to the dock, so a MutationObserver re-appends idempotently (same
    // pattern as the preview fullscreen toggle above). When the viewport
    // widens, cleanup moves the chip back to the dock — the desktop layout
    // is untouched.
    (0, react_1.useEffect)(() => {
        if (!mobile)
            return;
        let observer = null;
        const ensure = () => {
            const chip = document.querySelector('[data-slot="conversation.input.dock"] [data-gitgraph-chip-anchor]');
            if (chip === null)
                return;
            const card = document.querySelector('textarea')?.closest('[class$="_card"]');
            if (card == null)
                return;
            if (chip.parentElement !== card)
                card.insertBefore(chip, card.firstChild);
        };
        ensure();
        observer = new MutationObserver(ensure);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
            observer?.disconnect();
            const chip = document.querySelector('[data-slot="conversation.input.dock"] [data-gitgraph-chip-anchor]');
            const dock = document.querySelector('[data-slot="conversation.input.dock"]');
            if (chip !== null && dock !== null && chip.parentElement !== dock)
                dock.appendChild(chip);
        };
    }, [mobile]);
    // Settings dialog: move the toolbar (Open configuration file + close)
    // INTO the nav row so it shares ONE line with the category tabs — the
    // official layout gives the toolbar its own row under the tabs, which on
    // a phone leaves a full-width dead gap and pushes the options area down
    // (user feedback 2026-08-16). The toolbar is React-owned, so a
    // MutationObserver re-appends idempotently (same pattern as the chip
    // above). Desktop untouched: this effect only runs while the frame
    // marker is active. The toolbar is anchored by its class suffix — the
    // export dialog (header + description + body) has no nav row, so
    // querying the nav first makes the move a no-op there.
    (0, react_1.useEffect)(() => {
        if (!mobile)
            return;
        let observer = null;
        const ensure = () => {
            const dialog = document.querySelector('[aria-modal="true"]');
            if (dialog === null)
                return;
            const nav = dialog.querySelector(':scope > [class$="_nav"]');
            const header = dialog.querySelector('[class$="_header"]');
            if (nav === null || header === null)
                return;
            if (header.parentElement !== nav)
                nav.appendChild(header);
        };
        ensure();
        observer = new MutationObserver(ensure);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer?.disconnect();
    }, [mobile]);
    if (!tablet)
        return null;
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [open && ((0, jsx_runtime_1.jsx)("div", { "data-mobile-nav": "backdrop", role: "button", "aria-label": t('backdrop'), onClick: () => toggleSidebar() })), fabVisible && !open && ((0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "fab", "aria-label": t('open'), title: t('open'), onClick: () => toggleSidebar(), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPanelLeftOutline16, { size: 18 }) }))] }));
}
};
__modules["MobileDrawerFooter.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MobileDrawerFooter = MobileDrawerFooter;
const jsx_runtime_1 = require("react/jsx-runtime");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
/**
 * Mobile-only drawer footer actions, relocated from the session header to the
 * drawer footer (beside Settings):
 * - Files: opens the dsh-web-ui aionui explorer as a floating bottom sheet
 *   (the explorer column is hidden on mobile until this marker is set, so
 *   the suite's own persisted-expanded state can never cover the UI on load).
 * - Session log: the official session-log-export controller, so the
 *   progress/result dialog is shared with the desktop flow.
 * Hidden entirely on wide screens (CSS media query).
 */
function MobileDrawerFooter({ useSessions, downloadSessionLog, toggleSidebar, t }) {
    const sessionId = useSessions((state) => state.current);
    const openExplorer = () => {
        document.querySelector('[data-mobile-nav="frame"]')?.setAttribute('data-aionui-explorer-open', '');
        toggleSidebar();
    };
    return ((0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "drawer-actions", children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "explorer", "aria-label": t('files'), title: t('files'), onClick: openExplorer, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPanelLeftOutline16, { size: 14 }), (0, jsx_runtime_1.jsx)("span", { children: t('files') })] }), (0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "session-log", "aria-label": t('sessionLog'), title: t('sessionLog'), disabled: sessionId === undefined, onClick: () => {
                    if (sessionId !== undefined)
                        downloadSessionLog(sessionId);
                }, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconDownloadOutline16, { size: 14 }), (0, jsx_runtime_1.jsx)("span", { children: t('sessionLog') })] })] }));
}
};
__modules["nav-store.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_INFO_EVENT = exports.GO_HOME_EVENT = void 0;
exports.createNavStore = createNavStore;
const client_1 = require("@deepseek-ai/dsh-client-runtime/client");
/**
 * `window` event a `conversation.session.header.*` slot (session scope)
 * fires to move the ROOT-scope nav store back to `home` — see
 * {@link GO_HOME_EVENT} below for why a store handle cannot cross this
 * particular scope boundary directly.
 */
exports.GO_HOME_EVENT = 'dsh-mobile-nav:go-home';
/**
 * `window` event the header's ⓘ button (`conversation.session.header.utilities`,
 * session scope) fires to open the session-info sheet (S4, MobileSessionInfo.tsx)
 * — a second, sibling entry on the SAME slot. Not a store handle for the same
 * reason {@link GO_HOME_EVENT} isn't: two independent registrations sharing
 * one scope could hold a common handle instead, but keeping the info sheet's
 * open/closed state fully local (a plain `useState`) is simpler than adding a
 * second store, and the event is one line either way.
 */
exports.SESSION_INFO_EVENT = 'dsh-mobile-nav:session-info';
/**
 * Phone page-stack store (phone breakpoint only; the tablet/desktop layouts
 * never read it). Deliberately NOT persisted: the spec's launch rule is
 * "always land on the session list", so a reload must reset to `home`.
 *
 * Built by a factory instead of a module-level constant: a module-scope
 * handle is a disguised singleton across plugin reloads (ui-slots docs).
 *
 * One handle IS shared by every registration of one apply() — but only
 * within the SAME slot scope. This handle mounts at `shell.overlay`, a
 * ROOT-scope slot (MobileHome.tsx); declaring the identical handle on a
 * SESSION-scope slot (e.g. `conversation.session.header.actions`) throws at
 * runtime ("store handle mounted under ... is already mounted under scope
 * ...", confirmed 2026-08-17) — the framework creates one live instance per
 * (handle, scope), and root/session are different scopes even for the same
 * handle. A session-scope registration that needs to move the page stack
 * (the S2 header back button) cannot hold `actions.show` directly; it
 * dispatches {@link GO_HOME_EVENT} instead, and MobileHome — already
 * mounted with this store — is the one that calls `actions.show('home')`.
 * @returns a fresh store handle, shared by every SAME-SCOPE registration of
 * one apply().
 */
function createNavStore() {
    return (0, client_1.defineStore)({
        init: () => ({ view: 'home', workspace: null }),
        actions: {
            /**
             * Move the page stack.
             * @param draft - store draft.
             * @param view - target level.
             */
            show: (draft, view) => {
                draft.view = view;
            },
            /**
             * Pin the session-list workspace filter.
             * @param draft - store draft.
             * @param workspace - workspace id, or 'all'.
             */
            filter: (draft, workspace) => {
                draft.workspace = workspace;
            },
        },
    });
}
};
__modules["session-dot.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dotState = dotState;
/**
 * Status dot state of one session, matching the official sidebar semantics.
 * Shared by the home-screen row dots (MobileHome.tsx) and the session
 * header's running indicator (effects/header-status.ts), which reads it
 * outside React — see that module for why.
 * @param row - session summary.
 * @returns the dot state, or undefined when the row needs no dot.
 */
function dotState(row) {
    if (row.pendingInteraction !== undefined)
        return 'warning';
    if (row.running)
        return 'ongoing';
    if (row.completed === true)
        return 'done';
    return undefined;
}
};
__modules["MobileHome.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MobileHome = MobileHome;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
const nav_store_ts_1 = require("./nav-store.js");
const session_dot_ts_1 = require("./session-dot.js");
/** Phone breakpoint: below the tablet range, where the app-shell layout applies. */
const PHONE_QUERY = '(max-width: 767px)';
/** Live matchMedia hook for the phone breakpoint. */
function usePhone() {
    const [phone, setPhone] = (0, react_1.useState)(() => window.matchMedia(PHONE_QUERY).matches);
    (0, react_1.useEffect)(() => {
        const query = window.matchMedia(PHONE_QUERY);
        const onChange = (event) => setPhone(event.matches);
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);
    return phone;
}
/**
 * The site's own favicon, read at runtime from `document.head` (real-device
 * round 2 feedback: a home-screen logo, without shipping any trademarked
 * asset in this repo). A one-time lazy read is enough — the gateway/host
 * writes this `<link>` before the client bundle ever runs (same "first
 * frame" guarantee AGENTS.md documents for `viewport-fit=cover`), and
 * favicons do not change at runtime in practice, so there is no case here
 * that justifies a MutationObserver.
 */
function useSiteIconHref() {
    const [href] = (0, react_1.useState)(() => document.querySelector('link[rel~="icon"]')?.href);
    return href;
}
// Timestamps use the browser's own locale data — no dictionary keys, correct
// plurals everywhere. Deliberately NOT `document.documentElement.lang`: the
// shell stamps zh-CN there while the UI copy follows the browser languages
// (measured 2026-08-17), so the html attribute would print Chinese times in
// an English UI.
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' });
/**
 * Relative timestamp for a session row.
 * @param at - epoch milliseconds.
 * @returns "now" / "3 minutes ago" / "5/12", localized.
 */
function relativeTime(at) {
    const elapsed = Date.now() - at;
    if (elapsed < 60_000)
        return relative.format(0, 'second');
    if (elapsed < 3_600_000)
        return relative.format(-Math.floor(elapsed / 60_000), 'minute');
    if (elapsed < 86_400_000)
        return relative.format(-Math.floor(elapsed / 3_600_000), 'hour');
    if (elapsed < 604_800_000)
        return relative.format(-Math.floor(elapsed / 86_400_000), 'day');
    return shortDate.format(at);
}
/**
 * Card status subline (real-device round 2 follow-up, 2026-08-17): reuses
 * `dotState`'s own state read (the same ongoing/warning/done semantics the
 * dot already encodes) plus `agentPreset` from the same `SessionSummary`
 * row — no new data source. Returns undefined when there is neither a
 * state nor a preset to show, so the caller can skip the subline entirely
 * rather than render an empty row.
 */
function statusLine(row, dot, t) {
    const state = dot === 'ongoing' ? t('homeStatusOngoing')
        : dot === 'warning' ? t('homeStatusWarning')
            : dot === 'done' ? t('homeStatusDone')
                : undefined;
    if (state !== undefined && row.agentPreset !== undefined)
        return `${state} · ${row.agentPreset}`;
    return state ?? row.agentPreset;
}
/**
 * Phone home screen: the full-screen session list that owns the first level
 * of the page stack. Renders nothing at or above 768px — the tablet drawer
 * and the desktop layout stay exactly as they were.
 *
 * All data comes from the standard kit (`useSessions` / `useWorkspaces`) and
 * all navigation from the injected official actions; nothing here reads the
 * official DOM.
 */
function MobileHome({ useSessions, useWorkspaces, useStore, actions, openSession, startSession, t, }) {
    const phone = usePhone();
    const iconHref = useSiteIconHref();
    const [iconBroken, setIconBroken] = (0, react_1.useState)(false);
    const view = useStore((s) => s.view);
    const pinned = useStore((s) => s.workspace);
    // Whole snapshots: both stores keep unchanged rows identity-stable, and the
    // list re-renders on any session change anyway (the running dots live here).
    const sessions = useSessions((s) => s);
    const workspaces = useWorkspaces((s) => s);
    const [sheet, setSheet] = (0, react_1.useState)(null);
    // Workspace of the current session — the untouched filter default.
    const currentWorkspaceId = (0, react_1.useMemo)(() => {
        const current = sessions.current;
        if (current === undefined)
            return undefined;
        return workspaces.items.find((item) => item.sessionIds.includes(current))?.workspaceId;
    }, [sessions.current, workspaces.items]);
    const selected = pinned ?? currentWorkspaceId ?? 'all';
    const selectedWorkspace = selected === 'all'
        ? undefined
        : workspaces.items.find((item) => item.workspaceId === selected);
    const rows = (0, react_1.useMemo)(() => {
        const archived = new Set(workspaces.archivedSessionIds);
        const scope = selectedWorkspace === undefined ? null : new Set(selectedWorkspace.sessionIds);
        return sessions.ids
            .flatMap((id) => {
            const row = sessions.byId[id];
            return row === undefined ? [] : [row];
        })
            // Blank sessions are the New Session placeholders the official sidebar
            // hides too; subagents belong to their parent's session view.
            .filter((row) => !row.blank && row.parentId === undefined && row.origin !== 'subagent')
            .filter((row) => !archived.has(row.id))
            .filter((row) => scope === null || scope.has(row.id))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }, [sessions.ids, sessions.byId, workspaces.archivedSessionIds, selectedWorkspace]);
    // The session header's back button (session scope) cannot hold this
    // store directly — a handle mounts under exactly one scope, and this one
    // is already root-scoped here (see nav-store.ts) — so it dispatches
    // GO_HOME_EVENT instead and this, the store's actual owner, applies it.
    (0, react_1.useEffect)(() => {
        const onGoHome = () => actions.show('home');
        window.addEventListener(nav_store_ts_1.GO_HOME_EVENT, onGoHome);
        return () => window.removeEventListener(nav_store_ts_1.GO_HOME_EVENT, onGoHome);
    }, [actions]);
    const enter = (start) => {
        start();
        setSheet(null);
        actions.show('session');
    };
    if (!phone)
        return null;
    const title = selectedWorkspace?.title ?? t('allWorkspaces');
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [view === 'session' && ((0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "hero-back", "aria-label": t('backToList'), onClick: () => actions.show('home'), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronLeftOutline14, { size: 14 }) })), (0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "home", "data-view": view, "aria-hidden": view === 'session', children: [(0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "home-top", children: [iconHref !== undefined && !iconBroken && ((0, jsx_runtime_1.jsx)("img", { src: iconHref, alt: "", "aria-hidden": "true", "data-mobile-nav": "home-logo", onError: () => setIconBroken(true) })), (0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "ws-switch", "aria-haspopup": "menu", onClick: () => setSheet('filter'), children: [(0, jsx_runtime_1.jsx)("span", { children: title }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { size: 14 })] })] }), (0, jsx_runtime_1.jsxs)("ul", { "data-mobile-nav": "home-list", children: [rows.map((row) => {
                                const dot = (0, session_dot_ts_1.dotState)(row);
                                const status = statusLine(row, dot, t);
                                const initial = row.displayTitle.trim().charAt(0).toUpperCase();
                                return ((0, jsx_runtime_1.jsx)("li", { children: (0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "home-row", "data-current": row.id === sessions.current ? '' : undefined, onClick: () => enter(() => openSession(row.id)), children: [(0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "home-row-avatar", "aria-hidden": "true", children: dot !== undefined ? (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: dot, size: 10 }) : initial }), (0, jsx_runtime_1.jsxs)("span", { "data-mobile-nav": "home-row-body", children: [(0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "home-row-title", children: row.displayTitle }), status !== undefined && ((0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "home-row-status", children: status }))] }), (0, jsx_runtime_1.jsx)("time", { "data-mobile-nav": "home-row-time", dateTime: new Date(row.updatedAt).toISOString(), children: relativeTime(row.updatedAt) })] }) }, row.id));
                            }), rows.length === 0 && (0, jsx_runtime_1.jsx)("li", { "data-mobile-nav": "home-empty", children: t('noSessions') })] }), (0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "home-fab", "aria-label": t('newSession'), title: t('newSession'), onClick: () => enter(() => startSession(selectedWorkspace?.workspaceId)), children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPlusOutline16, { size: 18 }), (0, jsx_runtime_1.jsx)("span", { children: t('newSession') })] }), sheet !== null && ((0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "home-sheet-layer", children: [(0, jsx_runtime_1.jsx)("div", { "data-mobile-nav": "home-sheet-mask", role: "button", tabIndex: -1, "aria-label": t('close'), onClick: () => setSheet(null) }), (0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "home-sheet", role: "menu", children: [(0, jsx_runtime_1.jsx)("div", { "data-mobile-nav": "home-sheet-title", children: t('switchWorkspace') }), (0, jsx_runtime_1.jsx)("button", { type: "button", role: "menuitem", "data-mobile-nav": "home-sheet-item", "data-selected": selected === 'all' ? '' : undefined, onClick: () => {
                                            actions.filter('all');
                                            setSheet(null);
                                        }, children: t('allWorkspaces') }), workspaces.items.map((item) => ((0, jsx_runtime_1.jsx)("button", { type: "button", role: "menuitem", "data-mobile-nav": "home-sheet-item", "data-selected": selected === item.workspaceId ? '' : undefined, onClick: () => {
                                            actions.filter(item.workspaceId);
                                            setSheet(null);
                                        }, children: item.title }, item.workspaceId)))] })] }))] })] }));
}
};
__modules["MobileSessionHeader.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readViewTabs = readViewTabs;
exports.useViewTabs = useViewTabs;
exports.MobileHeaderActions = MobileHeaderActions;
exports.MobileHeaderUtilities = MobileHeaderUtilities;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
const nav_store_ts_1 = require("./nav-store.js");
/**
 * ic_ds_info_outline_16 — @deepseek-ai/dsh-client-ui-primitives has no
 * info-circle icon (grepped lib/types/icons/index.d.ts, 2026-08-17: 71
 * icons, nearest is IconQuestionOutline14, wrong glyph AND wrong size).
 * Hand-built to the same 16x16 box the rest of the header icon family
 * uses, so the ⓘ button in MobileHeaderUtilities below reads as one
 * family with the workbench button's mirrored IconPanelLeftOutline16
 * (real-device round 2 feedback: "same size (16), same stroke weight").
 */
function IconInfoOutline16({ size = 16 }) {
    return ((0, jsx_runtime_1.jsxs)("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", children: [(0, jsx_runtime_1.jsx)("circle", { cx: "8", cy: "8", r: "6.7", stroke: "currentColor", strokeWidth: "1.3" }), (0, jsx_runtime_1.jsx)("circle", { cx: "8", cy: "4.7", r: "0.95", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("rect", { x: "7.25", y: "6.9", width: "1.5", height: "4.7", rx: "0.75", fill: "currentColor" })] }));
}
/**
 * Reads the official session-header tablist by role/aria only (no hashed
 * classes) — the plan's one sanctioned official-DOM read: ChatStore's view
 * selection has no public setter (design doc Appendix C), so switching
 * views means clicking the official tab button ourselves.
 *
 * Exported: effects/gestures.ts (S6) reuses this exact read for the
 * content-area swipe gesture instead of re-querying the tablist a second
 * way — it runs outside React (a document-level touch listener), so it
 * needs the plain function, not the {@link useViewTabs} hook below.
 */
function readViewTabs() {
    const list = document.querySelector('header [role="tablist"]');
    if (list === null)
        return [];
    return [...list.querySelectorAll('[role="tab"]')].map((el) => ({
        label: el.textContent ?? '',
        active: el.getAttribute('aria-selected') === 'true',
        el,
    }));
}
/**
 * Live view-tab mirror. The tablist mounts/unmounts with the session header
 * and its `aria-selected` flips on every view switch (ours or the suite's
 * own), so a MutationObserver — not a one-time read — keeps the mirror
 * current. Scoped to `document.body` like the existing aionui-compat
 * effects (styles/aionui-compat.ts): the tablist itself may not exist yet
 * at mount time.
 *
 * Exported: MobileSessionInfo.tsx (S4) reuses this exact hook for the info
 * sheet's Chat/Trajectory segmented control instead of re-reading the
 * tablist a second way.
 */
function useViewTabs() {
    const [tabs, setTabs] = (0, react_1.useState)(() => []);
    (0, react_1.useEffect)(() => {
        const sync = () => setTabs(readViewTabs());
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-selected'],
            childList: true,
        });
        return () => observer.disconnect();
    }, []);
    return tabs;
}
/**
 * Session header, left lane: the back button (returns the phone page stack
 * to the session list) plus the "current view + dots" row that mirrors the
 * hidden official tablist. Both render unconditionally; CSS
 * (styles/header.css.ts) keeps them hidden at >= 768px so the tablet drawer
 * and the desktop layout stay exactly as they were.
 */
function MobileHeaderActions({ t }) {
    const tabs = useViewTabs();
    const active = tabs.find((tab) => tab.active) ?? tabs[0];
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "header-back", "aria-label": t('backToList'), title: t('backToList'), onClick: () => window.dispatchEvent(new CustomEvent(nav_store_ts_1.GO_HOME_EVENT)), children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronLeftOutline14, { size: 14 }) }), tabs.length > 1 && active !== undefined && ((0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "header-viewrow", "aria-label": t('switchView'), onClick: () => tabs.find((tab) => !tab.active)?.el.click(), children: [(0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "header-viewrow-label", children: active.label }), (0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "header-viewrow-dots", "aria-hidden": "true", children: tabs.map((tab, index) => ((0, jsx_runtime_1.jsx)("i", { "data-active": tab.active ? '' : undefined }, index))) })] }))] }));
}
/**
 * Session header, right lane: the session-info entry (S4 owns the actual
 * sheet — this fires a hook event for it to pick up) and the workbench
 * entry, which triggers dsh-better-sidebar's own toggle. There is no public
 * API for "open the panel" (BetterSidebarService.openTab only auto-expands
 * for a content open, not a bare type-only open), so this clicks the
 * plugin's real toggle button through a stable, non-hashed anchor: its root
 * mount marker `[data-dsh-better-sidebar]` plus the `_toggleButton` class
 * suffix (verified live: 2026-08-17). Safe no-op when the plugin, or any
 * other workbench-style plugin sharing that convention, is not installed.
 */
function MobileHeaderUtilities({ t }) {
    // Better-sidebar phone close button (S3.1 follow-up, 2026-08-17): the
    // panel's own top-right toggle cluster is hidden below 768px
    // (styles/compat.css.ts) because it duplicates the workbench button
    // below — but that cluster is also the panel's ONLY close control, so
    // hiding it blindly leaves an open panel with no way out. This button is
    // appended straight to document.body, mirroring the existing
    // preview-full-toggle pattern in MobileNavOverlay.tsx (raw DOM, not a
    // React portal — react-dom is not among this plugin's platform-module
    // imports, see AGENTS.md "client import purity"): never inside the
    // panel's own subtree (the third party's React re-renders would wipe
    // it) and never under any transformed/backdrop-filter ancestor (the S4
    // info-card WebKit lesson in AGENTS.md — position:fixed would re-anchor
    // to that ancestor instead of the viewport). It clicks the SAME hidden
    // official toggle the workbench button below uses. Visibility is pure
    // CSS (styles/compat.css.ts: `body:has([data-dsh-better-sidebar]
    // [class$="_panel"])` — the panel's class ends in "_panel" only while
    // open, "_panelHidden" is appended once closed), so this effect only
    // has to guarantee the node exists — no MutationObserver needed to
    // track open/closed state. Icon paths copied verbatim from
    // IconCloseOutline16 (primitives) for the same reason IconInfoOutline16
    // above is hand-built: this button lives outside the React tree, so it
    // cannot render a primitives component directly.
    (0, react_1.useEffect)(() => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.mobileNav = 'better-sidebar-close';
        button.setAttribute('aria-label', t('workbenchClose'));
        button.title = t('workbenchClose');
        // Bottom-center labeled pill (real-device follow-up, 2026-08-17): the
        // icon markup is a static trusted string (safe as innerHTML), but the
        // locale label is untrusted-shaped text — built as a real text node via
        // textContent, not string-concatenated into the same innerHTML, so a
        // translation can never be parsed as markup.
        button.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">'
            + '<path d="M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197Z" fill="currentColor"/>'
            + '<path d="M13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z" fill="currentColor"/>'
            + '</svg>';
        const label = document.createElement('span');
        label.textContent = t('workbenchClose');
        button.appendChild(label);
        const onClick = () => {
            document.querySelector('[data-dsh-better-sidebar] button[class$="_toggleButton"]')?.click();
        };
        button.addEventListener('click', onClick);
        document.body.appendChild(button);
        return () => {
            button.removeEventListener('click', onClick);
            button.remove();
        };
    }, [t]);
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "header-info", "aria-label": t('sessionInfo'), title: t('sessionInfo'), onClick: () => window.dispatchEvent(new CustomEvent(nav_store_ts_1.SESSION_INFO_EVENT)), children: (0, jsx_runtime_1.jsx)(IconInfoOutline16, { size: 16 }) }), (0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "header-workbench", "aria-label": t('workbench'), title: t('workbench'), onClick: () => {
                    document.querySelector('[data-dsh-better-sidebar] button[class$="_toggleButton"]')?.click();
                }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPanelLeftOutline16, { size: 16 }) })] }));
}
};
__modules["MobileSessionInfo.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MobileSessionInfo = MobileSessionInfo;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
const client_1 = require("@deepseek-ai/dsh-client-runtime/client");
const nav_store_ts_1 = require("./nav-store.js");
const MobileSessionHeader_tsx_1 = require("./MobileSessionHeader.js");
/* ---- StatsLine-identical formatting -------------------------------------
 * Ported (not imported — the source functions are module-private to
 * StatsLine.tsx) from dsh-client-ui-conversation lib/client.js:2755-2787
 * (verified 2026-08-17). The "口径对齐官方" requirement is digit-for-digit,
 * not just look-alike, so the algorithm is copied exactly. */
/** Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits). */
function formatTokens(n) {
    const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
    if (n < 1e3)
        return String(n);
    if (n < 1e6)
        return `${scaled(n / 1e3)}K`;
    return `${scaled(n / 1e6)}M`;
}
/** Compact duration: 45.2s under a minute, 2m42s from there on. */
function formatDuration(ms) {
    const s = ms / 1e3;
    if (s < 60)
        return `${Math.round(s * 10) / 10}s`;
    const whole = Math.round(s);
    return `${Math.floor(whole / 60)}m${whole % 60}s`;
}
/** Sum of the three disjoint prompt-side billing buckets. */
function billedInputTokens(usage) {
    return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}
/** Cache-hit share of prompt-side input over the whole durable log; null when nothing was billed. */
function cacheHitPercent(usage) {
    const denominator = billedInputTokens(usage);
    return denominator === 0 ? null : Math.round((usage.cacheReadTokens / denominator) * 100);
}
/** Data-missing / not-yet-observed placeholder for a stat cell. */
const NA = '—';
/**
 * Session-info sheet: the bottom sheet that gathers everything S3 pulled off
 * the composer (the official stats strip) and everything S2 left out of the
 * header (Chat/Trajectory as a real control, badges, session actions).
 *
 * Registered as a SECOND entry on `conversation.session.header.utilities` —
 * session scope, sibling to the ⓘ button that opens it
 * (MobileSessionHeader.tsx dispatches {@link SESSION_INFO_EVENT}).
 *
 * Mount-point choice (the plan's own tradeoff to weigh): this needs
 * `useProjection`/`sessionId` for the stats grid, and those are
 * session-scope-only standard props — `header.utilities` has them,
 * `shell.overlay` (S1's other option) does not. `shell.overlay` would have
 * gained nothing in exchange (GlobalStandardProps — `useSessions` for the
 * badges/subagent-count — is unconditional on every slot per
 * `PropsRuntime`, so this component gets it here for free too) while
 * running into a real problem: shell.overlay content renders inside the
 * `pI_x6G_overlayLayer`, a z-index:20 stacking context (AGENTS.md), and the
 * composer's own permission/model bottom sheets sit at z:60 — a
 * shell.overlay-hosted info sheet would render BEHIND an open composer
 * menu. Mounting inside the header's own DOM (outside that capped layer)
 * lets this sheet's z-index clear every other phone-shell float.
 */
function MobileSessionInfo({ sessionId, useSessions, useProjection, forkSession, openSession, renameSession, archiveSession, downloadSessionLog, t, }) {
    const [open, setOpen] = (0, react_1.useState)(false);
    const [busy, setBusy] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    (0, react_1.useEffect)(() => {
        const onOpen = () => {
            setError(null);
            setOpen(true);
        };
        window.addEventListener(nav_store_ts_1.SESSION_INFO_EVENT, onOpen);
        return () => window.removeEventListener(nav_store_ts_1.SESSION_INFO_EVENT, onOpen);
    }, []);
    const tabs = (0, MobileSessionHeader_tsx_1.useViewTabs)();
    const row = useSessions((s) => s.byId[sessionId]);
    const subagentCount = useSessions((s) => s.subagentsByParent[sessionId]?.entries.length ?? 0);
    const stats = useProjection('sessionStats');
    const usage = useProjection('tokenUsage');
    if (!open)
        return null;
    const close = () => setOpen(false);
    const run = async (action) => {
        setBusy(true);
        setError(null);
        try {
            await action();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setBusy(false);
        }
    };
    const onRename = () => {
        const next = window.prompt(t('infoRenamePrompt'), row?.displayTitle ?? '');
        if (next === null)
            return;
        const title = next.trim();
        if (title === '')
            return;
        void run(async () => {
            const result = await renameSession(sessionId, title);
            if (result === undefined)
                throw new Error(t('infoRename'));
            if (!result.ok)
                throw new Error(result.error.message);
        });
    };
    const onFork = () => {
        void run(async () => {
            const forkedId = await forkSession(sessionId);
            openSession(forkedId);
            close();
        });
    };
    const onArchive = () => {
        if (!window.confirm(t('infoArchiveConfirm')))
            return;
        void run(async () => {
            await archiveSession(sessionId);
            window.dispatchEvent(new CustomEvent(nav_store_ts_1.GO_HOME_EVENT));
            close();
        });
    };
    const onExport = () => {
        void downloadSessionLog(sessionId);
    };
    const cacheHit = usage === undefined ? null : cacheHitPercent(usage);
    const tokensEmpty = usage === undefined || (billedInputTokens(usage) === 0 && usage.outputTokens === 0);
    const cwd = row?.cwd === undefined || row.cwd === '' ? undefined : (0, client_1.workspaceTitleOf)(row.cwd);
    const cells = [
        { label: t('infoStatTurns'), value: stats === undefined ? NA : String(stats.turns), sub: undefined },
        { label: t('infoStatSteps'), value: stats === undefined ? NA : String(stats.steps), sub: undefined },
        {
            label: t('infoStatTtft'),
            value: stats === undefined || stats.ttftSteps === 0 ? NA : formatDuration(stats.ttftMs / stats.ttftSteps),
            sub: undefined,
        },
        {
            label: t('infoStatLlm'),
            value: stats === undefined || stats.llmMs === 0 ? NA : formatDuration(stats.llmMs),
            sub: undefined,
        },
        {
            label: t('infoStatTool'),
            value: stats === undefined || stats.toolMs === 0 ? NA : formatDuration(stats.toolMs),
            sub: undefined,
        },
        {
            label: t('infoStatTokens'),
            value: tokensEmpty || usage === undefined
                ? NA
                : `${formatTokens(billedInputTokens(usage))}→${formatTokens(usage.outputTokens)}`,
            sub: cacheHit === null ? undefined : t('infoCacheHit', { percent: cacheHit }),
        },
    ];
    return ((0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "info-layer", children: [(0, jsx_runtime_1.jsx)("div", { "data-mobile-nav": "info-mask", role: "button", tabIndex: -1, "aria-label": t('infoClose'), onClick: close }), (0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "info-sheet", role: "dialog", "aria-modal": "true", children: [(0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "info-head", children: [tabs.length > 1 && ((0, jsx_runtime_1.jsx)("div", { "data-mobile-nav": "info-tabs", role: "group", "aria-label": t('switchView'), children: tabs.map((tab) => ((0, jsx_runtime_1.jsx)("button", { type: "button", "aria-pressed": tab.active, "data-mobile-nav": "info-tab", "data-selected": tab.active ? '' : undefined, onClick: () => {
                                        if (!tab.active)
                                            tab.el.click();
                                        close();
                                    }, children: tab.label }, tab.label))) })), (0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "info-close", "aria-label": t('infoClose'), onClick: close, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconCloseOutline16, { size: 16 }) })] }), (0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "info-badges", children: [row?.agentPreset !== undefined && (0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "info-badge", children: row.agentPreset }), subagentCount > 0 && ((0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "info-badge", children: t('infoSubagents', { count: subagentCount }) })), (0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "info-badge-cwd", children: cwd ?? t('infoCwdFallback') })] }), (0, jsx_runtime_1.jsx)("div", { "data-mobile-nav": "info-stats", children: cells.map((cell) => ((0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "info-stat", children: [(0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "info-stat-value", children: cell.value }), (0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "info-stat-label", children: cell.label }), cell.sub !== undefined && (0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "info-stat-sub", children: cell.sub })] }, cell.label))) }), error !== null && (0, jsx_runtime_1.jsx)("div", { "data-mobile-nav": "info-error", children: t('infoActionError', { message: error }) }), (0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "info-actions", children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "info-action", disabled: busy, onClick: onExport, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconDownloadOutline16, { size: 16 }), (0, jsx_runtime_1.jsx)("span", { children: t('infoExport') })] }), (0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "info-action", disabled: busy, onClick: onRename, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconEditOutline16, { size: 16 }), (0, jsx_runtime_1.jsx)("span", { children: t('infoRename') })] }), (0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "info-action", disabled: busy, onClick: onFork, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconBranchOutline16, { size: 16 }), (0, jsx_runtime_1.jsx)("span", { children: t('infoFork') })] }), (0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "info-action", "data-mobile-nav-danger": "", disabled: busy, onClick: onArchive, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconArchiveOutline20, { size: 20 }), (0, jsx_runtime_1.jsx)("span", { children: t('infoArchive') })] })] })] })] }));
}
};
__modules["MobileAttachButton.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MobileAttachButton = MobileAttachButton;
const jsx_runtime_1 = require("react/jsx-runtime");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
/**
 * Composer attachment button (S3 placeholder).
 *
 * Renders into `conversation.input.left`, which CSS orders to the leftmost
 * seat of the phone composer's bottom row. The official file picker opens on
 * the HOST machine, so it is useless over a phone — S7 replaces this no-op
 * with a client-side `<input type="file">` + upload endpoint. Until then the
 * button holds the seat and stays inert on tap (aria-disabled rather than
 * `disabled`, so the label is still announced).
 */
function MobileAttachButton({ t }) {
    return ((0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "attach", "aria-label": t('attach'), "aria-disabled": "true", title: t('attachPending'), onClick: (e) => {
            e.preventDefault();
        }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPaperclipOutline16, { size: 16 }) }));
}
};
__modules["styles/base.css.js"] = function (require, module, exports) {
"use strict";
// base — split from src/client/mobile.css.ts (2026-08-16), order preserved.
// Do not reorder: styles/index.ts concatenates in this exact order.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BASE_CSS = void 0;
exports.BASE_CSS = `
/* ---------- safe-area variables (S2.1, 2026-08-17) ----------
   Every safe-area use in this stylesheet reads --mnav-sat / --mnav-sab
   instead of env() directly. Same computed value by default, but the
   indirection gives one place to override: ?mobile-nav-inset=54 (client/
   debug.ts) writes a fake inset onto the root element, so a desktop CDP
   run can regress notch layout — env(safe-area-inset-*) is hard 0 in every
   desktop browser, which is exactly why the header and the workbench
   panel shipped broken to a real iPhone. */
:root {
  --mnav-sat: env(safe-area-inset-top, 0px);
  --mnav-sab: env(safe-area-inset-bottom, 0px);
}

/* ---------- base control styles (rendered at any width, hidden where unused) ---------- */

[data-mobile-nav="toggle"],
[data-mobile-nav="files"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
[data-mobile-nav="toggle"]:hover,
[data-mobile-nav="files"]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}
[data-mobile-nav="toggle"]:focus-visible,
[data-mobile-nav="files"]:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4f6ef7);
  outline-offset: 1px;
}

/* Drawer footer actions: the relocated Session log download plus the Files
   action that opens the dsh-web-ui explorer sheet. */
[data-mobile-nav="drawer-actions"] {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
[data-mobile-nav="session-log"],
[data-mobile-nav="explorer"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
[data-mobile-nav="session-log"]:hover:not(:disabled),
[data-mobile-nav="explorer"]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}
[data-mobile-nav="session-log"]:disabled {
  color: var(--dsw-alias-label-dimmed, rgba(0, 0, 0, .35));
  cursor: default;
}

/* Floating fallback button (hero / blank phases without a session header).
   The top clears the camera band below the status bar; when the client has
   set viewport-fit=cover the safe-area inset moves it below the notch too. */
[data-mobile-nav="fab"] {
  position: absolute;
  top: calc(var(--mnav-sat) + 72px);
  left: 10px;
  z-index: 21;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 50%;
  background: var(--dsw-alias-button-floating-fill, #ffffff);
  color: var(--dsw-alias-label-primary, inherit);
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0, 0, 0, .18);
  -webkit-tap-highlight-color: transparent;
}
[data-mobile-nav="fab"]:hover {
  background: var(--dsw-alias-button-floating-hover, rgba(0, 0, 0, .08));
}
[data-mobile-nav="fab"]:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4f6ef7);
  outline-offset: 2px;
}

/* Dimmed backdrop under the open drawer; above every column, below the drawer. */
[data-mobile-nav="backdrop"] {
  position: absolute;
  inset: 0;
  z-index: 30;
  background: rgba(0, 0, 0, .45);
  cursor: pointer;
  animation: dsh-mobile-nav-fade .2s var(--ds-ease-in-out, ease-in-out);
  -webkit-tap-highlight-color: transparent;
}
@keyframes dsh-mobile-nav-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
/* Settings sheet entrance: the official dialog mounts with no animation at
   all, so it snaps in. Fade + slight rise/scale reads as a proper sheet. */
@keyframes dsh-mobile-nav-sheet-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* Preview sheet rise: the aionui preview column opens as a bottom sheet. */
@keyframes dsh-mobile-nav-sheet-up {
  from {
    opacity: 0;
    transform: translateY(28px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
`;
};
__modules["styles/layout.css.js"] = function (require, module, exports) {
"use strict";
// layout — split from src/client/mobile.css.ts (2026-08-16), order preserved.
// Do not reorder: styles/index.ts concatenates in this exact order.
Object.defineProperty(exports, "__esModule", { value: true });
exports.LAYOUT_CSS = void 0;
exports.LAYOUT_CSS = `/* ---------- mobile-only layout ---------- */

@media (max-width: 1023px) {
  /* --- Phone chrome ---
     The system status bar stays visible (no fullscreen). Two adjustments
     make it behave:
     - touch-action: manipulation kills double-tap-to-zoom (and the 300ms
       tap delay) while keeping pan and pinch zoom; the client also
       suppresses legacy-iOS gesturestart as a fallback.
     - With the client's viewport-fit=cover, env(safe-area-inset-top) is the
       status bar / notch height; the rules below push the app content below
       it so the status bar never covers anything. Off notched phones (or in
       a normal browser tab where the layout viewport already sits below the
       status bar) the inset is 0 and nothing shifts. */
  html,
  body {
    touch-action: manipulation !important;
  }

  /* AppFrame: the drawer takes the sidebar column out of grid flow, so the
     remaining in-flow items (center, details) land in tracks 1..2: give the
     center every pixel and keep the details track at zero. The top padding
     clears the status bar / notch for every in-flow surface (session header,
     messages, composer); the absolutely-positioned drawer is unaffected (its
     containing block is the frame's padding box, i.e. still the frame top). */
  /* box-sizing: border-box is load-bearing (S2.1, 2026-08-17). The official
     frame carries height: 100% with the default content-box, so the
     safe-area padding ADDED 54px to its height instead of taking 54px out
     of the content area: the frame grew past the viewport, the document
     became scrollable by exactly the inset, and the very first scroll put
     the header right back under the notch — measured with
     ?mobile-nav-inset=54 (frame 898px tall inside an 844px root, html at
     y=-54). Invisible on every desktop browser because the inset is 0
     there, which is how it shipped. */
  [data-mobile-nav="frame"] {
    position: relative !important;
    box-sizing: border-box !important;
    grid-template-columns: minmax(0, 1fr) 0 0 !important;
    padding-top: var(--mnav-sat) !important;
  }

  /* The sidebar column (first grid child) becomes a left drawer. The drawer
     hugs the sidebar content exactly (the wide sidebar carries an inline
     width, ~280px): a fixed 92vw box would leave a white strip where the
     container background shows beside the content.
     Closed state: translateX(-110%) — more than -100% of the max-content
     width — guarantees the whole drawer (and its shadow, had it one) leaves
     the viewport. A mere -100% leaves a sliver on screen; -105% (as used
     before) left 14px of the drawer plus a long 32px-blur shadow gradient
     visible along the left edge of the main UI. No box-shadow at all: the
     dimmed backdrop already separates drawer from content. */
  [data-mobile-nav="frame"] > :first-child {
    position: absolute !important;
    inset: 0 auto 0 0 !important;
    width: max-content !important;
    max-width: 92vw !important;
    z-index: 40 !important;
    transform: translateX(-110%);
    transition: transform .28s var(--ds-ease-in-out, ease-in-out);
    background: var(--dsw-alias-bg-base, #ffffff);
    /* Keep the drawer's own content below the status bar / notch: the drawer
       spans the full frame height (its absolute containing block is the
       frame's padding box, so the frame's own safe-area padding does NOT
       reach it). The drawer background paints the status-bar strip, which
       the client's theme-color meta matches, so the strip reads seamless. */
    padding-top: var(--mnav-sat) !important;
    /* Kill the official sidebarCol right border: with the backdrop the edge
       reads cleanly, and the settings dialog (width:100% of this box) stays
       pixel-flush with the drawer. */
    border-right: none !important;
  }

  /* Expanded state (frame without data-sidebar-collapsed) slides the drawer in.
     The open state must be transform:none — NOT translateX(0): an identity
     transform still makes the drawer the containing block for fixed-position
     descendants (the settings dialog's .VOzbGW_overlay is portaled into the
     sidebar DOM). With the identity transform the wide settings sheet
     (100vw-16) overflows the 280px drawer, the dialog's focus scrolls the
     overflow:hidden drawer to scrollLeft=102, and every static child (plus the
     fixed overlay) shifts 102px off-screen. With transform:none the overlay is
     viewport-anchored: it dims the full screen and the sheet sits at left:8. */
  [data-mobile-nav="frame"]:not([data-sidebar-collapsed]) > :first-child {
    transform: none !important;
  }

  /* Drag handles are useless on touch and would float over the drawer. */
  [data-side="sidebar"],
  [data-side="details"] {
    display: none !important;
  }

  /* --- Conversation text on mobile ---
     The official message flow keeps desktop's 32px side gutters and 16px
     type. On a phone: shrink the type a notch and widen the lines by
     trimming the gutters (the sidebar drawer list keeps its size). The
     flow's scroll container is the only _scroll element holding markdown
     <p> paragraphs — the composer's own scroll (textarea) is excluded
     via :has(p). */
  /* The official main scroll body reserves scrollbar-gutter for desktop
     scrollbars (8px), which shoves every column off-center on a phone.
     Classic desktop scrollbars (Edge/Chrome) also occupy ~8-17px in a
     phone-sized viewport, shifting the column further. Mobile scrolling
     is touch/wheel, so remove the scrollbar entirely on phones: the
     column is then exactly centered in every browser. */
  [data-phase] [class$="_scrollBody"] {
    scrollbar-gutter: auto !important;
    scrollbar-width: none !important;
  }
  [data-phase] [class$="_scrollBody"]::-webkit-scrollbar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
  }
  /* Message action rows (copy / run-time badges) can overflow the right
     edge on narrow screens — keep them inside the message width. */
  [data-phase] [class$="_actions"] {
    overflow: hidden !important;
  }
  [data-phase] [class$="_actions"] [class$="_timeEnd"] {
    flex: 0 1 auto !important;
    min-width: 0 !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }

  [data-phase] [class$="_scroll"]:has(p) {
    padding-left: 20px !important;
    padding-right: 20px !important;
    font-size: 15px !important;
  }
  /* The official markdown styles set an explicit 16px on paragraphs and
     list items, so the container's inherited 15px is not enough. User
     messages render their text in a div whose class carries _text_
     (16px too) — cover it as well. */
  [data-phase] [class$="_scroll"]:has(p) p,
  [data-phase] [class$="_scroll"]:has(p) li,
  [data-phase] [class$="_scroll"]:has(p) [class*="_text_"] {
    font-size: 15px !important;
  }

  /* Markdown tables: the official table uses width:max-content, so on a phone
     it hugs the content and leaves dead space beside/inside the table. Force
     the table to fill the message column and let the table wrapper handle
     overflow if a cell is genuinely too wide. */
  [data-phase] table {
    width: 100% !important;
    max-width: 100% !important;
  }
  [data-phase] th,
  [data-phase] td {
    max-width: none !important;
    min-width: 0 !important;
  }

  /* User bubbles: the official stack is capped at min(525px, 82%), which on a
     phone leaves a large blank strip on the left and pushes the bubble high.
     On mobile let the user message fill the same full width as assistant
     messages (the bubble background then spans the whole message column). */
  [data-phase] [class$="_userStack"],
  [data-phase] [class$="_userStack"] [class$="_bubble"] {
    box-sizing: border-box !important;
    width: fit-content !important;
    max-width: 100% !important;
  }

  /* --- Composer bottom row on mobile ---
     The official row gives the model pill (trailing) flex:0 0 auto, which
     squeezes the agent-permission pill (modes) down to 15px: the pill's
     chevron then overflows on top of the model name. Let the permission
     pill keep its natural width and let the model pill shrink instead.
     Anchored by the composer card (:has(textarea)): row = the _row class
     containing a _trailing group, tools = its first child, permission pill
     = its 2nd child, model pill = the _trailing group.
     NOTE: do NOT anchor these by the card's :last-child — a client effect
     moves the git-graph branch chip INTO the card, which becomes the card's
     new last child and silently disables every :last-child rule (the model
     pill then falls back to the official fixed layout and long model IDs
     overflow instead of ellipsizing). Structural anchors only. */
  /* The official row pads every group with 12px gaps, which on a phone eats
     width the model pill needs for the full model ID. Tighten the row to 8px
     gaps (the modes pill keeps its natural width) so the model name gets
     every spare pixel. */
  [data-phase] [class*="_card"]:has(textarea) [class$="_row"]:has([class$="_trailing"]) {
    gap: 8px !important;
  }
  [data-phase] [class*="_card"]:has(textarea) [class$="_row"]:has([class$="_trailing"]) > :first-child {
    gap: 8px !important;
  }
  [data-phase] [class*="_card"]:has(textarea) [class$="_row"]:has([class$="_trailing"]) > :first-child > :nth-child(2) {
    flex: 0 0 auto !important;
    gap: 8px !important;
  }
  [data-phase] [class*="_card"]:has(textarea) [class$="_trailing"] {
    flex: 1 1 auto !important;
    gap: 8px !important;
    min-width: 0 !important;
  }
  /* Let the model selector take the free space in the trailing group so the
     model name is not squeezed/truncated; the context meter stays fixed. */
  [data-phase] [class*="_card"]:has(textarea) [class$="_root"]:has(> [class$="_trigger"][aria-haspopup="menu"]) {
    flex: 1 1 auto !important;
    min-width: 0 !important;
  }
  [data-phase] [class*="_card"]:has(textarea) [class$="_root"]:has(> [class$="_trigger"][aria-haspopup="menu"]) > [class$="_trigger"] {
    width: 100% !important;
    max-width: 100% !important;
  }
  /* The model label must absorb the trigger's free width: officially it is a
     fixed-content flex item, so the spare width of a grown pill sits unused
     between the chevron and the pill edge. Let the label grow and shrink:
     the full model ID shows whenever the row can fit it, and the ellipsis
     lands exactly at the available width otherwise. */
  [data-phase] [class*="_card"]:has(textarea) [class$="_root"]:has(> [class$="_trigger"][aria-haspopup="menu"]) > [class$="_trigger"] > [class$="_triggerLabel"] {
    flex: 1 1 auto !important;
    min-width: 0 !important;
  }
  [data-phase] [class*="_card"]:has(textarea) [class$="_root"]:has(> [class$="_trigger"]:not([aria-haspopup="menu"])) {
    flex: 0 0 auto !important;
  }

  /* Model switcher menu: the official dropdown is right-aligned to the
     trigger (right:0). The model pill sits near the center of the composer,
     so on a phone the 240px menu overflows the left edge and looks off-center.
     Center the menu on the trigger instead. */
  [data-phase] [class*="_card"]:has(textarea) [class$="_root"]:has(> [class$="_trigger"]) > [class$="_menu"] {
    left: 50% !important;
    right: auto !important;
    transform: translateX(-50%) !important;
  }

  /* --- Session header on mobile ---
     Layout goal: [toggle] [session title] [mode badge] in a row, with the
     Session log capsule removed from the header (relocated to the drawer
     footer). Stable structural hooks only:
       [data-phase] header                     the session header element
       header > :first-child                   titleRow (titleCluster + utilities)
       header > :first-child > :last-child     headerUtilities (Session log seat) */
  [data-phase] header {
    padding-right: 12px !important;
  }
  /* Give the title row a lane clear of the absolutely-placed toggle, then
     balance the header: with header padding-right 12px, a 20px left
     padding puts the title's geometric center exactly on the viewport
     center (measured 195/195 at 390px). */
  [data-phase] header > :first-child {
    padding-left: 20px !important;
  }
  /* The directory toggle sits at the far left of the header (the header
     is position:relative; the data-slot wrappers are display:contents). */
  [data-mobile-nav="toggle"] {
    position: absolute !important;
    left: 8px !important;
    top: 12px !important;
    z-index: 2 !important;
  }
  /* The Files action stays in-flow inside headerActions. On mobile headerActions
     does not expand to fill the row: it is pushed to the right edge and keeps
     its content size, so [mode] [subagent/jobs] [files] sit close together
     with the normal 8px gaps — compact, no artificial blank columns. Explicit
     flex order keeps Files rightmost regardless of DOM order. */
  [data-mobile-nav="files"] {
    position: static !important;
    left: auto !important;
    right: auto !important;
    top: auto !important;
    z-index: auto !important;
  }
  [data-phase] header [class$="_headerActions"] {
    flex: 0 1 auto !important;
    min-width: 0 !important;
    margin-left: auto !important;
    justify-content: flex-end !important;
  }
  /* The session title/crumb must yield space on mobile so the mode label and
     subagent cluster are not squeezed to a single letter. Cap it at ~24vw and
     let it truncate with ellipsis. */
  [data-phase] header [class$="_crumbs"] {
    flex: 0 1 auto !important;
    min-width: 0 !important;
    max-width: 24vw !important;
  }
  /* Mode label (AgentPresetLabel): the official pill uses inline-flex, whose
     direct text node is only clipped — no ellipsis. Convert the pill to a
     block container, keep its icon absolutely positioned on the left, and let
     it size naturally up to 42vw so the mode name stays readable while the
     subagent/Files cluster still fits on a phone. */
  [data-phase] header [class$="_label"]:has(> svg) {
    order: 1 !important;
    flex: 0 1 auto !important;
    min-width: 0 !important;
    max-width: 42vw !important;
    display: block !important;
    position: relative !important;
    box-sizing: border-box !important;
    padding-left: 18px !important;
    padding-right: 2px !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }
  [data-phase] header [class$="_label"]:has(> svg) > svg {
    position: absolute !important;
    left: 0 !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
  }
  /* Subagent/jobs helpers: keep their triggers on one line and never let the
     row grow artificial empty space. */
  [data-phase] header [class$="_root"]:has(> button[class$="_trigger"]) {
    order: 2 !important;
    flex: 0 0 auto !important;
    min-width: max-content !important;
    max-width: none !important;
    white-space: nowrap !important;
    /* On mobile the popover is anchored to the header (viewport-width
       containing block) instead of the trigger, so a small left inset keeps it
       fully on screen and never clips the tree's status dots. */
    position: static !important;
  }
  [data-phase] header [class$="_root"]:has(> button[class$="_trigger"]) > button,
  [data-phase] header [class$="_root"]:has(> button[class$="_trigger"]) > button * {
    white-space: nowrap !important;
  }
  [data-phase] header [data-mobile-nav="files"] {
    order: 3 !important;
    flex: 0 0 auto !important;
  }
  /* Session log download: gone from the header row on mobile (the utilities
     seat holds only the session-log-export capsule). */
  [data-phase] header > :first-child > :last-child {
    display: none !important;
  }

  /* --- Header popovers on mobile (dsh-client-ui-jobs / dsh-client-ui-subagent) ---
     The official entries sit in the session header actions. Their popovers
     are anchored to the trigger's LEFT edge (left: 0), so from a right-edge
     trigger the 336px panel spills past the viewport. Re-anchor them to the
     trigger's right edge instead. The popover classes are hashed CSS-module
     names, so target them by the stable _menu suffix inside the header. */
  /* Header popovers on mobile: anchor to the left edge with a small inset and
     clamp the width, instead of right-aligning to a trigger near the right
     edge (which pushed the panel left off-screen and clipped the status dots).
     Also cap the height so the panel does not run into the composer/task bar. */
  [data-phase] header [class$="_menu"] {
    left: 8px !important;
    right: auto !important;
    width: min(336px, calc(100vw - 16px)) !important;
    max-width: none !important;
    max-height: min(420px, calc(100dvh - 120px)) !important;
  }
  /* --- Settings dialog on mobile ---
     Desktop: 800px two-column flex (188px nav + content). Mobile: a
     near-full-width sheet — nav tabs wrap into rows on top, option rows
     stay horizontal (title+description left, control right). Structural
     selectors are scoped to the unique aria-modal dialog; every
     settings-specific rule is gated with
     :has(> :first-child > :last-child > button) — the settings nav tab
     list holds <button> tabs, so the transient export dialog (the same
     primitives Modal, header(title+close)+description+body) keeps its
     official centered card layout. Requires :has() support
     (Chromium 105+, 2022).

     The directory picker (dsh-client-ui-directory-picker-browse) must be
     excluded too: its footer bar holds <button> children AND its breadcrumb
     trail (role="navigation") — which the role gate relies on to exclude
     it — is REPLACED by the path input in edit mode (pencil button), so
     without the ZuhsRW exclusion clicking the pencil would suddenly match
     this sheet rule: the dialog jumps to the top of the screen, the header
     (with the path input) is hidden by the > :first-child > :first-child
     display:none rule below, and the user can no longer type a path
     (issue #12, 2026-08-16). The picker family keeps the official layout
     on mobile in every mode. */
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) {
    position: absolute !important;
    left: 8px !important;
    /* Fixed top (no translateY): a transform on the panel combined with the
       panel overflowing the max-content drawer shifts the fixed overlay's
       coordinate frame, dragging the whole sidebar content off-screen. The
       safe-area inset keeps the sheet below the status bar / notch. */
    top: calc(var(--mnav-sat) + 12px) !important;
    width: calc(100vw - 16px) !important;
    max-width: calc(100vw - 16px) !important;
    /* Height follows the content (no dead space under a short page); it
       caps at 100dvh-24 (less the safe-area top) and the options area
       scrolls only then. */
    height: auto !important;
    max-height: min(800px, calc(100vh - 24px - var(--mnav-sat))) !important;
    max-height: min(800px, calc(100dvh - 24px - var(--mnav-sat))) !important;
    flex-direction: column !important;
    border-radius: 14px !important;
    animation: dsh-mobile-nav-sheet-in .22s var(--ds-ease-out, ease-in-out);
  }
  /* The settings sheet's dimmed mask fades in with the panel (the mask is
     the first child of the overlay that directly contains the sheet). */
  :has(> [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"]))) > :first-child {
    animation: dsh-mobile-nav-fade .18s var(--ds-ease-out, ease-in-out);
  }
  @media (prefers-reduced-motion: reduce) {
    [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])),
    :has(> [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"]))) > :first-child {
      animation: none !important;
    }
  }
  /* The export dialog (not the settings sheet) must never overflow the
     viewport: the official centered card can be wider than 390px.
     :not([data-mobile-nav="info-sheet"]) (S4, 2026-08-17): the session-info
     sheet also carries role="dialog" aria-modal="true" (correct a11y
     semantics for a bottom sheet with a scrim) and has no button as its
     first-child's last-child, so without this exclusion it silently matched
     this generic selector too — measured 358px (100vw-32px) instead of the
     374px its own left:8px/right:8px margins specify. Same category of bug
     as the ZuhsRW directory-picker collision below; same fix shape. */
  [aria-modal="true"]:not(:has(> :first-child > :last-child > button)):not([data-mobile-nav="info-sheet"]) {
    max-width: calc(100vw - 32px) !important;
  }
  /* Nav bar: hide the "Settings" caption (redundant on a full-width sheet)
     and wrap the tab list so every tab is visible — a horizontal scroll cut
     the last tab ("Plugins") off with no affordance to scroll. */
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) > :first-child {
    width: 100% !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 6px !important;
    padding: 10px 12px 8px !important;
  }
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) > :first-child > :first-child {
    display: none !important;
  }
  /* The tab list scrolls in the space left by the toolbar: the toolbar
     (config file + close) is reparented INTO this nav row by a client
     effect (MobileNavOverlay), so the tab list must be anchored by its
     class, NOT by :last-child (the reparented toolbar becomes the nav's
     new last child). */
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) > :first-child [class$="_navList"] {
    flex: 1 1 auto !important;
    min-width: 0 !important;
    flex-direction: row !important;
    flex-wrap: wrap !important;
    gap: 6px !important;
    overflow: visible !important;
  }
  /* Content toolbar (Open configuration file + close): grouped flush to
     the right edge, and reparented INTO the nav row on mobile so it shares
     one line with the tabs (user feedback 2026-08-16 — the toolbar's own
     row left a full-width dead gap under the tabs). Anchored by class: the
     header leaves the content subtree, so :first-child/:last-child anchors
     would now hit the options area. Children carry official auto-margins
     that would defeat flex-end, so neutralize them. The close button gets
     a round tappable base so it reads as its own control, not part of the
     outline button. */
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) [class$="_header"] {
    flex: 0 0 auto !important;
    justify-content: flex-end !important;
    align-items: center !important;
    gap: 8px !important;
    padding: 0 0 0 4px !important;
    min-height: 40px !important;
  }
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) [class$="_header"] > * {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) [class$="_header"] > :last-child {
    width: 32px !important;
    height: 32px !important;
    border-radius: 50% !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06)) !important;
  }
  /* Appearance mode cards: the official cube row renders three tall
     vertical cards (~268px) that eat half the sheet. Turn them into a
     compact horizontal trio (icon + label inline, equal widths).
     Relies on the official cube-row class name of this version. */
  [aria-modal="true"] [class$="_cubeRow"] {
    gap: 6px !important;
  }
  [aria-modal="true"] [class$="_cubeRow"] > * {
    flex: 1 1 0 !important;
    flex-direction: row !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 6px !important;
    padding: 10px 8px !important;
    min-height: 0 !important;
  }
  /* Content: the options scroll area gets bottom breathing room so the last
     row never sits flush against the sheet's rounded corner. */
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) > :last-child {
    flex: 1 1 auto !important;
    min-height: 0 !important;
  }
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) > :last-child > :last-child {
    padding: 0 12px 24px !important;
  }
`;
};
__modules["styles/compat.css.js"] = function (require, module, exports) {
"use strict";
// compat — split from src/client/mobile.css.ts (2026-08-16), order preserved.
// Do not reorder: styles/index.ts concatenates in this exact order.
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMPAT_CSS = void 0;
exports.COMPAT_CSS = `  /* ---------- dsh-web-ui family compatibility ----------
     The linxin666 plugin suite extends the shell frame directly:
       - aionui-panel appends two trailing grid columns (explorer / preview)
         plus absolute drag handles to [data-dsh-frame]; its 5-track inline
         grid is already overridden above, but the handles and columns would
         still float over the main UI. On mobile the columns leave the grid
         as floating bottom sheets and keep their own visibility state —
         the suite's collapse chevron / preview tabs still work, so no
         feature is lost. The task-board / ssh plugins inject sidebar
         entries and center-column takeover panels; the entries need
         spacing and the kanban needs scrollable columns. */

  /* Touch devices: the drag handles are useless — the floating expand
     button is the opener. */
  .aionui-explorer-handle,
  .aionui-preview-handle {
    display: none !important;
  }

  /* Shared base: both columns leave the grid as floating panels. The
     explorer is gated shut by default (its own persisted expanded state
     must never cover the mobile UI on load); the header Files action opens
     it via the frame marker below, and the sheet's own collapse chevron
     clears it. Preview stays owned by the suite (hidden while no tab is
     open). The per-column rules below override the geometry. */
  [data-aionui-explorer-col],
  [data-aionui-preview-col] {
    position: fixed !important;
    z-index: 55 !important;
    background: var(--aion-bg-base, #ffffff) !important;
    border-left: none !important;
  }
  /* Explorer (file tree) bottom sheet: bottom edge aligned exactly with
     the composer card's bottom line — the card sits 36px above the
     viewport bottom (8px composer padding + the 28px stats strip below
     the card), so the sheet uses the same 36px bottom offset. */
  [data-aionui-explorer-col] {
    visibility: hidden !important;
    left: 8px !important;
    right: 8px !important;
    top: auto !important;
    bottom: 36px !important;
    width: auto !important;
    height: min(55dvh, 460px) !important;
    max-height: calc(100dvh - 44px) !important;
    border-radius: 14px !important;
    overflow: hidden !important;
    box-shadow: 0 -4px 28px rgba(0, 0, 0, .18) !important;
    animation: dsh-mobile-nav-sheet-up .24s var(--ds-ease-out, ease-in-out) !important;
  }
  /* Preview (file content) bottom sheet. Gated shut by default: the suite
     persists open preview tabs in localStorage and restores them on load,
     which would pop the sheet over the fresh UI. The client only sets the
     frame marker after the user taps a file row in the explorer; the
     suite's own collapse chevron clears it via the visibility watcher. */
  [data-aionui-preview-col] {
    visibility: hidden !important;
    position: fixed !important;
    left: 8px !important;
    right: 8px !important;
    top: auto !important;
    bottom: 40px !important;
    width: auto !important;
    height: min(50dvh, 420px) !important;
    max-height: calc(100dvh - 48px) !important;
    border-radius: 14px !important;
    overflow: hidden !important;
    box-shadow: 0 -4px 28px rgba(0, 0, 0, .18) !important;
    z-index: 56 !important;
    animation: dsh-mobile-nav-sheet-up .24s var(--ds-ease-out, ease-in-out) !important;
    /* Fullscreen toggle (issue #8): animate the geometry change instead of
       snapping. visibility is deliberately not listed, so opening/closing
       the sheet stays instant; the open/close keyframes own transform. */
    transition:
      left .24s var(--ds-ease-out, ease-in-out),
      right .24s var(--ds-ease-out, ease-in-out),
      top .24s var(--ds-ease-out, ease-in-out),
      bottom .24s var(--ds-ease-out, ease-in-out),
      width .24s var(--ds-ease-out, ease-in-out),
      height .24s var(--ds-ease-out, ease-in-out),
      border-radius .24s var(--ds-ease-out, ease-in-out),
      box-shadow .24s var(--ds-ease-out, ease-in-out),
      padding-top .24s var(--ds-ease-out, ease-in-out) !important;
  }
  /* User-opened preview sheet (frame marker, set on file-row tap). */
  [data-mobile-nav="frame"][data-aionui-preview-open] [data-aionui-preview-col] {
    visibility: visible !important;
  }
  /* The Files action opens the explorer sheet (frame marker). */
  [data-mobile-nav="frame"][data-aionui-explorer-open] [data-aionui-explorer-col] {
    visibility: visible !important;
  }
  /* While the preview sheet is up, the explorer sheet yields (two stacked
     bottom sheets would read as one broken overlay). Closing the preview
     via its collapse chevron / tab close clears the marker, and the
     explorer sheet returns. Same specificity as the explorer-open rule, so
     this must stay AFTER it. */
  [data-mobile-nav="frame"][data-aionui-preview-open] [data-aionui-explorer-col] {
    visibility: hidden !important;
  }
  /* The open drawer must never sit under a sheet: while the frame is in the
     narrow-expanded state both sheets yield (later in the file than the
     open marker rule, so it wins at equal specificity). The fullscreen
     toggle has its own drawer-open rule at the end of its section. */
  [data-mobile-nav="frame"]:not([data-sidebar-collapsed]) [data-aionui-explorer-col],
  [data-mobile-nav="frame"]:not([data-sidebar-collapsed]) [data-aionui-preview-col] {
    visibility: hidden !important;
    display: none !important;
  }
  /* The suite's own expand button reads the store state we bypass on
     mobile — hide it; the header Files action is the opener. */
  .aionui-floating-expand {
    display: none !important;
  }

  /* Preview sheet fullscreen toggle (issue #8): a fixed button parked in the
     sheet's titlebar row, just left of the suite's collapse chevron (24px at
     right:8px of the sheet, and the sheet spans 8px..(100vw-8px)). The top
     calc mirrors the sheet geometry above (bottom 40px + min(50dvh, 420px));
     when the frame carries "data-mobile-preview-full" the sheet goes
     fullscreen and the button moves to the viewport corner. */
  [data-mobile-nav="preview-full-toggle"] {
    position: absolute !important;
    right: 36px !important;
    top: 8px !important;
    z-index: 57 !important;
    display: none !important;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--aion-text-secondary, var(--dsw-alias-label-secondary, inherit));
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    /* Native look: same size/radius/hover language as the suite's tab-bar
       icon buttons (the 20px panelCollapse next to it). The button lives
       INSIDE the preview column, so it rides the sheet's own open
       animation and geometry transition — no curve matching needed. */
    transition: background-color .15s, top .24s var(--ds-ease-out, ease-in-out);
  }
  [data-mobile-nav="preview-full-toggle"]:hover {
    background: var(--aion-bg-3, rgba(0, 0, 0, .22));
  }
  [data-mobile-nav="preview-full-toggle"]:active {
    background: var(--aion-bg-active, rgba(0, 0, 0, .28));
  }
  [data-mobile-nav="preview-full-toggle"]:focus-visible {
    outline: 2px solid var(--dsw-alias-state-business-primary, #4f6ef7);
    outline-offset: 2px;
  }
  [data-mobile-nav="preview-full-toggle"] svg {
    width: 14px;
    height: 14px;
  }
  /* Keep the last tab (and the "+" URL-tab trigger) from sliding under the
     fullscreen toggle: reserve the right end of the preview tab row. */
  [data-aionui-preview-col] [class$="_tabScroll"] {
    padding-right: 34px !important;
  }
  /* Visible only while the preview sheet is open. Visibility itself is
     inherited from the column, so the sheet's own hide rules (collapse,
     drawer open) cover the button too. */
  [data-mobile-nav="frame"][data-aionui-preview-open] [data-aionui-preview-col] [data-mobile-nav="preview-full-toggle"] {
    display: inline-flex !important;
  }
  /* Icon swap on the frame fullscreen marker. */
  [data-mobile-nav="preview-full-toggle"] .dsh-mobile-nav-full-out {
    display: none !important;
  }
  [data-mobile-nav="frame"][data-mobile-preview-full] [data-aionui-preview-col] [data-mobile-nav="preview-full-toggle"] .dsh-mobile-nav-full-in {
    display: none !important;
  }
  [data-mobile-nav="frame"][data-mobile-preview-full] [data-aionui-preview-col] [data-mobile-nav="preview-full-toggle"] .dsh-mobile-nav-full-out {
    display: inline !important;
  }
  /* Fullscreen preview: the sheet fills the whole viewport (notch included);
     the safe-area padding drops the titlebar row below the status bar, and
     the toggle follows the titlebar into the top corner. */
  [data-mobile-nav="frame"][data-aionui-preview-open][data-mobile-preview-full] [data-aionui-preview-col] {
    inset: 0 !important;
    left: 0 !important;
    right: 0 !important;
    top: 0 !important;
    bottom: 0 !important;
    width: 100% !important;
    height: 100dvh !important;
    max-height: none !important;
    box-sizing: border-box !important;
    padding-top: var(--mnav-sat) !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    z-index: 57 !important;
    animation: none !important;
  }
  /* Fullscreen: the column fills the viewport, so the button follows the
     titlebar row down below the notch. */
  [data-mobile-nav="frame"][data-mobile-preview-full] [data-aionui-preview-col] [data-mobile-nav="preview-full-toggle"] {
    top: calc(var(--mnav-sat) + 8px) !important;
  }
  @media (prefers-reduced-motion: reduce) {
    [data-aionui-preview-col],
    [data-mobile-nav="preview-full-toggle"] {
      transition: none !important;
      animation: none !important;
    }
  }

  /* dsh-web-ui sidebar entries (task board / ssh) sit flush against each
     other — give the injected rows breathing room. */
  button[data-dsh-taskboard-entry],
  button[data-dsh-ssh-entry] {
    margin-bottom: 8px !important;
  }

  /* Task board: five kanban columns at minmax(0,1fr) crush into ~78px phone
     strips. Give every column a usable minimum and let the row scroll. */
  [data-dsh-taskboard-board] > [class$="_columns"] {
    grid-template-columns: repeat(5, minmax(240px, 1fr)) !important;
    overflow-x: auto !important;
  }
  /* The floating button must not float over a takeover panel (task board /
     ssh own the center column while active). */
  html[data-dsh-taskboard-active] [data-mobile-nav="fab"],
  html[data-dsh-ssh-active] [data-mobile-nav="fab"],
  html[data-dsh-taskboard-active] [data-mobile-nav="backdrop"],
  html[data-dsh-ssh-active] [data-mobile-nav="backdrop"] {
    display: none !important;
  }
  /* Board header: let the search field take the slack instead of squeezing
     the action buttons. */
  [data-dsh-taskboard-board] > [class$="_boardHeader"] [class$="_search"] {
    flex: 1 1 auto !important;
    min-width: 80px !important;
  }

  /* ---------- dsh-web-ui polish: plugin market search ----------
     The market tab row (Discover / Themes / Installed + the plugin search
     box) is a no-wrap flex: at 390px the tabs plus the ~218px search box
     (~475px total) overflow the ~334px sheet and the search box runs off
     the right edge of the screen (it also forces a horizontal scrollbar on
     the sheet's options area). Let the row wrap: the tabs keep the first
     line and the search box gets its own full-width second line. */

  [aria-modal="true"] [class$="_tabs"] {
    flex-wrap: wrap !important;
    row-gap: 8px !important;
  }
  [aria-modal="true"] [class$="_searchInline"] {
    flex: 1 1 100% !important;
    width: 100% !important;
    max-width: 100% !important;
  }

  /* ---------- dsh-usage-stats polish: usage & balance panel ----------
     The panel's stats row shows three token counters side by side
     (today / month / total). The counters use tabular nowrap figures whose
     min-content width overflows the ~336px panel body on a phone: figures
     clip at the row's edges and the panel grows a horizontal scrollbar.
     Stack the three counters vertically — full-width rows, so the figures
     always fit. */

  [class*="usg_"][class$="_statsRow"] {
    flex-direction: column !important;
  }
  [class*="usg_"][class$="_stat"] {
    flex: 0 0 auto !important;
    width: 100% !important;
    min-width: 0 !important;
  }

  /* ---------- dsh-web-ui polish: settings sheet ----------
     The official dialog is a desktop two-column form; on a phone the
     label/control split leaves a huge dead gap and long descriptions wrap
     into tall stacks. Stack each row (text above, control full-width) and
     keep the nav tabs on ONE horizontally scrolling row. */

  /* Nav tabs: single scrolling row instead of the 3-per-row grid — seven
     categories wrap into three rows on a phone (~130px of sheet height);
     one row with a thin scrollbar keeps every tab reachable and returns
     that space to the options area (user feedback 2026-08-16). An earlier
     one-row attempt had no scroll affordance and silently cut the last
     tab off; the thin scrollbar IS the affordance. Scoped to the frame
     marker: the desktop dialog keeps its official vertical nav column. */
  [data-mobile-nav="frame"] [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) > :first-child [class$="_navList"] {
    display: flex !important;
    flex-wrap: nowrap !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    gap: 6px !important;
    width: 100% !important;
    scrollbar-width: thin !important;
    -webkit-overflow-scrolling: touch !important;
  }
  /* Hairline scrollbar for the tab row: the default WebKit scrollbar reads
     fat on a phone; 2px keeps the scroll affordance without the bulk. */
  [data-mobile-nav="frame"] [aria-modal="true"] [class$="_navList"]::-webkit-scrollbar {
    height: 2px !important;
  }
  [data-mobile-nav="frame"] [aria-modal="true"] [class$="_navList"]::-webkit-scrollbar-thumb {
    background: var(--dsw-alias-border-l2, rgba(0, 0, 0, .22)) !important;
    border-radius: 1px !important;
  }
  [data-mobile-nav="frame"] [aria-modal="true"] [class$="_navList"]::-webkit-scrollbar-track {
    background: transparent !important;
  }
  [data-mobile-nav="frame"] [aria-modal="true"] [class$="_navCell"] {
    flex: 0 0 auto !important;
    white-space: nowrap !important;
    padding: 6px 8px !important;
    gap: 6px !important;
    font-size: 13px !important;
    justify-content: flex-start !important;
  }
  [data-mobile-nav="frame"] [aria-modal="true"] [class$="_navCell"] svg {
    width: 14px !important;
    height: 14px !important;
    flex: none !important;
  }
  /* Content toolbar: the "Open configuration file" button is hidden on
     mobile — it is rarely needed on a phone and steals ~180px from the
     tab row's scroll area (user feedback 2026-08-16). Only the close ✕
     stays, flush right in the nav row. Desktop untouched (frame scoped). */
  [data-mobile-nav="frame"] [aria-modal="true"] [class$="_header"] [class$="_actions"] {
    display: none !important;
  }
  [data-mobile-nav="frame"] [aria-modal="true"] [class$="_header"] [class$="_actions"] [class$="_action"] {
    font-size: 13px !important;
    padding: 6px 12px !important;
    min-height: 0 !important;
  }
  /* Setting rows: text on top, control below at full width. */
  [aria-modal="true"] [class$="_section"] [class$="_row"] {
    flex-direction: column !important;
    align-items: stretch !important;
    gap: 8px !important;
  }
  [aria-modal="true"] [class$="_section"] [class$="_row"] > :first-child {
    width: 100% !important;
    max-width: none !important;
  }
  [aria-modal="true"] [class$="_section"] [class$="_row"] > :last-child {
    width: 100% !important;
    max-width: none !important;
  }
  /* Appearance mode group: give the cube row a consistent bordered
     segmented look (the official borders differ per state). */
  [aria-modal="true"] [class$="_cubeRow"] > * {
    border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12)) !important;
  }

  /* ---------- dsh-web-ui polish: explorer sheet ----------
     The aionui explorer was designed for a desktop side column: compact the
     header, search box and tree rows so a phone shows more entries, and pad
     the scroll bottom so the last row never sits flush on the edge. */

  [data-aionui-explorer-col] [class$="_tabBar"] {
    height: 36px !important;
  }
  [data-aionui-explorer-col] [class$="_tabBtn"],
  [data-aionui-explorer-col] [class$="_tabBtnActive"] {
    padding: 0 12px !important;
    font-size: 13px !important;
  }
  [data-aionui-explorer-col] [class$="_searchBox"] {
    height: 32px !important;
    font-size: 13px !important;
  }
  [data-aionui-explorer-col] [class*="_treeRow"] {
    height: 30px !important;
    font-size: 13px !important;
  }
  [data-aionui-explorer-col] [class*="_treeRow"] svg {
    width: 14px !important;
    height: 14px !important;
  }
  [data-aionui-explorer-col] [class$="_scrollArea"] {
    padding-bottom: 28px !important;
  }

  /* ---------- dsh-web-ui polish: drawer footer ----------
     The injected footer actions (Files + Session log) become two equal pill
     buttons instead of text-width capsules. */

  /* The official footerActions row also hosts the remote-web-ui entry
     row (two icon buttons); without wrapping the two groups squeeze each
     other on one line. Wrap so each group gets its own full-width row. */
  [data-mobile-nav="frame"] [class$="_footerActions"] {
    flex-wrap: wrap !important;
    gap: 6px !important;
  }
  [data-mobile-nav="drawer-actions"] {
    width: 100% !important;
  }
  [data-mobile-nav="drawer-actions"] > button {
    flex: 1 1 0 !important;
    padding: 0 8px !important;
    white-space: nowrap !important;
  }

  /* ---------- dsh-web-ui polish: floating pet ----------
     The whale-girl pet (dsh-pet) floats at the viewport corner with a
     persisted, draggable position. On phones the pet is scaled down so
     it does not dominate the screen; the plugin's own drag + persist
     still work (the position itself is left alone — the mobile default
     position is seeded via the pet API to just above the composer). */

  body > [class$="_float"]:has([class$="_sprite"][role="button"]) {
    transform: scale(.66);
    transform-origin: bottom right;
  }
  /* While a modal dialog (settings sheet / export) owns the screen the pet
     floats ABOVE it and covers the dialog content; modal semantics say the
     background is inert, so hide the pet for the modal's lifetime. */
  body:has([aria-modal="true"]) > [class$="_float"]:has([class$="_sprite"][role="button"]) {
    display: none !important;
  }

  /* ---------- conversation stats line ----------
     The official session-status row (turns / steps / LLM time / TTFT /
     cache) is long. It is the single entry the official StatsLine puts in
     conversation.composer.dock, so the structural anchor below reaches it
     without any DOM marking (S3 deleted the text-matching effect that used
     to set [data-slot="conversation.composer.dock"] > [class$="_root"]). Layout: ONE fixed-height (28px) flex
     strip that scrolls horizontally — the full metrics stream stays
     reachable by swiping, the row never grows vertically, no ellipsis or
     fade, 12px gaps between metric groups, a 2px scrollbar as the swipe
     affordance. The phone breakpoint hides the strip outright instead
     (styles/composer.css.ts — its data moves into the session info card). */

  [data-slot="conversation.composer.dock"] > [class$="_root"] {
    display: flex !important;
    flex-flow: row nowrap !important;
    align-items: center !important;
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    height: 28px !important;
    min-height: 28px !important;
    max-height: 28px !important;
    box-sizing: border-box !important;
    white-space: nowrap !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    scrollbar-width: thin !important;
    scrollbar-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, .28)) transparent !important;
    padding: 0 0 4px !important;
    line-height: 20px !important;
    font-size: 12px !important;
  }
  [data-slot="conversation.composer.dock"] > [class$="_root"]::-webkit-scrollbar {
    height: 2px !important;
  }
  [data-slot="conversation.composer.dock"] > [class$="_root"]::-webkit-scrollbar-thumb {
    background: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, .3)) !important;
    border-radius: 2px !important;
  }
  [data-slot="conversation.composer.dock"] > [class$="_root"]::-webkit-scrollbar-track {
    background: transparent !important;
  }
  [data-slot="conversation.composer.dock"] > [class$="_root"] > * {
    display: flex !important;
    flex: 0 0 auto !important;
    flex-flow: row nowrap !important;
    align-items: center !important;
    width: max-content !important;
    min-width: max-content !important;
    max-width: none !important;
    white-space: nowrap !important;
    margin-right: 12px !important;
    padding: 0 !important;
  }
  [data-slot="conversation.composer.dock"] > [class$="_root"] > *:last-child {
    margin-right: 0 !important;
  }
  [data-slot="conversation.composer.dock"] > [class$="_root"] * {
    white-space: nowrap !important;
  }

  /* ---------- dsh-genui panel dock ----------
     The genui panel docks above the composer (conversation.input.dock,
     id genui-panel). On a phone its business-blue outline, generous chrome
     and single-line ellipsis read as an unfinished artifact: long titles
     truncate mid-word ("…default b···") with the chevron glued to the
     ellipsis, and the pill crowds the composer. Mobile treatment: neutral
     card border matching the composer, tighter chrome so the full title
     fits, chevron with breathing room. Scoped to the mobile frame marker —
     desktop keeps genui's own styling untouched. */

  [data-mobile-nav="frame"] [data-genui-panel] {
    margin: 6px 12px 4px !important;
    border-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, .12)) !important;
    border-radius: 12px !important;
  }
  [data-mobile-nav="frame"] [data-genui-panel] [class*="_panelToggle"] {
    padding: 7px 12px !important;
    gap: 8px !important;
  }
  [data-mobile-nav="frame"] [data-genui-panel] [class*="_panelBadge"] {
    padding: 0 7px !important;
    border-radius: 5px !important;
    font-size: 10.5px !important;
    line-height: 1.7 !important;
  }
  [data-mobile-nav="frame"] [data-genui-panel] [class*="_panelTitle"] {
    flex: 1 1 auto !important;
    min-width: 0 !important;
    font-size: 12.5px !important;
    line-height: 1.45 !important;
  }
  [data-mobile-nav="frame"] [data-genui-panel] [class*="_panelChevron"] {
    flex: none !important;
    margin-left: 0 !important;
    padding-left: 4px !important;
  }

  /* ---------- git-graph branch chip: inside the composer card ----------
     The branch chip (conversation.input.dock) floats between the dock rows
     and the input card; on a phone it reads as a stray capsule crowding the
     composer. A client effect (MobileNavOverlay) reparents the chip INTO
     the composer card; these rules pin it to the card's top-left and give
     the card a dedicated chip row. The card is position: relative by the
     official stylesheet, so the absolute anchor resolves against it. The
     plugin's own sheet sets all four offsets on the anchor, so right/bottom
     must be neutralized too. Scope is the frame marker + the anchor
     attribute (NOT the dock slot — the reparenting moves the chip out of
     the dock's subtree). Desktop untouched: the frame marker only exists
     below 1024px, and the effect restores the chip to the dock when the
     viewport widens. Chip row geometry (2026-08-16, user feedback): 48px
     padding left a 16px dead gap between the chip and the input line and
     made the composer read too tall; the row is now 40px = chip (24px) at
     top 12px + ~4px to the textarea — the chip sits slightly lower and
     the gap is compressed without touching the official height budget
     further. */

  [data-mobile-nav="frame"] [data-gitgraph-chip-anchor] {
    position: absolute !important;
    top: 12px !important;
    left: 12px !important;
    right: auto !important;
    bottom: auto !important;
    z-index: 1 !important;
  }
  [data-mobile-nav="frame"] [class$="_card"]:has([data-gitgraph-chip-anchor]) {
    padding-top: 40px !important;
  }

  /* ---------- dsh-better-sidebar: safe area (S2.1, 2026-08-17) ----------
     THIRD-PARTY COMPAT RULE — dsh-better-sidebar (the workbench the session
     header's panel button opens). Its shell is viewport-fixed and starts at
     y=0: the panel at inset 0 (100vw drawer below 768px, a right column
     above it) and the toggle cluster at top:3px. Neither knows about
     env(safe-area-inset-*), so on a notched iPhone the whole tab strip —
     including the one button that CLOSES the panel — sits behind the status
     bar and cannot be tapped: the user opened the workbench and was stuck
     there (real-device report, 2026-08-17).
     Applied across the plugin's whole mobile band, not just <768px: the
     panel is fixed at top:0 in the 768-1023px range too, so the same notch
     covers the same tab strip. Zero effect wherever the inset is 0 (every
     desktop browser, every non-notched device) — desktop is >=1024px and
     out of this media block entirely.
     Anchors: the plugin's own mount marker [data-dsh-better-sidebar]
     (index.tsx) plus class-suffix selectors, per this repo's hashed-class
     convention. --dsh-title-bar-strip is the plugin's own title-bar-compat
     offset (set only while that mode is on, 0px fallback otherwise): adding
     to it keeps both offsets rather than clobbering theirs.
     !important because their :global(body[...]) rules outrank a plain
     attribute selector.
     No box-sizing here on purpose: the panel is position:fixed with BOTH
     top and bottom set, so its used height already resolves to
     "containing block - insets - padding - border" (CSS 2.1 10.6.4) and the
     padding shrinks the content box without any help. Forcing border-box
     also folds their 1px left border into the inline width — measured as a
     1px panel-width change at 768px, i.e. a regression outside this
     hotfix's remit. */
  [data-dsh-better-sidebar] [class$="_panel"],
  [data-dsh-better-sidebar] [class$="_panelHidden"] {
    padding-top: calc(var(--mnav-sat) + var(--dsh-title-bar-strip, 0px)) !important;
  }
  /* Only the tablet/desktop range still shows the cluster (see the hide
     rule below) — the notch offset is now dead weight below 768px, so it
     is scoped out rather than left applying invisibly. min-width:768px
     rather than the more common max-width pairing: this offset was
     already a harmless no-op at >=1024px before S3.1 (--mnav-sat is 0 on
     every desktop browser), so narrowing its floor to 768px changes
     nothing there either — it only stops evaluating on phone. */
  @media (min-width: 768px) {
    [data-dsh-better-sidebar] [class$="_toggleCluster"] {
      top: calc(var(--mnav-sat) + var(--dsh-title-bar-strip, 0px) + 3px) !important;
    }
  }

  /* ---------- dsh-better-sidebar: hide the phone toggle cluster (S3.1, 2026-08-17) ----------
     Real-device round 2 feedback: this fixed top-right cluster duplicates
     — and visually overlaps — the session header's own workbench button
     (MobileSessionHeader.tsx), which already opens/closes the same panel
     by clicking this cluster's toggle button through. Hidden below 768px
     only; the 768-1023px tablet range has no workbench button (header.css.ts
     scopes that entire reflow to <768px) and still depends on this cluster
     as its only entry point, so it stays exactly as v1.0.0/S2.1 shipped it
     there. The cluster also holds the panel's own close affordance — see
     [data-mobile-nav="better-sidebar-close"] below for the phone
     replacement, wired up in MobileSessionHeader.tsx. */
  @media (max-width: 767px) {
    [data-dsh-better-sidebar] [class$="_toggleCluster"] {
      display: none !important;
    }
  }

  /* ---------- dsh-better-sidebar: phone close button (S3.1 follow-up, 2026-08-17) ----------
     Appended to document.body by MobileSessionHeader.tsx's
     MobileHeaderUtilities effect — never inside the panel's own subtree
     (the third party's React re-renders would wipe it) and never under any
     transformed/backdrop-filter ancestor (the S4 info-card WebKit lesson in
     AGENTS.md: position:fixed re-anchors to the nearest such ancestor
     instead of the viewport). Default hidden — belt-and-braces, same
     reasoning as header.css.ts's [data-mobile-nav="header-info"] etc list:
     React does not know about media queries. Shown only below 768px AND
     only while the panel is actually open: the panel's own class name ends
     in "_panel" exclusively in the open state (the "_panelHidden" suffix is
     appended once closed, so the string no longer ends in "_panel") — a
     pure-CSS :has() open/closed read, no MutationObserver required.

     Bottom-center pill, not a top-right circle (real-device follow-up,
     2026-08-17): a top-right position collided with the panel's own
     per-tab toolbar controls — measured live at 390px with the explorer
     tab open, the panel's Refresh button sits at x:354-382 y:93-121, and a
     44px circle at top:8px+safe-area/right:8px lands at x:338-382
     y:(safe-area+8)-(safe-area+52), a direct overlap once the safe-area
     offset is small (or zero on non-notched phones). Every per-tab toolbar
     (explorer/git/tabBar) lives at the panel's TOP; nothing in the
     default explorer or git tabs reaches the bottom 90px of the viewport
     (checked live, both tabs, 2026-08-17), so bottom-center is clear
     regardless of which tab is open — one fixed position that does not
     need per-tab-type coordinates to dodge. */
  [data-mobile-nav="better-sidebar-close"] {
    display: none;
  }
  @media (max-width: 767px) {
    body:has([data-dsh-better-sidebar] [class$="_panel"]) [data-mobile-nav="better-sidebar-close"] {
      display: flex !important;
      position: fixed;
      left: 50%;
      bottom: calc(var(--mnav-sab) + 12px);
      transform: translateX(-50%);
      z-index: 70;
      align-items: center;
      gap: 6px;
      height: 44px;
      padding: 0 18px;
      border: none;
      border-radius: 999px;
      background: var(--dsw-alias-bg-base, #fff);
      box-shadow: 0 4px 16px rgba(0, 0, 0, .2);
      color: var(--dsw-alias-label-primary, inherit);
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    body:has([data-dsh-better-sidebar] [class$="_panel"]) [data-mobile-nav="better-sidebar-close"] svg {
      width: 14px;
      height: 14px;
      flex: none;
    }
    body:has([data-dsh-better-sidebar] [class$="_panel"]) [data-mobile-nav="better-sidebar-close"]:active {
      background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    }
  }
`;
};
__modules["styles/misc.css.js"] = function (require, module, exports) {
"use strict";
// misc — split from src/client/mobile.css.ts (2026-08-16), order preserved.
// Do not reorder: styles/index.ts concatenates in this exact order.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MISC_CSS = void 0;
exports.MISC_CSS = `  /* ---------- hero composer on mobile ----------
     The official hero card carries a 2-line textarea plus a tall tool row,
     which reads oversized on a phone. Tighten the empty-state rhythm: keep
     the official centered hero, shrink the textarea line box, slim the card
     padding and the tool row, and close the gap under the headline. */

  [data-phase="hero"] [class$="_card"]:has(textarea) {
    padding-top: 6px !important;
    gap: 8px !important;
  }
  /* The official composer autosizes the textarea and writes an inline
     height (2 lines on the hero empty state) on the textarea's scroll/grow
     wrappers. :placeholder-shown lets us collapse the EMPTY state to one
     line with !important; as soon as the user types, the pseudo-class no
     longer matches and the autosizer's inline height takes over again — so
     multi-line growth keeps working. */
  [data-phase="hero"] textarea:placeholder-shown {
    height: 28px !important;
  }
  [data-phase="hero"] [class$="_card"]:has(textarea:placeholder-shown) > [class$="_scroll"],
  [data-phase="hero"] [class$="_card"]:has(textarea:placeholder-shown) [class$="_grow"] {
    height: 28px !important;
  }
  [data-phase="hero"] [class$="_card"]:has(textarea) > [class$="_row"] {
    padding-top: 2px !important;
  }
  [data-phase="hero"] [class$="_headline"] {
    line-height: 1.15 !important;
    margin-bottom: 0 !important;
  }
  [data-phase="hero"] [class$="_stack"] {
    gap: 0 !important;
  }

  /* ---------- composer dock: swap git branch chip with the todo card ----------
     The git-graph branch chip (conversation.input.dock, order 100) floats
     alone at the bottom-left above the input card, with a dead zone to its
     right; the full-width todo card (order 0) sits above it. Swap them so
     the chip reads as the stack's top row and the todo card fills the row
     above the composer. The dock container itself is display:contents
     (inline style) — its children are direct flex items of the composer
     stack, so order on the children is what reorders them. Only the chip
     needs an order change: -1 puts it before the todo card (order 0) and
     before the input card (order 0, later in DOM). The todo card must KEEP
     its order 0 — raising it past the input card's order 0 would drop it
     below the composer entirely (2026-08-16 regression, fixed). The queue
     strip (order 20) keeps hugging the input card. Desktop untouched (this
     block lives inside the max-width: 1023px media query). */
  [data-slot="conversation.input.dock"] [data-gitgraph-chip-anchor] {
    order: -1 !important;
  }
  /* Mobile tap target + feedback for the branch chip (git-graph, 24px
     desktop spec). Two real-world problems: ① the chip is tiny and sits
     right above the expandable todo card — mis-taps land on the todo card;
     ② opening the popover waits for the host's /git/branches round-trip
     (~700ms on device) with zero feedback, so users tap again and toggle
     the popover closed. Enlarge the target, kill double-tap zoom delay,
     and give an instant pressed state so a tap reads as registered. */
  [data-slot="conversation.input.dock"] [data-gitgraph-chip-anchor] [data-gitgraph-chip] {
    touch-action: manipulation !important;
    min-height: 34px !important;
    padding: 0 12px !important;
    font-size: 13px !important;
  }
  [data-slot="conversation.input.dock"] [data-gitgraph-chip-anchor] [data-gitgraph-chip]:active {
    transform: scale(.96) !important;
    transition: transform .12s !important;
  }
}

/* ---------- tablet / wide mobile: keep sheets from becoming full-width ----------
   Below 768px the near-full-width sheets are the right call for a phone.
   On wider but still sub-desktop viewports (foldables, tablet portrait,
   desktop-mode tall windows) the same full-bleed sheet leaves content
   clustered at the left edge with a large dead zone on the right. Cap and
   center the modal sheets and the aionui bottom sheets instead. */
@media (min-width: 768px) and (max-width: 1023px) {
  /* All modal dialogs: centered, never edge-to-edge. The settings sheet has
     a higher-specificity full-width rule above, so repeat its selector here
     to win; the generic export/other-modal rule is covered by the second
     selector. */
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])),
  [aria-modal="true"]:not(:has(> :first-child > :last-child > button)) {
    left: 0 !important;
    right: 0 !important;
    margin-left: auto !important;
    margin-right: auto !important;
    width: min(calc(100vw - 32px), 720px) !important;
    max-width: min(calc(100vw - 32px), 720px) !important;
  }

  /* The dsh-web-ui explorer / preview bottom sheets: same treatment — keep
     the mobile bottom-sheet behavior, but stop them spanning the full width. */
  [data-aionui-explorer-col],
  [data-aionui-preview-col] {
    left: 0 !important;
    right: 0 !important;
    width: min(calc(100vw - 32px), 720px) !important;
    margin-left: auto !important;
    margin-right: auto !important;
  }

  /* Settings sections (e.g. Agent presets) often carry a desktop max-width
     (720px) that leaves a dead strip on the right once the sheet is capped to
     the same width; let them fill the sheet body instead. */
  [aria-modal="true"] [class$="_section"] {
    width: 100% !important;
    max-width: none !important;
  }
}

/* ---------- desktop: the mobile controls must never appear ---------- */

@media (min-width: 1024px) {
  [data-mobile-nav="toggle"],
  [data-mobile-nav="files"],
  [data-mobile-nav="fab"],
  [data-mobile-nav="backdrop"],
  [data-mobile-nav="session-log"],
  [data-mobile-nav="explorer"],
  [data-mobile-nav="drawer-actions"] {
    display: none !important;
  }
}
`;
};
__modules["styles/home.css.js"] = function (require, module, exports) {
"use strict";
// home — phone-only app shell (S1, 2026-08-17): the full-screen session list
// and the two-level page stack. Appended LAST so its rules win the ties
// against the shared <=1023px block in layout/compat/misc.
//
// Everything lives inside (max-width: 767px): the tablet range keeps the
// v1.0.0 drawer and the desktop stays a strict no-op.
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOME_CSS = void 0;
exports.HOME_CSS = `/* ---------- phone app shell (< 768px) ---------- */

@media (max-width: 767px) {
  /* --- the document never scrolls (S1.1, 2026-08-17) ---
     Real-device symptom: the workspace title bar, the session header, the
     composer and the FAB all slid with the finger — every fixed surface
     "followed the drag". They are not misplaced; the whole DOCUMENT was
     rubber-banding under them (they are absolute/in-flow inside the frame,
     so a document-level bounce moves them all as one).

     After the S2.1 box-sizing fix the document has no overflow at all
     (scrollHeight === clientHeight, measured with ?mobile-nav-inset=54), so
     this is not scrolling — it is iOS's elastic overscroll, which happens on
     an unscrollable document too, and which an inner scroller chains into as
     soon as it hits its own end.

     overscroll-behavior: none on the viewport kills both halves at once: the
     document itself gets no bounce, and overscroll chained up from the
     message flow / session list is absorbed without moving anything.
     overflow: hidden then hard-locks the document scroller so future content
     can never reintroduce a real scroll. Set on html AND body: the spec
     propagates the viewport's value from html, but engines have historically
     read body, and neither is a scroll container we ever want.

     Deliberately NOT position: fixed on body — the app shell does not need
     it, and it is the variant that strands iOS's fixed elements behind the
     on-screen keyboard. With plain overflow: hidden, iOS still pans the
     visual viewport to reveal a focused textarea, so the composer stays
     visible while typing without any visualViewport JS. */
  html,
  body {
    overflow: hidden !important;
    overscroll-behavior: none !important;
  }

  /* The message flow is the one scroller that regularly hits its end under a
     finger. Root-level \`none\` already absorbs the chain, but declaring it
     at the source keeps the guarantee if the root rule is ever weakened
     (the home list and both sheets already declare it).

     \`none\`, NOT \`contain\` (S4.1 fix, 2026-08-17). The two differ in exactly
     the way that bit us: \`contain\` stops overscroll from CHAINING OUT to the
     document but deliberately KEEPS this element's own local elastic bounce,
     while \`none\` suppresses that local bounce too. S1.1 only reasoned about
     the chain, so it picked \`contain\` — and the composer went on twitching
     upward on every drag-past-the-end while the header and FAB stayed put.

     Why only the composer moved: the official composer seat
     (\`[class$="_composerSeat"]\`) is \`position: sticky; bottom: 0\` and lives
     INSIDE this scroller (measured 2026-08-17: seat 0,710 390x134 inside
     _scrollBody 0,131 390x713, contains() === true). A sticky box is laid out
     against its scroll container's content, so the container's own rubber-band
     drags it along. The header/FAB are absolute on the frame, outside this
     scroller entirely — which is precisely why S1.1's document-level fix
     pinned them and left this one surface behind.

     Deliberately NOT re-pinning the seat with position: fixed: sticky inside
     the scroller is what keeps the focused textarea visible when iOS pans the
     visual viewport for the keyboard, and fixed is the variant that strands
     it behind the keyboard (same trap as the body rule above). Kill the
     bounce, keep the sticky. */
  [data-phase] [class$="_scrollBody"] {
    overscroll-behavior: none !important;
  }

  /* The official sidebar is no longer a drawer on a phone — the home screen
     replaced it. Hidden outright (not translated off-screen) so it cannot
     capture taps or hold layout. */
  [data-mobile-nav="frame"] > :first-child {
    display: none !important;
  }
  /* The header's drawer toggle opened that sidebar; with it gone the button
     has nothing to open. (S2 owns the rest of the header layout —
     styles/header.css.ts — including the Files button's replacement.) */
  [data-mobile-nav="toggle"] {
    display: none !important;
  }

  /* --- level 1: the session list ---
     Renders inside the shell overlay layer (absolute, pointer-events: none),
     so the page re-enables pointer events for itself. The layer's containing
     block is the frame's padding box, which still starts under the status
     bar — hence the safe-area padding here. */
  [data-mobile-nav="home"] {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    pointer-events: auto;
    /* dsw-specific-sidebar-fill, not an alias bg-layer-* token (real-device
       round 2 follow-up, 2026-08-17): fetched and diffed the live theme
       CSS (both light/dark blocks in /assets/index-*.css) because computed
       values, not source-read guesses, are what actually matter here —
       --dsw-alias-bg-base/-layer-1/-layer-2 all resolve to the exact same
       color in the LIGHT theme (neutral-bluish-00, i.e. plain white); they
       only diverge in dark mode. A layer-* token would have made the page
       and its cards indistinguishable in light mode specifically — the
       opposite of what was asked. --dsw-specific-sidebar-fill differs from
       bg-base in BOTH themes (bluish-50 vs -00 light, bluish-900 vs -950
       dark) and is the exact token dsh-better-sidebar's own panel already
       uses for this same "secondary surface next to bg-base content"
       role, so it is the correct reuse rather than a new hardcoded gray. */
    background: var(--dsw-specific-sidebar-fill, #f5f5f5);
    color: var(--dsw-alias-label-primary, inherit);
    padding-top: var(--mnav-sat);
    transform: translateX(0);
    opacity: 1;
    transition:
      transform .3s var(--ds-ease-in-out, ease-in-out),
      opacity .3s var(--ds-ease-in-out, ease-in-out);
  }
  /* Push transition: the list slides out to the left as the session takes
     the screen, and comes back from the left. It stays mounted (visibility,
     not display) so the slide has something to animate; the delayed
     visibility keeps it non-interactive the moment the transition ends. */
  [data-mobile-nav="home"][data-view="session"] {
    transform: translateX(-100%);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
      transform .3s var(--ds-ease-in-out, ease-in-out),
      opacity .3s var(--ds-ease-in-out, ease-in-out),
      visibility 0s .3s;
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-nav="home"],
    [data-mobile-nav="home"][data-view="session"] {
      transition: none !important;
    }
  }

  /* Title bar: the workspace name IS the switcher. */
  [data-mobile-nav="home-top"] {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    min-height: 52px;
    padding: 4px 16px 6px;
  }
  /* Site logo (real-device round 2, 2026-08-17): rendered only when
     document.head actually has a <link rel="icon"> (MobileHome.tsx never
     ships a placeholder box), so this rule only ever needs to size the
     image, not reserve space for its absence. */
  [data-mobile-nav="home-logo"] {
    width: 24px;
    height: 24px;
    margin-right: 6px;
    flex: none;
    border-radius: 6px;
    object-fit: contain;
  }
  [data-mobile-nav="ws-switch"] {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 44px;
    max-width: 100%;
    padding: 0 6px 0 0;
    border: none;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 22px;
    font-weight: 600;
    line-height: 1.2;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="ws-switch"] > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-mobile-nav="ws-switch"] > svg {
    flex: none;
    opacity: .55;
  }
  [data-mobile-nav="ws-switch"]:active {
    opacity: .6;
  }

  /* Session list: rounded cards, not bordered rows (real-device round 2
     follow-up, 2026-08-17 — reference: Claude Code mobile app's session
     list). \`gap\` on the flex column IS the inter-card spacing; no
     per-row margin bookkeeping. */
  [data-mobile-nav="home-list"] {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 16px calc(var(--mnav-sab) + 96px);
    list-style: none;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  [data-mobile-nav="home-row"] {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 60px;
    padding: 14px 16px;
    border: none;
    border-radius: 22px;
    background: var(--dsw-alias-bg-base, #ffffff);
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    /* Card edge definition (2026-08-17). Light theme only — see the dark
       override below. Two stacked shadows in the iOS idiom: a tight 1px
       contact shadow that draws the edge itself, plus a wide soft one that
       lifts the card off the page. Both are deliberately weak (.06/.05):
       the page sits on --dsw-specific-sidebar-fill and the card on
       --dsw-alias-bg-base, so there is already a slight tonal step here and
       the shadow only has to sharpen it, not carry it alone. */
    box-shadow: 0 1px 3px rgba(0, 0, 0, .06), 0 4px 12px rgba(0, 0, 0, .05);
  }
  [data-mobile-nav="home-row"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    /* Press = settle toward the page. Dropping the wide shadow and keeping a
       tighter contact one reads as the card pushing in, which is what the
       darkening background already implies; leaving the lifted shadow under
       a pressed card is the combination that looks wrong. */
    box-shadow: 0 1px 2px rgba(0, 0, 0, .05);
  }
  /* Dark theme: a black shadow on a near-black page is invisible, so the
     edge is drawn instead of cast. A 1px hairline at --dsw-alias-border-l2
     weight, delivered as an INSET box-shadow rather than a real border so
     the card's geometry is untouched (a real 1px border would grow every
     row by 2px unless box-sizing cooperated) and so it overrides the light
     shadow through the same property instead of fighting it.

     Chosen over "brighten the card face" because in dark theme the card
     (--dsw-alias-bg-base, bluish-950) is already DARKER than the page
     (--dsw-specific-sidebar-fill, bluish-900); lightening the card past the
     page would invert the layering that the light theme establishes, while
     a hairline keeps both themes reading as "page behind, card in front".

     Theme is read from body[data-ds-dark-theme], never prefers-color-scheme:
     the app hardcodes color-scheme: light on <html> and switches themes with
     this attribute, so a media query would never fire (AGENTS.md). This
     selector also outranks the :active rule above (0,2,1 vs 0,2,0), so one
     declaration covers the pressed state too. */
  body[data-ds-dark-theme] [data-mobile-nav="home-row"] {
    box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(255, 255, 255, .12));
  }
  [data-mobile-nav="home-row"][data-current] [data-mobile-nav="home-row-title"] {
    font-weight: 600;
  }
  /* Avatar: a running/warning/done session shows its existing StateDot
     (same component, same semantics as the old inline dot — just bigger
     and re-homed); otherwise the title's own first character stands in
     for it, so every row has a mark even when idle. interactive-bg-hover,
     not a bg-layer-* token: same reason as the page background above —
     bg-layer-2 is IDENTICAL to the card's own bg-base in light theme
     (verified against the live theme CSS), so it would render invisible
     there. interactive-bg-hover is a translucent rgba tint rather than a
     solid layer color, so it always reads as "a shade over the card" in
     both themes regardless of what the card's base color resolves to. */
  [data-mobile-nav="home-row-avatar"] {
    flex: none;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .55));
    font-size: 16px;
    font-weight: 600;
  }
  [data-mobile-nav="home-row-body"] {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  [data-mobile-nav="home-row-title"] {
    font-size: 16px;
    line-height: 21px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-mobile-nav="home-row-status"] {
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-size: 12.5px;
    line-height: 17px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-mobile-nav="home-row-time"] {
    flex: none;
    align-self: flex-start;
    color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, .4));
    font-size: 12.5px;
    line-height: 18px;
  }
  [data-mobile-nav="home-empty"] {
    margin: 12px 16px;
    padding: 48px 24px;
    border-radius: 22px;
    background: var(--dsw-alias-bg-base, #ffffff);
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-size: 15px;
    text-align: center;
  }

  /* New-session FAB: a labeled pill (real-device round 2 follow-up), not a
     bare circle — tap starts in the shown workspace, long press picks
     one. Inverted-surface tokens (not a hardcoded accent color): the same
     pair the official git-commit button in dsh-better-sidebar uses for
     its own solid CTA. */
  [data-mobile-nav="home-fab"] {
    position: absolute;
    right: 18px;
    bottom: calc(var(--mnav-sab) + 22px);
    z-index: 6;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 48px;
    padding: 0 20px 0 16px;
    border: none;
    border-radius: 999px;
    background: var(--dsw-alias-button-primary-fill, #1a1a1a);
    color: var(--dsw-alias-label-primary-inverted, #ffffff);
    font-family: inherit;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 6px 20px rgba(0, 0, 0, .24);
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="home-fab"]:active {
    transform: scale(.96);
  }

  /* Workspace sheet (switcher and long-press New Session share it). */
  [data-mobile-nav="home-sheet-layer"] {
    position: absolute;
    inset: 0;
    z-index: 7;
  }
  [data-mobile-nav="home-sheet-mask"] {
    position: absolute;
    inset: 0;
    background: var(--dsw-alias-bg-mask-3, rgba(0, 0, 0, .45));
    border: none;
    animation: dsh-mobile-nav-fade .18s var(--ds-ease-out, ease-in-out);
  }
  /* Docked to the screen edge, matching the composer's permission/model
     sheets (styles/composer.css.ts section 4) rather than floating.

     It used to sit at \`bottom: calc(var(--mnav-sab) + 8px)\` with all four
     corners rounded, which left a 42px strip of bare mask under it at
     sab: 34 (measured). Docking removes the strip instead of dimming it, and
     the safe area moves INSIDE the card as bottom padding — so the white
     card body runs all the way to the physical screen edge and the last row
     still clears the home indicator. Same reason the corners go top-only:
     a rounded bottom corner on a card flush with the screen edge reads as a
     rendering mistake. */
  [data-mobile-nav="home-sheet"] {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 70%;
    overflow-y: auto;
    overscroll-behavior: contain;
    box-sizing: border-box;
    padding: 6px 6px calc(var(--mnav-sab) + 14px);
    border-radius: 20px 20px 0 0;
    /* layer-2, not bg-base: in dark mode the sheet must lift off a page that
       shares bg-base, or only the shadow separates them. */
    background: var(--dsw-alias-bg-layer-2, #ffffff);
    box-shadow: 0 -8px 32px rgba(0, 0, 0, .28);
    animation: dsh-mobile-nav-sheet-up .22s var(--ds-ease-out, ease-in-out);
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-nav="home-sheet-mask"],
    [data-mobile-nav="home-sheet"] {
      animation: none !important;
    }
  }
  [data-mobile-nav="home-sheet-title"] {
    padding: 10px 12px 6px;
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-size: 13px;
  }
  [data-mobile-nav="home-sheet-item"] {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 48px;
    padding: 0 12px;
    border: none;
    border-radius: 12px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 16px;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="home-sheet-item"][data-selected] {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    font-weight: 600;
  }
  [data-mobile-nav="home-sheet-item"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }

  /* --- hero fallback back button ---
     The hero (new blank session) page renders no conversation.session.header,
     so the header-slot back button (S2) does not exist there. This floating
     fallback covers that page and hides itself as soon as the real header
     back mounts. */
  [data-mobile-nav="hero-back"] {
    position: absolute;
    top: calc(var(--mnav-sat) + 8px);
    left: 8px;
    z-index: 6;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 14px;
    background: transparent;
    color: var(--dsw-alias-label-secondary, inherit);
    pointer-events: auto;
  }
  [data-mobile-nav="hero-back"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }
  [data-mobile-nav="frame"]:has([data-mobile-nav="header-back"]) ~ [data-mobile-nav="hero-back"],
  body:has([data-mobile-nav="header-back"]) [data-mobile-nav="hero-back"] {
    display: none;
  }
}
`;
};
__modules["styles/header.css.js"] = function (require, module, exports) {
"use strict";
// header — session-page header five-piece reflow (S2, 2026-08-17). Scoped
// entirely to (max-width: 767px) and appended LAST (after home.css.ts) so
// its rules win ties against the shared <=1023px block in layout.css.ts —
// same reasoning as home.css.ts: 768-1023px keeps the v1.0.0 drawer header
// untouched, >=1024px is a strict no-op.
//
// DOM this reflows (dsh-client-ui-conversation lib/client.js:6949-7009,
// verified live 2026-08-17 at 375px — class names below are the CURRENT
// hashed values, always targeted by suffix):
//   header                    ConversationSessionHeader root
//     div.titleRow
//       div.titleCluster        (official: a flex cluster; we flatten it)
//         nav.crumbs             breadcrumb chain, last segment = the title
//         div.headerActions      [data-slot="conversation.session.header.actions"]
//       div.headerUtilities    [data-slot="conversation.session.header.utilities"]
//     div.tabs[role="tablist"]  Chat/Trajectory, only when there is >1 view
Object.defineProperty(exports, "__esModule", { value: true });
exports.HEADER_CSS = void 0;
exports.HEADER_CSS = `/* ---------- session header five-piece reflow (< 768px) ---------- */

/* New elements render unconditionally (React does not know about media
   queries); default them to hidden so 768px+ never sees them, then
   re-enable inside the phone block below. Belt-and-braces alongside the
   scoped rules — mirrors the existing [data-mobile-nav="*"] desktop no-op
   list in misc.css.ts. */
[data-mobile-nav="header-back"],
[data-mobile-nav="header-viewrow"],
[data-mobile-nav="header-info"],
[data-mobile-nav="header-workbench"] {
  display: none;
}

@media (max-width: 767px) {
  /* The Files action targeted the dsh-web-ui-all (aionui) explorer sheet —
     a different, unrelated suite from the workbench entry this slice adds
     (dsh-better-sidebar). Hidden here only; 768-1023px keeps it exactly as
     v1.0.0 shipped it. */
  [data-mobile-nav="files"] {
    display: none !important;
  }

  /* --- three-column header: [back 92px] [title, truly centered] [utilities 92px] --- */
  /* The bottom padding is the view-switch row's seat: that row is
     position:absolute (see the bottom of this file — it renders two levels
     deep inside headerActions and can never be a grid item of titleRow), so
     without a reserve it would hang over the message list. 28px = its
     height. Unconditional rather than header:has([data-mobile-nav=
     "header-viewrow"]) on purpose: :has() is silently dropped by pre-105
     WebViews (see AGENTS.md) and a 28px overlap on the first message is a
     worse failure than 28px of empty band in the (never observed in
     practice) single-view session. Total header chrome: 48 + 28 = 76px.
     Left/right 8px (S2.1 report leftover, fixed in S4): the official header
     had zero horizontal padding, so the utilities button cluster's right
     edge sat flush against the screen edge (x=390 at 390px width, no
     margin). The 92px grid columns absorb this fine — they're fixed track
     widths, only the center 1fr column shrinks by 16px. */
  [data-phase] header {
    position: relative;
    padding: 0 8px 28px !important;
  }
  /* No header bottom line — fade instead (real-device round 2, 2026-08-17).
     The official header draws its border as a \`::after\` 1px bar (the
     \`border-bottom\` on the header itself is transparent, just a layout
     reserve — dsh-client-ui-conversation lib/client.js ".wSkVaW_header{
     border-bottom:1px solid #0000}.wSkVaW_header:after{...height:1px;
     position:absolute;bottom:1px...}", verified live 2026-08-17), so
     hiding the pseudo-element is enough; the header's own border-bottom
     never had a visible color to begin with. The message scroller now
     fades in from under the header instead (styles/composer.css.ts, "no
     divider above OR below the message list" — the two edges share one
     mask-image on [class$="_scrollBody"]). */
  [data-phase] header::after {
    display: none !important;
  }
  /* grid-row: 1 on every item is load-bearing, not decoration (S2.1 fix for
     the "标题被挤下去" report). The three items are placed with explicit
     grid-column but arrive in DOM order crumbs(2) → headerActions(1) →
     headerUtilities(3): sparse auto-placement never moves its cursor
     backwards, so headerActions and headerUtilities were pushed onto an
     implicit SECOND row. Measured at 390px: row1 = crumbs 28px, row2 =
     back button 44px, titleRow = 72px with the title stuck at the top
     instead of centered. Pinning the row makes it one 48px band again. */
  [data-phase] header [class$="_titleRow"] {
    position: relative;
    display: grid;
    grid-template-columns: 92px 1fr 92px;
    grid-template-rows: minmax(48px, auto);
    align-items: center;
    min-height: 48px;
    padding: 0 !important;
  }
  /* Flatten the official cluster so its two children (crumbs, headerActions)
     become direct grid items of titleRow instead of a nested flex box. */
  [data-phase] header [class$="_titleCluster"] {
    display: contents;
  }
  /* margin-left: 0 cancels layout.css.ts's shared <=1023px
     "margin-left: auto !important" on this exact selector (it pushed the
     Files button to the row's right edge in the old non-grid header;
     inside our grid column it instead shoves the back button 48px right of
     the column's start — the auto margin absorbs the leftover space
     between the button's content width and the 92px column). */
  [data-phase] header [class$="_headerActions"] {
    grid-column: 1;
    grid-row: 1;
    justify-self: start;
    margin-left: 0 !important;
    display: flex;
    align-items: center;
    min-width: 0;
  }
  /* layout.css.ts's shared <=1023px block hides this element outright
     (header > :first-child > :last-child { display: none !important },
     specificity (0,3,1) — v1.0.0 relocated the desktop Session-log capsule
     to the drawer footer on every narrow width). That selector is repeated
     here at equal specificity so the later source order wins the display
     property; the class-suffix selector alone (0,2,1) would silently lose. */
  [data-phase] header [class$="_headerUtilities"],
  [data-phase] header > :first-child > :last-child {
    grid-column: 3;
    grid-row: 1;
    justify-self: end;
    display: flex !important;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  /* justify-self: stretch (the grid default) so this fills the whole 1fr
     column as a definite-width box — center/center-content happens inside
     it. justify-self: center (tried first) sizes the item to its content
     with no automatic column cap, and the obvious fix — max-width: 100% —
     resolves against the WRONG box here (measured 93.6px at 390px, where
     the column is ~206px): the item's DOM parent (titleCluster) is
     display:contents, and percentage max-width does not reliably resolve
     through a boxless ancestor to the grid track. Stretching sidesteps the
     percentage entirely — but layout.css.ts's shared <=1023px block ALSO
     caps this exact selector at max-width: 24vw !important (93.6px at
     390px — the value this rule used to silently inherit once its own
     max-width was dropped in favor of stretch), so that must be reset to
     none here too. */
  [data-phase] header [class$="_crumbs"] {
    grid-column: 2;
    grid-row: 1;
    justify-self: stretch;
    max-width: none !important;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    overflow: hidden;
  }
  /* Only the current session's own name is the "title" — the parent chain
     (subagent breadcrumbs) is the "多余项" the design calls out to hide,
     while the current segment (and its running dot, see below) stays. */
  [data-phase] header [class$="_crumbSeg"]:not(:last-child) {
    display: none !important;
  }
  [data-phase] header [class$="_crumbSeg"]:last-child {
    display: flex;
    align-items: center;
    min-width: 0;
    max-width: 100%;
  }
  [data-phase] header [class$="_crumbSeg"]:last-child [class$="_crumbSep"] {
    display: none !important;
  }
  [data-phase] header [class$="_crumb"] {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    max-width: 100%;
  }

  /* Running-status dot: no official element to reposition (the header
     renders only the crumb title, the two action slots, and the tablist —
     no status indicator), so this is the plan's documented fallback —
     read the data ourselves and draw it (effects/header-status.ts stamps
     data-mobile-nav-dot on the frame). A ::after on the title crumb keeps
     it truly inline with the (centered, truncated) text instead of a
     separately positioned box that would fight the centering math. */
  [data-phase] header [class$="_crumbCurrent"]::after {
    content: '';
    display: none;
    width: 6px;
    height: 6px;
    margin-left: 6px;
    border-radius: 50%;
    vertical-align: middle;
  }
  [data-mobile-nav="frame"][data-mobile-nav-dot] header [class$="_crumbCurrent"]::after {
    display: inline-block;
  }
  [data-mobile-nav="frame"][data-mobile-nav-dot="ongoing"] header [class$="_crumbCurrent"]::after {
    background: var(--dsw-alias-state-business-primary, #4f6ef7);
  }
  [data-mobile-nav="frame"][data-mobile-nav-dot="warning"] header [class$="_crumbCurrent"]::after {
    background: var(--dsw-alias-state-warn-primary, #d97706);
  }
  [data-mobile-nav="frame"][data-mobile-nav-dot="done"] header [class$="_crumbCurrent"]::after {
    background: var(--dsw-alias-state-success-primary, #16a34a);
  }

  /* Everything else the official header puts in these two list slots — the
     agent-preset mode badge, the jobs/subagent trigger, the desktop
     Session-log download capsule, and this plugin's own legacy directory
     toggle — is the "不常驻" set the design defers to the S4 info card.
     Scoped by the slots' own [data-slot] wrapper (a stable, non-hashed
     contract marker) rather than enumerating each registrant, so a future
     third-party header action is hidden by default too. */
  [data-phase] header [data-slot="conversation.session.header.actions"] > *,
  [data-phase] header [data-slot="conversation.session.header.utilities"] > * {
    display: none !important;
  }
  /* The agent-preset mode badge specifically survives the blanket hide
     above: layout.css.ts's shared <=1023px block targets it directly
     (header [class$="_label"]:has(> svg) { display: block !important }),
     specificity (0,3,1), higher than the [data-slot] wrapper rule (0,2,1) —
     display wins on specificity before source order, so a same-selector
     override is needed here too. */
  [data-phase] header [class$="_label"]:has(> svg) {
    display: none !important;
  }
  [data-phase] header [data-slot="conversation.session.header.actions"] > [data-mobile-nav="header-back"] {
    display: inline-flex !important;
  }
  /* header-viewrow is position:absolute (see below), so its re-shown
     display value must match the flex layout its own rule declares. */
  [data-phase] header [data-slot="conversation.session.header.actions"] > [data-mobile-nav="header-viewrow"] {
    display: flex !important;
  }
  [data-phase] header [data-slot="conversation.session.header.utilities"] > [data-mobile-nav="header-info"],
  [data-phase] header [data-slot="conversation.session.header.utilities"] > [data-mobile-nav="header-workbench"] {
    display: inline-flex !important;
  }

  /* Back button: 44pt touch target, leftmost column. */
  [data-mobile-nav="header-back"] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--dsw-alias-label-primary, inherit);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="header-back"]:active {
    opacity: .6;
  }

  /* Info + workbench utility buttons, rightmost column. */
  [data-mobile-nav="header-info"],
  [data-mobile-nav="header-workbench"] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--dsw-alias-label-secondary, inherit);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="header-info"]:active,
  [data-mobile-nav="header-workbench"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }
  /* Icon family unification (real-device round 2, 2026-08-17): the ⓘ text
     glyph is gone (MobileSessionHeader.tsx now renders IconInfoOutline16,
     a local 16px SVG built to match the primitives icon family) and the
     workbench button's IconPanelLeftOutline16 is mirrored into a
     panel-RIGHT glyph — there's no IconPanelRightOutline16 in primitives
     (checked lib/types/icons/index.d.ts), and the plugin's own right-side
     panel semantics are exactly the left icon flipped. Both buttons now
     carry a same-size (16px), same-stroke-weight icon. */
  [data-mobile-nav="header-workbench"] svg {
    transform: scaleX(-1);
  }

  /* Official Chat/Trajectory tablist: removed from layout entirely (S2.1 —
     visibility:hidden still held a 27px row, so the header carried the
     view-switch row's band TWICE: 72 + 27 + gap = 104px measured at 390px,
     and a real iPhone added ~54px of notch on top of that). The header's own
     padding-bottom above is now the row's seat.
     display:none does NOT break the view switch: HTMLElement.click()
     dispatches synthetically and fires React's handler regardless of
     rendering — only real pointer hit-testing needs a box, and this plugin
     never relies on it (MobileSessionHeader always calls .click()). */
  [data-phase] header [class$="_tabs"][role="tablist"] {
    display: none;
  }

  /* View-switch row: "current view name + dots", replacing the (still
     present, still clickable) official tablist visually. It renders inside
     headerActions/headerUtilities, but titleRow's own position:relative
     (set above) makes IT the containing block for absolute descendants —
     display:contents on titleCluster does not break that search — so
     top:100% sits directly under the title regardless of the title row's
     actual height, with no hardcoded offset to keep in sync. */
  [data-mobile-nav="header-viewrow"] {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 28px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-family: inherit;
    font-size: 13px;
    line-height: 18px;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="header-viewrow-dots"] {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  [data-mobile-nav="header-viewrow-dots"] > i {
    display: block;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    opacity: .35;
    font-style: normal;
  }
  [data-mobile-nav="header-viewrow-dots"] > i[data-active] {
    opacity: 1;
  }
}
`;
};
__modules["styles/composer.css.js"] = function (require, module, exports) {
"use strict";
// composer — phone-only composer reflow (S3, 2026-08-17).
//
// Appended after home/header so its < 768px rules win the ties against the
// shared <= 1023px block in layout/compat/misc (which keeps the v1.0.0
// composer treatment alive for the 768-1023px tablet range).
//
// Official structure this file reshapes (verified live at 390px, see the S3
// report): InputBar renders
//   _card > _row > [_tools > (_add, _modes > PermissionSelect, input.left)]
//                  [_trailing > (input.right, input.model, ContextMeter, _primary)]
// with `_tools` / `_trailing` as inner flex groups. Flattening both to
// `display: contents` turns every control into a direct flex item of `_row`,
// which is what makes a pure `order` reflow possible without touching a
// single official component.
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMPOSER_CSS = void 0;
/** The composer input card's bottom control row (the only `_row` that is a direct card child — the ContextMeter panel also has `_row` descendants). */
const ROW = '[data-slot="conversation.composer.bar"] [class$="_card"] > [class$="_row"]';
/** The model seat's own root inside the trailing group (long form so it beats the <=1023px pill rules in layout.css.ts). */
const MODEL = `${ROW} > [class$="_trailing"] > [data-slot="conversation.input.model"] > [class$="_root"]`;
/** The permission select's trigger button (structure only — the PermissionSelect hashed classes are never named). */
const PERM = `${ROW} > [class$="_tools"] > [class$="_modes"]`;
exports.COMPOSER_CSS = `/* ---------- phone composer (< 768px) ---------- */

@media (max-width: 767px) {
  /* --- 1. flatten the two official groups ---
     \`_tools\` and \`_trailing\` only exist to cluster controls left/right.
     display:contents dissolves them into \`_row\`, so the six leaf controls
     become siblings in one flex line and \`order\` alone drives the layout:
     [attach · + · permission · model] …elastic gap… [context ring · send]. */
  ${ROW} {
    justify-content: flex-start !important;
    gap: 5px !important;
    padding: 2px 8px 8px !important;
  }
  ${ROW} > [class$="_tools"],
  ${ROW} > [class$="_trailing"] {
    display: contents !important;
  }

  /* --- 2. the running order ---
     The attachment button (S3 placeholder, S7 wires it up) sits leftmost;
     the official "+" command menu keeps its seat right next to it, where
     the two "insert something" affordances read as one cluster. */
  ${ROW} [data-mobile-nav="attach"] {
    order: 1 !important;
  }
  ${ROW} > [class$="_tools"] > [class$="_add"] {
    order: 2 !important;
  }
  ${ROW} > [class$="_tools"] > [class$="_modes"] {
    order: 3 !important;
    flex: 0 1 auto !important;
    min-width: 0 !important;
    gap: 6px !important;
  }
  /* The model seat carries the elastic gap: everything after it is pushed to
     the right edge, so no spacer element is needed. */
  ${MODEL} {
    order: 4 !important;
    flex: 0 1 auto !important;
    min-width: 0 !important;
    margin-right: auto !important;
  }
  /* Third-party input.right entries park next to the ring rather than
     landing at order 0 (= far left) once the groups are flattened. */
  ${ROW} > [class$="_trailing"] > [data-slot="conversation.input.right"] > * {
    order: 5 !important;
  }
  /* ContextMeter — the only \`span\` ending in _root inside the row. */
  ${ROW} > [class$="_trailing"] > span[class$="_root"] {
    order: 6 !important;
    flex: none !important;
  }
  ${ROW} > [class$="_trailing"] > [class$="_primary"] {
    order: 7 !important;
  }

  /* --- 3. permission + model as icon-only pills (real-device round 2, 2026-08-17) ---
     S3's icon-and-label capsules read as noise on an actual phone — there
     is no room to usefully show a preset name or a model id, so the label
     text is now hidden outright and both triggers collapse to a plain
     ~44x30 icon button. This AGREES with (rather than fights) the official
     container query (\`@container (width <= 460px) { .trigger:has(.triggerIcon)
     .triggerLabel { display: none } }\`) that S3 had to override — no need
     to override it back. Accessible name is unaffected: both official
     triggers already ship a descriptive aria-label independent of the
     visible text (PermissionSelect: t('input.accessMode', {name}); the
     model trigger: t('trigger.aria'/'trigger.ariaEffort')) — verified live
     in dsh-client-ui-conversation / dsh-client-ui-model-selection lib/
     client.js, 2026-08-17 — so hiding the label costs nothing for screen
     readers. The permission trigger only renders an icon for the
     "read-only" / "workspace-write" presets (permissionGlyphs in
     dsh-client-ui-conversation) — "Full access" and any host-configured
     preset name fall back to chevron-only, a known gap in the official
     markup this plugin cannot fill without inventing new icon meaning.
     The model trigger never renders an icon at all (only label + optional
     effort text + chevron), so its ::before below draws one from a
     primitives icon path (Sparkle — the closest existing "model" glyph) as
     a CSS-only pseudo-element: it survives React re-renders for free
     (unlike a DOM-injected node, which would need a MutationObserver, see
     the preview-full-toggle pitfall in AGENTS.md) and does not touch
     accessible-name computation (empty generated content). S3's
     rtl-ellipsis trick on the model label is simply inert under
     display:none now; left alone rather than unpicked. */
  ${PERM} [class$="_triggerLabel"],
  ${MODEL} > [class$="_trigger"] > [class$="_triggerLabel"],
  ${MODEL} > [class$="_trigger"] > [class$="_triggerEffort"] {
    display: none !important;
  }
  ${PERM} button[class$="_trigger"],
  ${MODEL} > [class$="_trigger"] {
    background: var(--dsw-specific-selector, rgba(127, 127, 127, .12)) !important;
    width: 44px !important;
    height: 30px !important;
    max-width: none !important;
    min-width: 0 !important;
    padding: 0 !important;
    gap: 2px !important;
    justify-content: center !important;
    border-radius: 999px !important;
    touch-action: manipulation !important;
  }
  /* PermissionSelect wraps its trigger in the Menu primitive's root span,
     which must shrink to the icon button's fixed width. */
  ${PERM} > span:has(> button[class$="_trigger"]) {
    flex: 0 0 auto !important;
    min-width: 0 !important;
  }
  /* ic_ds_sparkle_16 (@deepseek-ai/dsh-client-ui-primitives IconSparkle16
     path, copied verbatim) as a mask so it inherits currentColor like every
     other icon in the row — the model trigger has no official icon slot to
     hook into. */
  ${MODEL} > [class$="_trigger"]::before {
    content: '';
    width: 16px;
    height: 16px;
    flex: none;
    background: currentColor;
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z'/%3E%3Cpath d='M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z'/%3E%3C/svg%3E");
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z'/%3E%3Cpath d='M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z'/%3E%3C/svg%3E");
    -webkit-mask-size: contain;
    mask-size: contain;
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
  }

  /* --- 4. both menus become bottom sheets ---
     The permission menu is the Menu primitive (role=menu, absolute, side=top)
     and the model menu is ModelSelect's own \`_menu\` (absolute, bottom+right).
     Neither has a transformed ancestor between it and the viewport, so
     position:fixed re-anchors both to the screen edge. Only the shell moves —
     the items, the two-level model panes and every selection handler stay
     official. */
  ${PERM} [role="menu"],
  ${MODEL} > [class$="_menu"] {
    position: fixed !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    top: auto !important;
    transform: none !important;
    width: 100% !important;
    min-width: 0 !important;
    max-width: none !important;
    max-height: min(70dvh, 520px) !important;
    box-sizing: border-box !important;
    border-radius: 16px 16px 0 0 !important;
    border-bottom: none !important;
    padding: 8px 8px calc(8px + var(--mnav-sab)) !important;
    z-index: 60 !important;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, .18) !important;
  }
  /* 44pt+ rows in both sheets (Menu items, model options, and the model
     sheet's two root cells that drill into the model / effort panes). */
  ${PERM} [role="menu"] [role="menuitem"],
  ${MODEL} > [class$="_menu"] [class$="_option"],
  ${MODEL} > [class$="_menu"] [class$="_cell"] {
    min-height: 48px !important;
    border-radius: 12px !important;
    font-size: 15px !important;
  }
  /* --- 4b. the official scroll-to-bottom button must not poke through the
     sheet (real-device follow-up, 2026-08-17) ---
     ChatView's own "jump to latest" button (aria-label t("chat.toBottom"))
     is \`position: sticky; z-index: 8\` inside the message column, not
     \`position: fixed\` — it never escapes to the same top-level stacking
     context our sheets get promoted to, so raising the sheet's z-index
     further does nothing (measured live: it still rendered on top at
     z-index 60 vs 8). Rather than chase engine-specific stacking-context
     semantics (Chromium and WebKit do not always agree here — see AGENTS.md
     CDP/document.hidden lesson for another instance of that), this hides
     the button outright while either sheet is open and lets it reappear on
     close: a plain \`display: none\` behind a live \`:has()\` read is correct
     regardless of which stacking rules the engine happens to apply.
     Selector: no hashed classes (dsh-client-ui-conversation lib/client.js,
     verified 2026-08-17) — \`data-chat-flow\` is the one stable attribute on
     the message column, and the button's wrapper is its only sibling
     (ChatView only ever renders the column and, conditionally, this one
     slot), so the adjacent-sibling combinator pins it precisely. */
  body:has(${PERM} [role="menu"]) [data-chat-flow] + div,
  body:has(${MODEL} > [class$="_menu"]) [data-chat-flow] + div {
    display: none !important;
  }
  /* --- 5. input box: two lines minimum, five lines maximum ---
     The official autosizer drives the box off the hidden mirror's height, so
     a min-height on the mirror IS the min-height of the field; the scroll cap
     rides the official custom property. 52px = 2 x 24px line box + 4px pad,
     124px = 5 lines. The hero card keeps its own one-line collapse (misc.css
     pins _scroll/_grow while the placeholder shows). */
  [data-slot="conversation.composer.bar"] [class$="_card"] [class$="_mirror"] {
    min-height: 52px !important;
  }
  [class$="_composerSeat"] {
    --dsh-composer-text-max-height: 124px;
  }

  /* --- 6. no divider above OR below the message list ---
     Instead of a rule the messages butt against, the message scroller
     fades out over its last 26px (S3, no divider above the composer) AND
     fades in over its first 20px (S3.1 real-device round 2: the header's
     own bottom line is removed too, styles/header.css.ts's
     \`header::after\` rule). The mask lives on the scroll body (NOT on the
     header or the composer): a mask clips everything it paints, and both
     surfaces host position:fixed children (composer's permission/model
     sheets, any future header overlay) that must not be clipped.
     \`mask-image\` can only be declared once per element, so both fades are
     ONE linear-gradient rather than two separate declarations (the second
     would silently replace the first) — this is the merge of what used to
     be S3's bottom-only mask. */
  [class$="_scrollBody"] {
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 26px), transparent 100%);
    mask-image: linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 26px), transparent 100%);
  }
  [class$="_composerSeat"],
  [class$="_composerStack"] {
    border-top: none !important;
  }

  /* --- 7. dock entries become mini chips above the input card ---
     conversation.input.dock is display:contents (inline style), so its
     entries are stacked rows of the composer column. Forcing the slot itself
     to flex turns them into ONE scrollable chip line outside and above the
     card. Written against the slot, not against any particular plugin's chip
     (the git branch chip and the todo panel are third-party and may not be
     installed at all). */
  [data-slot="conversation.input.dock"] {
    display: flex !important;
    flex-flow: row nowrap !important;
    align-items: center !important;
    gap: 6px !important;
    min-width: 0 !important;
    margin: 0 16px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    scrollbar-width: none !important;
  }
  [data-slot="conversation.input.dock"]::-webkit-scrollbar {
    display: none !important;
  }
  [data-slot="conversation.input.dock"] > * {
    flex: 0 0 auto !important;
    max-width: 70% !important;
    min-height: 26px !important;
    max-height: 26px !important;
    border-radius: 999px !important;
    font-size: 11.5px !important;
    line-height: 18px !important;
    overflow: hidden !important;
  }
  /* The git-graph chip carries a 34px tablet target from misc.css; that
     selector is more specific, so restate it at the phone breakpoint. */
  [data-slot="conversation.input.dock"] [data-gitgraph-chip-anchor] [data-gitgraph-chip] {
    min-height: 26px !important;
    padding: 0 10px !important;
    font-size: 11.5px !important;
  }

  /* --- 8. the official stats strip leaves the composer ---
     Its data moves into the session info card (S4). The row is the composer
     dock's own \`_root\` entry; the slot itself stays live for later entries. */
  [data-slot="conversation.composer.dock"] > [class$="_root"] {
    display: none !important;
  }

  /* --- 9. the attachment placeholder (S7 wires it to a real picker) --- */
  [data-mobile-nav="attach"] {
    width: 28px !important;
    height: 28px !important;
    flex: none !important;
    display: grid !important;
    place-items: center !important;
    padding: 0 !important;
    border: none !important;
    border-radius: 999px !important;
    background: var(--dsw-specific-selector, rgba(127, 127, 127, .12));
    color: var(--dsw-alias-label-primary, inherit);
    cursor: pointer;
    touch-action: manipulation;
  }
  [data-mobile-nav="attach"]:active {
    transform: scale(.94);
    transition: transform .12s;
  }

  /* --- 9. home-indicator clearance (S4.1, 2026-08-17) ---
     Owned HERE, not by dsh-mobile-pwa. That plugin used to carry
       [data-slot="conversation.composer"] { padding-bottom: max(env(safe-area-inset-bottom), 8px) }
     in both pwa/app.css and the gateway's inline DEVICE_CSS. Both were
     INERT and had always been: that slot element is \`display: contents\`
     (measured 2026-08-17 — the slot wrapper generates no box, so padding on
     it is discarded), which is why raising it never moved anything. The rule
     is deleted on the PWA side and restated here on an element that actually
     lays out, reading --mnav-sab so ?mobile-nav-inset=54,34 can regress it
     off-device (env() is hard 0 on desktop — the whole reason S2.1 exists).

     Target: the card should look EQUALLY inset on all four sides. This same
     element carries the card's side inset (\`padding: 0 16px\` officially,
     measured 16px left and 16px right at 390px), so the bottom gap is simply
     capped at that same 16px. Clearing the FULL 34px inset — the naive
     max(sab, 8px) — is what read as "too thick": it is more than double the
     side margin, so the card looked shoved up off the bottom edge.

     clamp() says all three requirements at once:
       - floor 8px  -> a device with no home indicator (sab: 0) keeps the
                       official 8px exactly, so this is a strict no-op there;
       - track sab  -> a shallower inset than 16px is honoured as-is;
       - cap 16px   -> a full-size indicator (sab: 34) lands on 16px, equal
                       to the side inset, which is the look being asked for.
     Keep the 16px in step with the side padding above if that ever changes;
     that equality IS the spec here, not a coincidence. */
  [data-slot="conversation.composer.bar"] > [class$="_root"] {
    padding-bottom: clamp(8px, var(--mnav-sab), 16px) !important;
  }
}

/* The attachment button only exists for the phone shell. */
@media (min-width: 768px) {
  [data-mobile-nav="attach"] {
    display: none !important;
  }
}
`;
};
__modules["styles/info.css.js"] = function (require, module, exports) {
"use strict";
// info — session-info bottom sheet (S4, 2026-08-17). Scoped entirely to
// (max-width: 767px) and appended LAST (after composer.css.ts) so its rules
// win the header.css.ts blanket-hide tie (same specificity, later source
// wins — see the comment on the re-show block below) and the shared
// <=1023px block never sees it. 768-1023px / >=1024px: strict no-op, same
// discipline as every other phone-only file in this stylesheet.
//
// Visual language borrowed from styles/home.css.ts's workspace sheet
// (fixed/absolute bottom sheet, 16px top radius, dsh-mobile-nav-fade /
// -sheet-up keyframes from base.css.ts) and styles/composer.css.ts's own
// bottom-sheet technique for the permission/model menus (position: fixed,
// safe-area bottom padding, 48px+ touch rows) — this file reuses both
// rather than inventing a third sheet shape.
Object.defineProperty(exports, "__esModule", { value: true });
exports.INFO_CSS = void 0;
exports.INFO_CSS = `/* ---------- session-info sheet (< 768px) ---------- */

/* Unconditional render (React, not CSS, decides open/closed) — default
   hidden outside the phone breakpoint so a stray SESSION_INFO_EVENT at
   >=768px (the ⓘ trigger itself is already CSS-hidden there) can never
   paint anything, mirroring header.css.ts's own belt-and-braces list. */
[data-mobile-nav="info-layer"] {
  display: none;
}

@media (max-width: 767px) {
  /* header.css.ts hides every [data-slot="conversation.session.header.utilities"]
     direct child by default (its own ⓘ/workbench buttons are the two named
     exceptions) — this is a second, sibling entry on that same slot, so it
     needs the identical re-show override. Equal specificity
     ([data-slot="…"] > * vs this attribute selector, both one attribute
     selector + !important) means source order decides the tie; this file
     is concatenated after header.css.ts in styles/index.ts, so it wins. */
  [data-phase] header [data-slot="conversation.session.header.utilities"] > [data-mobile-nav="info-layer"] {
    display: block !important;
  }

  [data-mobile-nav="info-layer"] {
    position: fixed;
    inset: 0;
    /* Above the composer's own bottom sheets (permission/model menus sit at
       z:60, styles/composer.css.ts) and the shell.overlay layer's z:20
       ceiling (AGENTS.md stacking-context pitfall) — this sheet must cover
       both, which is only possible because it renders inside the header's
       own DOM instead of that capped layer. */
    z-index: 70;
  }
  [data-mobile-nav="info-mask"] {
    position: absolute;
    inset: 0;
    border: none;
    background: var(--dsw-alias-bg-mask-3, rgba(0, 0, 0, .45));
    animation: dsh-mobile-nav-fade .18s var(--ds-ease-out, ease-in-out);
  }
  [data-mobile-nav="info-sheet"] {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: calc(var(--mnav-sab) + 8px);
    max-height: 82dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
    box-sizing: border-box;
    padding: 12px;
    border-radius: 16px;
    background: var(--dsw-alias-bg-layer-2, #ffffff);
    box-shadow: 0 8px 32px rgba(0, 0, 0, .28);
    animation: dsh-mobile-nav-sheet-up .22s var(--ds-ease-out, ease-in-out);
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-nav="info-mask"],
    [data-mobile-nav="info-sheet"] {
      animation: none !important;
    }
  }

  /* --- head: Chat/Trajectory segmented control + close --- */
  [data-mobile-nav="info-head"] {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }
  [data-mobile-nav="info-tabs"] {
    display: flex;
    gap: 2px;
    padding: 2px;
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    border-radius: 12px;
  }
  [data-mobile-nav="info-tab"] {
    min-height: 36px;
    padding: 0 14px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-family: inherit;
    font-size: 14px;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="info-tab"][data-selected] {
    background: var(--dsw-alias-bg-layer-2, #ffffff);
    color: var(--dsw-alias-label-primary, inherit);
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .12);
  }
  [data-mobile-nav="info-close"] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex: none;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--dsw-alias-label-secondary, inherit);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="info-close"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }

  /* --- badges: agent preset, subagent count, cwd --- */
  [data-mobile-nav="info-badges"] {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
  }
  [data-mobile-nav="info-badge"],
  [data-mobile-nav="info-badge-cwd"] {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .6));
    font-size: 12px;
    line-height: 18px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-mobile-nav="info-badge-cwd"] {
    font-family: var(--dsw-font-mono, ui-monospace, monospace);
  }

  /* --- six-cell stats grid --- */
  [data-mobile-nav="info-stats"] {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }
  [data-mobile-nav="info-stat"] {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-height: 48px;
    padding: 8px 4px;
    border-radius: 12px;
    background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, .03));
    text-align: center;
  }
  [data-mobile-nav="info-stat-value"] {
    color: var(--dsw-alias-label-primary, inherit);
    font-size: 17px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }
  [data-mobile-nav="info-stat-label"] {
    color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, .4));
    font-size: 11px;
    line-height: 1.3;
  }
  [data-mobile-nav="info-stat-sub"] {
    color: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, .4));
    font-size: 10px;
    line-height: 1.2;
  }

  [data-mobile-nav="info-error"] {
    margin-bottom: 8px;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--dsw-alias-state-warn-bg, rgba(217, 119, 6, .12));
    color: var(--dsw-alias-state-warn-primary, #d97706);
    font-size: 12px;
    line-height: 1.4;
  }

  /* --- action row: export / rename / fork / archive --- */
  [data-mobile-nav="info-actions"] {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  [data-mobile-nav="info-action"] {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 48px;
    padding: 0 10px;
    border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
    border-radius: 12px;
    background: transparent;
    color: var(--dsw-alias-label-primary, inherit);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="info-action"]:active:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }
  [data-mobile-nav="info-action"]:disabled {
    opacity: .5;
    cursor: default;
  }
  [data-mobile-nav="info-action"][data-mobile-nav-danger] {
    border-color: var(--dsw-alias-state-warn-primary, #d97706);
    color: var(--dsw-alias-state-warn-primary, #d97706);
  }
}
`;
};
__modules["styles/index.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MOBILE_CSS = void 0;
const base_css_ts_1 = require("./styles/base.css.js");
const layout_css_ts_1 = require("./styles/layout.css.js");
const compat_css_ts_1 = require("./styles/compat.css.js");
const misc_css_ts_1 = require("./styles/misc.css.js");
const home_css_ts_1 = require("./styles/home.css.js");
const header_css_ts_1 = require("./styles/header.css.js");
const composer_css_ts_1 = require("./styles/composer.css.js");
const info_css_ts_1 = require("./styles/info.css.js");
/**
 * All mobile styles, concatenated in the exact order of the original
 * single-file stylesheet (base → layout → compat → misc, where misc keeps
 * composer → tablet → desktop), followed by the phone app shell (home), the
 * session-header reflow (header), the composer reflow (composer), and the
 * session-info sheet (info, which must come last of all: it re-shows a
 * header.utilities child header.css.ts hides by default, so its rule has to
 * win that tie too) — all appended in this order so their <768px rules win
 * ties against the shared <=1023px block. Injected as ONE <style
 * data-plugin> tag — do not reorder.
 */
exports.MOBILE_CSS = [base_css_ts_1.BASE_CSS, layout_css_ts_1.LAYOUT_CSS, compat_css_ts_1.COMPAT_CSS, misc_css_ts_1.MISC_CSS, home_css_ts_1.HOME_CSS, header_css_ts_1.HEADER_CSS, composer_css_ts_1.COMPOSER_CSS, info_css_ts_1.INFO_CSS].join('\n');
};
__modules["debug.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installDebugBadge = installDebugBadge;
/**
 * Debug badge — ?mobile-nav-debug=1
 * Renders a live state overlay (URL, viewport, media queries, shell chrome,
 * aionui columns, genui cards, captured errors) so a phone-side repro can be
 * diagnosed without guessing. No-op unless the query param is present.
 */
function installDebugBadge(ctx) {
    /**
     * Fake safe-area inset — ?mobile-nav-inset=54 or ?mobile-nav-inset=54,34
     * env(safe-area-inset-*) is hard 0 on every desktop browser (CDP included),
     * so notch bugs are invisible until a real phone loads the page — the S2.1
     * hotfix exists because of exactly that. Overriding --mnav-sat / --mnav-sab
     * (see styles/base.css.ts) on the root element reproduces a notch anywhere.
     * No param = the variables keep their env() values = zero behaviour change.
     *
     * One value fakes the TOP inset only (the historic behaviour — every S1-S3
     * verification recipe passes `=54`, and they must keep meaning what they
     * did). A second, comma-separated value fakes the BOTTOM inset too:
     * `=54,34` is the iPhone notch + home-indicator pair. The bottom half was
     * added in S4.1 because the home-bar padding it guards (composer clearance
     * over the indicator) is otherwise untestable off-device for exactly the
     * same reason the top half exists.
     */
    ctx.effect(() => {
        const raw = new URLSearchParams(location.search).get('mobile-nav-inset');
        if (raw === null)
            return () => { };
        const [topRaw, bottomRaw] = raw.split(',');
        const top = Number(topRaw);
        if (!Number.isFinite(top))
            return () => { };
        const root = document.documentElement;
        root.style.setProperty('--mnav-sat', `${top}px`);
        const bottom = bottomRaw === undefined ? Number.NaN : Number(bottomRaw);
        if (Number.isFinite(bottom))
            root.style.setProperty('--mnav-sab', `${bottom}px`);
        return () => {
            root.style.removeProperty('--mnav-sat');
            root.style.removeProperty('--mnav-sab');
        };
    }, 'dsh-mobile-nav: fake safe-area inset');
    /**
     * No-URL toggle — 5 quick taps on the home workspace title.
     * A standalone PWA has no address bar, and the paired-device cookie lives
     * in the PWA's own jar (Safari hits the pairing wall instead), so the
     * ?mobile-nav-debug=1 param is unreachable exactly where the badge is
     * needed most. Five taps within 2.5s on [data-mobile-nav="ws-switch"]
     * flip a localStorage flag and reload.
     */
    ctx.effect(() => {
        let taps = 0;
        let firstTap = 0;
        const onTap = (event) => {
            if (!(event.target instanceof Element))
                return;
            if (event.target.closest('[data-mobile-nav="ws-switch"]') === null)
                return;
            const now = Date.now();
            if (now - firstTap > 2500) {
                taps = 0;
                firstTap = now;
            }
            taps += 1;
            if (taps >= 5) {
                const key = 'dsh-mobile-nav.debug';
                if (localStorage.getItem(key) === '1')
                    localStorage.removeItem(key);
                else
                    localStorage.setItem(key, '1');
                location.reload();
            }
        };
        document.addEventListener('click', onTap, true);
        return () => document.removeEventListener('click', onTap, true);
    }, 'dsh-mobile-nav: debug badge tap toggle');
    ctx.effect(() => {
        const enabled = new URLSearchParams(location.search).has('mobile-nav-debug')
            || localStorage.getItem('dsh-mobile-nav.debug') === '1';
        if (!enabled)
            return () => { };
        const errors = [];
        const onError = (event) => errors.push(`ERR ${event.message.slice(0, 120)}`);
        const onRejection = (event) => errors.push(`REJ ${String(event.reason).slice(0, 120)}`);
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
        /* Probe element: reads the REAL env(safe-area-inset-*) as computed padding
           — the --mnav-* vars can be faked by the inset param, this cannot. */
        const probe = document.createElement('div');
        probe.style.cssText =
            'position:fixed;visibility:hidden;pointer-events:none;' +
                'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
        document.body.appendChild(probe);
        const badge = document.createElement('div');
        badge.style.cssText = [
            'position:fixed', 'top:40px', 'right:6px', 'z-index:2147483000',
            'background:rgba(0,0,0,.82)', 'color:#fff', 'font:11px/1.5 ui-monospace,monospace',
            'padding:8px 10px', 'border-radius:8px', 'max-width:94vw', 'max-height:70vh',
            'overflow:auto', 'white-space:pre-wrap', 'pointer-events:none',
        ].join(';');
        const read = () => {
            const q = (sel) => !!document.querySelector(sel);
            const vis = (sel) => {
                const el = document.querySelector(sel);
                return el === null ? 'absent' : getComputedStyle(el).visibility;
            };
            const frame = document.querySelector('[data-mobile-nav="frame"]');
            return [
                `URL ${location.pathname}${location.search}`,
                `W ${innerWidth} x ${innerHeight} dpr ${devicePixelRatio}`,
                `mq≤1023 ${matchMedia('(max-width: 1023px)').matches}  mq≥1024 ${matchMedia('(min-width: 1024px)').matches}`,
                `css ${q('style[data-plugin-css*="mobile"]')}  frame ${!!frame}`,
                `previewCol ${vis('[data-aionui-preview-col]')}  explorerCol ${vis('[data-aionui-explorer-col]')}`,
                `previewOpen ${frame?.hasAttribute('data-aionui-preview-open') ?? '?'}  explorerOpen ${frame?.hasAttribute('data-aionui-explorer-open') ?? '?'}  previewFull ${frame?.hasAttribute('data-mobile-preview-full') ?? '?'}`,
                `header ${vis('[data-phase] header')} h${Math.round(document.querySelector('[data-phase] header')?.getBoundingClientRect().height ?? 0)}  composer ${q('textarea')}`,
                `sat ${getComputedStyle(document.documentElement).getPropertyValue('--mnav-sat').trim() || '?'}  sab ${getComputedStyle(document.documentElement).getPropertyValue('--mnav-sab').trim() || '?'}`,
                (() => {
                    /* Bottom-gap forensics: real env values + who ends where. */
                    const ps = getComputedStyle(probe);
                    const bottomOf = (sel) => {
                        const el = document.querySelector(sel);
                        return el === null ? '—' : String(Math.round(el.getBoundingClientRect().bottom));
                    };
                    return [
                        `env sat ${ps.paddingTop} sab ${ps.paddingBottom}`,
                        `vh ${innerHeight} vv ${Math.round(window.visualViewport?.height ?? -1)}`,
                        `botFrame ${bottomOf('[data-mobile-nav="frame"]')} composer ${bottomOf('[data-phase] textarea')}`,
                        `botList ${bottomOf('[data-mobile-nav="home-list"]')} fab ${bottomOf('[data-mobile-nav="home-fab"]')}`,
                        `cssLen ${document.querySelector('style[data-plugin-css*="mobile"]')?.textContent?.length ?? 0}`,
                    ].join('\n');
                })(),
                `genui cards ${document.querySelectorAll('[data-genui]').length}  panel ${q('[data-genui-panel]')}`,
                `phase ${document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? '?'}`,
                `errs ${errors.slice(-5).join(' | ') || 'none'}`,
            ].join('\n');
        };
        /* Feedback-loop guards: painting the badge mutates the body subtree the
           observer watches — without these two checks the observer retriggers
           itself forever and freezes the page (the badge was rarely actually
           enabled before, which is how this survived). */
        const paint = () => {
            const next = read();
            if (next !== badge.textContent)
                badge.textContent = next;
        };
        paint();
        const observer = new MutationObserver((mutations) => {
            if (mutations.every((m) => m.target === badge || badge.contains(m.target) || m.target === probe))
                return;
            paint();
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        const timer = setInterval(paint, 1500);
        document.body.appendChild(badge);
        return () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
            observer.disconnect();
            clearInterval(timer);
            probe.remove();
            badge.remove();
        };
    }, 'dsh-mobile-nav: debug badge');
}
};
__modules["effects/phone-chrome.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installPhoneChrome = installPhoneChrome;
/**
 * Phone chrome: KEEP the system status bar (no fullscreen) and make it
 * blend into the page. On narrow screens:
 * - The viewport meta gains viewport-fit=cover, so env(safe-area-inset-top)
 *   is the real status-bar / notch height and the stylesheet can push every
 *   surface below it (off notched phones, or in a browser tab where the
 *   layout viewport already sits below the status bar, the inset is 0 and
 *   nothing shifts).
 * - A theme-color meta tracks the shell background (the official theme is
 *   toggled by body[data-ds-dark-theme], which flips --dsw-alias-bg-base):
 *   Android then paints the status bar / URL bar with the page's own base
 *   color, so the status bar reads as part of the UI instead of a foreign
 *   strip. The drawer paints the same strip on iOS / notch displays.
 * - gesturestart is suppressed as the legacy-iOS fallback for double-tap
 *   zoom; modern browsers are covered by the stylesheet's
 *   touch-action: manipulation (which keeps pan and pinch zoom).
 */
function installPhoneChrome(ctx) {
    ctx.effect(() => {
        const narrow = window.matchMedia('(max-width: 1023px)');
        const viewport = document.querySelector('meta[name="viewport"]');
        const originalViewport = viewport?.content ?? '';
        const themeMeta = document.createElement('meta');
        themeMeta.name = 'theme-color';
        const bodyBg = () => getComputedStyle(document.body).backgroundColor;
        const sync = () => {
            if (viewport !== null)
                viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
            themeMeta.content = bodyBg();
            if (themeMeta.parentElement === null)
                document.head.appendChild(themeMeta);
        };
        const restore = () => {
            if (viewport !== null)
                viewport.content = originalViewport;
            themeMeta.remove();
        };
        const onGestureStart = (event) => event.preventDefault();
        if (narrow.matches)
            sync();
        const onChange = (event) => (event.matches ? sync() : restore());
        narrow.addEventListener('change', onChange);
        const observer = new MutationObserver(() => {
            if (narrow.matches)
                themeMeta.content = bodyBg();
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
        document.addEventListener('gesturestart', onGestureStart);
        return () => {
            narrow.removeEventListener('change', onChange);
            observer.disconnect();
            document.removeEventListener('gesturestart', onGestureStart);
            restore();
        };
    }, 'dsh-mobile-nav: status bar theme + viewport + zoom guard');
}
};
__modules["effects/aionui-compat.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installAionuiCompat = installAionuiCompat;
/** dsh-web-ui 兼容：explorer / preview 列的显隐标记与升起动画（同域同机制，合并一处）。 */
function installAionuiCompat(ctx) {
    // dsh-web-ui compatibility: the aionui explorer column would render as a
    // sheet over the whole mobile UI whenever its (persisted) expanded state
    // is active — including right after a reload, with no way out (the
    // suite's floating expand button only exists while collapsed). Instead
    // of fighting the suite's store timing, the mobile stylesheet keeps the
    // explorer column hidden by default and the header's Files action (plus
    // the drawer footer entry) opens it via the `data-aionui-explorer-open`
    // marker on the frame. This effect just clears that marker when the
    // sheet's own collapse chevron is tapped, so closing is symmetric with
    // opening.
    ctx.effect(() => {
        // Arm on the CURRENT width and re-arm on every width change: the guard
        // used to run once at apply time, so a wide→narrow transition (desktop
        // resize, tablet split view) left the markers dead and the explorer /
        // preview sheets could neither open nor close properly.
        const narrow = window.matchMedia('(max-width: 1023px)');
        let cleanup;
        const install = () => {
            cleanup?.();
            if (!narrow.matches) {
                cleanup = undefined;
                return;
            }
            const onChevronClick = (event) => {
                const target = event.target;
                if (target === null || !target.closest('.aionui-collapse-chevron'))
                    return;
                document.querySelector('[data-mobile-nav="frame"]')?.removeAttribute('data-aionui-explorer-open');
            };
            document.addEventListener('click', onChevronClick, true);
            cleanup = () => document.removeEventListener('click', onChevronClick, true);
        };
        install();
        narrow.addEventListener('change', install);
        return () => {
            narrow.removeEventListener('change', install);
            cleanup?.();
        };
    }, 'dsh-mobile-nav: aionui explorer close marker');
    // dsh-web-ui compatibility: the aionui preview column persists its open
    // tabs in localStorage and restores them on load, which would pop the
    // preview sheet over the fresh UI after a reload. Gate it like the
    // explorer: the stylesheet keeps the column hidden unless the frame
    // carries `data-aionui-preview-open`; this effect sets that marker when
    // the user actually taps a file row in the explorer sheet, and clears it
    // whenever the suite hides the column again (collapse chevron / tab
    // close), so a restored-but-unwanted sheet never appears.
    ctx.effect(() => {
        // Arm on the CURRENT width and re-arm on every width change (see the
        // explorer marker effect for why).
        const narrow = window.matchMedia('(max-width: 1023px)');
        let cleanup;
        const install = () => {
            cleanup?.();
            if (!narrow.matches) {
                cleanup = undefined;
                return;
            }
            const frame = () => document.querySelector('[data-mobile-nav="frame"]');
            // Closing the preview sheet also drops the fullscreen marker, so the
            // next preview starts in the sheet layout again.
            const closePreview = () => {
                frame()?.removeAttribute('data-aionui-preview-open');
                frame()?.removeAttribute('data-mobile-preview-full');
            };
            const onTap = (event) => {
                const target = event.target;
                if (target === null)
                    return;
                const row = target.closest('[data-aionui-explorer-col] [class*="_treeRow"]');
                if (row === null)
                    return;
                // Only FILE rows open the preview sheet. Directory rows toggle
                // expansion and must not pop the (possibly stale, restored-from-
                // localStorage) preview tab over the tree. Substring matching:
                // the suite's hashed classes carry a hash prefix, so the exact-token
                // `class~=` form never matches and the trailing `$=` form misses
                // selected rows (`_treeRowSelected`) and open arrows
                // (`_treeArrowOpen`) — regressions of issue #8. The arrow gate must
                // additionally exclude the leaf marker: FILE rows render a
                // `_treeArrowEmpty` span whose class still contains the `_treeArrow`
                // substring, so a bare substring match would treat every row as a
                // directory and no preview would ever open.
                if (row.querySelector('[class*="_treeArrow"]:not([class*="_treeArrowEmpty"])') !== null)
                    return;
                frame()?.setAttribute('data-aionui-preview-open', '');
            };
            // The preview sheet's own collapse button (the two inward arrows in the
            // tab bar) closes the AionUI store, but on mobile the suite's layout sync
            // can be skipped while its shell-track mirror is not ready yet — in that
            // case the inline visibility never flips to hidden and the visibility
            // watcher below would never clear our marker. Clear it directly on the
            // button click so the sheet always closes regardless of the suite's sync.
            const onCollapse = (event) => {
                const target = event.target;
                if (target === null)
                    return;
                if (target.closest('[data-aionui-preview-col] [class$="_panelCollapse"]') !== null) {
                    closePreview();
                }
            };
            const sync = () => {
                const pv = document.querySelector('[data-aionui-preview-col]');
                if (pv === null)
                    return;
                // Read the suite's inline visibility, not the computed value: while the
                // `data-aionui-preview-open` marker is present our stylesheet forces the
                // sheet visible with !important, so getComputedStyle() would never report
                // hidden and the marker would never be cleared.
                if (pv.style.visibility === 'hidden')
                    closePreview();
            };
            document.addEventListener('click', onTap, true);
            document.addEventListener('click', onCollapse, true);
            const observer = new MutationObserver(sync);
            observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style'] });
            sync();
            cleanup = () => {
                document.removeEventListener('click', onTap, true);
                document.removeEventListener('click', onCollapse, true);
                observer.disconnect();
            };
        };
        install();
        narrow.addEventListener('change', install);
        return () => {
            narrow.removeEventListener('change', install);
            cleanup?.();
        };
    }, 'dsh-mobile-nav: preview sheet open marker');
    // The dsh-web-ui explorer / preview columns toggle via `visibility`
    // (their inline style), which never restarts a CSS animation — so the
    // sheets would only animate on first mount. Replay the rise animation
    // with the Web Animations API each time a column turns visible, then
    // leave the resting state to the stylesheet.
    ctx.effect(() => {
        // Arm on the CURRENT width and re-arm on every width change (see the
        // explorer marker effect for why).
        const narrow = window.matchMedia('(max-width: 1023px)');
        let cleanup;
        const install = () => {
            cleanup?.();
            if (!narrow.matches) {
                cleanup = undefined;
                return;
            }
            const cols = ['[data-aionui-explorer-col]', '[data-aionui-preview-col]'];
            const seen = new Map();
            const play = (el) => {
                el.animate([
                    { opacity: 0, transform: 'translateY(28px)' },
                    { opacity: 1, transform: 'none' },
                ], { duration: 280, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' });
            };
            const check = () => {
                for (const sel of cols) {
                    const el = document.querySelector(sel);
                    if (el === null)
                        continue;
                    const visible = getComputedStyle(el).visibility === 'visible';
                    const prev = seen.get(sel) ?? false;
                    if (visible && !prev)
                        play(el);
                    seen.set(sel, visible);
                }
            };
            const observer = new MutationObserver(check);
            // Visibility flips come through inline style mutations (suite) or the
            // explorer-open marker on the frame; class changes are watched too.
            observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style', 'class', 'data-aionui-explorer-open'] });
            check();
            cleanup = () => {
                observer.disconnect();
            };
        };
        install();
        narrow.addEventListener('change', install);
        return () => {
            narrow.removeEventListener('change', install);
            cleanup?.();
        };
    }, 'dsh-mobile-nav: sheet rise animation replay');
}
};
__modules["effects/header-status.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installHeaderStatusDot = installHeaderStatusDot;
const session_dot_ts_1 = require("./session-dot.js");
/**
 * Session header running-status dot (S2). No official element exists to
 * reposition (ConversationSessionHeader renders only the crumb title, the
 * actions/utilities slots, and the tablist — dsh-client-ui-conversation
 * lib/client.js:6949-7009), so this reads `ctx.sessions.list` directly
 * (the same feed `useSessions` wraps) and stamps a data attribute the
 * mobile stylesheet turns into a `::after` dot on the title crumb —
 * "read data, self-draw" is the plan's documented fallback for this piece.
 * Kept outside React: the dot must track the CURRENT session regardless of
 * which component the header happens to mount, and a plain attribute +
 * CSS avoids reaching into the official crumb's own DOM subtree.
 */
function installHeaderStatusDot(ctx) {
    ctx.effect(() => {
        const apply = () => {
            const frame = document.querySelector('[data-mobile-nav="frame"]');
            if (frame === null)
                return;
            const { current, byId } = ctx.sessions.list.getSnapshot();
            const row = current === undefined ? undefined : byId[current];
            const state = row === undefined ? undefined : (0, session_dot_ts_1.dotState)(row);
            if (state === undefined)
                frame.removeAttribute('data-mobile-nav-dot');
            else
                frame.setAttribute('data-mobile-nav-dot', state);
        };
        apply();
        return ctx.sessions.list.subscribe(apply);
    }, 'dsh-mobile-nav: header status dot');
}
};
__modules["effects/gestures.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installGestures = installGestures;
const MobileSessionHeader_tsx_1 = require("./MobileSessionHeader.js");
/** Phone breakpoint — same query every phone-only effect in this plugin uses. */
const PHONE_QUERY = '(max-width: 767px)';
/** The official message scroll region (AGENTS.md: the real scroller behind
 * `data-chat-flow`, not ChatView's own `.scroll` which the suite forces to
 * `overflow: visible`). Scoped with `[data-phase]` exactly like every other
 * reader of this element in styles/layout.css.ts and styles/home.css.ts. */
const CONTENT_SELECTOR = '[data-phase] [class$="_scrollBody"]';
/** The sticky composer footer lives INSIDE the scroll body (AGENTS.md
 * S4.1 pitfall); a horizontal drag started on the input itself must not be
 * read as a page-turn gesture. */
const COMPOSER_SEAT_SELECTOR = '[class$="_composerSeat"]';
/** This plugin's two dismissible sheets (session-info, home workspace
 * picker). Official popupSelect menus (permission/model) are deliberately
 * excluded — the design spec leaves those mask-tap-only. */
const SHEET_SELECTOR = '[data-mobile-nav="info-sheet"], [data-mobile-nav="home-sheet"]';
/** Every dismissible surface this plugin or the official suite can have
 * open at once. Content-area swipe must not fight a control underneath one
 * of these — both of our own sheets render unconditionally (React returns
 * null when closed, see MobileSessionInfo.tsx / MobileHome.tsx), so their
 * presence in the DOM IS their open state, no extra tracking needed. */
function anyOverlayOpen() {
    return document.querySelector('[data-mobile-nav="info-layer"], [data-mobile-nav="home-sheet-layer"], [role="menu"], [aria-modal="true"]') !== null;
}
/**
 * Walks from `el` up to (not including) `boundary`, true if any ancestor
 * can itself scroll horizontally — code blocks, wide tables, the stats
 * strip's own horizontal scroller. Generic scrollWidth/overflow-x check
 * rather than hardcoding selectors: covers every "chip row" and markdown
 * element in this stylesheet without keeping a duplicate list in sync.
 */
function hasHorizontalScrollAncestor(el, boundary) {
    let node = el;
    while (node !== null && node !== boundary) {
        if (node.scrollWidth > node.clientWidth + 1) {
            const overflowX = getComputedStyle(node).overflowX;
            if (overflowX === 'auto' || overflowX === 'scroll')
                return true;
        }
        node = node.parentElement;
    }
    return false;
}
const SWIPE_MIN_DX = 60;
const SWIPE_RATIO = 1.6;
/** pwa's edge-swipe-back hot zone (dsh-mobile-pwa touch-gestures.js) — never ours to take. */
const EDGE_GUARD = 24;
/**
 * S6.1 — content-area swipe: a horizontal drag across the message scroll
 * region switches Chat/Trajectory by clicking the official (hidden)
 * tablist, the same "no public setView" workaround MobileSessionHeader.tsx
 * already uses for the header's own view row (design doc Appendix C).
 *
 * Passive, and this never calls preventDefault — the whole gesture is
 * decided from the touchstart/touchend endpoints, never mid-drag, so
 * vertical scrolling of the message list is completely unaffected. With
 * exactly two views, "the other tab" is the only possible target regardless
 * of swipe direction, so direction never needs to be computed — this
 * mirrors MobileHeaderActions' own `tabs.find((tab) => !tab.active)`.
 */
function installContentSwipe(ctx) {
    ctx.effect(() => {
        const narrow = window.matchMedia(PHONE_QUERY);
        let start = null;
        const onTouchStart = (event) => {
            if (event.touches.length !== 1) {
                start = null;
                return;
            }
            const touch = event.touches[0];
            const target = event.target;
            if (touch === undefined || !(target instanceof Element)) {
                start = null;
                return;
            }
            const contentEl = target.closest(CONTENT_SELECTOR);
            const eligible = contentEl !== null
                && touch.clientX >= EDGE_GUARD
                && target.closest(COMPOSER_SEAT_SELECTOR) === null
                && !anyOverlayOpen()
                && !hasHorizontalScrollAncestor(target, contentEl);
            start = { x: touch.clientX, y: touch.clientY, eligible };
        };
        const onTouchEnd = (event) => {
            const state = start;
            start = null;
            if (state === null || !state.eligible)
                return;
            const touch = event.changedTouches[0];
            if (touch === undefined)
                return;
            const dx = touch.clientX - state.x;
            const dy = touch.clientY - state.y;
            if (Math.abs(dx) <= SWIPE_MIN_DX || Math.abs(dx) <= SWIPE_RATIO * Math.abs(dy))
                return;
            (0, MobileSessionHeader_tsx_1.readViewTabs)().find((tab) => !tab.active)?.el.click();
        };
        const attach = () => {
            document.addEventListener('touchstart', onTouchStart, { passive: true });
            document.addEventListener('touchend', onTouchEnd, { passive: true });
        };
        const detach = () => {
            document.removeEventListener('touchstart', onTouchStart);
            document.removeEventListener('touchend', onTouchEnd);
            start = null;
        };
        if (narrow.matches)
            attach();
        const onChange = (event) => (event.matches ? attach() : detach());
        narrow.addEventListener('change', onChange);
        return () => {
            narrow.removeEventListener('change', onChange);
            detach();
        };
    }, 'dsh-mobile-nav: content-area swipe (Chat/Trajectory)');
}
const CLOSE_DISTANCE = 80;
/** px/ms — a fast flick closes the sheet even short of CLOSE_DISTANCE. */
const CLOSE_VELOCITY = 0.5;
/** Below this the drag is a tap/jitter, not yet a pull — avoids hijacking
 * the very first pixels of an upward scroll inside the sheet. */
const DRAG_COMMIT_PX = 4;
function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
/** The sheet's own mask sibling — both this plugin's sheets name theirs
 * with a "-mask" suffix (info-mask, home-sheet-mask) and already wire a
 * click handler that calls the sheet's close(). Reusing that handler (a
 * synthetic click) needs no access to the sheet's React state at all. */
function closeSheet(sheet) {
    sheet.parentElement?.querySelector('[data-mobile-nav$="-mask"]')?.click();
}
/**
 * S6.2 — sheet drag-to-close: this plugin's two own bottom sheets (session
 * info, home workspace picker) support "drag down to dismiss", mirroring
 * the mask-tap close they already have. Official popupSelect menus
 * (permission/model) are excluded on purpose — the design spec leaves them
 * mask-tap-only, and they are the suite's own DOM, not ours to add gesture
 * handling to.
 *
 * touchmove is registered non-passive (unlike the content swipe above)
 * because this gesture needs to preventDefault once it takes over, so the
 * sheet's own translateY tracks the finger instead of fighting the
 * scroller's native rubber-band. Before that handoff — while the sheet's
 * inner content isn't scrolled to top — nothing is intercepted at all, so
 * a pull down first scrolls the content as normal (spec requirement).
 */
function installSheetDragClose(ctx) {
    ctx.effect(() => {
        const narrow = window.matchMedia(PHONE_QUERY);
        let drag = null;
        const settle = (sheet, close) => {
            if (close) {
                sheet.style.transform = '';
                sheet.style.transition = '';
                closeSheet(sheet);
                return;
            }
            if (prefersReducedMotion()) {
                sheet.style.transition = 'none';
                sheet.style.transform = '';
                return;
            }
            sheet.style.transition = 'transform .22s var(--ds-ease-out, ease-in-out)';
            sheet.style.transform = '';
            const clear = () => {
                sheet.style.transition = '';
                sheet.removeEventListener('transitionend', clear);
            };
            sheet.addEventListener('transitionend', clear);
        };
        const onTouchStart = (event) => {
            if (event.touches.length !== 1) {
                drag = null;
                return;
            }
            const touch = event.touches[0];
            const target = event.target;
            if (touch === undefined || !(target instanceof Element)) {
                drag = null;
                return;
            }
            const sheet = target.closest(SHEET_SELECTOR);
            if (sheet === null) {
                drag = null;
                return;
            }
            drag = { sheet, startY: touch.clientY, lastY: touch.clientY, startTime: Date.now(), dragging: false };
        };
        const onTouchMove = (event) => {
            if (drag === null)
                return;
            const touch = event.touches[0];
            if (touch === undefined)
                return;
            drag.lastY = touch.clientY;
            const dy = touch.clientY - drag.startY;
            if (!drag.dragging) {
                if (drag.sheet.scrollTop > 0)
                    return;
                if (dy <= DRAG_COMMIT_PX)
                    return;
                drag.dragging = true;
                drag.sheet.style.transition = 'none';
            }
            event.preventDefault();
            drag.sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
        };
        const finish = () => {
            if (drag === null)
                return;
            const { sheet, dragging, startY, lastY, startTime } = drag;
            drag = null;
            if (!dragging)
                return;
            const dy = Math.max(0, lastY - startY);
            const elapsed = Math.max(1, Date.now() - startTime);
            const velocity = dy / elapsed;
            settle(sheet, dy > CLOSE_DISTANCE || velocity > CLOSE_VELOCITY);
        };
        const attach = () => {
            document.addEventListener('touchstart', onTouchStart, { passive: true });
            document.addEventListener('touchmove', onTouchMove, { passive: false });
            document.addEventListener('touchend', finish, { passive: true });
            document.addEventListener('touchcancel', finish, { passive: true });
        };
        const detach = () => {
            document.removeEventListener('touchstart', onTouchStart);
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', finish);
            document.removeEventListener('touchcancel', finish);
            drag = null;
        };
        if (narrow.matches)
            attach();
        const onChange = (event) => (event.matches ? attach() : detach());
        narrow.addEventListener('change', onChange);
        return () => {
            narrow.removeEventListener('change', onChange);
            detach();
        };
    }, 'dsh-mobile-nav: sheet drag-to-close');
}
/** S6: the two-gesture set — content-area swipe and sheet drag-to-close.
 * Both install/uninstall their own document listeners on the phone
 * breakpoint's matchMedia change, so at >= 768px this is a true no-op (no
 * listeners attached at all), matching every other effect in this file. */
function installGestures(ctx) {
    installContentSwipe(ctx);
    installSheetDragClose(ctx);
}
};
__modules["locales.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
/** `mobileNav` namespace dictionaries: drawer controls. */
exports.NS = 'mobileNav';
/** Simplified Chinese dictionary (the key-set source of truth). */
exports.zh = {
    'open': '打开目录',
    'close': '收起目录',
    'backdrop': '点击关闭目录',
    'sessionLog': '导出会话日志',
    'files': '文件浏览',
    'previewFullscreen': '全屏预览',
    'previewExitFullscreen': '退出全屏',
    'allWorkspaces': '全部',
    'switchWorkspace': '切换工作区',
    'newSession': '新建会话',
    'noSessions': '还没有会话，点右下角加号开始',
    'homeStatusOngoing': '运行中',
    'homeStatusWarning': '待处理',
    'homeStatusDone': '已完成',
    'backToList': '返回会话列表',
    'sessionInfo': '会话信息',
    'workbench': '工作台',
    'workbenchClose': '关闭工作台',
    'switchView': '切换视图',
    'attach': '添加附件',
    'attachPending': '附件上传即将上线',
    'infoClose': '关闭',
    'infoMode': '模式',
    'infoCwdFallback': '未知目录',
    'infoSubagents': '{count} 个子代理',
    'infoStatTurns': '轮次',
    'infoStatSteps': '步骤',
    'infoStatTtft': '首字延迟',
    'infoStatLlm': '模型耗时',
    'infoStatTool': '工具耗时',
    'infoStatTokens': 'Token',
    'infoCacheHit': '缓存 {percent}%',
    'infoExport': '导出日志',
    'infoRename': '重命名',
    'infoRenamePrompt': '会话新名称',
    'infoFork': 'Fork 会话',
    'infoArchive': '归档',
    'infoArchiveConfirm': '归档后将从会话列表隐藏，确定继续？',
    'infoActionError': '操作失败：{message}',
};
/** English dictionary, key-identical to the Chinese source of truth. */
exports.en = {
    'open': 'Open directory',
    'close': 'Close directory',
    'backdrop': 'Click to close directory',
    'sessionLog': 'Session log',
    'files': 'Files',
    'previewFullscreen': 'Fullscreen preview',
    'previewExitFullscreen': 'Exit fullscreen',
    'allWorkspaces': 'All',
    'switchWorkspace': 'Switch workspace',
    'newSession': 'New session',
    'noSessions': 'No sessions yet — tap + to start one',
    'homeStatusOngoing': 'Running',
    'homeStatusWarning': 'Needs attention',
    'homeStatusDone': 'Done',
    'backToList': 'Back to sessions',
    'sessionInfo': 'Session info',
    'workbench': 'Workbench',
    'workbenchClose': 'Close workbench',
    'switchView': 'Switch view',
    'attach': 'Add attachment',
    'attachPending': 'Attachments coming soon',
    'infoClose': 'Close',
    'infoMode': 'Mode',
    'infoCwdFallback': 'Unknown directory',
    'infoSubagents': '{count} subagents',
    'infoStatTurns': 'Turns',
    'infoStatSteps': 'Steps',
    'infoStatTtft': 'TTFT',
    'infoStatLlm': 'LLM time',
    'infoStatTool': 'Tool time',
    'infoStatTokens': 'Tokens',
    'infoCacheHit': 'Cache {percent}%',
    'infoExport': 'Export log',
    'infoRename': 'Rename',
    'infoRenamePrompt': 'New session name',
    'infoFork': 'Fork session',
    'infoArchive': 'Archive',
    'infoArchiveConfirm': 'Archiving hides this session from the list. Continue?',
    'infoActionError': 'Action failed: {message}',
};
};
__modules["index.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const MobileNavToggle_tsx_1 = require("./MobileNavToggle.js");
const MobileNavOverlay_tsx_1 = require("./MobileNavOverlay.js");
const MobileDrawerFooter_tsx_1 = require("./MobileDrawerFooter.js");
const MobileHome_tsx_1 = require("./MobileHome.js");
const MobileSessionHeader_tsx_1 = require("./MobileSessionHeader.js");
const MobileSessionInfo_tsx_1 = require("./MobileSessionInfo.js");
const MobileAttachButton_tsx_1 = require("./MobileAttachButton.js");
const nav_store_ts_1 = require("./nav-store.js");
const index_ts_1 = require("./styles/index.js");
const debug_ts_1 = require("./debug.js");
const phone_chrome_ts_1 = require("./effects/phone-chrome.js");
const aionui_compat_ts_1 = require("./effects/aionui-compat.js");
const header_status_ts_1 = require("./effects/header-status.js");
const gestures_ts_1 = require("./effects/gestures.js");
const locales_ts_1 = require("./locales.js");
/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
exports.inject = ['slots', 'layout', 'locale', 'sessionLogDownload', 'sessions', 'workspaces'];
/**
 * Mobile-adaptive shell, browser half: injects the mobile stylesheet, then
 * contributes the directory toggle to the session header and the backdrop +
 * floating button to the shell overlay.
 * @param ctx - client root context.
 */
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(locales_ts_1.NS, { zh: locales_ts_1.zh, en: locales_ts_1.en }), 'dsh-mobile-nav: dictionaries');
    ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@dsh-external/dsh-mobile-nav';
        tag.dataset.pluginCss = '@dsh-external/dsh-mobile-nav/mobile.css';
        tag.textContent = index_ts_1.MOBILE_CSS;
        document.head.appendChild(tag);
        return () => {
            tag.remove();
        };
    }, 'dsh-mobile-nav: styles');
    // Diagnostic overlay for phone-side repros (?mobile-nav-debug=1).
    (0, debug_ts_1.installDebugBadge)(ctx);
    (0, phone_chrome_ts_1.installPhoneChrome)(ctx);
    (0, aionui_compat_ts_1.installAionuiCompat)(ctx);
    // Session header running-status dot (S2): no official element exists to
    // reposition, so this reads ctx.sessions directly and self-draws via CSS.
    (0, header_status_ts_1.installHeaderStatusDot)(ctx);
    // S6: content-area swipe (Chat/Trajectory) + sheet drag-to-close.
    (0, gestures_ts_1.installGestures)(ctx);
    // Page-stack store (apply world) — created before any registration so
    // every slot below (the phone home screen, the session header's back
    // button) shares the exact same handle/instance.
    const nav = (0, nav_store_ts_1.createNavStore)();
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'mobile-nav-toggle',
        order: 10,
        locale: locales_ts_1.NS,
        inject: () => ({
            toggleSidebar: () => ctx.layout.toggleSidebar(),
        }),
    }, MobileNavToggle_tsx_1.MobileNavToggle));
    // Session header back button + Chat/Trajectory view-switch row (S2).
    // Renders unconditionally; CSS (styles/header.css.ts) keeps it hidden at
    // >= 768px. Order is irrelevant here — the phone stylesheet hides every
    // other header.actions entry and only re-shows this one.
    //
    // No `store: nav` here: this slot is session-scope while `nav` already
    // mounts at shell.overlay's root scope, and a handle can only mount
    // under one scope (runtime throws otherwise — see nav-store.ts). The
    // back button dispatches GO_HOME_EVENT and MobileHome applies it.
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'mobile-header-actions',
        order: 0,
        locale: locales_ts_1.NS,
    }, MobileSessionHeader_tsx_1.MobileHeaderActions));
    // Session-info entry (placeholder — S4 owns the sheet) + workbench entry
    // (dsh-better-sidebar, see MobileSessionHeader.tsx for the trigger).
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'mobile-header-utilities',
        order: 0,
        locale: locales_ts_1.NS,
    }, MobileSessionHeader_tsx_1.MobileHeaderUtilities));
    // Session-info sheet (S4): a second, sibling entry on the SAME slot as
    // the ⓘ button above — it listens for the CustomEvent that button fires
    // instead of sharing render state with it. Session scope gives this
    // entry useProjection/sessionId (the stats grid) for free alongside the
    // always-present useSessions/useWorkspaces (see MobileSessionInfo.tsx's
    // header comment for the full mount-point tradeoff against shell.overlay).
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'mobile-session-info',
        order: 10,
        locale: locales_ts_1.NS,
        // The factory's own sessionId param is unused: every function below
        // takes its own session id explicitly (they're generic action bindings
        // reused verbatim, not closures over one particular session).
        inject: (_sessionId) => ({
            forkSession: (id) => ctx.sessions.fork({ sessionId: id }),
            openSession: (id) => ctx.sessions.open(id),
            renameSession: (id, title) => ctx.sessions.binding(id)?.session.rename(title),
            archiveSession: (id) => ctx.workspaces.archiveSession(id),
            downloadSessionLog: (id) => ctx.sessionLogDownload.download(id),
        }),
    }, MobileSessionInfo_tsx_1.MobileSessionInfo));
    // Composer attachment seat (S3 placeholder, S7 wires it to a real picker).
    // Registered unconditionally; styles/composer.css.ts hides it at >= 768px
    // and orders it into the leftmost seat of the phone composer row.
    ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'mobile-attach',
        order: 0,
        locale: locales_ts_1.NS,
    }, MobileAttachButton_tsx_1.MobileAttachButton));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'mobile-nav-overlay',
        order: 10,
        locale: locales_ts_1.NS,
        inject: () => ({
            toggleSidebar: () => ctx.layout.toggleSidebar(),
        }),
    }, MobileNavOverlay_tsx_1.MobileNavOverlay));
    // Phone app shell (< 768px): the full-screen session list that is level 1
    // of the page stack. Owns the `nav` handle created above (root scope);
    // the session header's back button listens for GO_HOME_EVENT instead of
    // sharing the handle directly (see nav-store.ts and the comment above).
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'mobile-home',
        order: 20,
        locale: locales_ts_1.NS,
        store: nav,
        inject: () => ({
            openSession: (id) => ctx.sessions.open(id),
            startSession: (workspaceId) => ctx.workspaces.startSession(workspaceId),
        }),
    }, MobileHome_tsx_1.MobileHome));
    // Session log download, relocated from the session header to the drawer
    // footer on mobile (the header capsule is hidden by CSS); the drawer
    // footer also hosts the Files action that opens the dsh-web-ui explorer
    // sheet.
    //
    // Footer stacking relies on the list-slot sort by (priority, order):
    // dsh-remote-web-ui leaves it unset (default 0, its two icon buttons stay
    // on top) and dsh-usage-stats uses 10. Order 5 keeps the Files + Session
    // log pills directly under the icon row with the usage/balance badge
    // below them — instead of a tie at 10 where registration order could
    // wedge the badge between the icons and the pills.
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'mobile-nav-session-log',
        order: 5,
        locale: locales_ts_1.NS,
        inject: () => ({
            downloadSessionLog: (sessionId) => ctx.sessionLogDownload.download(sessionId),
            toggleSidebar: () => ctx.layout.toggleSidebar(),
        }),
    }, MobileDrawerFooter_tsx_1.MobileDrawerFooter));
}
};
var __cache = {};
function __localRequire(id) {
  if (id.charCodeAt(0) !== 46) return require(id);
  id = id.slice(2);
  var cached = __cache[id];
  if (cached) return cached.exports;
  var module = { exports: {} };
  __cache[id] = module;
  __modules[id](__localRequire, module, module.exports);
  return module.exports;
}
var module = { exports: {} };
__modules["index.js"](__localRequire, module, module.exports);
return module.exports; } });
