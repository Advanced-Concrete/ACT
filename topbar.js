// =========================================================================
// ACT MASTER - CLEAN TOP BAR MODULE (topbar.js)
// Zero-conflict drop-in header redesign for mobile & desktop
// - Turns `[≡ Menu]` into a crisp 36x36 icon-only button so titles have room
// - Gives #topBarPageTitle full horizontal breathing room (no more `Bl...`/`P...`)
// - Replaces the wide User Pill + Switch User button with a single compact
//   User Chip (`● JT ▾` on mobile, `● Admin: Jake Textor ▾` on wider screens)
//   and a clean anchored account popover with Switch User & live sync status
// =========================================================================
(function initACTTopBar() {
  'use strict';

  const ROLE_META = {
    admin:      { label: 'Administrator',   short: 'Admin',      dot: 'bg-emerald-400', badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
    pm:         { label: 'Project Manager', short: 'PM',         dot: 'bg-indigo-400',  badge: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40' },
    supervisor: { label: 'Supervisor',      short: 'Supervisor', dot: 'bg-amber-400',   badge: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
    crew:       { label: 'Crew Member',     short: 'Crew',       dot: 'bg-slate-400',   badge: 'bg-slate-700/60 text-slate-300 border-slate-600' }
  };

  const tb = {
    header: null,
    menuBtn: null,
    titleEl: null,
    userTextEl: null,
    userPillEl: null,
    switchBtn: null,
    popoverOpen: false,
    mounted: false,
    observer: null
  };

  // =========================================================================
  // 1. SAFE HELPERS & USER INFO RESOLVER
  // =========================================================================
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isAppOnline() {
    const actOnline = typeof isOnline !== 'undefined' ? Boolean(isOnline) : true;
    return actOnline && navigator.onLine;
  }

  function getEffectiveRole() {
    if (typeof getActiveUserEffectiveRole === 'function') {
      return String(getActiveUserEffectiveRole() || 'crew').toLowerCase();
    }
    return typeof currentRole !== 'undefined' ? String(currentRole || 'crew').toLowerCase() : 'crew';
  }

  function getInitials(name) {
    const clean = String(name || '')
      .replace(/^(Admin|PM|Supervisor|Crew)\s*:\s*/i, '')
      .trim();
    if (!clean) return 'AC';
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function getActiveUserInfo() {
    const role = getEffectiveRole();
    const meta = ROLE_META[role] || ROLE_META.crew;

    let emp = null;
    try {
      if (
        typeof activeCrewEmployeeId !== 'undefined' &&
        activeCrewEmployeeId &&
        typeof state !== 'undefined' &&
        Array.isArray(state.employees)
      ) {
        emp = state.employees.find((e) => e.id === activeCrewEmployeeId) || null;
      }
    } catch {}

    let rawHeaderText = (tb.userTextEl?.textContent || '').trim();
    let displayName = emp?.full_name
      ? String(emp.full_name).trim()
      : rawHeaderText.replace(/^(Admin|PM|Supervisor|Crew)\s*:\s*/i, '').trim() ||
        (role === 'admin' ? 'Administrator' : 'User');

    let cardLast4 = '';
    try {
      if (emp && typeof state !== 'undefined' && Array.isArray(state.cards)) {
        const card = state.cards.find((c) => (c.assigned_employee_id || c.employee_id) === emp.id);
        if (card) cardLast4 = String(card.last_four || card.last4 || '').trim();
      }
    } catch {}

    const desktopLabel = role === 'crew' ? displayName : `${meta.short}: ${displayName}`;
    return {
      role,
      meta,
      displayName,
      desktopLabel,
      initials: getInitials(displayName),
      cardLast4
    };
  }

  // =========================================================================
  // 2. STYLES (DARK + OUTDOOR LIGHT MODE + LANDSCAPE COMPACT)
  // =========================================================================
  function injectStyles() {
    if (document.getElementById('actTopBarStyles')) return;
    const style = document.createElement('style');
    style.id = 'actTopBarStyles';
    style.textContent = `
      body > header.act-tb-enhanced {
        min-height: 52px !important;
        padding-top: 6px !important;
        padding-bottom: 6px !important;
        padding-left: 10px !important;
        padding-right: 10px !important;
      }

      /* Hide original wide user pill & Switch User button (kept in DOM for app-core.js) */
      .act-tb-legacy-hidden {
        display: none !important;
      }

      /* Left group: Menu icon + full-width Title */
      .act-tb-left-group {
        flex: 1 1 0% !important;
        min-width: 0 !important;
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
      }

      .act-tb-right-group {
        flex: 0 0 auto !important;
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        margin-left: 8px !important;
      }

      /* Crisp 36x36 icon-only Menu button */
      .act-tb-menu-btn {
        width: 36px !important;
        height: 36px !important;
        min-width: 36px !important;
        padding: 0 !important;
        border-radius: 8px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        flex-shrink: 0 !important;
      }
      .act-tb-menu-btn .act-tb-menu-label {
        display: none !important;
      }

      /* Readable, un-crushed Page Title */
      #topBarPageTitle.act-tb-title {
        flex: 1 1 auto !important;
        min-width: 0 !important;
        max-width: none !important;
        font-size: 15px !important;
        font-weight: 800 !important;
        line-height: 1.2 !important;
        letter-spacing: -0.01em !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }

      /* Compact User Chip */
      #actTbUserBtn {
        height: 36px;
        padding: 0 10px;
        border-radius: 8px;
        background-color: rgba(30, 41, 59, 0.9);
        border: 1px solid rgba(71, 85, 105, 0.75);
        color: #f1f5f9;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        flex-shrink: 0;
        transition: background-color 120ms ease, border-color 120ms ease;
      }
      #actTbUserBtn:hover {
        background-color: #334155;
        border-color: #64748b;
      }
      #actTbUserBtn[aria-expanded="true"] {
        border-color: #38bdf8;
      }

      /* Account Popover */
      #actTbUserPopover {
        position: fixed;
        right: 10px;
        width: 248px;
        max-width: calc(100vw - 20px);
        z-index: 88;
        border-radius: 10px;
        background-color: #0f172a;
        border: 1px solid #334155;
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.6);
        color: #f1f5f9;
        overflow: hidden;
      }

      /* Outdoor Light Mode Overrides */
      html.act-light #actTbUserBtn {
        background-color: #f1f5f9 !important;
        border-color: #94a3b8 !important;
        color: #020617 !important;
      }
      html.act-light #actTbUserBtn:hover {
        background-color: #e2e8f0 !important;
      }
      html.act-light #actTbUserPopover {
        background-color: #ffffff !important;
        border-color: #94a3b8 !important;
        color: #020617 !important;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.18) !important;
      }

      @media (orientation: landscape) and (max-height: 540px) {
        body > header.act-tb-enhanced {
          min-height: 44px !important;
          padding-top: 4px !important;
          padding-bottom: 4px !important;
        }
        .act-tb-menu-btn,
        #actTbUserBtn {
          height: 32px !important;
        }
        .act-tb-menu-btn {
          width: 32px !important;
          min-width: 32px !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // =========================================================================
  // 3. LOCATE EXISTING HEADER ELEMENTS SAFELY
  // =========================================================================
  function discoverHeaderElements() {
    const header = document.querySelector('body > header');
    if (!header) return false;

    const titleEl = document.getElementById('topBarPageTitle');
    const buttons = Array.from(header.querySelectorAll('button'));

    const menuBtn =
      header.querySelector('button[onclick*="openSideMenu"]') ||
      buttons.find((b) => /\bmenu\b/i.test(b.textContent || '')) ||
      buttons[0] ||
      null;

    const switchBtn =
      buttons.find(
        (b) =>
          b !== menuBtn &&
          b.id !== 'actTbUserBtn' &&
          (/switch\s*user|log\s*out/i.test(b.textContent || '') ||
            /logout|switchuser/i.test(b.getAttribute('onclick') || ''))
      ) || null;

    let userTextEl =
      document.getElementById('topBarUserName') ||
      document.getElementById('activeUserBadgeText') ||
      document.getElementById('topBarUserLabel') ||
      null;

    if (!userTextEl) {
      // Fallback: find the span/div inside header showing "Admin: ..." / "PM: ..." / active user
      userTextEl =
        Array.from(header.querySelectorAll('span, div')).find((el) => {
          if (el.children.length > 0) return false;
          if (el === titleEl || menuBtn?.contains(el) || switchBtn?.contains(el)) return false;
          const txt = (el.textContent || '').trim();
          return /^(Admin|PM|Supervisor)\s*:/i.test(txt);
        }) || null;
    }

    // Walk up from userTextEl to find its standalone pill container (never climbing past switchBtn or titleEl)
    let userPillEl = null;
    if (userTextEl) {
      let cur = userTextEl;
      while (cur.parentElement && cur.parentElement !== header) {
        const parent = cur.parentElement;
        if (
          (switchBtn && parent.contains(switchBtn)) ||
          (menuBtn && parent.contains(menuBtn)) ||
          (titleEl && parent.contains(titleEl))
        ) {
          break;
        }
        cur = parent;
      }
      userPillEl = cur;
    }

    tb.header = header;
    tb.titleEl = titleEl;
    tb.menuBtn = menuBtn;
    tb.switchBtn = switchBtn;
    tb.userTextEl = userTextEl;
    tb.userPillEl = userPillEl;
    return true;
  }

  function stripMenuButtonText(menuBtn) {
    if (!menuBtn || menuBtn.dataset.actTbCleaned === '1') return;
    menuBtn.dataset.actTbCleaned = '1';
    menuBtn.classList.add('act-tb-menu-btn');
    menuBtn.setAttribute('aria-label', 'Open Menu');
    menuBtn.setAttribute('title', 'Menu');

    // Wrap bare text nodes like "Menu" so CSS hides them cleanly while preserving SVG icon
    Array.from(menuBtn.childNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        const span = document.createElement('span');
        span.className = 'act-tb-menu-label';
        span.textContent = node.textContent;
        node.replaceWith(span);
      } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() !== 'svg') {
        if (/\bmenu\b/i.test(node.textContent || '') && !node.querySelector('svg')) {
          node.classList.add('act-tb-menu-label');
        }
      }
    });
  }

  // =========================================================================
  // 4. COMPACT USER CHIP & POPOVER
  // =========================================================================
  function ensurePopover() {
    let pop = document.getElementById('actTbUserPopover');
    if (pop) return pop;

    pop = document.createElement('div');
    pop.id = 'actTbUserPopover';
    pop.className = 'hidden';
    document.body.appendChild(pop);
    return pop;
  }

  function renderPopoverContent() {
    const pop = ensurePopover();
    const info = getActiveUserInfo();
    const online = isAppOnline();

    pop.innerHTML = `
      <div class="p-3 border-b border-slate-800 space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-extrabold text-white truncate">${esc(info.displayName)}</span>
          <span class="px-1.5 py-0.5 rounded border text-[10px] font-bold shrink-0 ${info.meta.badge}">
            ${esc(info.meta.short)}
          </span>
        </div>
        <div class="flex items-center justify-between gap-2 text-[11px] text-slate-400">
          <span class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-amber-400'}"></span>
            <span>${online ? 'Supabase Connected' : 'Offline Mode'}</span>
          </span>
          ${info.cardLast4 ? `<span class="font-mono text-emerald-400 font-bold">•••• ${esc(info.cardLast4)}</span>` : ''}
        </div>
      </div>

      <div class="p-2 space-y-1">
        ${
          tb.switchBtn
            ? `<button id="actTbPopoverSwitchBtn" type="button"
                class="w-full h-9 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-bold text-slate-100 flex items-center justify-between transition">
                <span>Switch User</span>
                <span class="text-slate-400">⇄</span>
              </button>`
            : ''
        }
      </div>
    `;

    const swBtn = document.getElementById('actTbPopoverSwitchBtn');
    if (swBtn && tb.switchBtn) {
      swBtn.onclick = () => {
        closePopover();
        tb.switchBtn.click();
      };
    }
  }

  function openPopover() {
    const pop = ensurePopover();
    renderPopoverContent();
    const topPx = tb.header ? Math.round(tb.header.getBoundingClientRect().bottom + 6) : 58;
    pop.style.top = `${topPx}px`;
    pop.classList.remove('hidden');
    tb.popoverOpen = true;
    document.getElementById('actTbUserBtn')?.setAttribute('aria-expanded', 'true');
  }

  function closePopover() {
    const pop = document.getElementById('actTbUserPopover');
    if (pop) pop.classList.add('hidden');
    tb.popoverOpen = false;
    document.getElementById('actTbUserBtn')?.setAttribute('aria-expanded', 'false');
  }

  function renderUserChip() {
    const btn = document.getElementById('actTbUserBtn');
    if (!btn) return;

    const switchHiddenByApp = Boolean(tb.switchBtn && tb.switchBtn.classList.contains('hidden'));
    const pillHiddenByApp = Boolean(tb.userPillEl && tb.userPillEl.classList.contains('hidden'));
    const loginView = document.getElementById('loginScreen') || document.getElementById('viewLogin');
    const isLoggedOut = Boolean(loginView && !loginView.classList.contains('hidden'));

    if (isLoggedOut || (switchHiddenByApp && pillHiddenByApp)) {
      btn.classList.add('hidden');
      closePopover();
      return;
    }

    btn.classList.remove('hidden');
    const info = getActiveUserInfo();
    btn.title = `${info.displayName} (${info.meta.label})`;
    btn.innerHTML = `
      <span class="w-2 h-2 rounded-full ${info.meta.dot} shrink-0"></span>
      <span class="sm:hidden font-extrabold tracking-wide">${esc(info.initials)}</span>
      <span class="hidden sm:inline max-w-[170px] truncate">${esc(info.desktopLabel)}</span>
      <span class="text-[9px] opacity-65">▾</span>
    `;

    if (tb.popoverOpen) {
      renderPopoverContent();
    }
  }

  // =========================================================================
  // 5. MOUNT & SYNC HOOKS
  // =========================================================================
  function applyTopBarUpgrade() {
    if (!discoverHeaderElements()) return;
    injectStyles();

    tb.header.classList.add('act-tb-enhanced');

    if (tb.menuBtn) {
      stripMenuButtonText(tb.menuBtn);
    }

    if (tb.titleEl) {
      tb.titleEl.classList.add('act-tb-title');
      if (
        tb.titleEl.parentElement &&
        tb.titleEl.parentElement !== tb.header &&
        (!tb.switchBtn || !tb.titleEl.parentElement.contains(tb.switchBtn))
      ) {
        tb.titleEl.parentElement.classList.add('act-tb-left-group');
      }
    }

    const rightAnchor = tb.switchBtn || tb.userPillEl;
    if (rightAnchor) {
      const rightParent = rightAnchor.parentElement;
      if (
        rightParent &&
        rightParent !== tb.header &&
        (!tb.menuBtn || !rightParent.contains(tb.menuBtn))
      ) {
        rightParent.classList.add('act-tb-right-group');
      }

      if (tb.userPillEl) tb.userPillEl.classList.add('act-tb-legacy-hidden');
      if (tb.switchBtn) tb.switchBtn.classList.add('act-tb-legacy-hidden');

      if (!document.getElementById('actTbUserBtn')) {
        const chip = document.createElement('button');
        chip.id = 'actTbUserBtn';
        chip.type = 'button';
        chip.setAttribute('aria-haspopup', 'true');
        chip.setAttribute('aria-expanded', 'false');
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          if (tb.popoverOpen) closePopover();
          else openPopover();
        });
        rightParent.insertBefore(chip, rightAnchor);
      }
    }

    renderUserChip();

    if (!tb.mounted) {
      tb.mounted = true;

      document.addEventListener('click', (e) => {
        if (!tb.popoverOpen) return;
        const pop = document.getElementById('actTbUserPopover');
        const btn = document.getElementById('actTbUserBtn');
        if (pop?.contains(e.target) || btn?.contains(e.target)) return;
        closePopover();
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && tb.popoverOpen) closePopover();
      });

      window.addEventListener('online', renderUserChip);
      window.addEventListener('offline', renderUserChip);

      if (tb.userTextEl) {
        tb.observer = new MutationObserver(() => renderUserChip());
        tb.observer.observe(tb.userTextEl, { childList: true, characterData: true, subtree: true });
      }

      // Let fixed views (Calendar, Docs, Blueprints) re-measure header height
      setTimeout(() => window.dispatchEvent(new Event('resize')), 40);
    }
  }

  function installHooks() {
    const wrapSync = (fnName) => {
      const prev = window[fnName];
      if (typeof prev !== 'function') return;
      window[fnName] = function () {
        const res = prev.apply(this, arguments);
        if (!tb.mounted) applyTopBarUpgrade();
        else renderUserChip();
        return res;
      };
    };

    wrapSync('refreshRoleUiVisibility');
    wrapSync('updateTopBarIndicators');
    wrapSync('renderAll');

    const prevOpenMenu = window.openSideMenu;
    if (typeof prevOpenMenu === 'function') {
      window.openSideMenu = function () {
        closePopover();
        return prevOpenMenu.apply(this, arguments);
      };
    }

    const prevLogout = window.logoutUser;
    if (typeof prevLogout === 'function') {
      window.logoutUser = function () {
        closePopover();
        const res = prevLogout.apply(this, arguments);
        setTimeout(renderUserChip, 50);
        return res;
      };
    }
  }

  window.ACTTopBar = {
    refresh: () => {
      applyTopBarUpgrade();
      renderUserChip();
    },
    closePopover
  };

  function boot() {
    applyTopBarUpgrade();
    installHooks();
    setTimeout(applyTopBarUpgrade, 350);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
