// =========================================================================
// ACT MASTER - CLIENT ERROR LOGGER (error-logger.js)
// Zero-conflict drop-in crash & failure logger for field devices
// - Captures unhandled JS errors & unhandled Promise rejections automatically
// - Exposes window.logAppError(module, action, err, extraContext) for manual hooks
// - Attaches active employee, role, current screen, viewport, and online state
// - Queues offline/early-boot errors in localStorage and flushes safely when online
// =========================================================================
(function initACTErrorLogger() {
  'use strict';

  const TABLE_NAME = 'app_error_logs';
  const QUEUE_KEY = 'act_pending_error_logs_v1';
  const MAX_QUEUE = 30;
  const DEDUPE_MS = 5000;

  let lastSig = '';
  let lastTime = 0;
  let isFlushing = false;
  let bootPollCount = 0;

  // =========================================================================
  // 1. SAFE ACT CONTEXT HELPERS
  // =========================================================================
  function getSupabase() {
    try {
      return typeof supabaseClient !== 'undefined' && supabaseClient ? supabaseClient : null;
    } catch {
      return null;
    }
  }

  function isAppOnline() {
    try {
      const actOnline = typeof isOnline !== 'undefined' ? Boolean(isOnline) : true;
      return actOnline && navigator.onLine;
    } catch {
      return navigator.onLine;
    }
  }

  function getActiveUserContext() {
    let employeeId = null;
    let userName = null;
    let userRole = 'crew';

    try {
      if (typeof getActiveUserEffectiveRole === 'function') {
        userRole = String(getActiveUserEffectiveRole() || 'crew').toLowerCase();
      } else if (typeof currentRole !== 'undefined' && currentRole) {
        userRole = String(currentRole).toLowerCase();
      }
    } catch {}

    try {
      if (typeof activeCrewEmployeeId !== 'undefined' && activeCrewEmployeeId) {
        employeeId = String(activeCrewEmployeeId);
        if (typeof state !== 'undefined' && Array.isArray(state.employees)) {
          const emp = state.employees.find((e) => String(e.id) === employeeId);
          if (emp?.full_name) userName = String(emp.full_name).trim();
        }
      } else if (userRole === 'admin') {
        employeeId = 'ADMIN';
        userName = 'Administrator';
      }
    } catch {}

    return { employeeId, userName, userRole };
  }

  function extractErrorDetails(err) {
    if (err instanceof Error) {
      return {
        message: err.message || err.name || 'Error',
        stack: (err.stack || '').slice(0, 2000) || null
      };
    }

    if (err && typeof err === 'object') {
      const parts = [
        err.message || err.error_description || err.error || err.statusText,
        err.code ? `[${err.code}]` : '',
        err.details || err.hint || ''
      ].filter(Boolean);

      let msg = parts.join(' — ');
      if (!msg) {
        try {
          msg = JSON.stringify(err);
        } catch {
          msg = 'Unknown object error';
        }
      }
      return {
        message: msg,
        stack: typeof err.stack === 'string' ? err.stack.slice(0, 2000) : null
      };
    }

    return {
      message: String(err || 'Unknown error'),
      stack: null
    };
  }

  function safeContext(extraContext) {
    const out = {
      screen: document.getElementById('topBarPageTitle')?.textContent?.trim() || '',
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio || 1,
      path: window.location.pathname
    };

    if (extraContext && typeof extraContext === 'object') {
      try {
        const cleanExtra = JSON.parse(JSON.stringify(extraContext));
        Object.assign(out, cleanExtra);
      } catch {
        out.extra = String(extraContext).slice(0, 300);
      }
    }
    return out;
  }

  // =========================================================================
  // 2. OFFLINE QUEUE (RACE-SAFE BY ITEM ID)
  // =========================================================================
  function readQueue() {
    try {
      const raw = window.localStorage.getItem(QUEUE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeQueue(items) {
    try {
      if (!items.length) {
        window.localStorage.removeItem(QUEUE_KEY);
      } else {
        window.localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-MAX_QUEUE)));
      }
    } catch {}
  }

  function enqueueOffline(payload) {
    const queue = readQueue();
    queue.push({
      _qid: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      payload
    });
    writeQueue(queue);
  }

  async function flushErrorQueue() {
    if (isFlushing) return;
    const sb = getSupabase();
    if (!sb || !isAppOnline()) return;

    const snapshot = readQueue();
    if (!snapshot.length) return;

    isFlushing = true;
    try {
      const userCtx = getActiveUserContext();
      const rows = snapshot.map((entry) => {
        const p = entry.payload || entry;
        return {
          occurred_at: p.occurred_at || new Date().toISOString(),
          employee_id: p.employee_id || userCtx.employeeId,
          user_name: p.user_name || userCtx.userName,
          user_role: p.user_role || userCtx.userRole,
          module: p.module || 'global',
          action: p.action || 'queued',
          message: String(p.message || 'Unknown error').slice(0, 500),
          stack: p.stack || null,
          context: p.context || {},
          user_agent: p.user_agent || navigator.userAgent,
          online: typeof p.online === 'boolean' ? p.online : false
        };
      });

      const { error } = await sb.from(TABLE_NAME).insert(rows);
      if (!error) {
        const sentIds = new Set(snapshot.map((entry) => entry._qid).filter(Boolean));
        const remaining = readQueue().filter((entry) => entry._qid && !sentIds.has(entry._qid));
        writeQueue(remaining);
      }
    } catch {
      // Retry on next online event or app boot
    } finally {
      isFlushing = false;
    }
  }

  // =========================================================================
  // 3. MAIN LOGGING ENTRYPOINT
  // =========================================================================
  async function logAppError(module, action, err, extraContext = {}) {
    try {
      const mod = String(module || 'global').slice(0, 80);
      const act = String(action || 'error').slice(0, 120);
      const { message, stack } = extractErrorDetails(err);
      const cleanMessage = String(message || 'Unknown error').slice(0, 500);

      // Dedupe tight error loops
      const sig = `${mod}|${act}|${cleanMessage}`;
      const now = Date.now();
      if (sig === lastSig && now - lastTime < DEDUPE_MS) return;
      lastSig = sig;
      lastTime = now;

      const userCtx = getActiveUserContext();
      const payload = {
        occurred_at: new Date(now).toISOString(),
        employee_id: userCtx.employeeId,
        user_name: userCtx.userName,
        user_role: userCtx.userRole,
        module: mod,
        action: act,
        message: cleanMessage,
        stack,
        context: safeContext(extraContext),
        user_agent: navigator.userAgent,
        online: isAppOnline()
      };

      const sb = getSupabase();
      if (!sb || !isAppOnline()) {
        enqueueOffline(payload);
        return;
      }

      const { error } = await sb.from(TABLE_NAME).insert(payload);
      if (error) {
        enqueueOffline(payload);
      }
    } catch {
      // Never allow the logger itself to crash the app
    }
  }

  // =========================================================================
  // 4. GLOBAL LISTENERS & BOOT FLUSH
  // =========================================================================
  window.addEventListener('error', (event) => {
    logAppError('global', 'window.error', event.error || event.message, {
      file: event.filename || '',
      line: event.lineno || 0,
      col: event.colno || 0
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    logAppError('global', 'unhandledrejection', event.reason);
  });

  window.addEventListener('online', () => {
    flushErrorQueue();
  });

  function waitForSupabaseAndFlush() {
    if (getSupabase()) {
      flushErrorQueue();
      return;
    }
    if (bootPollCount < 20) {
      bootPollCount += 1;
      setTimeout(waitForSupabaseAndFlush, 500);
    }
  }

  window.logAppError = logAppError;
  window.ACTErrorLogger = {
    log: logAppError,
    flush: flushErrorQueue,
    getQueue: readQueue,
    clearQueue: () => writeQueue([])
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForSupabaseAndFlush);
  } else {
    waitForSupabaseAndFlush();
  }
})();
