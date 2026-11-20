// =========================================================================
// ACT MASTER - PERSISTENT LOGIN MODULE (session-persist.js)
// Keeps users signed in across app/PWA reloads for 30 days (sliding window)
// without storing plaintext PINs in localStorage.
// - Automatically signs out if an Admin deactivates the user or changes their PIN
// - Immediately clears the saved session when "Switch User / Log Out" is tapped
// - Works offline via ACT's IndexedDB employee cache
// =========================================================================
(function () {
  'use strict';

  const SESSION_STORAGE_KEY = 'fieldops_saved_session';
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30-day sliding window

  let autoLoginAttempted = false;
  let isAutoRestoring = false;
  let restoreFallbackTimer = null;

  function readSavedSession() {
    try {
      const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.userId || !parsed.pinHash) return null;
      if (parsed.expiresAt && Date.now() > Number(parsed.expiresAt)) {
        clearSavedSession();
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function clearSavedSession() {
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {}
  }

  // Computes a one-way fingerprint of userId + PIN so plaintext PINs are never saved
  async function hashUserPin(userId, pin) {
    const input = `act-session-v1:${String(userId)}:${String(pin || '1234')}`;
    try {
      if (window.crypto && window.crypto.subtle) {
        const bytes = new TextEncoder().encode(input);
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      }
    } catch {}

    // Deterministic fallback for non-HTTPS local testing
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < input.length; i++) {
      const ch = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ ch, 0x85ebca6b) >>> 0;
    }
    return `fnv_${h1.toString(16)}_${h2.toString(16)}`;
  }

  async function saveUserSession(userId, pin) {
    if (!userId) return;
    try {
      const pinHash = await hashUserPin(userId, pin);
      const record = {
        userId: String(userId),
        pinHash,
        expiresAt: Date.now() + SESSION_TTL_MS
      };
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(record));
    } catch {}
  }

  function setRestoringUi(showSpinner) {
    const loginScreen = document.getElementById('loginScreen');
    if (!loginScreen) return;
    const formEl = loginScreen.querySelector('form');
    const restoringEl = document.getElementById('loginRestoringMsg');
    if (formEl) formEl.classList.toggle('hidden', showSpinner);
    if (restoringEl) restoringEl.classList.toggle('hidden', !showSpinner);
  }

  async function tryAutoLogin() {
    if (autoLoginAttempted) return;

    const loginScreen = document.getElementById('loginScreen');
    const userSelect = document.getElementById('loginUserSelect');
    const pinInput = document.getElementById('loginPinInput');
    if (!loginScreen || !userSelect || !pinInput) return;

    // Already signed in
    if (loginScreen.classList.contains('hidden')) {
      autoLoginAttempted = true;
      return;
    }

    // Wait until app-core.js has populated the employee dropdown
    if (userSelect.options.length <= 1) return;

    const saved = readSavedSession();
    if (!saved) {
      autoLoginAttempted = true;
      setRestoringUi(false);
      return;
    }

    autoLoginAttempted = true;
    clearTimeout(restoreFallbackTimer);

    try {
      let expectedPin = '1234';
      if (saved.userId !== 'ADMIN') {
        const employees = typeof state !== 'undefined' && Array.isArray(state.employees)
          ? state.employees
          : [];
        const emp = employees.find((e) => e.id === saved.userId);
        // Auto-revoke if employee was removed or marked inactive
        if (!emp || emp.active === false) {
          clearSavedSession();
          setRestoringUi(false);
          return;
        }
        expectedPin = emp.pin || '1234';
      }

      // Auto-revoke if an Admin changed this user's PIN since last login
      const currentHash = await hashUserPin(saved.userId, expectedPin);
      if (currentHash !== saved.pinHash) {
        clearSavedSession();
        setRestoringUi(false);
        return;
      }

      // Confirm the option exists in the login dropdown
      const optionExists = Array.from(userSelect.options).some((opt) => opt.value === saved.userId);
      if (!optionExists) {
        clearSavedSession();
        setRestoringUi(false);
        return;
      }

      // Trigger ACT's native login flow so roles, PM Hub, and Blueprints initialize identically
      isAutoRestoring = true;
      userSelect.value = saved.userId;
      pinInput.value = expectedPin;
      if (typeof window.handleLoginSubmit === 'function') {
        window.handleLoginSubmit({ preventDefault: function () {} });
      }
      pinInput.value = '';
      isAutoRestoring = false;

      if (loginScreen.classList.contains('hidden')) {
        // Slide expiration forward another 30 days
        saveUserSession(saved.userId, expectedPin).catch(() => {});
      } else {
        clearSavedSession();
      }
    } catch (err) {
      console.warn('ACT auto-login restore skipped:', err);
      isAutoRestoring = false;
    } finally {
      setRestoringUi(false);
    }
  }

  function installSessionHooks() {
    // 1. Hide login form behind a brief spinner if a saved session is waiting to restore
    if (readSavedSession()) {
      setRestoringUi(true);
      restoreFallbackTimer = setTimeout(() => {
        setRestoringUi(false);
      }, 8000);
    }

    // 2. Wrap handleLoginSubmit to persist verified logins when checked
    const prevLoginSubmit = window.handleLoginSubmit;
    if (typeof prevLoginSubmit === 'function') {
      window.handleLoginSubmit = function (event) {
        const selectedUser = document.getElementById('loginUserSelect')?.value || '';
        const enteredPin = (document.getElementById('loginPinInput')?.value || '').trim();
        const keepBox = document.getElementById('loginKeepSignedIn');
        const shouldKeep = keepBox ? Boolean(keepBox.checked) : true;

        const result = prevLoginSubmit.apply(this, arguments);

        if (!isAutoRestoring) {
          const loginScreen = document.getElementById('loginScreen');
          const loginSucceeded = Boolean(loginScreen && loginScreen.classList.contains('hidden'));
          if (loginSucceeded && selectedUser) {
            if (shouldKeep) {
              saveUserSession(selectedUser, enteredPin).catch(() => {});
            } else {
              clearSavedSession();
            }
          }
        }
        return result;
      };
    }

    // 3. Wrap logoutUser so "Switch User / Log Out" always clears the saved session
    const prevLogout = window.logoutUser;
    if (typeof prevLogout === 'function') {
      window.logoutUser = function () {
        autoLoginAttempted = true;
        clearTimeout(restoreFallbackTimer);
        clearSavedSession();
        setRestoringUi(false);
        return prevLogout.apply(this, arguments);
      };
    }

    // 4. Wrap populateLoginUserDropdown so auto-login runs the moment ACT finishes booting
    const prevPopulateDropdown = window.populateLoginUserDropdown;
    if (typeof prevPopulateDropdown === 'function') {
      window.populateLoginUserDropdown = function () {
        const res = prevPopulateDropdown.apply(this, arguments);
        tryAutoLogin();
        return res;
      };
    }

    // Fallback check in case app-core.js already finished populating before this script loaded
    tryAutoLogin();
  }

  installSessionHooks();
})();
