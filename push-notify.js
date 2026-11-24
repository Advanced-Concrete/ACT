(function initActPushNotifications() {
  'use strict';

  const SW_PATH = './sw.js';
  const BANNER_DISMISS_KEY = 'act_push_banner_dismissed_session';

  let currentAdminTab = 'missing';
  let adminDataCache = null;
  let expandedEmployees = new Set();
  let showDismissedList = false;
  let lastLoggedInKey = null;
  let badgeRefreshTimer = null;

  // =========================================================================
  // 1. ENVIRONMENT & ACT SESSION HELPERS
  // =========================================================================
  function getSupabaseClient() {
    const candidates = [
      typeof supabaseClient !== 'undefined' ? supabaseClient : null,
      typeof sb !== 'undefined' ? sb : null,
      typeof supabaseDb !== 'undefined' ? supabaseDb : null,
      window.supabaseClient,
      window.sb,
      window._supabase,
      window.actSupabase
    ];
    for (const c of candidates) {
      if (c && typeof c.from === 'function') return c;
    }
    if (typeof supabase !== 'undefined' && supabase && typeof supabase.from === 'function') {
      return supabase;
    }
    return null;
  }

  function getActiveSession() {
    const role =
      (typeof currentRole !== 'undefined' && currentRole) ||
      window.currentRole ||
      '';

    let empId =
      (typeof currentEmployeeId !== 'undefined' && currentEmployeeId) ||
      (typeof currentUserId !== 'undefined' && currentUserId) ||
      (typeof currentUser !== 'undefined' && currentUser && (currentUser.id || currentUser)) ||
      (typeof currentEmployee !== 'undefined' && currentEmployee && currentEmployee.id) ||
      window.currentEmployeeId ||
      null;

    if (!empId) {
      const loginSel =
        document.getElementById('loginUserSelect') ||
        document.querySelector('#loginScreen select');
      if (loginSel && loginSel.value) empId = loginSel.value;
    }

    if (!empId && String(role).toLowerCase() === 'admin') {
      empId = 'admin';
    }

    const emps =
      typeof state !== 'undefined' && Array.isArray(state.employees)
        ? state.employees
        : [];
    const empObj = emps.find((e) => String(e.id) === String(empId)) || null;
    const displayName = empObj
      ? empObj.full_name
      : String(empId || '').toLowerCase() === 'admin'
      ? 'Administrator'
      : 'User';

    return {
      role: String(role || '').toLowerCase(),
      isAdmin: String(role || '').toLowerCase() === 'admin',
      employeeId: empId ? String(empId) : null,
      displayName
    };
  }

  function isLoggedIn() {
    const loginEl = document.getElementById('loginScreen');
    if (!loginEl) return false;
    const isHidden =
      loginEl.classList.contains('hidden') ||
      window.getComputedStyle(loginEl).display === 'none';
    return isHidden && Boolean(getActiveSession().employeeId);
  }

  function notifyToast(msg, isError = false) {
    if (typeof showSimpleToast === 'function') {
      showSimpleToast(msg, isError);
    } else {
      console[isError ? 'error' : 'log']('[ACT Push]', msg);
      if (isError) alert(msg);
    }
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(val) {
    const n = Number(val || 0);
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(isNaN(n) ? 0 : n);
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function normalizeLastFour(val) {
    const digits = String(val ?? '').replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-4) : digits;
  }

  function isIosDevice() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  function isStandaloneMode() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function getDeviceLabel() {
    const ua = navigator.userAgent || '';
    let os = 'Desktop';
    if (/iPhone/i.test(ua)) os = 'iPhone';
    else if (/iPad/i.test(ua)) os = 'iPad';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac/i.test(ua)) os = 'Mac';
    return `${os} • ${isStandaloneMode() ? 'App' : 'Browser'}`;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // =========================================================================
  // 2. SERVICE WORKER & BROWSER PUSH SUBSCRIPTION
  // =========================================================================
  function getPushSupportState() {
    if (isIosDevice() && !isStandaloneMode()) {
      return { supported: false, reason: 'ios_needs_homescreen' };
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return { supported: false, reason: 'unsupported_browser' };
    }
    if (Notification.permission === 'denied') {
      return { supported: false, reason: 'permission_denied' };
    }
    return { supported: true, reason: 'ok' };
  }

  async function getActiveRegistration() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      const reg = await navigator.serviceWorker.register(SW_PATH, { scope: './' });
      await navigator.serviceWorker.ready;
      return reg;
    } catch (err) {
      console.error('[ACT Push] SW registration failed:', err);
      return null;
    }
  }

  async function getCurrentSubscription() {
    const support = getPushSupportState();
    if (!support.supported) return null;
    try {
      const reg = await navigator.serviceWorker.getRegistration('./');
      if (!reg || !reg.pushManager) return null;
      return await reg.pushManager.getSubscription();
    } catch (_) {
      return null;
    }
  }

  async function syncExistingSubscriptionSilently() {
    const session = getActiveSession();
    const client = getSupabaseClient();
    if (!session.employeeId || !client) return;

    const sub = await getCurrentSubscription();
    if (!sub) return;

    const json = sub.toJSON();
    if (!json || !json.endpoint || !json.keys) return;

    await client.from('push_subscriptions').upsert(
      {
        employee_id: session.employeeId,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        device_label: getDeviceLabel(),
        updated_at: new Date().toISOString()
      },
      { onConflict: 'endpoint' }
    );
  }

  async function enablePushOnThisDevice() {
    const support = getPushSupportState();
    if (!support.supported) {
      if (support.reason === 'ios_needs_homescreen') {
        notifyToast('On iPhone: tap Share → Add to Home Screen, then open ACT from your Home Screen first.', true);
      } else if (support.reason === 'permission_denied') {
        notifyToast('Notifications are blocked in your browser/phone settings. Please allow notifications for ACT.', true);
      } else {
        notifyToast('This browser does not support Web Push notifications.', true);
      }
      return false;
    }

    const session = getActiveSession();
    const client = getSupabaseClient();
    if (!session.employeeId || !client) {
      notifyToast('Please sign in first before enabling alerts.', true);
      return false;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        notifyToast('Notification permission was not granted.', true);
        await refreshPushUiState();
        return false;
      }

      const { data: settings, error: setErr } = await client
        .from('push_settings')
        .select('vapid_public_key')
        .eq('id', 'default')
        .maybeSingle();

      if (setErr) throw setErr;
      const vapidPublicKey = settings?.vapid_public_key?.trim();
      if (!vapidPublicKey) {
        notifyToast('Push setup incomplete: VAPID public key is missing in Supabase push_settings.', true);
        return false;
      }

      const reg = await getActiveRegistration();
      if (!reg) throw new Error('Service Worker failed to register.');

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
        });
      }

      const json = sub.toJSON();
      if (!json || !json.endpoint || !json.keys) {
        throw new Error('Browser returned an incomplete push subscription.');
      }

      const { error: upErr } = await client.from('push_subscriptions').upsert(
        {
          employee_id: session.employeeId,
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
          device_label: getDeviceLabel(),
          updated_at: new Date().toISOString()
        },
        { onConflict: 'endpoint' }
      );
      if (upErr) throw upErr;

      notifyToast('Receipt alerts enabled on this device!', false);
      await refreshPushUiState();
      return true;
    } catch (err) {
      console.error('[ACT Push] Enable error:', err);
      notifyToast(`Could not enable alerts: ${err.message || err}`, true);
      return false;
    }
  }

  async function disablePushOnThisDevice() {
    if (!confirm('Turn off receipt push notifications on this device?')) return;
    const client = getSupabaseClient();
    try {
      const sub = await getCurrentSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        if (client && endpoint) {
          await client.from('push_subscriptions').delete().eq('endpoint', endpoint);
        }
      }
      notifyToast('Receipt alerts turned off for this device.', false);
      await refreshPushUiState();
    } catch (err) {
      console.error('[ACT Push] Disable error:', err);
      notifyToast(`Could not disable alerts: ${err.message || err}`, true);
    }
  }

  // =========================================================================
  // 3. SIDE MENU & OPT-IN BANNER INJECTION
  // =========================================================================
  function ensureSideMenuControls() {
    const drawer = document.getElementById('sideMenuDrawer');
    if (!drawer) return;

    let container = document.getElementById('actPushSideMenuSection');
    if (!container) {
      container = document.createElement('div');
      container.id = 'actPushSideMenuSection';
      container.className = 'px-3 py-3 mt-2 border-t border-slate-700/80 space-y-2';

      // Place inside the scrollable nav area if present, else append to drawer
      const navTarget = drawer.querySelector('nav') || drawer.querySelector('.overflow-y-auto') || drawer;
      navTarget.appendChild(container);
    }

    const session = getActiveSession();
    container.innerHTML = `
      <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 px-2">Alerts</div>
      <button id="actPushUserToggleBtn" type="button"
        class="w-full flex items-center justify-between gap-2 px-3 py-3 rounded-xl bg-slate-800/90 hover:bg-slate-700 border border-slate-700 text-left text-sm font-semibold text-slate-100 transition">
        <span class="flex items-center gap-2.5">
          <span class="text-base">🔔</span>
          <span id="actPushUserToggleLabel">Receipt Alerts</span>
        </span>
        <span id="actPushUserStatusPill" class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-700 text-slate-300">...</span>
      </button>
      ${
        session.isAdmin
          ? `<button id="actPushAdminOpenBtn" type="button"
              class="w-full flex items-center justify-between gap-2 px-3 py-3 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-left text-sm font-semibold text-emerald-200 transition">
              <span class="flex items-center gap-2.5">
                <span class="text-base">📣</span>
                <span>Push Notifications</span>
              </span>
              <span id="actPushAdminBadge" class="hidden text-xs font-extrabold px-2 py-0.5 rounded-full bg-amber-500 text-slate-950">0</span>
            </button>`
          : ''
      }
    `;

    const toggleBtn = document.getElementById('actPushUserToggleBtn');
    if (toggleBtn) {
      toggleBtn.onclick = async () => {
        const sub = await getCurrentSubscription();
        if (sub) {
          await disablePushOnThisDevice();
        } else {
          await enablePushOnThisDevice();
        }
      };
    }

    const adminBtn = document.getElementById('actPushAdminOpenBtn');
    if (adminBtn) {
      adminBtn.onclick = () => {
        if (typeof toggleSideMenu === 'function') {
          try { toggleSideMenu(false); } catch (_) {}
        }
        openAdminPushModal();
      };
    }
  }

  function removeOptInBanner() {
    const existing = document.getElementById('actPushOptInBanner');
    if (existing) existing.remove();
  }

  function renderOptInBanner(support) {
    if (sessionStorage.getItem(BANNER_DISMISS_KEY) === '1') return;
    if (document.getElementById('actPushOptInBanner')) return;

    const banner = document.createElement('div');
    banner.id = 'actPushOptInBanner';
    banner.className =
      'fixed bottom-4 left-1/2 -translate-x-1/2 z-[65] w-[94%] max-w-md rounded-2xl bg-slate-900/95 border border-emerald-500/40 shadow-2xl p-3.5 text-slate-100 backdrop-blur';

    if (support.reason === 'ios_needs_homescreen') {
      banner.innerHTML = `
        <div class="flex items-start gap-3">
          <div class="text-xl leading-none mt-0.5">📲</div>
          <div class="flex-1 text-xs leading-relaxed text-slate-200">
            <div class="font-bold text-sm text-white mb-0.5">Enable Missing Receipt Alerts</div>
            On iPhone, tap <strong>Share → Add to Home Screen</strong>, then open ACT from your Home Screen to turn on alerts.
          </div>
          <button id="actPushBannerClose" type="button" class="text-slate-400 hover:text-white text-lg px-1 leading-none">&times;</button>
        </div>
      `;
    } else {
      banner.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="text-xl leading-none">🔔</div>
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm text-white">Turn on receipt alerts?</div>
            <div class="text-xs text-slate-300">Get notified only when a card receipt is missing.</div>
          </div>
          <button id="actPushBannerEnable" type="button"
            class="shrink-0 px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs">
            Enable
          </button>
          <button id="actPushBannerClose" type="button" class="text-slate-400 hover:text-white text-lg px-1 leading-none">&times;</button>
        </div>
      `;
    }

    document.body.appendChild(banner);

    const closeBtn = document.getElementById('actPushBannerClose');
    if (closeBtn) {
      closeBtn.onclick = () => {
        sessionStorage.setItem(BANNER_DISMISS_KEY, '1');
        removeOptInBanner();
      };
    }

    const enableBtn = document.getElementById('actPushBannerEnable');
    if (enableBtn) {
      enableBtn.onclick = async () => {
        enableBtn.disabled = true;
        enableBtn.textContent = '...';
        const ok = await enablePushOnThisDevice();
        if (ok) removeOptInBanner();
        else {
          enableBtn.disabled = false;
          enableBtn.textContent = 'Enable';
        }
      };
    }
  }

  async function refreshPushUiState() {
    if (!isLoggedIn()) {
      removeOptInBanner();
      return;
    }

    ensureSideMenuControls();

    const pill = document.getElementById('actPushUserStatusPill');
    const support = getPushSupportState();
    const sub = support.supported ? await getCurrentSubscription() : null;

    if (pill) {
      if (sub) {
        pill.textContent = 'On';
        pill.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
        removeOptInBanner();
        syncExistingSubscriptionSilently().catch(() => {});
      } else if (support.reason === 'ios_needs_homescreen') {
        pill.textContent = 'Home Screen';
        pill.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300';
        renderOptInBanner(support);
      } else if (support.reason === 'permission_denied') {
        pill.textContent = 'Blocked';
        pill.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300';
        removeOptInBanner();
      } else if (!support.supported) {
        pill.textContent = 'N/A';
        pill.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-700 text-slate-400';
        removeOptInBanner();
      } else {
        pill.textContent = 'Off';
        pill.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300';
        renderOptInBanner(support);
      }
    }

    if (getActiveSession().isAdmin) {
      refreshAdminBadgeCount().catch(() => {});
    }
  }

  async function refreshAdminBadgeCount() {
    const badge = document.getElementById('actPushAdminBadge');
    const client = getSupabaseClient();
    if (!badge || !client) return;

    const data = await loadAdminPushData();
    const count = data.missingGroups.length;
    if (count > 0) {
      badge.textContent = String(count);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // =========================================================================
  // 4. ADMIN DATA LOADING & EDGE FUNCTION CALLS
  // =========================================================================
  async function loadAdminPushData() {
    const client = getSupabaseClient();
    if (!client) throw new Error('Supabase client not found.');

    const [empRes, cardRes, lineRes, subRes, setRes, logRes] = await Promise.all([
      client
        .from('employees')
        .select('id, full_name, role, active')
        .neq('active', false)
        .order('full_name', { ascending: true }),
      client.from('cards').select('id, last_four, assigned_employee_id'),
      client
        .from('statement_lines')
        .select(
          'id, post_date, card_id, last_four, vendor, amount, is_statement_row, reconciled_with_statement, receipt_image, discrepancy_dismissed, discrepancy_dismissed_by, discrepancy_dismissed_at, discrepancy_dismiss_note'
        )
        .eq('is_statement_row', true)
        .order('post_date', { ascending: false }),
      client.from('push_subscriptions').select('id, employee_id, device_label, updated_at'),
      client.from('push_settings').select('*').eq('id', 'default').maybeSingle(),
      client
        .from('push_notification_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20)
    ]);

    if (empRes.error) throw empRes.error;
    if (cardRes.error) throw cardRes.error;
    if (lineRes.error) throw lineRes.error;
    if (subRes.error) throw subRes.error;

    const employees = empRes.data || [];
    const empById = new Map(employees.map((e) => [String(e.id), e]));

    const cardById = new Map();
    const cardByLastFour = new Map();
    for (const c of cardRes.data || []) {
      if (!c.assigned_employee_id) continue;
      const eid = String(c.assigned_employee_id);
      if (c.id) cardById.set(String(c.id), eid);
      const l4 = normalizeLastFour(c.last_four);
      if (l4) cardByLastFour.set(l4, eid);
    }

    const subsByEmp = new Map();
    for (const s of subRes.data || []) {
      const eid = String(s.employee_id);
      const list = subsByEmp.get(eid) || [];
      list.push(s);
      subsByEmp.set(eid, list);
    }

    const missingMap = new Map();
    const dismissedLines = [];

    for (const row of lineRes.data || []) {
      const hasReceipt =
        typeof row.receipt_image === 'string' && row.receipt_image.trim().length > 0;
      const isReconciled = row.reconciled_with_statement === true;
      if (hasReceipt || isReconciled) continue;

      let eid = null;
      if (row.card_id && cardById.has(String(row.card_id))) {
        eid = cardById.get(String(row.card_id));
      } else {
        const l4 = normalizeLastFour(row.last_four);
        if (l4 && cardByLastFour.has(l4)) eid = cardByLastFour.get(l4);
      }

      const empObj = eid ? empById.get(eid) : null;
      const enrichedRow = {
        ...row,
        employee_id: eid,
        employee_name: empObj ? empObj.full_name : `Unassigned Card (*${normalizeLastFour(row.last_four) || '????'})`
      };

      if (row.discrepancy_dismissed === true) {
        dismissedLines.push(enrichedRow);
        continue;
      }

      if (!eid || !empObj) continue;

      const group = missingMap.get(eid) || {
        employeeId: eid,
        fullName: empObj.full_name || 'Cardholder',
        deviceCount: (subsByEmp.get(eid) || []).length,
        totalAmount: 0,
        lines: []
      };
      group.lines.push(enrichedRow);
      group.totalAmount += Number(row.amount || 0);
      missingMap.set(eid, group);
    }

    const missingGroups = Array.from(missingMap.values()).sort(
      (a, b) => b.lines.length - a.lines.length || a.fullName.localeCompare(b.fullName)
    );

    adminDataCache = {
      employees,
      subsByEmp,
      missingGroups,
      dismissedLines,
      settings: setRes.data || { auto_remind_enabled: true },
      logs: logRes.data || []
    };

    return adminDataCache;
  }

  async function invokePushEdgeFunction(payload) {
    const client = getSupabaseClient();
    const session = getActiveSession();
    if (!client) throw new Error('Supabase client not found.');

    const { data, error } = await client.functions.invoke('send-receipt-alerts', {
      body: {
        ...payload,
        admin_employee_id: session.employeeId || 'admin'
      }
    });

    if (error) {
      throw new Error(error.message || 'Edge Function request failed.');
    }
    if (data && data.error) {
      throw new Error(data.error);
    }
    return data;
  }

  async function setLineDismissed(lineId, dismissed) {
    const client = getSupabaseClient();
    const session = getActiveSession();
    if (!client) return;

    let note = null;
    if (dismissed) {
      const input = prompt(
        'Dismiss this missing-receipt discrepancy so the cardholder is no longer reminded about it?\n\nOptional reason (e.g., "Receipt emailed to accounting" or "Under threshold"):'
      );
      if (input === null) return; // User cancelled
      note = input.trim() || 'Dismissed by Admin';
    } else {
      if (!confirm('Restore this item to the missing receipts list?')) return;
    }

    const patch = dismissed
      ? {
          discrepancy_dismissed: true,
          discrepancy_dismissed_by: session.displayName,
          discrepancy_dismissed_at: new Date().toISOString(),
          discrepancy_dismiss_note: note
        }
      : {
          discrepancy_dismissed: false,
          discrepancy_dismissed_by: null,
          discrepancy_dismissed_at: null,
          discrepancy_dismiss_note: null
        };

    const { error } = await client
      .from('statement_lines')
      .update(patch)
      .eq('id', lineId);

    if (error) {
      notifyToast(`Failed to update discrepancy: ${error.message}`, true);
      return;
    }

    // Mirror onto in-memory ACT state so subsequent saveState() calls preserve it
    if (typeof state !== 'undefined' && Array.isArray(state.statementLines)) {
      const localLine = state.statementLines.find((x) => String(x.id) === String(lineId));
      if (localLine) Object.assign(localLine, patch);
    }

    notifyToast(dismissed ? 'Discrepancy dismissed.' : 'Discrepancy restored.', false);
    await renderAdminPushModalBody(true);
    refreshAdminBadgeCount().catch(() => {});
  }

  // =========================================================================
  // 5. ADMIN NOTIFICATION CENTER MODAL
  // =========================================================================
  function ensureAdminModalShell() {
    let modal = document.getElementById('actPushAdminModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'actPushAdminModal';
    modal.className =
      'fixed inset-0 z-[80] hidden bg-slate-950/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4';

    modal.innerHTML = `
      <div class="w-full max-w-2xl max-h-[92vh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden text-slate-100">
        <div class="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/95">
          <div>
            <h2 class="text-lg font-extrabold text-white flex items-center gap-2">
              <span>📣</span> Push Notifications
            </h2>
            <p class="text-xs text-slate-400">24h post-CSV alert • +48h follow-up • Direct alerts</p>
          </div>
          <div class="flex items-center gap-2">
            <button id="actPushModalRefresh" type="button"
              class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200">
              Refresh
            </button>
            <button id="actPushModalClose" type="button"
              class="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-xl leading-none text-slate-300">
              &times;
            </button>
          </div>
        </div>

        <div id="actPushModalBody" class="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          <div class="py-12 text-center text-slate-400 text-sm">Loading notification center...</div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeAdminPushModal();
    });

    document.getElementById('actPushModalClose').onclick = closeAdminPushModal;
    document.getElementById('actPushModalRefresh').onclick = () => renderAdminPushModalBody(true);

    return modal;
  }

  function closeAdminPushModal() {
    const modal = document.getElementById('actPushAdminModal');
    if (modal) modal.classList.add('hidden');
  }

  async function openAdminPushModal() {
    if (!getActiveSession().isAdmin) {
      notifyToast('Admin access required.', true);
      return;
    }
    const modal = ensureAdminModalShell();
    modal.classList.remove('hidden');
    await renderAdminPushModalBody(true);
  }

  async function renderAdminPushModalBody(forceReload = false) {
    const bodyEl = document.getElementById('actPushModalBody');
    if (!bodyEl) return;

    if (forceReload || !adminDataCache) {
      bodyEl.innerHTML = `<div class="py-12 text-center text-slate-400 text-sm animate-pulse">Loading latest statement data & devices...</div>`;
      try {
        await loadAdminPushData();
      } catch (err) {
        bodyEl.innerHTML = `<div class="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">Error loading push data: ${esc(err.message || err)}</div>`;
        return;
      }
    }

    const { employees, subsByEmp, missingGroups, dismissedLines, settings, logs } = adminDataCache;
    const autoOn = settings.auto_remind_enabled !== false;
    const pendingCsv = settings.pending_csv_alert_at;
 const pendingFollowup = !pendingCsv ? settings.pending_followup_alert_at : null;

 const pendingBannerHtml = pendingCsv
   ? `
     <div class="rounded-xl bg-amber-500/15 border border-amber-400/40 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
       <div class="text-xs text-amber-100">
         <div class="font-bold text-sm text-amber-300">24-Hour Post-CSV Alert Queued</div>
         Scheduled to fire on <strong>${esc(formatDateTime(pendingCsv))}</strong> (followed by a +48h reminder for any still missing).
       </div>
       <div class="flex items-center gap-2 shrink-0">
         <button id="actPushSendCsvNowBtn" type="button"
           class="px-3 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs">
           Send Now
         </button>
         <button id="actPushCancelCsvTimerBtn" type="button"
           class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-600">
           Cancel Timer
         </button>
       </div>
     </div>
   `
   : pendingFollowup
   ? `
     <div class="rounded-xl bg-amber-500/15 border border-amber-400/40 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
       <div class="text-xs text-amber-100">
         <div class="font-bold text-sm text-amber-300">48-Hour Follow-Up Alert Queued</div>
         Final reminder scheduled for <strong>${esc(formatDateTime(pendingFollowup))}</strong> (only for remaining missing receipts).
       </div>
       <div class="flex items-center gap-2 shrink-0">
         <button id="actPushSendFollowupNowBtn" type="button"
           class="px-3 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs">
           Send Now
         </button>
         <button id="actPushCancelFollowupTimerBtn" type="button"
           class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-600">
           Cancel Follow-Up
         </button>
       </div>
     </div>
   `
   : '';

 const scheduleCardHtml = `
   <div class="rounded-xl bg-slate-800/70 border border-slate-700 p-3.5 flex items-center justify-between gap-3">
     <div>
       <div class="text-sm font-bold text-white">Automatic Reminders</div>
       <div class="text-xs text-slate-400">
         24h after CSV upload + 48h follow-up
         ${settings.last_auto_sent_at ? ` • Last auto-sent ${esc(formatDateTime(settings.last_auto_sent_at))}` : ''}
       </div>
     </div>
     <button id="actPushAutoToggleBtn" type="button"
       class="shrink-0 px-3.5 py-2 rounded-xl font-bold text-xs transition ${
         autoOn
           ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30'
           : 'bg-slate-700 text-slate-300 border border-slate-600 hover:bg-slate-600'
       }">
       ${autoOn ? 'Auto: ON' : 'Auto: PAUSED'}
     </button>
   </div>
 `;
    const tabsHtml = `
      <div class="grid grid-cols-3 gap-2 p-1 rounded-xl bg-slate-950/70 border border-slate-800">
        <button data-push-tab="missing" type="button"
          class="py-2.5 px-2 rounded-lg text-xs font-bold transition ${
            currentAdminTab === 'missing' ? 'bg-emerald-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800'
          }">
          Missing (${missingGroups.length})
        </button>
        <button data-push-tab="individual" type="button"
          class="py-2.5 px-2 rounded-lg text-xs font-bold transition ${
            currentAdminTab === 'individual' ? 'bg-emerald-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800'
          }">
          Individual
        </button>
        <button data-push-tab="history" type="button"
          class="py-2.5 px-2 rounded-lg text-xs font-bold transition ${
            currentAdminTab === 'history' ? 'bg-emerald-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800'
          }">
          History
        </button>
      </div>
    `;

    let tabContentHtml = '';

    // ---- TAB 1: MISSING RECEIPTS (GROUP + DISMISS DISCREPANCIES) ----
    if (currentAdminTab === 'missing') {
      if (missingGroups.length === 0) {
        tabContentHtml = `
          <div class="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-6 text-center">
            <div class="text-2xl mb-1">✅</div>
            <div class="font-bold text-emerald-300">All caught up!</div>
            <div class="text-xs text-slate-300 mt-1">No cardholders currently have undismissed missing statement receipts.</div>
          </div>
        `;
      } else {
        const rowsHtml = missingGroups
          .map((g) => {
            const isExpanded = expandedEmployees.has(g.employeeId);
            const activeBadge =
              g.deviceCount > 0
                ? `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">Push Active (${g.deviceCount})</span>`
                : `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">Not Enabled</span>`;

            const linesHtml = isExpanded
              ? `
                <div class="mt-2.5 pt-2.5 border-t border-slate-700/80 space-y-2">
                  ${g.lines
                    .map(
                      (line) => `
                        <div class="flex items-center justify-between gap-2 rounded-lg bg-slate-900/90 px-3 py-2 text-xs">
                          <div class="min-w-0">
                            <div class="font-semibold text-slate-100 truncate">${esc(line.vendor || 'Unknown Vendor')}</div>
                            <div class="text-slate-400">
                              ${esc(line.post_date || 'No date')} • Card *${esc(normalizeLastFour(line.last_four) || '????')} • <span class="text-slate-200 font-semibold">${esc(formatMoney(line.amount))}</span>
                            </div>
                          </div>
                          <button type="button" data-dismiss-line="${esc(line.id)}"
                            class="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/20 hover:text-rose-200 border border-slate-600 text-[11px] font-bold text-slate-300">
                            Dismiss
                          </button>
                        </div>
                      `
                    )
                    .join('')}
                </div>
              `
              : '';

            return `
              <div class="rounded-xl bg-slate-800/70 border border-slate-700 p-3">
                <div class="flex items-center gap-3">
                  <input type="checkbox" class="act-push-missing-cb w-5 h-5 accent-emerald-500 rounded shrink-0"
                    value="${esc(g.employeeId)}" ${g.deviceCount > 0 ? 'checked' : ''} />
                  <div class="flex-1 min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-bold text-sm text-white">${esc(g.fullName)}</span>
                      ${activeBadge}
                    </div>
                    <div class="text-xs text-slate-400 mt-0.5">
                      ${g.lines.length} missing receipt${g.lines.length === 1 ? '' : 's'} • ${esc(formatMoney(g.totalAmount))}
                    </div>
                  </div>
                  <button type="button" data-expand-emp="${esc(g.employeeId)}"
                    class="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-300">
                    ${isExpanded ? 'Hide ▴' : 'Items ▾'}
                  </button>
                </div>
                ${linesHtml}
              </div>
            `;
          })
          .join('');

        tabContentHtml = `
          <div class="space-y-3">
            <div class="flex items-center justify-between text-xs">
              <span class="text-slate-400">Cardholders with missing receipt images</span>
              <div class="flex gap-2">
                <button id="actPushSelectAllMissing" type="button" class="text-emerald-400 hover:underline font-semibold">Select Active</button>
                <span class="text-slate-600">|</span>
                <button id="actPushClearAllMissing" type="button" class="text-slate-400 hover:underline font-semibold">Clear</button>
              </div>
            </div>
            <div class="space-y-2">${rowsHtml}</div>
            <div class="space-y-2 pt-2 border-t border-slate-800">
              <label class="block text-xs font-semibold text-slate-300">Optional Custom Note (leave blank for automatic count & total)</label>
              <input id="actPushGroupNote" type="text" maxlength="180"
                placeholder="e.g., Please upload your card receipts by Friday at 3 PM."
                class="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500" />
              <button id="actPushSendGroupBtn" type="button"
                class="w-full py-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-sm shadow-lg transition">
                Send Missing Receipt Alerts to Selected
              </button>
            </div>
          </div>
        `;
      }

      if (dismissedLines.length > 0) {
        tabContentHtml += `
          <div class="pt-2 border-t border-slate-800">
            <button id="actPushToggleDismissedBtn" type="button"
              class="text-xs font-semibold text-slate-400 hover:text-slate-200">
              ${showDismissedList ? '▾' : '▸'} Dismissed Discrepancies (${dismissedLines.length})
            </button>
            ${
              showDismissedList
                ? `<div class="mt-2 space-y-2">
                    ${dismissedLines
                      .map(
                        (line) => `
                          <div class="flex items-center justify-between gap-2 rounded-xl bg-slate-950/80 border border-slate-800 px-3 py-2.5 text-xs">
                            <div class="min-w-0">
                              <div class="font-semibold text-slate-200 truncate">
                                ${esc(line.employee_name)} — ${esc(line.vendor || 'Unknown Vendor')} (${esc(formatMoney(line.amount))})
                              </div>
                              <div class="text-slate-400">
                                ${esc(line.post_date || '')} • Dismissed by ${esc(line.discrepancy_dismissed_by || 'Admin')}${line.discrepancy_dismiss_note ? `: "${esc(line.discrepancy_dismiss_note)}"` : ''}
                              </div>
                            </div>
                            <button type="button" data-restore-line="${esc(line.id)}"
                              class="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-emerald-500/20 hover:text-emerald-200 border border-slate-700 text-[11px] font-bold text-slate-300">
                              Restore
                            </button>
                          </div>
                        `
                      )
                      .join('')}
                  </div>`
                : ''
            }
          </div>
        `;
      }
    }

    // ---- TAB 2: INDIVIDUAL / TARGETED NOTIFICATIONS ----
    if (currentAdminTab === 'individual') {
      const empRowsHtml = employees
        .map((emp) => {
          const eid = String(emp.id);
          const devCount = (subsByEmp.get(eid) || []).length;
          const badge =
            devCount > 0
              ? `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">Push Active (${devCount})</span>`
              : `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">Not Enabled</span>`;

          return `
            <label data-ind-name="${esc((emp.full_name || '').toLowerCase())}"
              class="act-push-ind-row flex items-center gap-3 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-slate-700/80 p-3 cursor-pointer">
              <input type="checkbox" class="act-push-ind-cb w-5 h-5 accent-emerald-500 rounded shrink-0" value="${esc(eid)}" />
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-sm text-white truncate">${esc(emp.full_name || eid)}</div>
              </div>
              ${badge}
            </label>
          `;
        })
        .join('');

      tabContentHtml = `
        <div class="space-y-3">
          <div class="flex items-center gap-2">
            <input id="actPushIndSearch" type="search" placeholder="Search employee name..."
              class="flex-1 px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500" />
            <button id="actPushTestSelfBtn" type="button"
              class="shrink-0 px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-bold text-slate-200">
              Test My Device
            </button>
          </div>

          <div class="max-h-56 overflow-y-auto space-y-1.5 pr-1">
            ${empRowsHtml}
          </div>

          <div class="space-y-2.5 pt-2 border-t border-slate-800">
            <div class="grid grid-cols-2 gap-2">
              <label class="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-slate-800/70 border border-slate-700 text-xs font-semibold cursor-pointer">
                <input type="radio" name="actPushIndType" value="custom" checked class="accent-emerald-500" />
                Custom Message
              </label>
              <label class="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-slate-800/70 border border-slate-700 text-xs font-semibold cursor-pointer">
                <input type="radio" name="actPushIndType" value="summary" class="accent-emerald-500" />
                Missing Receipt Summary
              </label>
            </div>

            <div id="actPushIndCustomFields" class="space-y-2">
              <input id="actPushIndTitle" type="text" maxlength="80" value="ACT Reminder"
                placeholder="Notification title"
                class="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-emerald-500" />
              <textarea id="actPushIndMessage" rows="3" maxlength="240"
                placeholder="Type your message to the selected employee(s)..."
                class="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"></textarea>
            </div>

            <button id="actPushSendIndBtn" type="button"
              class="w-full py-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-sm shadow-lg transition">
              Send to Selected Individual(s)
            </button>
          </div>
        </div>
      `;
    }

    // ---- TAB 3: HISTORY LOG ----
    if (currentAdminTab === 'history') {
      if (!logs.length) {
        tabContentHtml = `<div class="py-10 text-center text-slate-400 text-sm">No push notifications sent yet.</div>`;
      } else {
        tabContentHtml = `
          <div class="space-y-2">
            ${logs
              .map(
                (l) => `
                  <div class="rounded-xl bg-slate-800/60 border border-slate-700/80 p-3 text-xs space-y-1">
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-bold text-white">${esc(l.sent_by || l.mode)}</span>
                      <span class="text-slate-400">${esc(formatDateTime(l.created_at))}</span>
                    </div>
                    <div class="text-slate-300">${esc(l.message_preview || '')}</div>
                    <div class="text-slate-400">
                      Targeted: <strong class="text-slate-200">${Number(l.target_count || 0)}</strong> •
                      Delivered: <strong class="text-emerald-300">${Number(l.delivered_count || 0)}</strong> •
                      Failed: <strong class="${Number(l.failed_count || 0) > 0 ? 'text-rose-300' : 'text-slate-400'}">${Number(l.failed_count || 0)}</strong>
                    </div>
                  </div>
                `
              )
              .join('')}
          </div>
        `;
      }
    }

    bodyEl.innerHTML = `${pendingBannerHtml}${scheduleCardHtml}${tabsHtml}${tabContentHtml}`;
    wireAdminModalEvents();
  }

  function wireAdminModalEvents() {
    const client = getSupabaseClient();

    // Tab switching
    document.querySelectorAll('[data-push-tab]').forEach((btn) => {
      btn.onclick = () => {
        currentAdminTab = btn.getAttribute('data-push-tab');
        renderAdminPushModalBody(false);
      };
    });

    // Auto-reminders toggle
    const autoBtn = document.getElementById('actPushAutoToggleBtn');
    if (autoBtn && client && adminDataCache) {
      autoBtn.onclick = async () => {
        const nextVal = !(adminDataCache.settings.auto_remind_enabled !== false);
        autoBtn.disabled = true;
        const { error } = await client
          .from('push_settings')
          .update({ auto_remind_enabled: nextVal, updated_at: new Date().toISOString() })
          .eq('id', 'default');
        if (error) {
          notifyToast(`Failed to update auto setting: ${error.message}`, true);
          autoBtn.disabled = false;
          return;
        }
        adminDataCache.settings.auto_remind_enabled = nextVal;
        notifyToast(nextVal ? 'Automatic reminders enabled.' : 'Automatic reminders paused.', false);
        renderAdminPushModalBody(false);
      };
    }

    // 24h CSV timer actions
    const sendCsvNowBtn = document.getElementById('actPushSendCsvNowBtn');
    if (sendCsvNowBtn) {
      sendCsvNowBtn.onclick = async () => {
        if (!confirm('Send missing-receipt alerts to all cardholders missing a receipt now and clear the 24-hour timer?')) return;
        sendCsvNowBtn.disabled = true;
        sendCsvNowBtn.textContent = 'Sending...';
        try {
          const res = await invokePushEdgeFunction({
            mode: 'group_missing',
            clear_pending_csv_timer: true
          });
          notifyToast(`Sent ${res.stats?.delivered || 0} alert(s) to ${res.stats?.targetEmployees || 0} cardholder(s).`, false);
          await renderAdminPushModalBody(true);
        } catch (err) {
          notifyToast(err.message || 'Failed to send alerts.', true);
          sendCsvNowBtn.disabled = false;
          sendCsvNowBtn.textContent = 'Send Now';
        }
      };
    }

    const cancelCsvBtn = document.getElementById('actPushCancelCsvTimerBtn');
    if (cancelCsvBtn && client) {
      cancelCsvBtn.onclick = async () => {
        if (!confirm('Cancel the queued 24-hour post-CSV alert? (Weekly Monday 8 AM reminders will still run.)')) return;
        const { error } = await client
          .from('push_settings')
          .update({ pending_csv_alert_at: null, updated_at: new Date().toISOString() })
          .eq('id', 'default');
        if (error) {
          notifyToast(`Failed to cancel timer: ${error.message}`, true);
          return;
        }
        notifyToast('24-hour post-CSV alert cancelled.', false);
        await renderAdminPushModalBody(true);
      };
    }
   
    // 48h follow-up timer actions
 const sendFollowupNowBtn = document.getElementById('actPushSendFollowupNowBtn');
 if (sendFollowupNowBtn) {
   sendFollowupNowBtn.onclick = async () => {
     if (!confirm('Send the 48-hour follow-up alert now to everyone still missing a receipt and clear the timer?')) return;
     sendFollowupNowBtn.disabled = true;
     sendFollowupNowBtn.textContent = 'Sending...';
     try {
       const res = await invokePushEdgeFunction({
         mode: 'group_missing',
         clear_pending_followup_timer: true
       });
       notifyToast(`Sent ${res.stats?.delivered || 0} follow-up alert(s) to ${res.stats?.targetEmployees || 0} cardholder(s).`, false);
       await renderAdminPushModalBody(true);
     } catch (err) {
       notifyToast(err.message || 'Failed to send follow-up alerts.', true);
       sendFollowupNowBtn.disabled = false;
       sendFollowupNowBtn.textContent = 'Send Now';
     }
   };
 }

 const cancelFollowupBtn = document.getElementById('actPushCancelFollowupTimerBtn');
 if (cancelFollowupBtn && client) {
   cancelFollowupBtn.onclick = async () => {
     if (!confirm('Cancel the queued 48-hour follow-up alert?')) return;
     const { error } = await client
       .from('push_settings')
       .update({ pending_followup_alert_at: null, updated_at: new Date().toISOString() })
       .eq('id', 'default');
     if (error) {
       notifyToast(`Failed to cancel follow-up: ${error.message}`, true);
       return;
     }
     notifyToast('48-hour follow-up alert cancelled.', false);
     await renderAdminPushModalBody(true);
   };
 }

    // Expand / collapse employee missing lines
    document.querySelectorAll('[data-expand-emp]').forEach((btn) => {
      btn.onclick = () => {
        const eid = btn.getAttribute('data-expand-emp');
        if (expandedEmployees.has(eid)) expandedEmployees.delete(eid);
        else expandedEmployees.add(eid);
        renderAdminPushModalBody(false);
      };
    });

    // Dismiss & restore discrepancy buttons
    document.querySelectorAll('[data-dismiss-line]').forEach((btn) => {
      btn.onclick = () => setLineDismissed(btn.getAttribute('data-dismiss-line'), true);
    });
    document.querySelectorAll('[data-restore-line]').forEach((btn) => {
      btn.onclick = () => setLineDismissed(btn.getAttribute('data-restore-line'), false);
    });

    const toggleDismissedBtn = document.getElementById('actPushToggleDismissedBtn');
    if (toggleDismissedBtn) {
      toggleDismissedBtn.onclick = () => {
        showDismissedList = !showDismissedList;
        renderAdminPushModalBody(false);
      };
    }

    // Select / Clear missing checkboxes
    const selAllBtn = document.getElementById('actPushSelectAllMissing');
    if (selAllBtn && adminDataCache) {
      selAllBtn.onclick = () => {
        const activeIds = new Set(
          adminDataCache.missingGroups.filter((g) => g.deviceCount > 0).map((g) => g.employeeId)
        );
        document.querySelectorAll('.act-push-missing-cb').forEach((cb) => {
          cb.checked = activeIds.has(cb.value);
        });
      };
    }
    const clrAllBtn = document.getElementById('actPushClearAllMissing');
    if (clrAllBtn) {
      clrAllBtn.onclick = () => {
        document.querySelectorAll('.act-push-missing-cb').forEach((cb) => {
          cb.checked = false;
        });
      };
    }

    // Send group missing alerts
    const sendGroupBtn = document.getElementById('actPushSendGroupBtn');
    if (sendGroupBtn) {
      sendGroupBtn.onclick = async () => {
        const selected = Array.from(document.querySelectorAll('.act-push-missing-cb:checked')).map((cb) => cb.value);
        if (!selected.length) {
          notifyToast('Select at least one cardholder first.', true);
          return;
        }
        if (!confirm(`Send missing-receipt push alerts to ${selected.length} selected cardholder(s)?`)) return;

        const customNote = (document.getElementById('actPushGroupNote')?.value || '').trim();
        sendGroupBtn.disabled = true;
        sendGroupBtn.textContent = 'Sending...';
        try {
          const res = await invokePushEdgeFunction({
            mode: 'group_missing',
            employee_ids: selected,
            custom_message: customNote
          });
          notifyToast(
            `Delivered ${res.stats?.delivered || 0} notification(s) across ${res.stats?.targetEmployees || 0} cardholder(s).`,
            false
          );
          await renderAdminPushModalBody(true);
        } catch (err) {
          notifyToast(err.message || 'Send failed.', true);
          sendGroupBtn.disabled = false;
          sendGroupBtn.textContent = 'Send Missing Receipt Alerts to Selected';
        }
      };
    }

    // Individual tab search & custom message toggle
    const searchInput = document.getElementById('actPushIndSearch');
    if (searchInput) {
      searchInput.oninput = () => {
        const q = searchInput.value.trim().toLowerCase();
        document.querySelectorAll('.act-push-ind-row').forEach((row) => {
          const name = row.getAttribute('data-ind-name') || '';
          row.classList.toggle('hidden', Boolean(q && !name.includes(q)));
        });
      };
    }

    document.querySelectorAll('input[name="actPushIndType"]').forEach((radio) => {
      radio.onchange = () => {
        const fields = document.getElementById('actPushIndCustomFields');
        if (fields) fields.classList.toggle('hidden', radio.value !== 'custom');
      };
    });

    // Test push to Admin's own device
    const testSelfBtn = document.getElementById('actPushTestSelfBtn');
    if (testSelfBtn) {
      testSelfBtn.onclick = async () => {
        testSelfBtn.disabled = true;
        testSelfBtn.textContent = 'Sending...';
        try {
          const res = await invokePushEdgeFunction({ mode: 'test_self' });
          if ((res.stats?.delivered || 0) === 0) {
            notifyToast('No active push subscription found for your login. Tap "Receipt Alerts" in the menu to enable first.', true);
          } else {
            notifyToast('Test push sent! Check your notifications.', false);
          }
        } catch (err) {
          notifyToast(err.message || 'Test push failed.', true);
        } finally {
          testSelfBtn.disabled = false;
          testSelfBtn.textContent = 'Test My Device';
        }
      };
    }

    // Send individual notification
    const sendIndBtn = document.getElementById('actPushSendIndBtn');
    if (sendIndBtn) {
      sendIndBtn.onclick = async () => {
        const selected = Array.from(document.querySelectorAll('.act-push-ind-cb:checked')).map((cb) => cb.value);
        if (!selected.length) {
          notifyToast('Select at least one employee.', true);
          return;
        }
        const type = document.querySelector('input[name="actPushIndType"]:checked')?.value || 'custom';
        const title = (document.getElementById('actPushIndTitle')?.value || '').trim();
        const msg = (document.getElementById('actPushIndMessage')?.value || '').trim();

        if (type === 'custom' && !msg) {
          notifyToast('Enter a message to send.', true);
          return;
        }
        if (!confirm(`Send notification to ${selected.length} selected employee(s)?`)) return;

        sendIndBtn.disabled = true;
        sendIndBtn.textContent = 'Sending...';
        try {
          const res = await invokePushEdgeFunction({
            mode: 'individual',
            employee_ids: selected,
            title: type === 'custom' ? title || 'ACT Reminder' : undefined,
            custom_message: type === 'custom' ? msg : ''
          });
          notifyToast(
            `Delivered ${res.stats?.delivered || 0} notification(s) to ${res.stats?.targetEmployees || 0} employee(s).`,
            false
          );
          await renderAdminPushModalBody(true);
        } catch (err) {
          notifyToast(err.message || 'Send failed.', true);
          sendIndBtn.disabled = false;
          sendIndBtn.textContent = 'Send to Selected Individual(s)';
        }
      };
    }
  }

  // =========================================================================
  // 6. LIFECYCLE WATCHER (HANDLES PIN LOGIN / AUTO-LOGIN / SWITCH USER)
  // =========================================================================
  function checkSessionTransition() {
    const logged = isLoggedIn();
    const session = getActiveSession();
    const key = logged ? `${session.employeeId}:${session.role}` : 'logged_out';

    if (key !== lastLoggedInKey) {
      lastLoggedInKey = key;
      if (logged) {
        refreshPushUiState().catch(() => {});
      } else {
        removeOptInBanner();
        closeAdminPushModal();
        const section = document.getElementById('actPushSideMenuSection');
        if (section) section.remove();
      }
    }
  }

  function startWatcher() {
    checkSessionTransition();
    const loginEl = document.getElementById('loginScreen');
    if (loginEl && window.MutationObserver) {
      const obs = new MutationObserver(() => checkSessionTransition());
      obs.observe(loginEl, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    badgeRefreshTimer = window.setInterval(checkSessionTransition, 1200);
  }

  window.ACTPush = {
    enable: enablePushOnThisDevice,
    disable: disablePushOnThisDevice,
    openAdminModal: openAdminPushModal,
    refresh: refreshPushUiState
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startWatcher);
  } else {
    startWatcher();
  }
})();
