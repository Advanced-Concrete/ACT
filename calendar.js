// =========================================================================
// ACT MASTER - COMPANY CALENDARS MODULE (calendar.js)
// Zero-conflict drop-in read-only iCloud & Google Calendar viewer
// - Proxies multiple iCloud (.ics / webcal) & Google Calendar (iCal .ics) feeds
// - Per-calendar access control (enforced server-side in `calendar-proxy`):
//     * By Role: Admin, PM, Supervisor, Crew (plus 1-tap Everyone shortcut)
//     * By Individual User: assign specific employees to any feed
//     * Crew menu tab auto-hides when a crew user has zero assigned calendars
// - Full-bleed hairline Month grid + clean Day view
// - Per-user offline cache in localStorage (safe on shared tablets)
// =========================================================================
(function initACTCalendar() {
  'use strict';

  const PROXY_FN = 'calendar-proxy';
  const CACHE_PREFIX = 'act_company_cal_cache_v2_';
  const HIDDEN_PREFIX = 'act_company_cal_hidden_v2_';
  const ACCESS_PREFIX = 'act_company_cal_access_v2_';

  const ROLE_OPTIONS = [
    { key: 'admin', label: 'Admin' },
    { key: 'pm', label: 'PM' },
    { key: 'supervisor', label: 'Supervisor' },
    { key: 'crew', label: 'Crew' }
  ];

  const COLOR_STYLES = {
    sky:     { name: 'Blue',   dot: 'bg-sky-400',     eventBar: 'bg-sky-600 text-white',         pill: 'bg-sky-500/20 text-sky-200 border-sky-400/40',             bar: 'bg-sky-400',     chipOn: 'bg-sky-500/20 text-sky-200 border-sky-400/50' },
    emerald: { name: 'Green',  dot: 'bg-emerald-400', eventBar: 'bg-emerald-600 text-white',     pill: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40', bar: 'bg-emerald-400', chipOn: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/50' },
    amber:   { name: 'Amber',  dot: 'bg-amber-400',   eventBar: 'bg-amber-500 text-slate-950',   pill: 'bg-amber-500/20 text-amber-200 border-amber-400/40',       bar: 'bg-amber-400',   chipOn: 'bg-amber-500/20 text-amber-200 border-amber-400/50' },
    rose:    { name: 'Red',    dot: 'bg-rose-400',    eventBar: 'bg-rose-600 text-white',        pill: 'bg-rose-500/20 text-rose-200 border-rose-400/40',          bar: 'bg-rose-400',    chipOn: 'bg-rose-500/20 text-rose-200 border-rose-400/50' },
    violet:  { name: 'Purple', dot: 'bg-violet-400',  eventBar: 'bg-violet-600 text-white',      pill: 'bg-violet-500/20 text-violet-200 border-violet-400/40',    bar: 'bg-violet-400',  chipOn: 'bg-violet-500/20 text-violet-200 border-violet-400/50' },
    orange:  { name: 'Orange', dot: 'bg-orange-400',  eventBar: 'bg-orange-600 text-white',      pill: 'bg-orange-500/20 text-orange-200 border-orange-400/40',    bar: 'bg-orange-400',  chipOn: 'bg-orange-500/20 text-orange-200 border-orange-400/50' },
    cyan:    { name: 'Teal',   dot: 'bg-cyan-400',    eventBar: 'bg-teal-600 text-white',        pill: 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40',          bar: 'bg-cyan-400',    chipOn: 'bg-cyan-500/20 text-cyan-200 border-cyan-400/50' },
    slate:   { name: 'Gray',   dot: 'bg-slate-400',   eventBar: 'bg-slate-600 text-white',       pill: 'bg-slate-500/25 text-slate-200 border-slate-400/40',       bar: 'bg-slate-400',   chipOn: 'bg-slate-600/40 text-slate-100 border-slate-400/50' }
  };

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const now = new Date();
  const calState = {
    isOpen: false,
    viewMode: 'month', // 'month' | 'day'
    cursorYear: now.getFullYear(),
    cursorMonth: now.getMonth(), // 0-11
    selectedDateStr: toYmd(now),
    calendars: [],
    events: [],
    warnings: [],
    hiddenCalendarIds: new Set(),
    syncedAt: null,
    loadedRangeKey: '',
    loading: false,
    errorMsg: '',

    // User & Crew auto-visibility tracking
    activeUserKey: '',
    crewHasAccess: false,
    checkingAccessKey: '',

    // Admin Feed Manager state
    adminFeeds: [],
    adminEmployees: [],
    editingFeedId: null,
    formRoles: new Set(['admin', 'pm', 'supervisor']),
    formUserIds: new Set(),
    userSearchQuery: ''
  };

  // =========================================================================
  // 1. SAFE ACT BRIDGES & USER-SCOPED STORAGE
  // =========================================================================
  function getSupabase() {
    return typeof supabaseClient !== 'undefined' ? supabaseClient : null;
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

  function isAdminUser() {
    return getEffectiveRole() === 'admin';
  }

  function isManagementRole() {
    const r = getEffectiveRole();
    return r === 'admin' || r === 'pm' || r === 'supervisor';
  }

  function getActiveEmployeeId() {
    if (typeof activeCrewEmployeeId !== 'undefined' && activeCrewEmployeeId) {
      return String(activeCrewEmployeeId);
    }
    return isAdminUser() ? 'ADMIN' : '';
  }

  function getUserKey() {
    return `${getActiveEmployeeId()}::${getEffectiveRole()}`;
  }

  function canViewCalendar() {
    if (isManagementRole()) return true;
    return Boolean(getActiveEmployeeId() && calState.crewHasAccess);
  }

  function toast(msg, isError = false) {
    if (typeof showSimpleToast === 'function') {
      showSimpleToast(msg, isError);
    } else {
      console.log(`[Calendar${isError ? ' Error' : ''}]`, msg);
    }
  }

  function loadJSON(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, val) {
    try {
      window.localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  }

  function getCacheKeyForUser() {
    return `${CACHE_PREFIX}${getActiveEmployeeId() || 'anon'}`;
  }

  function getHiddenKeyForUser() {
    return `${HIDDEN_PREFIX}${getActiveEmployeeId() || 'anon'}`;
  }

  function getAccessKeyForUser() {
    return `${ACCESS_PREFIX}${getActiveEmployeeId() || 'anon'}`;
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getColorStyle(colorKey) {
    return COLOR_STYLES[colorKey] || COLOR_STYLES.sky;
  }

  function detectSourceBadge(urlOrSource) {
    const val = String(urlOrSource || '').toLowerCase();
    if (val === 'google' || val.includes('calendar.google.com') || val.includes('googleusercontent.com')) {
      return { label: 'Google', cls: 'bg-blue-500/20 text-blue-300 border-blue-400/30' };
    }
    if (val === 'icloud' || val.includes('icloud.com')) {
      return { label: 'iCloud', cls: 'bg-slate-700/80 text-slate-200 border-slate-500/40' };
    }
    return { label: 'iCal', cls: 'bg-slate-800 text-slate-300 border-slate-600/40' };
  }

  function formatPermissionSummary(feed) {
    const roles = Array.isArray(feed.allowed_roles)
      ? feed.allowed_roles.map((r) => String(r).toLowerCase())
      : ['admin', 'pm', 'supervisor'];
    const users = Array.isArray(feed.allowed_user_ids) ? feed.allowed_user_ids : [];

    const hasAllRoles = ROLE_OPTIONS.every((opt) => roles.includes(opt.key));
    let rolePart = '';
    if (hasAllRoles) {
      rolePart = 'Everyone';
    } else {
      const labels = ROLE_OPTIONS.filter((opt) => roles.includes(opt.key)).map((opt) => opt.label);
      rolePart = labels.length ? labels.join(' · ') : 'Admin only';
    }

    if (users.length > 0 && !hasAllRoles) {
      return `${rolePart} + ${users.length} user${users.length === 1 ? '' : 's'}`;
    }
    return rolePart;
  }

  // =========================================================================
  // 2. DATE HELPERS
  // =========================================================================
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toYmd(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function parseYmdLocal(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }

  function shiftDaysYmd(ymd, deltaDays) {
    const d = parseYmdLocal(ymd);
    d.setDate(d.getDate() + deltaDays);
    return toYmd(d);
  }

  function formatTimeShort(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function formatTimeCompact(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'p' : 'a';
    const h12 = h % 12 || 12;
    return m === 0 ? `${h12}${ampm}` : `${h12}:${pad2(m)}${ampm}`;
  }

  function formatMonthHeading(year, month, shortMonth = false) {
    return new Date(year, month, 1).toLocaleDateString('en-US', {
      month: shortMonth ? 'short' : 'long',
      year: 'numeric'
    });
  }

  function formatDayHeading(ymd) {
    const d = parseYmdLocal(ymd);
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  function getEventsForDay(ymd) {
    const dayDate = parseYmdLocal(ymd);
    const dayStart = dayDate.getTime();
    const dayEnd = new Date(
      dayDate.getFullYear(),
      dayDate.getMonth(),
      dayDate.getDate() + 1,
      0,
      0,
      0,
      0
    ).getTime();

    return calState.events
      .filter((ev) => !calState.hiddenCalendarIds.has(ev.calendarId))
      .filter((ev) => {
        if (ev.allDay && ev.startDate && ev.endDateExclusive) {
          return ymd >= ev.startDate && ymd < ev.endDateExclusive;
        }
        const sMs = new Date(ev.startIso).getTime();
        const eMs = new Date(ev.endIso).getTime();
        if (eMs <= sMs) {
          return sMs >= dayStart && sMs < dayEnd;
        }
        return sMs < dayEnd && eMs > dayStart;
      })
      .sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return new Date(a.startIso).getTime() - new Date(b.startIso).getTime();
      });
  }

  // =========================================================================
  // 3. EDGE FUNCTION CALLER, ACCESS CHECK & PER-USER CACHING
  // =========================================================================
  async function invokeCalendarProxy(payload) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase client is not configured.');
    if (!isAppOnline()) throw new Error('Device is offline.');

    const empId = getActiveEmployeeId();
    if (!empId) throw new Error('Sign in to access calendars.');

    const { data, error } = await sb.functions.invoke(PROXY_FN, {
      body: { ...payload, employee_id: empId }
    });

    if (error) {
      let detail = error.message || 'Calendar request failed';
      try {
        if (error.context && typeof error.context.json === 'function') {
          const body = await error.context.json();
          if (body?.error || body?.message) detail = body.error || body.message;
        }
      } catch {}
      throw new Error(detail);
    }
    if (data && typeof data === 'object' && data.error) {
      throw new Error(data.error);
    }
    return data;
  }

  function hydrateFromCache() {
    const cached = loadJSON(getCacheKeyForUser(), null);
    if (!cached) {
      calState.calendars = [];
      calState.events = [];
      calState.syncedAt = null;
      return;
    }
    calState.calendars = Array.isArray(cached.calendars) ? cached.calendars : [];
    calState.events = Array.isArray(cached.events) ? cached.events : [];
    calState.syncedAt = cached.syncedAt || null;
  }

  async function refreshCrewAccessForActiveUser() {
    const empId = getActiveEmployeeId();
    const userKey = getUserKey();

    if (!empId) {
      calState.crewHasAccess = false;
      ensureMenuButton();
      return;
    }

    if (isManagementRole()) {
      calState.crewHasAccess = true;
      ensureMenuButton();
      return;
    }

    // Use cached flag immediately so offline crew users keep their tab
    calState.crewHasAccess = Boolean(loadJSON(getAccessKeyForUser(), false));
    ensureMenuButton();

    if (!isAppOnline() || !getSupabase()) return;
    if (calState.checkingAccessKey === userKey) return;
    calState.checkingAccessKey = userKey;

    try {
      const res = await invokeCalendarProxy({ mode: 'my_access' });
      if (getUserKey() !== userKey) return;
      calState.crewHasAccess = Boolean(res?.hasAccess);
      saveJSON(getAccessKeyForUser(), calState.crewHasAccess);
      ensureMenuButton();
      if (calState.isOpen && !canViewCalendar()) {
        closeCalendarView();
      }
    } catch {
      // Keep last cached access state if offline/transient error
    } finally {
      if (calState.checkingAccessKey === userKey) {
        calState.checkingAccessKey = '';
      }
    }
  }

  async function fetchEventsForCurrentMonth(force = false) {
    if (!canViewCalendar()) return;

    const userKey = getUserKey();
    const rangeKey = `${userKey}::${calState.cursorYear}-${pad2(calState.cursorMonth + 1)}`;
    if (!force && calState.loadedRangeKey === rangeKey && calState.calendars.length > 0) {
      renderCalendarBody();
      return;
    }

    const startDt = new Date(calState.cursorYear, calState.cursorMonth - 1, 1);
    const endDt = new Date(calState.cursorYear, calState.cursorMonth + 2, 0, 23, 59, 59);

    if (!isAppOnline()) {
      hydrateFromCache();
      calState.errorMsg = '';
      calState.warnings = [];
      renderCalendarBody();
      return;
    }

    calState.loading = true;
    calState.errorMsg = '';
    calState.warnings = [];
    renderCalendarBody();

    try {
      const res = await invokeCalendarProxy({
        mode: 'fetch_events',
        range_start: startDt.toISOString(),
        range_end: endDt.toISOString()
      });
      if (getUserKey() !== userKey) return;

      calState.calendars = Array.isArray(res?.calendars) ? res.calendars : [];
      calState.events = Array.isArray(res?.events) ? res.events : [];
      calState.warnings = Array.isArray(res?.warnings) ? res.warnings : [];
      calState.syncedAt = res?.syncedAt || new Date().toISOString();
      calState.loadedRangeKey = rangeKey;

      if (!isManagementRole()) {
        calState.crewHasAccess = calState.calendars.length > 0;
        saveJSON(getAccessKeyForUser(), calState.crewHasAccess);
        ensureMenuButton();
      }

      saveJSON(getCacheKeyForUser(), {
        calendars: calState.calendars,
        events: calState.events,
        syncedAt: calState.syncedAt
      });
    } catch (err) {
      hydrateFromCache();
      calState.errorMsg = err.message || 'Could not load company calendars.';
    } finally {
      calState.loading = false;
      renderCalendarBody();
    }
  }

  // =========================================================================
  // 4. DOM INJECTION (STYLES + SIDE MENU BUTTON + MAIN VIEW + MODALS)
  // =========================================================================
  function injectCalendarStyles() {
    if (document.getElementById('actCalStyles')) return;
    const style = document.createElement('style');
    style.id = 'actCalStyles';
    style.textContent = `
      .act-cal-no-scrollbar::-webkit-scrollbar { display: none; }
      .act-cal-no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      .act-cal-month-bar {
        display: block;
        width: 100%;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: clip;
        padding: 1px 3px;
        border-radius: 3px;
        font-size: 10px;
        line-height: 1.3;
        font-weight: 600;
        letter-spacing: -0.015em;
      }
      @media (min-width: 640px) {
        .act-cal-month-bar {
          padding: 2px 5px;
          border-radius: 4px;
          font-size: 11px;
          text-overflow: ellipsis;
          letter-spacing: 0;
        }
      }
      #viewCompanyCalendar {
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }
    `;
    document.head.appendChild(style);
  }

  function ensureMenuButton() {
    let btn = document.getElementById('menuFeatCalendar');
    if (!btn) {
      const bpBtn = document.getElementById('menuFeatBlueprints');
      if (!bpBtn || !bpBtn.parentNode) return null;

      btn = document.createElement('button');
      btn.id = 'menuFeatCalendar';
      btn.type = 'button';
      btn.className = bpBtn.className;
      btn.innerHTML = `
        <span class="flex items-center gap-2.5 min-w-0">
          <span class="text-base leading-none">📅</span>
          <span class="truncate">Company Calendar</span>
        </span>
        <span class="text-[10px] font-mono text-slate-400">Sync</span>
      `;
      btn.addEventListener('click', () => {
        if (typeof window.selectMenuFeature === 'function') {
          window.selectMenuFeature('calendar');
        } else {
          openCalendarView();
        }
      });

      bpBtn.parentNode.insertBefore(btn, bpBtn.nextSibling);
    }

    btn.classList.toggle('hidden', !canViewCalendar());
    return btn;
  }

  function positionCalendarSection() {
    const view = document.getElementById('viewCompanyCalendar');
    const actHeader = document.querySelector('body > header');
    if (!view) return;
    const topPx = actHeader ? Math.round(actHeader.getBoundingClientRect().height) : 53;
    view.style.top = `${topPx}px`;
  }

  function ensureCalendarView() {
    injectCalendarStyles();
    let view = document.getElementById('viewCompanyCalendar');
    if (view) return view;

    view = document.createElement('section');
    view.id = 'viewCompanyCalendar';
    view.className =
      'hidden fixed inset-x-0 bottom-0 z-30 bg-slate-950 text-slate-100 flex flex-col overflow-hidden';
    view.innerHTML = `
      <div id="actCalToolbar" class="shrink-0 bg-slate-900/95 border-b border-slate-800 px-2.5 sm:px-3 py-2 space-y-1.5"></div>
      <div id="actCalBody" class="flex-1 min-h-0 flex flex-col overflow-y-auto"></div>
    `;
    document.body.appendChild(view);

    window.addEventListener('resize', () => {
      if (calState.isOpen) positionCalendarSection();
    });

    return view;
  }

  function ensureEventDetailModal() {
    if (document.getElementById('actCalEventModal')) return;
    const modal = document.createElement('div');
    modal.id = 'actCalEventModal';
    modal.className =
      'hidden fixed inset-0 z-[90] bg-slate-950/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4';
    modal.innerHTML = `
      <div class="w-full max-w-md rounded-t-3xl sm:rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden text-slate-100">
        <div class="flex items-start justify-between gap-3 px-4 py-3.5 border-b border-slate-800">
          <div id="actCalEventModalHeader" class="min-w-0"></div>
          <button id="actCalEventModalClose" type="button"
            class="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-xl leading-none text-slate-300 shrink-0">&times;</button>
        </div>
        <div id="actCalEventModalBody" class="p-4 space-y-3 text-sm max-h-[75vh] overflow-y-auto"></div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
    document.getElementById('actCalEventModalClose').onclick = () => modal.classList.add('hidden');
  }

  function ensureManageFeedsModal() {
    if (document.getElementById('actCalManageModal')) return;
    const modal = document.createElement('div');
    modal.id = 'actCalManageModal';
    modal.className =
      'hidden fixed inset-0 z-[92] bg-slate-950/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4';
    modal.innerHTML = `
      <div class="w-full max-w-lg rounded-t-3xl sm:rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden text-slate-100">
        <div class="flex items-center justify-between px-4 py-3.5 border-b border-slate-800">
          <div>
            <h3 class="text-base font-extrabold text-white">Manage Company Calendars</h3>
            <p class="text-[11px] text-slate-400">Sync iCloud & Google Calendars with role or per-user access</p>
          </div>
          <button id="actCalManageClose" type="button"
            class="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-xl leading-none text-slate-300">&times;</button>
        </div>
        <div id="actCalManageBody" class="p-4 space-y-4 max-h-[82vh] overflow-y-auto"></div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
    document.getElementById('actCalManageClose').onclick = () => modal.classList.add('hidden');
  }

  // =========================================================================
  // 5. RENDERING: COMPACT TOOLBAR, FULL-BLEED MONTH GRID & DAY VIEW
  // =========================================================================
  function renderToolbar() {
    const bar = document.getElementById('actCalToolbar');
    if (!bar) return;

    const headingFull =
      calState.viewMode === 'month'
        ? formatMonthHeading(calState.cursorYear, calState.cursorMonth, false)
        : formatDayHeading(calState.selectedDateStr);
    const headingShort =
      calState.viewMode === 'month'
        ? formatMonthHeading(calState.cursorYear, calState.cursorMonth, true)
        : formatDayHeading(calState.selectedDateStr);

    const chipsHtml = calState.calendars
      .map((c) => {
        const st = getColorStyle(c.color);
        const isHidden = calState.hiddenCalendarIds.has(c.id);
        return `
          <button type="button" data-cal-filter="${esc(c.id)}"
            class="h-7 px-2.5 rounded-lg border text-[11px] font-bold flex items-center gap-1.5 shrink-0 transition ${
              isHidden
                ? 'bg-slate-950 text-slate-500 border-slate-800 line-through'
                : st.chipOn
            }">
            <span class="w-2 h-2 rounded-full ${isHidden ? 'bg-slate-600' : st.dot}"></span>
            <span>${esc(c.name)}</span>
          </button>
        `;
      })
      .join('');

    bar.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1 min-w-0">
          <button id="actCalPrevBtn" type="button" aria-label="Previous"
            class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700/80 text-base font-bold text-white flex items-center justify-center shrink-0">
            ‹
          </button>
          <button id="actCalNextBtn" type="button" aria-label="Next"
            class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700/80 text-base font-bold text-white flex items-center justify-center shrink-0">
            ›
          </button>
          <h2 class="text-sm sm:text-base font-extrabold text-white ml-1 truncate">
            <span class="sm:hidden">${esc(headingShort)}</span>
            <span class="hidden sm:inline">${esc(headingFull)}</span>
          </h2>
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          <button id="actCalTodayBtn" type="button"
            class="h-8 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700/80 text-xs font-bold text-slate-200">
            Today
          </button>
          <button id="actCalRefreshBtn" type="button" title="Refresh calendars" ${calState.loading ? 'disabled' : ''}
            class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700/80 text-xs font-bold text-slate-200 flex items-center justify-center">
            ${calState.loading ? '…' : '↻'}
          </button>
          ${
            isAdminUser()
              ? `<button id="actCalManageBtn" type="button"
                  class="h-8 px-2.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/40 text-xs font-bold text-indigo-200 flex items-center gap-1">
                  <span>⚙</span><span class="hidden sm:inline">Feeds</span>
                </button>`
              : ''
          }
        </div>
      </div>

      <div class="flex items-center gap-2">
        <div class="inline-flex p-0.5 rounded-lg bg-slate-950 border border-slate-800 shrink-0">
          <button id="actCalModeMonthBtn" type="button"
            class="px-2.5 py-1 rounded-md text-[11px] font-bold transition ${
              calState.viewMode === 'month' ? 'bg-sky-500 text-slate-950' : 'text-slate-300 hover:text-white'
            }">
            Month
          </button>
          <button id="actCalModeDayBtn" type="button"
            class="px-2.5 py-1 rounded-md text-[11px] font-bold transition ${
              calState.viewMode === 'day' ? 'bg-sky-500 text-slate-950' : 'text-slate-300 hover:text-white'
            }">
            Day
          </button>
        </div>

        ${
          chipsHtml
            ? `<div class="act-cal-no-scrollbar flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto">${chipsHtml}</div>`
            : ''
        }
      </div>
    `;

    document.getElementById('actCalPrevBtn').onclick = () => navigateCalendar(-1);
    document.getElementById('actCalNextBtn').onclick = () => navigateCalendar(1);
    document.getElementById('actCalTodayBtn').onclick = () => {
      const today = new Date();
      calState.cursorYear = today.getFullYear();
      calState.cursorMonth = today.getMonth();
      calState.selectedDateStr = toYmd(today);
      fetchEventsForCurrentMonth(false);
    };
    document.getElementById('actCalModeMonthBtn').onclick = () => {
      calState.viewMode = 'month';
      renderCalendarBody();
    };
    document.getElementById('actCalModeDayBtn').onclick = () => {
      calState.viewMode = 'day';
      renderCalendarBody();
    };
    document.getElementById('actCalRefreshBtn').onclick = () => fetchEventsForCurrentMonth(true);

    const manageBtn = document.getElementById('actCalManageBtn');
    if (manageBtn) manageBtn.onclick = openManageFeedsModal;

    bar.querySelectorAll('[data-cal-filter]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-cal-filter');
        if (calState.hiddenCalendarIds.has(id)) calState.hiddenCalendarIds.delete(id);
        else calState.hiddenCalendarIds.add(id);
        saveJSON(getHiddenKeyForUser(), Array.from(calState.hiddenCalendarIds));
        renderCalendarBody();
      };
    });
  }

  function navigateCalendar(delta) {
    if (calState.viewMode === 'month') {
      const next = new Date(calState.cursorYear, calState.cursorMonth + delta, 1);
      calState.cursorYear = next.getFullYear();
      calState.cursorMonth = next.getMonth();
      fetchEventsForCurrentMonth(false);
    } else {
      const nextYmd = shiftDaysYmd(calState.selectedDateStr, delta);
      calState.selectedDateStr = nextYmd;
      const d = parseYmdLocal(nextYmd);
      const monthChanged =
        d.getFullYear() !== calState.cursorYear || d.getMonth() !== calState.cursorMonth;
      calState.cursorYear = d.getFullYear();
      calState.cursorMonth = d.getMonth();
      if (monthChanged) fetchEventsForCurrentMonth(false);
      else renderCalendarBody();
    }
  }

  function renderCalendarBody() {
    renderToolbar();
    const body = document.getElementById('actCalBody');
    if (!body) return;

    const statusNotes = [];
    if (!isAppOnline()) {
      const ts = calState.syncedAt ? new Date(calState.syncedAt).toLocaleString() : 'cached copy';
      statusNotes.push(`Offline mode — showing last synced schedule (${ts}).`);
    }
    if (calState.errorMsg) statusNotes.push(calState.errorMsg);
    if (calState.warnings.length > 0) statusNotes.push(...calState.warnings);

    const bannerHtml = statusNotes.length
      ? `
        <div class="shrink-0 mx-2.5 my-2 rounded-xl bg-amber-500/15 border border-amber-400/40 px-3 py-2 text-xs text-amber-200 space-y-0.5">
          ${statusNotes.map((w) => `<div>${esc(w)}</div>`).join('')}
        </div>
      `
      : '';

    if (calState.loading && calState.calendars.length === 0) {
      body.innerHTML = `${bannerHtml}<div class="py-16 text-center text-sm text-slate-400">Syncing calendars…</div>`;
      return;
    }

    if (calState.calendars.length === 0 && !calState.loading) {
      body.innerHTML = `
        ${bannerHtml}
        <div class="p-4">
          <div class="max-w-md mx-auto mt-8 rounded-2xl bg-slate-900 border border-slate-800 p-6 text-center space-y-3">
            <div class="text-3xl">📅</div>
            <h3 class="text-base font-extrabold text-white">No Calendars Assigned Yet</h3>
            <p class="text-xs text-slate-400">
              ${
                isAdminUser()
                  ? 'Add iCloud or Google Calendar iCal feeds and choose which roles or individual employees can view each one.'
                  : 'No company calendars are assigned to your account right now.'
              }
            </p>
            ${
              isAdminUser()
                ? `<button id="actCalEmptyAddBtn" type="button"
                    class="px-4 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-extrabold text-xs">
                    + Add Calendar Feed
                  </button>`
                : ''
            }
          </div>
        </div>
      `;
      const addBtn = document.getElementById('actCalEmptyAddBtn');
      if (addBtn) addBtn.onclick = openManageFeedsModal;
      return;
    }

    if (calState.viewMode === 'month') {
      renderMonthGrid(body, bannerHtml);
    } else {
      renderDayView(body, bannerHtml);
    }
  }

  function renderMonthGrid(container, bannerHtml) {
    const year = calState.cursorYear;
    const month = calState.cursorMonth;
    const today = new Date();
    const todayStr = toYmd(today);
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
    const todayDow = today.getDay();

    const firstOfMonth = new Date(year, month, 1);
    const startOffset = firstOfMonth.getDay();
    const gridStart = new Date(year, month, 1 - startOffset);

    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      cells.push(d);
    }
    const usedCells = cells[35].getMonth() !== month ? cells.slice(0, 35) : cells;
    const weekRows = usedCells.length / 7;
    const maxVisibleEvents = weekRows === 5 ? 5 : 4;

    const headerRow = WEEKDAYS.map((wd, idx) => {
      const highlight = isCurrentMonth && idx === todayDow;
      return `
        <div class="text-center text-[11px] font-bold py-1.5 ${
          highlight ? 'text-sky-400' : 'text-slate-400'
        }">
          ${wd}
        </div>
      `;
    }).join('');

    const dayCellsHtml = usedCells
      .map((d, cellIdx) => {
        const ymd = toYmd(d);
        const inMonth = d.getMonth() === month;
        const isToday = ymd === todayStr;
        const isSelected = ymd === calState.selectedDateStr && !isToday;
        const isLastCol = cellIdx % 7 === 6;

        const dayEvents = getEventsForDay(ymd);
        const visibleEvents = dayEvents.slice(0, maxVisibleEvents);
        const extraCount = dayEvents.length - visibleEvents.length;

        const barsHtml = visibleEvents
          .map((ev) => {
            const st = getColorStyle(ev.color);
            const desktopTime = ev.allDay
              ? ''
              : `<span class="hidden sm:inline opacity-80 mr-1">${esc(formatTimeCompact(ev.startIso))}</span>`;
            return `
              <div class="act-cal-month-bar ${st.eventBar}" title="${esc(ev.title)}">
                ${desktopTime}${esc(ev.title)}
              </div>
            `;
          })
          .join('');

        return `
          <button type="button" data-open-day="${ymd}"
            class="min-w-0 min-h-0 px-[1.5px] sm:px-1 pt-1 pb-1 border-b border-slate-800/80 ${
              isLastCol ? '' : 'border-r'
            } text-left flex flex-col justify-start gap-[2px] overflow-hidden transition ${
              isSelected
                ? 'bg-slate-800/75'
                : inMonth
                ? 'bg-slate-950 hover:bg-slate-900/80 active:bg-slate-800/70'
                : 'bg-slate-950/60 hover:bg-slate-900/50'
            }">
            <div class="flex items-center justify-center w-full shrink-0 mb-[1px]">
              <span class="${
                isToday
                  ? 'px-2 py-[1px] rounded-full bg-sky-500 text-slate-950 text-[11px] font-extrabold leading-tight'
                  : inMonth
                  ? 'text-[11px] font-bold text-slate-200 leading-tight py-[1px]'
                  : 'text-[11px] font-semibold text-slate-600 leading-tight py-[1px]'
              }">
                ${d.getDate()}
              </span>
            </div>
            <div class="w-full flex-1 min-h-0 flex flex-col gap-[2px] overflow-hidden ${
              inMonth ? '' : 'opacity-60'
            }">
              ${barsHtml}
              ${
                extraCount > 0
                  ? `<div class="text-[9px] sm:text-[10px] font-bold text-slate-400 px-[2px] leading-tight">+${extraCount} more</div>`
                  : ''
              }
            </div>
          </button>
        `;
      })
      .join('');

    container.innerHTML = `
      ${bannerHtml}
      <div class="flex-1 min-h-0 flex flex-col w-full">
        <div class="shrink-0 grid grid-cols-7 bg-slate-950 border-b border-slate-800/90">
          ${headerRow}
        </div>
        <div class="flex-1 min-h-0 grid grid-cols-7" style="grid-template-rows: repeat(${weekRows}, minmax(88px, 1fr));">
          ${dayCellsHtml}
        </div>
      </div>
    `;

    container.querySelectorAll('[data-open-day]').forEach((btn) => {
      btn.onclick = () => {
        const ymd = btn.getAttribute('data-open-day');
        calState.selectedDateStr = ymd;
        const d = parseYmdLocal(ymd);
        calState.cursorYear = d.getFullYear();
        calState.cursorMonth = d.getMonth();
        calState.viewMode = 'day';
        renderCalendarBody();
      };
    });
  }

  function renderDayView(container, bannerHtml) {
    const ymd = calState.selectedDateStr;
    const dayEvents = getEventsForDay(ymd);
    const allDayEvents = dayEvents.filter((e) => e.allDay);
    const timedEvents = dayEvents.filter((e) => !e.allDay);

    const renderCard = (ev) => {
      const st = getColorStyle(ev.color);
      const timeLabel = ev.allDay
        ? 'All Day'
        : `${formatTimeShort(ev.startIso)} – ${formatTimeShort(ev.endIso)}`;

      return `
        <button type="button" data-event-id="${esc(ev.id)}"
          class="w-full text-left rounded-2xl bg-slate-900 hover:bg-slate-800/80 border border-slate-800 p-3.5 flex items-stretch gap-3 transition">
          <div class="w-1.5 rounded-full ${st.bar} shrink-0"></div>
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-extrabold text-slate-300">${esc(timeLabel)}</span>
              <span class="px-2 py-0.5 rounded-full border text-[10px] font-bold shrink-0 ${st.pill}">
                ${esc(ev.calendarName)}
              </span>
            </div>
            <div class="text-base font-extrabold text-white leading-snug">${esc(ev.title)}</div>
            ${
              ev.location
                ? `<div class="text-xs text-slate-400 truncate">📍 ${esc(ev.location)}</div>`
                : ''
            }
            ${
              ev.description
                ? `<div class="text-xs text-slate-400 line-clamp-2">${esc(ev.description)}</div>`
                : ''
            }
          </div>
        </button>
      `;
    };

    let contentHtml = '';
    if (dayEvents.length === 0) {
      contentHtml = `
        <div class="rounded-2xl bg-slate-900/70 border border-slate-800 py-14 px-6 text-center space-y-2">
          <div class="text-2xl">🗓️</div>
          <div class="text-sm font-bold text-slate-200">No events scheduled for this day</div>
          <div class="text-xs text-slate-500">Use ‹ › above or switch back to Month view to check other dates.</div>
        </div>
      `;
    } else {
      contentHtml = `
        ${
          allDayEvents.length > 0
            ? `
              <div class="space-y-2">
                <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 px-1">All-Day</div>
                ${allDayEvents.map(renderCard).join('')}
              </div>
            `
            : ''
        }
        ${
          timedEvents.length > 0
            ? `
              <div class="space-y-2">
                <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 px-1">Scheduled</div>
                ${timedEvents.map(renderCard).join('')}
              </div>
            `
            : ''
        }
      `;
    }

    container.innerHTML = `
      ${bannerHtml}
      <div class="p-3 sm:p-4 max-w-2xl w-full mx-auto space-y-4">
        ${contentHtml}
      </div>
    `;

    container.querySelectorAll('[data-event-id]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-event-id');
        const ev = dayEvents.find((e) => e.id === id);
        if (ev) openEventDetailModal(ev);
      };
    });
  }

  function openEventDetailModal(ev) {
    ensureEventDetailModal();
    const modal = document.getElementById('actCalEventModal');
    const header = document.getElementById('actCalEventModalHeader');
    const body = document.getElementById('actCalEventModalBody');
    const st = getColorStyle(ev.color);
    const src = detectSourceBadge(ev.source);

    header.innerHTML = `
      <div class="flex items-center gap-1.5 mb-1.5 flex-wrap">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[11px] font-bold ${st.pill}">
          <span class="w-2 h-2 rounded-full ${st.dot}"></span>
          ${esc(ev.calendarName)}
        </span>
        <span class="px-2 py-0.5 rounded-full border text-[10px] font-bold ${src.cls}">
          ${src.label}
        </span>
      </div>
      <h3 class="text-lg font-extrabold text-white leading-snug">${esc(ev.title)}</h3>
    `;

    const whenText = ev.allDay
      ? `${formatDayHeading(ev.startDate)} • All Day`
      : `${new Date(ev.startIso).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        })} • ${formatTimeShort(ev.startIso)} – ${formatTimeShort(ev.endIso)}`;

    const mapsUrl = ev.location
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}`
      : '';

    const sourceApp =
      ev.source === 'google'
        ? 'Google Calendar'
        : ev.source === 'icloud'
        ? 'Apple Calendar'
        : 'your source calendar';

    body.innerHTML = `
      <div class="rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs font-semibold text-slate-200">
        🕒 ${esc(whenText)}
      </div>
      ${
        ev.location
          ? `
            <div class="rounded-xl bg-slate-950 border border-slate-800 p-3 flex items-center justify-between gap-2">
              <div class="text-xs text-slate-200 min-w-0">📍 ${esc(ev.location)}</div>
              <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer"
                class="shrink-0 px-2.5 py-1.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 text-sky-200 text-xs font-bold">
                Maps ↗
              </a>
            </div>
          `
          : ''
      }
      ${
        ev.description
          ? `
            <div class="rounded-xl bg-slate-950 border border-slate-800 p-3 text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">
              ${esc(ev.description)}
            </div>
          `
          : ''
      }
      <div class="text-[11px] text-slate-500 text-center pt-1">
        Read-only synced event. Edit in ${esc(sourceApp)} to update.
      </div>
    `;

    modal.classList.remove('hidden');
  }

  // =========================================================================
  // 6. ADMIN MANAGE FEEDS MODAL (iCLOUD + GOOGLE + ROLES + INDIVIDUAL USERS)
  // =========================================================================
  function loadFormPermissionsFromFeed(feed) {
    if (feed) {
      const roles = Array.isArray(feed.allowed_roles)
        ? feed.allowed_roles.map((r) => String(r).toLowerCase())
        : ['admin', 'pm', 'supervisor'];
      calState.formRoles = new Set(roles);
      calState.formRoles.add('admin');
      calState.formUserIds = new Set(
        Array.isArray(feed.allowed_user_ids) ? feed.allowed_user_ids.map(String) : []
      );
    } else {
      calState.formRoles = new Set(['admin', 'pm', 'supervisor']);
      calState.formUserIds = new Set();
    }
    calState.userSearchQuery = '';
  }

  async function openManageFeedsModal() {
    if (!isAdminUser()) return;
    ensureManageFeedsModal();
    const modal = document.getElementById('actCalManageModal');
    const body = document.getElementById('actCalManageBody');
    calState.editingFeedId = null;
    loadFormPermissionsFromFeed(null);

    modal.classList.remove('hidden');
    body.innerHTML = `<div class="py-10 text-center text-xs text-slate-400">Loading calendar feeds…</div>`;

    try {
      const res = await invokeCalendarProxy({ mode: 'list_feeds' });
      calState.adminFeeds = Array.isArray(res?.feeds) ? res.feeds : [];
      calState.adminEmployees = Array.isArray(res?.employees) ? res.employees : [];
      renderManageFeedsBody();
    } catch (err) {
      body.innerHTML = `<div class="rounded-xl bg-rose-500/15 border border-rose-400/40 p-3 text-xs text-rose-200">${esc(err.message)}</div>`;
    }
  }

  function renderEmployeeChecklist() {
    const listWrap = document.getElementById('actCalUserChecklist');
    const countEl = document.getElementById('actCalUserSelectedCount');
    if (countEl) {
      const n = calState.formUserIds.size;
      countEl.textContent = n > 0 ? `${n} selected` : 'Optional';
    }
    if (!listWrap) return;

    const q = calState.userSearchQuery.trim().toLowerCase();
    const filtered = calState.adminEmployees
      .filter((e) => !q || e.full_name.toLowerCase().includes(q) || e.role.includes(q))
      .sort((a, b) => {
        const aSel = calState.formUserIds.has(a.id) ? 0 : 1;
        const bSel = calState.formUserIds.has(b.id) ? 0 : 1;
        if (aSel !== bSel) return aSel - bSel;
        return a.full_name.localeCompare(b.full_name);
      });

    if (filtered.length === 0) {
      listWrap.innerHTML = `<div class="py-3 text-center text-[11px] text-slate-500">No matching employees.</div>`;
      return;
    }

    listWrap.innerHTML = filtered
      .map((emp) => {
        const checked = calState.formUserIds.has(emp.id);
        const alreadyByRole = calState.formRoles.has(emp.role);
        return `
          <label class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition ${
            checked ? 'bg-sky-500/15 text-white' : 'hover:bg-slate-800/80 text-slate-300'
          }">
            <span class="flex items-center gap-2 min-w-0">
              <input type="checkbox" data-toggle-emp="${esc(emp.id)}" ${checked ? 'checked' : ''} class="rounded shrink-0" />
              <span class="text-xs font-semibold truncate">${esc(emp.full_name)}</span>
            </span>
            <span class="flex items-center gap-1.5 shrink-0">
              ${
                alreadyByRole && !checked
                  ? `<span class="text-[9px] text-slate-500">via role</span>`
                  : ''
              }
              <span class="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                ${esc(emp.role)}
              </span>
            </span>
          </label>
        `;
      })
      .join('');

    listWrap.querySelectorAll('[data-toggle-emp]').forEach((inp) => {
      inp.onchange = () => {
        const id = inp.getAttribute('data-toggle-emp');
        if (inp.checked) calState.formUserIds.add(id);
        else calState.formUserIds.delete(id);
        renderEmployeeChecklist();
      };
    });
  }

  function renderRoleButtons() {
    const wrap = document.getElementById('actCalRoleButtonsWrap');
    const everyoneBtn = document.getElementById('actCalEveryoneToggleBtn');
    const isEveryone = ROLE_OPTIONS.every((opt) => calState.formRoles.has(opt.key));

    if (everyoneBtn) {
      everyoneBtn.className = `px-2.5 py-1 rounded-lg border text-[11px] font-bold transition ${
        isEveryone
          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50'
          : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-white'
      }`;
      everyoneBtn.textContent = isEveryone ? '✓ Everyone' : 'Select Everyone';
    }

    if (!wrap) return;
    wrap.innerHTML = ROLE_OPTIONS.map((opt) => {
      const on = calState.formRoles.has(opt.key);
      const locked = opt.key === 'admin';
      return `
        <button type="button" data-toggle-role="${opt.key}" ${locked ? 'disabled' : ''}
          class="h-8 rounded-lg border text-xs font-bold transition ${
            on
              ? 'bg-sky-500/20 text-sky-200 border-sky-400/60'
              : 'bg-slate-900 text-slate-400 border-slate-800 hover:border-slate-600'
          } ${locked ? 'opacity-80 cursor-default' : ''}">
          ${on ? '✓ ' : ''}${opt.label}
        </button>
      `;
    }).join('');

    wrap.querySelectorAll('[data-toggle-role]').forEach((btn) => {
      btn.onclick = () => {
        const key = btn.getAttribute('data-toggle-role');
        if (key === 'admin') return;
        if (calState.formRoles.has(key)) calState.formRoles.delete(key);
        else calState.formRoles.add(key);
        renderRoleButtons();
        renderEmployeeChecklist();
      };
    });
  }

  function renderManageFeedsBody() {
    const body = document.getElementById('actCalManageBody');
    if (!body) return;

    const editing = calState.editingFeedId
      ? calState.adminFeeds.find((f) => f.id === calState.editingFeedId)
      : null;

    const selectedColor = editing?.color || 'sky';

    const listHtml =
      calState.adminFeeds.length === 0
        ? `<div class="rounded-xl bg-slate-950 border border-slate-800 p-4 text-center text-xs text-slate-400">No calendar feeds added yet.</div>`
        : calState.adminFeeds
            .map((f) => {
              const st = getColorStyle(f.color);
              const src = detectSourceBadge(f.ics_url);
              const permText = formatPermissionSummary(f);
              return `
                <div class="rounded-xl bg-slate-950 border border-slate-800 p-3 flex items-center justify-between gap-2">
                  <div class="min-w-0 flex-1 space-y-1">
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="w-2.5 h-2.5 rounded-full ${st.dot} shrink-0"></span>
                      <span class="text-sm font-bold text-white truncate">${esc(f.name)}</span>
                      <span class="text-[10px] px-1.5 py-0.5 rounded border font-bold ${src.cls}">${src.label}</span>
                      ${!f.enabled ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-bold">Paused</span>` : ''}
                    </div>
                    <div class="text-[11px] text-slate-300 font-medium">
                      Visible to: <span class="text-sky-300 font-semibold">${esc(permText)}</span>
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <button type="button" data-edit-feed="${esc(f.id)}"
                      class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200">
                      Edit
                    </button>
                    <button type="button" data-del-feed="${esc(f.id)}"
                      class="px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-xs font-bold text-rose-300">
                      Delete
                    </button>
                  </div>
                </div>
              `;
            })
            .join('');

    const colorSwatches = Object.entries(COLOR_STYLES)
      .map(
        ([key, st]) => `
          <button type="button" data-pick-color="${key}"
            class="h-8 rounded-lg border flex items-center justify-center gap-1.5 text-[11px] font-bold transition ${
              selectedColor === key
                ? 'border-white bg-slate-800 text-white'
                : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-600'
            }">
            <span class="w-2.5 h-2.5 rounded-full ${st.dot}"></span>
            <span>${st.name}</span>
          </button>
        `
      )
      .join('');

    body.innerHTML = `
      <div class="space-y-2">
        <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Connected Company Calendars</div>
        ${listHtml}
      </div>

      <form id="actCalFeedForm" class="rounded-2xl bg-slate-950/90 border border-slate-800 p-3.5 space-y-3.5">
        <div class="flex items-center justify-between">
          <div class="text-xs font-extrabold text-white">
            ${editing ? `Edit "${esc(editing.name)}"` : 'Add iCloud or Google Calendar Feed'}
          </div>
          ${
            editing
              ? `<button id="actCalCancelEditFeed" type="button" class="text-[11px] font-bold text-slate-400 hover:text-white">Cancel Edit</button>`
              : ''
          }
        </div>

        <div>
          <label class="block text-[11px] font-bold text-slate-400 mb-1">Calendar Name</label>
          <input id="actCalFeedName" type="text" required placeholder="e.g. Finish Schedule, Pour Schedule, Company Holidays"
            value="${esc(editing?.name || '')}"
            class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white focus:outline-none focus:border-sky-500" />
        </div>

        <div>
          <label class="block text-[11px] font-bold text-slate-400 mb-1">Calendar iCal Link (iCloud or Google)</label>
          <input id="actCalFeedUrl" type="text" required placeholder="webcal://p##-caldav.icloud.com/... or https://calendar.google.com/calendar/ical/.../basic.ics"
            value="${esc(editing?.ics_url || '')}"
            class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs font-mono text-white focus:outline-none focus:border-sky-500" />
          <div class="text-[10px] text-slate-400 mt-1.5 space-y-0.5 leading-relaxed">
            <div><strong class="text-slate-300">Google Calendar:</strong> Settings → pick calendar → <em>Integrate calendar</em> → copy <strong>Secret address in iCal format</strong> (keeps calendar private).</div>
            <div><strong class="text-slate-300">Apple iCloud:</strong> Calendar app → Calendars → (i) → turn on <em>Public Calendar</em> → Share Link → Copy.</div>
          </div>
        </div>

        <div>
          <label class="block text-[11px] font-bold text-slate-400 mb-1.5">Color</label>
          <input id="actCalFeedColor" type="hidden" value="${esc(selectedColor)}" />
          <div class="grid grid-cols-4 gap-1.5">${colorSwatches}</div>
        </div>

        <div class="space-y-2 pt-1 border-t border-slate-800">
          <div class="flex items-center justify-between gap-2">
            <label class="text-[11px] font-bold text-slate-300">Who Can View — Roles</label>
            <button id="actCalEveryoneToggleBtn" type="button"></button>
          </div>
          <div id="actCalRoleButtonsWrap" class="grid grid-cols-4 gap-1.5"></div>
        </div>

        <div class="space-y-2 pt-1 border-t border-slate-800">
          <div class="flex items-center justify-between gap-2">
            <label class="text-[11px] font-bold text-slate-300">Assign Specific Users</label>
            <span id="actCalUserSelectedCount" class="text-[10px] font-bold text-sky-400"></span>
          </div>
          <input id="actCalUserSearchInput" type="text" placeholder="Search employees by name or role..."
            value="${esc(calState.userSearchQuery)}"
            class="w-full px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white focus:outline-none focus:border-sky-500" />
          <div id="actCalUserChecklist"
            class="max-h-40 overflow-y-auto rounded-xl bg-slate-900/90 border border-slate-800 p-1 space-y-0.5"></div>
        </div>

        <label class="flex items-center gap-2 text-xs text-slate-300 cursor-pointer pt-1">
          <input id="actCalFeedEnabled" type="checkbox" ${editing?.enabled === false ? '' : 'checked'} class="rounded" />
          <span>Active (syncs to assigned roles & users)</span>
        </label>

        <button id="actCalSaveFeedBtn" type="submit"
          class="w-full py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-extrabold text-xs transition">
          ${editing ? 'Save Changes' : '+ Add Calendar'}
        </button>
      </form>
    `;

    renderRoleButtons();
    renderEmployeeChecklist();

    document.getElementById('actCalEveryoneToggleBtn').onclick = () => {
      const isEveryone = ROLE_OPTIONS.every((opt) => calState.formRoles.has(opt.key));
      if (isEveryone) {
        calState.formRoles = new Set(['admin', 'pm', 'supervisor']);
      } else {
        calState.formRoles = new Set(ROLE_OPTIONS.map((opt) => opt.key));
      }
      renderRoleButtons();
      renderEmployeeChecklist();
    };

    document.getElementById('actCalUserSearchInput').oninput = (e) => {
      calState.userSearchQuery = e.target.value || '';
      renderEmployeeChecklist();
    };

    body.querySelectorAll('[data-pick-color]').forEach((btn) => {
      btn.onclick = () => {
        const color = btn.getAttribute('data-pick-color');
        document.getElementById('actCalFeedColor').value = color;
        body.querySelectorAll('[data-pick-color]').forEach((b) => {
          const on = b.getAttribute('data-pick-color') === color;
          b.className = `h-8 rounded-lg border flex items-center justify-center gap-1.5 text-[11px] font-bold transition ${
            on
              ? 'border-white bg-slate-800 text-white'
              : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-600'
          }`;
        });
      };
    });

    const cancelEditBtn = document.getElementById('actCalCancelEditFeed');
    if (cancelEditBtn) {
      cancelEditBtn.onclick = () => {
        calState.editingFeedId = null;
        loadFormPermissionsFromFeed(null);
        renderManageFeedsBody();
      };
    }

    body.querySelectorAll('[data-edit-feed]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-edit-feed');
        const feed = calState.adminFeeds.find((f) => f.id === id) || null;
        calState.editingFeedId = id;
        loadFormPermissionsFromFeed(feed);
        renderManageFeedsBody();
      };
    });

    body.querySelectorAll('[data-del-feed]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-del-feed');
        const feed = calState.adminFeeds.find((f) => f.id === id);
        if (!confirm(`Remove "${feed?.name || 'this calendar'}" from ACT?`)) return;
        try {
          await invokeCalendarProxy({ mode: 'delete_feed', id });
          calState.adminFeeds = calState.adminFeeds.filter((f) => f.id !== id);
          if (calState.editingFeedId === id) {
            calState.editingFeedId = null;
            loadFormPermissionsFromFeed(null);
          }
          toast('Calendar removed.', false);
          renderManageFeedsBody();
          fetchEventsForCurrentMonth(true);
        } catch (err) {
          toast(err.message, true);
        }
      };
    });

    document.getElementById('actCalFeedForm').onsubmit = async (e) => {
      e.preventDefault();
      const saveBtn = document.getElementById('actCalSaveFeedBtn');
      const name = document.getElementById('actCalFeedName').value.trim();
      const icsUrl = document.getElementById('actCalFeedUrl').value.trim();
      const color = document.getElementById('actCalFeedColor').value || 'sky';
      const enabled = document.getElementById('actCalFeedEnabled').checked;
      const allowed_roles = Array.from(calState.formRoles);
      const allowed_user_ids = Array.from(calState.formUserIds);

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await invokeCalendarProxy({
          mode: 'upsert_feed',
          id: calState.editingFeedId || undefined,
          name,
          ics_url: icsUrl,
          color,
          enabled,
          allowed_roles,
          allowed_user_ids
        });
        const refreshed = await invokeCalendarProxy({ mode: 'list_feeds' });
        calState.adminFeeds = Array.isArray(refreshed?.feeds) ? refreshed.feeds : [];
        if (Array.isArray(refreshed?.employees)) {
          calState.adminEmployees = refreshed.employees;
        }
        calState.editingFeedId = null;
        loadFormPermissionsFromFeed(null);
        toast(`Saved calendar "${name}".`, false);
        renderManageFeedsBody();
        fetchEventsForCurrentMonth(true);
      } catch (err) {
        toast(err.message, true);
        saveBtn.disabled = false;
        saveBtn.textContent = editing ? 'Save Changes' : '+ Add Calendar';
      }
    };
  }

  // =========================================================================
  // 7. VIEW LIFECYCLE & ACT NAVIGATION HOOKS
  // =========================================================================
  async function openCalendarView() {
    if (!canViewCalendar()) {
      toast('No calendars are assigned to your account.', true);
      return;
    }

    window.ACTBlueprints?.close?.();
    ['viewCrew', 'viewAdmin', 'viewOtherModule', 'viewPmPortal', 'roleWorkspaceQuickBar'].forEach(
      (id) => document.getElementById(id)?.classList.add('hidden')
    );

    const view = ensureCalendarView();
    positionCalendarSection();
    view.classList.remove('hidden');
    calState.isOpen = true;

    const titleEl = document.getElementById('topBarPageTitle');
    if (titleEl) titleEl.textContent = 'Calendar';

    if (typeof closeSideMenu === 'function') closeSideMenu();

    hydrateFromCache();
    renderCalendarBody();
    await fetchEventsForCurrentMonth(false);
  }

  function closeCalendarView() {
    calState.isOpen = false;
    document.getElementById('viewCompanyCalendar')?.classList.add('hidden');
    document.getElementById('actCalEventModal')?.classList.add('hidden');
    document.getElementById('actCalManageModal')?.classList.add('hidden');
  }

  function syncUserContextAndVisibility() {
    const nextKey = getUserKey();
    const userChanged = nextKey !== calState.activeUserKey;

    if (userChanged) {
      calState.activeUserKey = nextKey;
      calState.loadedRangeKey = '';
      calState.calendars = [];
      calState.events = [];
      calState.warnings = [];
      calState.errorMsg = '';
      calState.hiddenCalendarIds = new Set(loadJSON(getHiddenKeyForUser(), []));
      refreshCrewAccessForActiveUser();
    }

    ensureMenuButton();

    if (calState.isOpen) {
      if (!canViewCalendar()) {
        closeCalendarView();
      } else if (userChanged) {
        hydrateFromCache();
        fetchEventsForCurrentMonth(true);
      } else {
        renderToolbar();
      }
    }
  }

  function installNavigationHooks() {
    const prevSelectMenu = window.selectMenuFeature;
    window.selectMenuFeature = function (featureKey) {
      if (featureKey === 'calendar') {
        openCalendarView();
        return;
      }
      closeCalendarView();
      if (typeof prevSelectMenu === 'function') {
        return prevSelectMenu.apply(this, arguments);
      }
    };

    const prevOpenAdmin = window.openAdminPage;
    if (typeof prevOpenAdmin === 'function') {
      window.openAdminPage = function () {
        closeCalendarView();
        return prevOpenAdmin.apply(this, arguments);
      };
    }

    const prevPersonalCard = window.openMyPersonalCardView;
    if (typeof prevPersonalCard === 'function') {
      window.openMyPersonalCardView = function () {
        closeCalendarView();
        return prevPersonalCard.apply(this, arguments);
      };
    }

    const prevLogout = window.logoutUser;
    if (typeof prevLogout === 'function') {
      window.logoutUser = function () {
        closeCalendarView();
        calState.activeUserKey = '';
        calState.loadedRangeKey = '';
        calState.crewHasAccess = false;
        calState.calendars = [];
        calState.events = [];
        return prevLogout.apply(this, arguments);
      };
    }

    const prevRefreshRole = window.refreshRoleUiVisibility;
    if (typeof prevRefreshRole === 'function') {
      window.refreshRoleUiVisibility = function () {
        const res = prevRefreshRole.apply(this, arguments);
        syncUserContextAndVisibility();
        return res;
      };
    }

    const prevUpdateTopBar = window.updateTopBarIndicators;
    if (typeof prevUpdateTopBar === 'function') {
      window.updateTopBarIndicators = function () {
        const res = prevUpdateTopBar.apply(this, arguments);
        syncUserContextAndVisibility();
        return res;
      };
    }

    syncUserContextAndVisibility();
  }

  window.ACTCalendar = {
    open: openCalendarView,
    close: closeCalendarView,
    refresh: () => fetchEventsForCurrentMonth(true)
  };

  function boot() {
    installNavigationHooks();
    ensureMenuButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
