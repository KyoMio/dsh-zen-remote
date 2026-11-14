// 首屏主题防闪（GC-7a）：在首屏渲染前把持久化（或系统）主题写进
// <html data-theme>，避免深色用户看到一帧白底闪烁。
//
// 逻辑与 src/web/App.tsx 的 readStoredTheme 完全一致，两边改动必须同步。
// 以独立外链文件同步加载（CONSOLE_CSP 是 default-src 'self'，禁内联脚本）。
(() => {
  let stored = null;
  try {
    stored = window.localStorage.getItem('zen-remote-console.theme');
  } catch {
    /* localStorage 不可用（隐私模式等）时跟随系统 */
  }
  const theme =
    stored === 'light' || stored === 'dark'
      ? stored
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  document.documentElement.dataset.theme = theme;
})();
