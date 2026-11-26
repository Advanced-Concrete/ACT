// =========================================================================
// ACT MASTER - THEME TOGGLE MODULE (theme.js)
// Zero-conflict drop-in Dark / Outdoor Light Mode switch
// - Injects segmented toggle at the top of the side navigation menu
// - Saves preference per device in localStorage (`act_theme_mode`)
// - Updates mobile browser status bar theme-color meta tag
// =========================================================================
(function initACTTheme() {
  'use strict';

  const THEME_KEY = 'act_theme_mode';

  function getSavedTheme() {
    try {
      return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  function updateMetaThemeColor(mode) {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', mode === 'light' ? '#ffffff' : '#0f172a');
  }

  function applyTheme(mode, persist = true) {
    const clean = mode === 'light' ? 'light' : 'dark';
    document.documentElement.classList.toggle('act-light', clean === 'light');
    updateMetaThemeColor(clean);

    if (persist) {
      try {
        window.localStorage.setItem(THEME_KEY, clean);
      } catch {}
    }

    syncToggleButtons(clean);
  }

  function syncToggleButtons(mode) {
    const darkBtn = document.getElementById('actThemeBtnDark');
    const lightBtn = document.getElementById('actThemeBtnLight');
    if (!darkBtn || !lightBtn) return;

    const isLight = mode === 'light';

    darkBtn.className = !isLight
      ? 'flex-1 h-9 rounded-lg text-xs font-extrabold flex items-center justify-center gap-1.5 bg-sky-500 text-slate-950 shadow-sm transition'
      : 'flex-1 h-9 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 text-slate-400 hover:text-white transition';

    lightBtn.className = isLight
      ? 'flex-1 h-9 rounded-lg text-xs font-extrabold flex items-center justify-center gap-1.5 bg-sky-600 text-white shadow-sm transition'
      : 'flex-1 h-9 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 text-slate-400 hover:text-white transition';
  }

  function ensureSidebarToggle() {
    if (document.getElementById('actThemeToggleRow')) {
      syncToggleButtons(getSavedTheme());
      return;
    }

    // Anchor at the very top of the side menu navigation list
    const anchorBtn =
      document.getElementById('menuFeatBlueprints') ||
      document.getElementById('menuFeatCalendar') ||
      document.getElementById('menuFeatDocuments');

    const navContainer = anchorBtn?.parentElement;
    if (!navContainer) return;

    const wrap = document.createElement('div');
    wrap.id = 'actThemeToggleRow';
    wrap.className = 'pb-2.5 mb-2 border-b border-slate-800';
    wrap.innerHTML = `
      <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 px-1 mb-1.5">
        Display Mode
      </div>
      <div class="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-950 border border-slate-800">
        <button id="actThemeBtnDark" type="button">
          <span>🌙</span><span>Dark</span>
        </button>
        <button id="actThemeBtnLight" type="button">
          <span>☀️</span><span>Light</span>
        </button>
      </div>
    `;

    navContainer.insertBefore(wrap, navContainer.firstChild);

    document.getElementById('actThemeBtnDark').addEventListener('click', () => applyTheme('dark', true));
    document.getElementById('actThemeBtnLight').addEventListener('click', () => applyTheme('light', true));

    syncToggleButtons(getSavedTheme());
  }

  function hookUiSync() {
    const prevRefreshRole = window.refreshRoleUiVisibility;
    if (typeof prevRefreshRole === 'function') {
      window.refreshRoleUiVisibility = function () {
        const res = prevRefreshRole.apply(this, arguments);
        ensureSidebarToggle();
        return res;
      };
    }

    const prevUpdateTopBar = window.updateTopBarIndicators;
    if (typeof prevUpdateTopBar === 'function') {
      window.updateTopBarIndicators = function () {
        const res = prevUpdateTopBar.apply(this, arguments);
        ensureSidebarToggle();
        return res;
      };
    }
  }

  window.ACTTheme = {
    get: getSavedTheme,
    set: (mode) => applyTheme(mode, true),
    toggle: () => applyTheme(getSavedTheme() === 'light' ? 'dark' : 'light', true)
  };

  function boot() {
    applyTheme(getSavedTheme(), false);
    ensureSidebarToggle();
    hookUiSync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
