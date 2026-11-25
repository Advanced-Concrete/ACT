// =========================================================================
// ACT MASTER - COMPANY CALENDARS MODULE (calendar.js)
// Zero-conflict drop-in read-only iOS / iCloud calendar viewer
// - Proxies multiple iCloud Public Calendar (.ics) feeds via `calendar-proxy`
// - Role guards:
//     Admin:      View Month/Day + Add/Edit/Remove company calendar feeds
//     PM / Supv:  View Month/Day + filter calendars (read-only)
//     Crew:       Hidden in menu & blocked on client + server
// - Offline cache in localStorage for field reference when signal drops
// =========================================================================
(function initACTCalendar() {
  'use strict';

  const PROXY_FN = 'calendar-proxy';
  const CACHE_KEY = 'act_company_calendar_cache_v1';
  const HIDDEN_CALS_KEY = 'act_company_calendar_hidden_v1';

  const COLOR_STYLES = {
    sky:     { name: 'Blue',   dot: 'bg-sky-400',     pill: 'bg-sky-500/20 text-sky-200 border-sky-400/40',       bar: 'bg-sky-400',     chipOn: 'bg-sky-500/20 text-sky-200 border-sky-400/50' },
    emerald: { name: 'Green',  dot: 'bg-emerald-400', pill: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40', bar: 'bg-emerald-400', chipOn: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/50' },
    amber:   { name: 'Amber',  dot: 'bg-amber-400',   pill: 'bg-amber-500/20 text-amber-200 border-amber-400/40',   bar: 'bg-amber-400',   chipOn: 'bg-amber-500/20 text-amber-200 border-amber-400/50' },
    rose:    { name: 'Red',    dot: 'bg-rose-400',    pill: 'bg-rose-500/20 text-rose-200 border-rose-400/40',      bar: 'bg-rose-400',    chipOn: 'bg-rose-500/20 text-rose-200 border-rose-400/50' },
    violet:  { name: 'Purple', dot: 'bg-violet-400',  pill: 'bg-violet-500/20 text-violet-200 border-violet-400/40', bar: 'bg-violet-400',  chipOn: 'bg-violet-500/20 text-violet-200 border-violet-400/50' },
    orange:  { name: 'Orange', dot: 'bg-orange-400',  pill: 'bg-orange-500/20 text-orange-200 border-orange-400/40', bar: 'bg-orange-400',  chipOn: 'bg-orange-500/20 text-orange-200 border-orange-400/50' },
    cyan:    { name: 'Teal',   dot: 'bg-cyan-400',    pill: 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40',      bar: 'bg-cyan-400',    chipOn: 'bg-cyan-500/20 text-cyan-200 border-cyan-400/50' },
    slate:   { name: 'Gray',   dot: 'bg-slate-400',   pill: 'bg-slate-500/25 text-slate-200 border-slate-400/40',   bar: 'bg-slate-400',   chipOn: 'bg-slate-600/40 text-slate-100 border-slate-400/50' }
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
    hiddenCalendarIds: new Set(loadJSON(HIDDEN_CALS_KEY, [])),
    syncedAt: null,
    loadedRangeKey: '',
    loading: false,
    errorMsg: '',
    adminFeeds: [],
    editingFeedId: null
  };

  // =========================================================================
  // 1. SAFE ACT BRIDGES & ROLE GUARDS
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

  function canViewCalendar() {
    const r = getEffectiveRole();
    return r === 'admin' || r === 'pm' || r === 'supervisor';
  }

  function isAdminUser() {
    return getEffectiveRole() === 'admin';
  }

  function getActiveEmployeeId() {
    if (typeof activeCrewEmployeeId !== 'undefined' && activeCrewEmployeeId) {
      return String(activeCrewEmployeeId);
    }
    return isAdminUser() ? 'ADMIN' : '';
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

  function formatMonthHeading(year, month) {
    return new Date(year, month, 1).toLocaleDateString('en-US', {
      month: 'long',
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
    const dayStart = parseYmdLocal(ymd).getTime();
    const dayEnd = new Date(
      parseYmdLocal(ymd).getFullYear(),
      parseYmdLocal(ymd).getMonth(),
      parseYmdLocal(ymd).getDate() + 1,
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
  // 3. EDGE FUNCTION CALLER & CACHING
  // =========================================================================
  async function invokeCalendarProxy(payload) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase client is not configured.');
    if (!isAppOnline()) throw new Error('Device is offline.');

    const { data, error } = await sb.functions.invoke(PROXY_FN, {
      body: { ...payload, employee_id: getActiveEmployeeId() }
    });

    if (error) {
      let detail = error.message || 'Calendar request failed';
      try {
        if (error.context && typeof error.context.json === 'function') {
          const body = await error.context.json();
          if (body?.error) detail = body.error;
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
    const cached = loadJSON(CACHE_KEY, null);
    if (!cached) return;
    if (Array.isArray(cached.calendars)) calState.calendars = cached.calendars;
    if (Array.isArray(cached.events)) calState.events = cached.events;
    if (cached.syncedAt) calState.syncedAt = cached.syncedAt;
  }

  async function fetchEventsForCurrentMonth(force = false) {
    if (!canViewCalendar()) return;

    const rangeKey = `${calState.cursorYear}-${pad2(calState.cursorMonth + 1)}`;
    if (!force && calState.loadedRangeKey === rangeKey && calState.events.length > 0) {
      renderCalendarBody();
      return;
    }

    // Fetch a generous window covering prev/next month spillover days
    const startDt = new Date(calState.cursorYear, calState.cursorMonth - 1, 1);
    const endDt = new Date(calState.cursorYear, calState.cursorMonth + 2, 0, 23, 59, 59);

    if (!isAppOnline()) {
      hydrateFromCache();
      calState.errorMsg = '';
      renderCalendarBody();
      return;
    }

    calState.loading = true;
    calState.errorMsg = '';
    renderCalendarBody();

    try {
      const res = await invokeCalendarProxy({
        mode: 'fetch_events',
        range_start: startDt.toISOString(),
        range_end: endDt.toISOString()
      });

      calState.calendars = Array.isArray(res?.calendars) ? res.calendars : [];
      calState.events = Array.isArray(res?.events) ? res.events : [];
      calState.warnings = Array.isArray(res?.warnings) ? res.warnings : [];
      calState.syncedAt = res?.syncedAt || new Date().toISOString();
      calState.loadedRangeKey = rangeKey;

      saveJSON(CACHE_KEY, {
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
  // 4. DOM INJECTION (SIDE MENU BUTTON + MAIN VIEW + MODALS)
  // =========================================================================
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
        <span class="text-[10px] font-mono text-slate-400">iOS</span>
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
    let view = document.getElementById('viewCompanyCalendar');
    if (view) return view;

    view = document.createElement('section');
    view.id = 'viewCompanyCalendar';
    view.className =
      'hidden fixed inset-x-0 bottom-0 z-30 bg-slate-950 text-slate-100 flex flex-col overflow-hidden';
    view.innerHTML = `
      <div id="actCalToolbar" class="shrink-0 bg-slate-900 border-b border-slate-800 px-3 py-2.5 space-y-2.5"></div>
      <div id="actCalBody" class="flex-1 overflow-y-auto p-3 sm:p-4"></div>
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
            <p class="text-[11px] text-slate-400">Read-only iCloud Public Calendar feeds (visible to Supv, PM & Admin)</p>
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
  // 5. RENDERING: TOOLBAR, MONTH VIEW & DAY VIEW
  // =========================================================================
  function renderToolbar() {
    const bar = document.getElementById('actCalToolbar');
    if (!bar) return;

    const heading =
      calState.viewMode === 'month'
        ? formatMonthHeading(calState.cursorYear, calState.cursorMonth)
        : formatDayHeading(calState.selectedDateStr);

    const chipsHtml = calState.calendars.length
      ? `
        <div class="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          ${calState.calendars
            .map((c) => {
              const st = getColorStyle(c.color);
              const isHidden = calState.hiddenCalendarIds.has(c.id);
              return `
                <button type="button" data-cal-filter="${esc(c.id)}"
                  class="px-2.5 py-1.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 shrink-0 transition ${
                    isHidden
                      ? 'bg-slate-950 text-slate-500 border-slate-800 line-through'
                      : st.chipOn
                  }">
                  <span class="w-2 h-2 rounded-full ${isHidden ? 'bg-slate-600' : st.dot}"></span>
                  <span>${esc(c.name)}</span>
                </button>
              `;
            })
            .join('')}
        </div>
      `
      : '';

    bar.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-1.5">
          <button id="actCalPrevBtn" type="button"
            class="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-base font-bold text-white flex items-center justify-center">
            ‹
          </button>
          <button id="actCalTodayBtn" type="button"
            class="px-3 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-bold text-slate-200">
            Today
          </button>
          <button id="actCalNextBtn" type="button"
            class="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-base font-bold text-white flex items-center justify-center">
            ›
          </button>
          <h2 class="text-sm sm:text-base font-extrabold text-white ml-1.5 truncate">${esc(heading)}</h2>
        </div>

        <div class="flex items-center gap-1.5">
          <div class="inline-flex p-0.5 rounded-xl bg-slate-950 border border-slate-800">
            <button id="actCalModeMonthBtn" type="button"
              class="px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                calState.viewMode === 'month' ? 'bg-sky-500 text-slate-950' : 'text-slate-300 hover:text-white'
              }">
              Month
            </button>
            <button id="actCalModeDayBtn" type="button"
              class="px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                calState.viewMode === 'day' ? 'bg-sky-500 text-slate-950' : 'text-slate-300 hover:text-white'
              }">
              Day
            </button>
          </div>

          <button id="actCalRefreshBtn" type="button" title="Refresh calendars" ${calState.loading ? 'disabled' : ''}
            class="h-9 px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700 text-xs font-bold text-slate-200">
            ${calState.loading ? '…' : '↻'}
          </button>

          ${
            isAdminUser()
              ? `<button id="actCalManageBtn" type="button"
                  class="h-9 px-3 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/40 text-xs font-bold text-indigo-200">
                  ⚙ Feeds
                </button>`
              : ''
          }
        </div>
      </div>
      ${chipsHtml}
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
        saveJSON(HIDDEN_CALS_KEY, Array.from(calState.hiddenCalendarIds));
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
        <div class="mb-3 rounded-xl bg-amber-500/15 border border-amber-400/40 px-3.5 py-2.5 text-xs text-amber-200 space-y-1">
          ${statusNotes.map((w) => `<div>${esc(w)}</div>`).join('')}
        </div>
      `
      : '';

    if (calState.loading && calState.calendars.length === 0) {
      body.innerHTML = `${bannerHtml}<div class="py-16 text-center text-sm text-slate-400">Syncing iCloud calendars…</div>`;
      return;
    }

    if (calState.calendars.length === 0 && !calState.loading) {
      body.innerHTML = `
        ${bannerHtml}
        <div class="max-w-md mx-auto mt-10 rounded-2xl bg-slate-900 border border-slate-800 p-6 text-center space-y-3">
          <div class="text-3xl">📅</div>
          <h3 class="text-base font-extrabold text-white">No Company Calendars Connected Yet</h3>
          <p class="text-xs text-slate-400">
            ${
              isAdminUser()
                ? 'Add one or more read-only iCloud Public Calendar links so Supervisors, PMs, and Admins can view schedules across all devices.'
                : 'Ask an ACT Administrator to add the company iCloud calendar feed(s).'
            }
          </p>
          ${
            isAdminUser()
              ? `<button id="actCalEmptyAddBtn" type="button"
                  class="px-4 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-extrabold text-xs">
                  + Add iCloud Calendar
                </button>`
              : ''
          }
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
    const todayStr = toYmd(new Date());

    const firstOfMonth = new Date(year, month, 1);
    const startOffset = firstOfMonth.getDay(); // 0=Sun
    const gridStart = new Date(year, month, 1 - startOffset);

    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      cells.push(d);
    }
    // Trim trailing 6th week if completely in next month
    const usedCells = cells[35].getMonth() !== month ? cells.slice(0, 35) : cells;

    const headerRow = WEEKDAYS.map(
      (wd) =>
        `<div class="text-center text-[11px] font-bold uppercase tracking-wider text-slate-400 py-1.5">${wd}</div>`
    ).join('');

    const dayCellsHtml = usedCells
      .map((d) => {
        const ymd = toYmd(d);
        const inMonth = d.getMonth() === month;
        const isToday = ymd === todayStr;
        const isSelected = ymd === calState.selectedDateStr;
        const dayEvents = getEventsForDay(ymd);
        const visibleEvents = dayEvents.slice(0, 3);
        const extraCount = dayEvents.length - visibleEvents.length;

        const pillsHtml = visibleEvents
          .map((ev) => {
            const st = getColorStyle(ev.color);
            const timePrefix = ev.allDay ? '' : `${formatTimeShort(ev.startIso).replace(':00 ', '')} `;
            return `
              <div class="px-1.5 py-0.5 rounded border text-[10px] sm:text-[11px] font-bold truncate leading-tight ${st.pill}">
                ${esc(timePrefix + ev.title)}
              </div>
            `;
          })
          .join('');

        return `
          <button type="button" data-open-day="${ymd}"
            class="min-h-[82px] sm:min-h-[108px] p-1.5 rounded-xl border text-left flex flex-col gap-1 transition ${
              isSelected
                ? 'bg-slate-800/90 border-sky-400/80 ring-1 ring-sky-400/50'
                : inMonth
                ? 'bg-slate-900/90 hover:bg-slate-800/70 border-slate-800'
                : 'bg-slate-950/60 hover:bg-slate-900/50 border-slate-900 opacity-50'
            }">
            <div class="flex items-center justify-between w-full">
              <span class="w-6 h-6 rounded-full text-xs font-extrabold flex items-center justify-center ${
                isToday
                  ? 'bg-sky-500 text-slate-950'
                  : inMonth
                  ? 'text-slate-200'
                  : 'text-slate-500'
              }">
                ${d.getDate()}
              </span>
              ${
                dayEvents.length > 0
                  ? `<span class="sm:hidden text-[10px] font-bold text-slate-400">${dayEvents.length}</span>`
                  : ''
              }
            </div>
            <div class="w-full space-y-1 overflow-hidden">
              ${pillsHtml}
              ${
                extraCount > 0
                  ? `<div class="text-[10px] font-bold text-slate-400 px-1">+${extraCount} more</div>`
                  : ''
              }
            </div>
          </button>
        `;
      })
      .join('');

    container.innerHTML = `
      ${bannerHtml}
      <div class="max-w-6xl mx-auto">
        <div class="grid grid-cols-7 gap-1 sm:gap-1.5 mb-1">${headerRow}</div>
        <div class="grid grid-cols-7 gap-1 sm:gap-1.5">${dayCellsHtml}</div>
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
      <div class="max-w-2xl mx-auto space-y-4">
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

    header.innerHTML = `
      <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[11px] font-bold mb-1.5 ${st.pill}">
        <span class="w-2 h-2 rounded-full ${st.dot}"></span>
        ${esc(ev.calendarName)}
      </span>
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
        Read-only iCloud Calendar event. Edit in Apple Calendar to update.
      </div>
    `;

    modal.classList.remove('hidden');
  }

  // =========================================================================
  // 6. ADMIN MANAGE FEEDS MODAL
  // =========================================================================
  async function openManageFeedsModal() {
    if (!isAdminUser()) return;
    ensureManageFeedsModal();
    const modal = document.getElementById('actCalManageModal');
    const body = document.getElementById('actCalManageBody');
    calState.editingFeedId = null;

    modal.classList.remove('hidden');
    body.innerHTML = `<div class="py-10 text-center text-xs text-slate-400">Loading calendar feeds…</div>`;

    try {
      const res = await invokeCalendarProxy({ mode: 'list_feeds' });
      calState.adminFeeds = Array.isArray(res?.feeds) ? res.feeds : [];
      renderManageFeedsBody();
    } catch (err) {
      body.innerHTML = `<div class="rounded-xl bg-rose-500/15 border border-rose-400/40 p-3 text-xs text-rose-200">${esc(err.message)}</div>`;
    }
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
              return `
                <div class="rounded-xl bg-slate-950 border border-slate-800 p-3 flex items-center justify-between gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="w-2.5 h-2.5 rounded-full ${st.dot} shrink-0"></span>
                      <span class="text-sm font-bold text-white truncate">${esc(f.name)}</span>
                      ${!f.enabled ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-bold">Paused</span>` : ''}
                    </div>
                    <div class="text-[11px] font-mono text-slate-500 truncate mt-0.5">${esc(f.ics_url)}</div>
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

      <form id="actCalFeedForm" class="rounded-2xl bg-slate-950/90 border border-slate-800 p-3.5 space-y-3">
        <div class="flex items-center justify-between">
          <div class="text-xs font-extrabold text-white">
            ${editing ? `Edit "${esc(editing.name)}"` : 'Add iCloud Calendar Feed'}
          </div>
          ${
            editing
              ? `<button id="actCalCancelEditFeed" type="button" class="text-[11px] font-bold text-slate-400 hover:text-white">Cancel Edit</button>`
              : ''
          }
        </div>

        <div>
          <label class="block text-[11px] font-bold text-slate-400 mb-1">Calendar Name</label>
          <input id="actCalFeedName" type="text" required placeholder="e.g. Pour Schedule, Saw Cutting, Equipment"
            value="${esc(editing?.name || '')}"
            class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white focus:outline-none focus:border-sky-500" />
        </div>

        <div>
          <label class="block text-[11px] font-bold text-slate-400 mb-1">iCloud Public Calendar Link</label>
          <input id="actCalFeedUrl" type="text" required placeholder="webcal://p123-caldav.icloud.com/published/2/..."
            value="${esc(editing?.ics_url || '')}"
            class="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs font-mono text-white focus:outline-none focus:border-sky-500" />
          <p class="text-[10px] text-slate-500 mt-1">
            On iPhone/iPad: Calendar app → Calendars → tap (i) → turn on Public Calendar → Share Link → Copy.
          </p>
        </div>

        <div>
          <label class="block text-[11px] font-bold text-slate-400 mb-1.5">Color</label>
          <input id="actCalFeedColor" type="hidden" value="${esc(selectedColor)}" />
          <div class="grid grid-cols-4 gap-1.5">${colorSwatches}</div>
        </div>

        <label class="flex items-center gap-2 text-xs text-slate-300 cursor-pointer pt-1">
          <input id="actCalFeedEnabled" type="checkbox" ${editing?.enabled === false ? '' : 'checked'} class="rounded" />
          <span>Active (visible to Supervisors, PMs & Admins)</span>
        </label>

        <button id="actCalSaveFeedBtn" type="submit"
          class="w-full py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-extrabold text-xs transition">
          ${editing ? 'Save Changes' : '+ Add Calendar'}
        </button>
      </form>
    `;

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
        renderManageFeedsBody();
      };
    }

    body.querySelectorAll('[data-edit-feed]').forEach((btn) => {
      btn.onclick = () => {
        calState.editingFeedId = btn.getAttribute('data-edit-feed');
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
          if (calState.editingFeedId === id) calState.editingFeedId = null;
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

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await invokeCalendarProxy({
          mode: 'upsert_feed',
          id: calState.editingFeedId || undefined,
          name,
          ics_url: icsUrl,
          color,
          enabled
        });
        const refreshed = await invokeCalendarProxy({ mode: 'list_feeds' });
        calState.adminFeeds = Array.isArray(refreshed?.feeds) ? refreshed.feeds : [];
        calState.editingFeedId = null;
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
      toast('Calendar access is restricted to Supervisors, PMs, and Admins.', true);
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
    if (titleEl) titleEl.textContent = 'Company Calendar';

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
        calState.loadedRangeKey = '';
        return prevLogout.apply(this, arguments);
      };
    }

    const syncVisibility = () => {
      ensureMenuButton();
      if (calState.isOpen && !canViewCalendar()) {
        closeCalendarView();
      } else if (calState.isOpen) {
        renderToolbar();
      }
    };

    const prevRefreshRole = window.refreshRoleUiVisibility;
    if (typeof prevRefreshRole === 'function') {
      window.refreshRoleUiVisibility = function () {
        const res = prevRefreshRole.apply(this, arguments);
        syncVisibility();
        return res;
      };
    }

    const prevUpdateTopBar = window.updateTopBarIndicators;
    if (typeof prevUpdateTopBar === 'function') {
      window.updateTopBarIndicators = function () {
        const res = prevUpdateTopBar.apply(this, arguments);
        syncVisibility();
        return res;
      };
    }

    syncVisibility();
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
