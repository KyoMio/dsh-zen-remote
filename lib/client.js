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
exports.GO_HOME_EVENT = void 0;
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
/** Long-press threshold for the FAB's workspace menu. */
const LONG_PRESS_MS = 450;
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
    // FAB press: a tap starts a session in the selected workspace, a long press
    // opens the workspace menu first.
    const timer = (0, react_1.useRef)(null);
    const longPressed = (0, react_1.useRef)(false);
    const cancelPress = () => {
        if (timer.current === null)
            return;
        window.clearTimeout(timer.current);
        timer.current = null;
    };
    (0, react_1.useEffect)(() => cancelPress, []);
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
    return ((0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "home", "data-view": view, "aria-hidden": view === 'session', children: [(0, jsx_runtime_1.jsx)("div", { "data-mobile-nav": "home-top", children: (0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "ws-switch", "aria-haspopup": "menu", onClick: () => setSheet('filter'), children: [(0, jsx_runtime_1.jsx)("span", { children: title }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconChevronDownOutline14, { size: 14 })] }) }), (0, jsx_runtime_1.jsxs)("ul", { "data-mobile-nav": "home-list", children: [rows.map((row) => {
                        const dot = (0, session_dot_ts_1.dotState)(row);
                        return ((0, jsx_runtime_1.jsx)("li", { children: (0, jsx_runtime_1.jsxs)("button", { type: "button", "data-mobile-nav": "home-row", "data-current": row.id === sessions.current ? '' : undefined, onClick: () => enter(() => openSession(row.id)), children: [(0, jsx_runtime_1.jsx)("span", { "data-mobile-nav": "home-row-title", children: row.displayTitle }), (0, jsx_runtime_1.jsxs)("span", { "data-mobile-nav": "home-row-meta", children: [dot !== undefined && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.StateDot, { state: dot, size: 8 }), (0, jsx_runtime_1.jsx)("time", { dateTime: new Date(row.updatedAt).toISOString(), children: relativeTime(row.updatedAt) })] })] }) }, row.id));
                    }), rows.length === 0 && (0, jsx_runtime_1.jsx)("li", { "data-mobile-nav": "home-empty", children: t('noSessions') })] }), (0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "home-fab", "aria-label": t('newSession'), title: t('newSession'), onContextMenu: (event) => event.preventDefault(), onPointerDown: () => {
                    longPressed.current = false;
                    cancelPress();
                    timer.current = window.setTimeout(() => {
                        longPressed.current = true;
                        timer.current = null;
                        setSheet('create');
                    }, LONG_PRESS_MS);
                }, onPointerUp: () => {
                    cancelPress();
                    if (longPressed.current)
                        return;
                    enter(() => startSession(selectedWorkspace?.workspaceId));
                }, onPointerLeave: cancelPress, onPointerCancel: cancelPress, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPlusOutline16, { size: 22 }) }), sheet !== null && ((0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "home-sheet-layer", children: [(0, jsx_runtime_1.jsx)("div", { "data-mobile-nav": "home-sheet-mask", role: "button", tabIndex: -1, "aria-label": t('close'), onClick: () => setSheet(null) }), (0, jsx_runtime_1.jsxs)("div", { "data-mobile-nav": "home-sheet", role: "menu", children: [(0, jsx_runtime_1.jsx)("div", { "data-mobile-nav": "home-sheet-title", children: sheet === 'filter' ? t('switchWorkspace') : t('newSessionIn') }), sheet === 'filter' && ((0, jsx_runtime_1.jsx)("button", { type: "button", role: "menuitem", "data-mobile-nav": "home-sheet-item", "data-selected": selected === 'all' ? '' : undefined, onClick: () => {
                                    actions.filter('all');
                                    setSheet(null);
                                }, children: t('allWorkspaces') })), workspaces.items.map((item) => ((0, jsx_runtime_1.jsx)("button", { type: "button", role: "menuitem", "data-mobile-nav": "home-sheet-item", "data-selected": sheet === 'filter' && selected === item.workspaceId ? '' : undefined, onClick: () => {
                                    if (sheet === 'filter') {
                                        actions.filter(item.workspaceId);
                                        setSheet(null);
                                        return;
                                    }
                                    enter(() => startSession(item.workspaceId));
                                }, children: item.title }, item.workspaceId)))] })] }))] }));
}
};
__modules["MobileSessionHeader.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MobileHeaderActions = MobileHeaderActions;
exports.MobileHeaderUtilities = MobileHeaderUtilities;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
const nav_store_ts_1 = require("./nav-store.js");
/**
 * Reads the official session-header tablist by role/aria only (no hashed
 * classes) — the plan's one sanctioned official-DOM read: ChatStore's view
 * selection has no public setter (design doc Appendix C), so switching
 * views means clicking the official tab button ourselves.
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
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "header-info", "aria-label": t('sessionInfo'), title: t('sessionInfo'), onClick: () => window.dispatchEvent(new CustomEvent('dsh-mobile-nav:session-info')), children: (0, jsx_runtime_1.jsx)("span", { "aria-hidden": "true", children: "\u24D8" }) }), (0, jsx_runtime_1.jsx)("button", { type: "button", "data-mobile-nav": "header-workbench", "aria-label": t('workbench'), title: t('workbench'), onClick: () => {
                    document.querySelector('[data-dsh-better-sidebar] button[class$="_toggleButton"]')?.click();
                }, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconPanelLeftOutline16, { size: 16 }) })] }));
}
};
__modules["styles/base.css.js"] = function (require, module, exports) {
"use strict";
// base — split from src/client/mobile.css.ts (2026-08-16), order preserved.
// Do not reorder: styles/index.ts concatenates in this exact order.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BASE_CSS = void 0;
exports.BASE_CSS = `
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
  top: calc(env(safe-area-inset-top, 0px) + 72px);
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
  [data-mobile-nav="frame"] {
    position: relative !important;
    grid-template-columns: minmax(0, 1fr) 0 0 !important;
    padding-top: env(safe-area-inset-top, 0px) !important;
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
    padding-top: env(safe-area-inset-top, 0px) !important;
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
    top: calc(env(safe-area-inset-top, 0px) + 12px) !important;
    width: calc(100vw - 16px) !important;
    max-width: calc(100vw - 16px) !important;
    /* Height follows the content (no dead space under a short page); it
       caps at 100dvh-24 (less the safe-area top) and the options area
       scrolls only then. */
    height: auto !important;
    max-height: min(800px, calc(100vh - 24px - env(safe-area-inset-top, 0px))) !important;
    max-height: min(800px, calc(100dvh - 24px - env(safe-area-inset-top, 0px))) !important;
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
     viewport: the official centered card can be wider than 390px. */
  [aria-modal="true"]:not(:has(> :first-child > :last-child > button)) {
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
    padding-top: env(safe-area-inset-top, 0px) !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    z-index: 57 !important;
    animation: none !important;
  }
  /* Fullscreen: the column fills the viewport, so the button follows the
     titlebar row down below the notch. */
  [data-mobile-nav="frame"][data-mobile-preview-full] [data-aionui-preview-col] [data-mobile-nav="preview-full-toggle"] {
    top: calc(env(safe-area-inset-top, 0px) + 8px) !important;
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

  /* ---------- dsh-web-ui polish: conversation stats line ----------
     The official session-status row (turns / steps / LLM time / TTFT /
     cache) is long. The client marks the exact row with
     [data-mobile-nav="stats"] (text-anchored, hashed classes can't be
     targeted). Layout: ONE fixed-height (28px) flex strip that scrolls
     horizontally — the full metrics stream stays reachable by swiping,
     the row never grows vertically, no ellipsis or fade, 12px gaps
     between metric groups, a 2px scrollbar as the swipe affordance. */

  [data-mobile-nav="stats"] {
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
  [data-mobile-nav="stats"]::-webkit-scrollbar {
    height: 2px !important;
  }
  [data-mobile-nav="stats"]::-webkit-scrollbar-thumb {
    background: var(--dsw-alias-label-tertiary, rgba(0, 0, 0, .3)) !important;
    border-radius: 2px !important;
  }
  [data-mobile-nav="stats"]::-webkit-scrollbar-track {
    background: transparent !important;
  }
  [data-mobile-nav="stats"] > * {
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
  [data-mobile-nav="stats"] > *:last-child {
    margin-right: 0 !important;
  }
  [data-mobile-nav="stats"] * {
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
    background: var(--dsw-alias-bg-base, #ffffff);
    color: var(--dsw-alias-label-primary, inherit);
    padding-top: env(safe-area-inset-top, 0px);
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

  /* Session list: 60px rows, iOS-style inset separators. */
  [data-mobile-nav="home-list"] {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    padding: 0 0 calc(env(safe-area-inset-bottom, 0px) + 96px);
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
    padding: 8px 16px;
    border: none;
    /* border-l1 is 4% — invisible as a list separator; l2 (10%/12%) is the
       official divider weight and reads in both themes. */
    border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .1));
    background: transparent;
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="home-row"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  }
  [data-mobile-nav="home-row"][data-current] [data-mobile-nav="home-row-title"] {
    font-weight: 600;
  }
  [data-mobile-nav="home-row-title"] {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 16px;
    line-height: 22px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-mobile-nav="home-row-meta"] {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-size: 13px;
    line-height: 18px;
  }
  [data-mobile-nav="home-empty"] {
    padding: 48px 24px;
    color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .5));
    font-size: 15px;
    text-align: center;
  }

  /* New-session FAB: tap starts in the shown workspace, long press picks one. */
  [data-mobile-nav="home-fab"] {
    position: absolute;
    right: 18px;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 22px);
    z-index: 6;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--dsw-alias-state-business-primary, #4f6ef7);
    color: #ffffff;
    cursor: pointer;
    box-shadow: 0 6px 20px rgba(0, 0, 0, .24);
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }
  [data-mobile-nav="home-fab"]:active {
    transform: scale(.94);
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
  [data-mobile-nav="home-sheet"] {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 8px);
    max-height: 70%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    border-radius: 16px;
    /* layer-2, not bg-base: in dark mode the sheet must lift off a page that
       shares bg-base, or only the shadow separates them. */
    background: var(--dsw-alias-bg-layer-2, #ffffff);
    box-shadow: 0 8px 32px rgba(0, 0, 0, .28);
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
  [data-phase] header {
    position: relative;
    padding: 0 !important;
  }
  [data-phase] header [class$="_titleRow"] {
    position: relative;
    display: grid;
    grid-template-columns: 92px 1fr 92px;
    align-items: center;
    min-height: 44px;
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
  [data-mobile-nav="header-info"] > span {
    font-size: 17px;
    line-height: 1;
  }

  /* Official Chat/Trajectory tablist: visually hidden but NOT display:none —
     visibility:hidden keeps it in layout (so the view-switch row below has
     somewhere to sit without overlapping the scroll body) and keeps it
     genuinely clickable via .click() (only real pointer hit-testing is
     removed, which this plugin never relies on: the view-switch row always
     dispatches a programmatic click). */
  [data-phase] header [class$="_tabs"][role="tablist"] {
    visibility: hidden;
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
/**
 * All mobile styles, concatenated in the exact order of the original
 * single-file stylesheet (base → layout → compat → misc, where misc keeps
 * composer → tablet → desktop), followed by the phone app shell (home) and
 * the session-header reflow (header), which must come last so their <768px
 * rules win ties against the shared <=1023px block. Injected as ONE
 * <style data-plugin> tag — do not reorder.
 */
exports.MOBILE_CSS = [base_css_ts_1.BASE_CSS, layout_css_ts_1.LAYOUT_CSS, compat_css_ts_1.COMPAT_CSS, misc_css_ts_1.MISC_CSS, home_css_ts_1.HOME_CSS, header_css_ts_1.HEADER_CSS].join('\n');
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
    ctx.effect(() => {
        if (!new URLSearchParams(location.search).has('mobile-nav-debug'))
            return () => { };
        const errors = [];
        const onError = (event) => errors.push(`ERR ${event.message.slice(0, 120)}`);
        const onRejection = (event) => errors.push(`REJ ${String(event.reason).slice(0, 120)}`);
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
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
                `header ${vis('[data-phase] header')}  composer ${q('textarea')}`,
                `genui cards ${document.querySelectorAll('[data-genui]').length}  panel ${q('[data-genui-panel]')}`,
                `phase ${document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? '?'}`,
                `errs ${errors.slice(-5).join(' | ') || 'none'}`,
            ].join('\n');
        };
        const paint = () => { badge.textContent = read(); };
        paint();
        const observer = new MutationObserver(paint);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        const timer = setInterval(paint, 1500);
        document.body.appendChild(badge);
        return () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
            observer.disconnect();
            clearInterval(timer);
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
__modules["effects/stats-line.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installStatsLine = installStatsLine;
// The official conversation status row (turns / steps / LLM time / TTFT /
// cache) has a hashed class, so the stylesheet cannot target it directly.
// Mark the exact row on narrow screens by text: a [class$=_root] that
// carries the metrics text and no textarea (the composer card also ends in
// _root and can mention turns in its model line). The CSS then lays the
// marked row out as ONE horizontally scrolling line with every metric
// reachable.
function installStatsLine(ctx) {
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
            // The composer root renders the TPS readout ("TPS 89.4 tok/s") as its
            // own row BELOW the status strip; fold it into the strip so every
            // metric scrolls together. The suite re-renders its own tree, so this
            // must be idempotent and re-run on every mutation.
            const moveTps = (stats) => {
                if ([...stats.children].some((c) => /^TPS\s+\d/.test((c.textContent ?? '').trim())))
                    return;
                const stack = stats.closest('[class$="_composerStack"]');
                if (stack === null)
                    return;
                for (const el of stack.querySelectorAll('div')) {
                    const text = (el.textContent ?? '').trim();
                    if (!/^TPS\s+\d/.test(text))
                        continue;
                    if (el.children.length > 0)
                        continue;
                    stats.appendChild(el);
                    return;
                }
            };
            const mark = () => {
                for (const root of document.querySelectorAll('[data-phase] [class$="_root"]')) {
                    // The status row lives inside the composer stack; message-area
                    // blocks can also mention turns/steps and must be skipped.
                    if (root.closest('[class$="_composerStack"]') === null)
                        continue;
                    // The todo plan strip also lives in the composer stack and its root
                    // ends in _root. Its items may legitimately contain "步"/"steps" in
                    // their text, so never mistake it (or any interactive dock panel)
                    // for the stats strip.
                    if (root.matches('[data-testid="todo-panel"]'))
                        continue;
                    if (root.querySelector('button') !== null)
                        continue;
                    const text = root.textContent ?? '';
                    if (!/(turns|steps|\bLLM\b|轮|步)/.test(text))
                        continue;
                    if (root.querySelector('textarea') !== null)
                        continue;
                    root.setAttribute('data-mobile-nav', 'stats');
                    moveTps(root);
                    return;
                }
            };
            const observer = new MutationObserver(mark);
            observer.observe(document.body, { childList: true, subtree: true });
            mark();
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
    }, 'dsh-mobile-nav: stats line marker');
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
    'newSessionIn': '在工作区新建会话',
    'noSessions': '还没有会话，点右下角加号开始',
    'backToList': '返回会话列表',
    'sessionInfo': '会话信息',
    'workbench': '工作台',
    'switchView': '切换视图',
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
    'newSessionIn': 'New session in workspace',
    'noSessions': 'No sessions yet — tap + to start one',
    'backToList': 'Back to sessions',
    'sessionInfo': 'Session info',
    'workbench': 'Workbench',
    'switchView': 'Switch view',
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
const nav_store_ts_1 = require("./nav-store.js");
const index_ts_1 = require("./styles/index.js");
const debug_ts_1 = require("./debug.js");
const phone_chrome_ts_1 = require("./effects/phone-chrome.js");
const aionui_compat_ts_1 = require("./effects/aionui-compat.js");
const stats_line_ts_1 = require("./effects/stats-line.js");
const header_status_ts_1 = require("./effects/header-status.js");
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
    (0, stats_line_ts_1.installStatsLine)(ctx);
    // Session header running-status dot (S2): no official element exists to
    // reposition, so this reads ctx.sessions directly and self-draws via CSS.
    (0, header_status_ts_1.installHeaderStatusDot)(ctx);
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
