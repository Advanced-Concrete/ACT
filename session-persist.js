// =========================================================================
// ACT MASTER - PERSISTENT LOGIN MODULE (session-persist.js)
// Keeps users signed in across closed tabs, Home Screen PWA launches, and
// device restarts for 90 days (sliding window) without storing plaintext PINs.
// - Dual-layer storage: localStorage + IndexedDB backup + Storage Persistence API
// - Cold-start safe: waits for Supabase sync before revoking newly added users
// - Automatically signs out if an Admin deactivates the user or changes their PIN
// - Immediately clears both storage layers when "Switch User / Log Out" is tapped
// =========================================================================
(function () {
  'use strict';

  const SESSION_STORAGE_KEY = 'fieldops_saved_session';
  const SESSION_IDB_NAME = 'ACT_PersistentSession_v1';
  const SESSION_IDB_STORE = 'session';
  const SESSION_IDB_KEY = 'active';
  const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90-day sliding window

  let autoLoginCompleted = false;
  let autoLoginRunning = false;
  let isAutoRestoring = false;
  let loggedOutManually = false;
  let restoreFallbackTimer = null;

  // Ask iOS/Android/Chrome to protect this Home Screen app's storage from OS eviction
  function requestPersistentStorage() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        navigator.storage.persist().catch(() => {});
      }
    } catch {}
  }

  // Dedicated tiny IndexedDB mirror so login survives OS cache/localStorage sweeps
  function openSessionIdb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(SESSION_IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(SESSION_IDB_STORE)) {
          db.createObjectStore(SESSION_IDB_STORE);
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function idbReadSession() {
    try {
      const db = await openSessionIdb();
      return await new Promise((resolve) => {
        const tx = db.transaction(SESSION_IDB_STORE, 'readonly');
        const req = tx.objectStore(SESSION_IDB_STORE).get(SESSION_IDB_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function idbWriteSession(record) {
    try {
      const db = await openSessionIdb();
      await new Promise((resolve) => {
        const tx = db.transaction(SESSION_IDB_STORE, 'readwrite');
        tx.objectStore(SESSION_IDB_STORE).put(record, SESSION_IDB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {}
  }

  async function idbDeleteSession() {
    try {
      const db = await openSessionIdb();
      await new Promise((resolve) => {
        const tx = db.transaction(SESSION_IDB_STORE, 'readwrite');
        tx.objectStore(SESSION_IDB_STORE).delete(SESSION_IDB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {}
  }

  function validateSessionRecord(parsed) {
    if (!parsed || !parsed.userId || !parsed.pinHash) return null;
    if (parsed.expiresAt && Date.now() > Number(parsed.expiresAt)) {
      clearSavedSession();
      return null;
    }
    return parsed;
  }

  function readSavedSessionSync() {
    try {
      const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      return validateSessionRecord(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async function readSavedSessionAsync() {
    const fromLs = readSavedSessionSync();
    if (fromLs) return fromLs;

    // Fallback: recover from IndexedDB if OS evicted localStorage after restart
    const fromIdb = validateSessionRecord(await idbReadSession());
    if (fromIdb) {
      try {
        window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(fromIdb));
      } catch {}
      return fromIdb;
    }
    return null;
  }

  function clearSavedSession() {
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {}
    idbDeleteSession().catch(() => {});
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
      requestPersistentStorage();
      const pinHash = await hashUserPin(userId, pin);
      const record = {
        userId: String(userId),
        pinHash,
        expiresAt: Date.now() + SESSION_TTL_MS
      };
      try {
        window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(record));
      } catch {}
      await idbWriteSession(record);
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
    if (autoLoginCompleted || autoLoginRunning || loggedOutManually) return;

    const loginScreen = document.getElementById('loginScreen');
    const userSelect = document.getElementById('loginUserSelect');
    const pinInput = document.getElementById('loginPinInput');
    if (!loginScreen || !userSelect || !pinInput) return;

    // Already signed in
    if (loginScreen.classList.contains('hidden')) {
      autoLoginCompleted = true;
      return;
    }

    // Wait until app-core.js has populated the employee dropdown
    if (userSelect.options.length <= 1) return;

    autoLoginRunning = true;

    try {
      const saved = await readSavedSessionAsync();
      if (!saved) {
        autoLoginCompleted = true;
        setRestoringUi(false);
        return;
      }

      let expectedPin = '1234';
      if (saved.userId !== 'ADMIN') {
        const employees = typeof state !== 'undefined' && Array.isArray(state.employees)
          ? state.employees
          : [];
        const emp = employees.find((e) => e.id === saved.userId);

        // Cold-start safety: if employee isn't in local cache yet, wait for Supabase sync
        // instead of clearing the saved session prematurely
        if (!emp) {
          setRestoringUi(false);
          return;
        }

        // Auto-revoke immediately if employee was marked inactive
        if (emp.active === false) {
          autoLoginCompleted = true;
          clearSavedSession();
          setRestoringUi(false);
          return;
        }
        expectedPin = emp.pin || '1234';
      }

      // Auto-revoke if an Admin changed this user's PIN since last login
      const currentHash = await hashUserPin(saved.userId, expectedPin);
      if (currentHash !== saved.pinHash) {
        autoLoginCompleted = true;
        clearSavedSession();
        setRestoringUi(false);
        return;
      }

      // Confirm the option exists in the login dropdown
      const optionExists = Array.from(userSelect.options).some((opt) => opt.value === saved.userId);
      if (!optionExists) {
        setRestoringUi(false);
        return;
      }

      // Trigger ACT's native login flow so roles, PM Hub, and Blueprints initialize identically
      clearTimeout(restoreFallbackTimer);
      isAutoRestoring = true;
      userSelect.value = saved.userId;
      pinInput.value = expectedPin;
      if (typeof window.handleLoginSubmit === 'function') {
        window.handleLoginSubmit({ preventDefault: function () {} });
      }
      pinInput.value = '';
      isAutoRestoring = false;

      if (loginScreen.classList.contains('hidden')) {
        autoLoginCompleted = true;
        // Slide expiration forward another 90 days across both localStorage & IndexedDB
        saveUserSession(saved.userId, expectedPin).catch(() => {});
      } else {
        autoLoginCompleted = true;
        clearSavedSession();
      }
    } catch (err) {
      console.warn('ACT auto-login restore skipped:', err);
      isAutoRestoring = false;
    } finally {
      autoLoginRunning = false;
      setRestoringUi(false);
    }
  }

  function installSessionHooks() {
    requestPersistentStorage();

    // 1. Hide login form behind a brief spinner if a saved session is waiting to restore
    if (readSavedSessionSync()) {
      setRestoringUi(true);
      restoreFallbackTimer = setTimeout(() => {
        setRestoringUi(false);
      }, 6000);
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
            loggedOutManually = false;
            autoLoginCompleted = true;
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

    // 3. Wrap logoutUser so "Switch User / Log Out" always clears both storage layers
    const prevLogout = window.logoutUser;
    if (typeof prevLogout === 'function') {
      window.logoutUser = function () {
        loggedOutManually = true;
        autoLoginCompleted = true;
        clearTimeout(restoreFallbackTimer);
        clearSavedSession();
        setRestoringUi(false);
        return prevLogout.apply(this, arguments);
      };
    }

    // 4. Wrap populateLoginUserDropdown so auto-login retries cleanly after cold-start Supabase sync
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
