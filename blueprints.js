// =========================================================================
// ACT MASTER - BLUEPRINTS MODULE (blueprints.js)
// Zero-conflict drop-in PDF blueprint & cross-sheet callout viewer
// - All Dropbox calls route through Supabase Edge Function `dropbox-proxy`
// - Shared callout overlays sync via `supabaseClient` (`blueprint_callout_links`)
// - First-open Auto-Scan runs for ALL roles (strictly once per page across all
//   devices via `blueprint_scanned_pages`); manual Re-Scan & AI Model Settings
//   are Admin-only and sync to all devices via `app_settings`
// - Offline PDFs + overlay snapshots + linked target sheets cached in IndexedDB
// - Role guards:
//     Admin:      Dropbox setup, Re-Scan Links, Model Settings, Add/Edit/Delete links, View/Offline
//     PM/Supv:    Add/Edit/Delete links, View/Offline (triggers first-open Auto-Scan)
//     Crew:       View/Offline only (triggers first-open Auto-Scan)
// =========================================================================
(function () {
  'use strict';

  if (window.pdfjsLib && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  const LINKS_TABLE = 'blueprint_callout_links';
  const SCANNED_PAGES_TABLE = 'blueprint_scanned_pages';
  const SCANNER_SETTINGS_ROW_ID = 'blueprint_scanner_settings';
  const PROXY_FN = 'dropbox-proxy';
  const DEFAULT_LOCKED_ROOT = '/Current Jobs';

  // High-tier Gemini model fallback chain (used ONLY for blueprint callout scanning;
  // ACT receipt OCR in app-core.js remains untouched on fast Flash models)
  const BLUEPRINT_GEMINI_MODEL_CHAIN = [
    'gemini-4-neon',
    'gemini-4-carbon',
    'gemini-4-hydrogen',
    'gemini-4-argon',
    'gemini-3.1-pro-preview',
    'gemini-2.5-pro',
    'gemini-3.8-flash',
    'gemini-2.5-flash'
  ];

  // Official Structured Outputs schema for rock-solid JSON on Gemini 4 & 3.1 Pro
  const CALLOUT_RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
      callouts: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            label: { type: 'STRING' },
            target_filename: { type: 'STRING' },
            detail_title: { type: 'STRING' },
            box_2d: {
              type: 'ARRAY',
              items: { type: 'INTEGER' }
            }
          },
          required: ['label', 'target_filename', 'box_2d']
        }
      }
    },
    required: ['callouts']
  };

  // Non-sheet tokens to ignore during automatic sheet-number extraction
  const IGNORED_SHEET_TOKENS = new Set([
    'PDF', 'REV', 'REV1', 'REV2', 'REV3', 'REV4', 'ADD1', 'ADD2', 'RFI1', 'RFI2',
    'ASI1', 'ASI2', 'DWG', 'CAD', 'BIM', 'NTS', 'TYP', 'SIM', 'OPP', 'REF', 'MAX',
    'MIN', 'CL', 'EQ', 'TOC', 'TOS', 'BOF', 'TOF', 'FFL', 'FFE', 'NO', 'PG'
  ]);

  // -----------------------------------------------------------------------
  // 1. SAFE ACT BRIDGES (Read top-level ACT globals safely without coupling)
  // -----------------------------------------------------------------------
  function getSupabase() {
    return typeof supabaseClient !== 'undefined' ? supabaseClient : null;
  }

  function isAppOnline() {
    const actOnline = typeof isOnline !== 'undefined' ? Boolean(isOnline) : true;
    return actOnline && navigator.onLine;
  }

  function getEffectiveRole() {
    if (typeof getActiveUserEffectiveRole === 'function') {
      return getActiveUserEffectiveRole();
    }
    return typeof currentRole !== 'undefined' ? currentRole : 'crew';
  }

  function canEditCallouts() {
    const role = getEffectiveRole();
    return role === 'admin' || role === 'pm' || role === 'supervisor';
  }

  function isAdminUser() {
    return getEffectiveRole() === 'admin';
  }

  function isAutoScanEnabled() {
    return SafeStorage.get('bp_admin_autoscan_enabled', 'true') !== 'false';
  }

  function getBlueprintModelPreference() {
    return SafeStorage.get('bp_admin_gemini_model', 'auto') || 'auto';
  }

  function getBlueprintScanMode() {
    return SafeStorage.get('bp_admin_scan_mode', 'combined') || 'combined';
  }

  /**
   * Pulls Admin-configured Blueprint AI scanner settings (model, mode, auto-scan toggle)
   * from Supabase `app_settings` so Crew/PM/Supervisor devices automatically use the
   * exact Gemini model (e.g. Gemini 4 Hydrogen) selected by the Admin.
   */
  async function loadScannerSettingsFromSupabase() {
    const sb = getSupabase();
    if (!sb || !isAppOnline()) return false;
    try {
      const { data, error } = await sb
        .from('app_settings')
        .select('ocr_api_key')
        .eq('id', SCANNER_SETTINGS_ROW_ID)
        .maybeSingle();
      if (error || !data?.ocr_api_key) return false;
      const cfg = JSON.parse(data.ocr_api_key);
      if (typeof cfg.autoScanEnabled === 'boolean') {
        SafeStorage.set('bp_admin_autoscan_enabled', cfg.autoScanEnabled ? 'true' : 'false');
      }
      if (typeof cfg.geminiModel === 'string' && cfg.geminiModel) {
        SafeStorage.set('bp_admin_gemini_model', cfg.geminiModel);
      }
      if (typeof cfg.scanMode === 'string' && cfg.scanMode) {
        SafeStorage.set('bp_admin_scan_mode', cfg.scanMode);
      }
      bpState.scannerSettingsLoaded = true;
      updateConnectionBadges();
      return true;
    } catch {
      return false;
    }
  }

  async function saveScannerSettingsToSupabase() {
    if (!isAdminUser()) return false;
    const sb = getSupabase();
    if (!sb || !isAppOnline()) return false;
    try {
      const payload = {
        autoScanEnabled: isAutoScanEnabled(),
        geminiModel: getBlueprintModelPreference(),
        scanMode: getBlueprintScanMode()
      };
      const { error } = await sb.from('app_settings').upsert({
        id: SCANNER_SETTINGS_ROW_ID,
        ocr_api_key: JSON.stringify(payload),
        updated_at: new Date().toISOString()
      });
      return !error;
    } catch {
      return false;
    }
  }

  function getAdminEmployeeId() {
    if (typeof activeCrewEmployeeId !== 'undefined' && activeCrewEmployeeId) {
      return activeCrewEmployeeId;
    }
    return isAdminUser() ? 'ADMIN' : '';
  }

  function getActiveUserDisplayName() {
    try {
      if (
        typeof activeCrewEmployeeId !== 'undefined' &&
        activeCrewEmployeeId &&
        typeof state !== 'undefined' &&
        Array.isArray(state.employees)
      ) {
        const emp = state.employees.find((e) => e.id === activeCrewEmployeeId);
        if (emp?.full_name) return emp.full_name;
      }
    } catch {}
    return isAdminUser() ? 'Administrator' : 'User';
  }

  function notify(msg, type = 'info') {
    if (typeof showSimpleToast === 'function') {
      showSimpleToast(msg, type === 'error' || type === 'warning');
      return;
    }
    console.log(`[Blueprints ${type}]`, msg);
  }

  const SafeStorage = {
    get(key, fallback = '') {
      try {
        return window.localStorage.getItem(key) ?? fallback;
      } catch {
        return fallback;
      }
    },
    set(key, val) {
      try {
        window.localStorage.setItem(key, String(val));
      } catch {}
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {}
    },
    getJSON(key, fallback = null) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    setJSON(key, val) {
      try {
        window.localStorage.setItem(key, JSON.stringify(val));
      } catch {}
    }
  };

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0.0 MB';
    const mb = bytes / (1024 * 1024);
    return mb < 0.1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`;
  }

  function normalizeSheetToken(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Canonicalizes a sheet code for precise matching while preserving decimal points
   * (e.g., "S-2.0" -> "S2.0", "A 101" -> "A101", "S2.00" -> "S2.00").
   */
  function canonicalSheetCode(raw) {
    return String(raw || '')
      .toUpperCase()
      .replace(/[\s\-_]+/g, '')
      .replace(/^\.+|\.+$/g, '')
      .trim();
  }

  // -----------------------------------------------------------------------
  // 2. ISOLATED INDEXEDDB OFFLINE CACHE (`ProDrawOfflineDB` v5)
  // -----------------------------------------------------------------------
  const ProDrawOfflineDB = {
    dbName: 'ProDrawOfflineDB',
    version: 5,
    db: null,
    async open() {
      if (this.db) return this.db;
      const openWithVersion = (ver) =>
        new Promise((resolve, reject) => {
          const req = ver ? indexedDB.open(this.dbName, ver) : indexedDB.open(this.dbName);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('documents')) {
              db.createObjectStore('documents', { keyPath: 'docId' });
            }
            if (!db.objectStoreNames.contains('blobs')) {
              db.createObjectStore('blobs');
            }
            if (!db.objectStoreNames.contains('overlays')) {
              db.createObjectStore('overlays', { keyPath: 'docId' });
            }
          };
          req.onsuccess = (e) => {
            this.db = e.target.result;
            resolve(this.db);
          };
          req.onerror = (e) => reject(e.target.error);
        });

      try {
        return await openWithVersion(this.version);
      } catch (err) {
        if (err && err.name === 'VersionError') {
          return await openWithVersion(null);
        }
        throw err;
      }
    },
    async getAllDocuments() {
      try {
        await this.open();
        if (!this.db.objectStoreNames.contains('documents')) return [];
        return await new Promise((resolve) => {
          const tx = this.db.transaction('documents', 'readonly');
          const req = tx.objectStore('documents').getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });
      } catch {
        return [];
      }
    },
    async saveDocument(meta, arrayBuffer) {
      await this.open();
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('blobs', 'readwrite');
        const req = tx.objectStore('blobs').put(arrayBuffer, meta.docId);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
      });
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('documents', 'readwrite');
        const req = tx.objectStore('documents').put(meta);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
      });
    },
    async removeDocument(docId) {
      try {
        await this.open();
        for (const store of ['blobs', 'documents', 'overlays']) {
          if (!this.db.objectStoreNames.contains(store)) continue;
          await new Promise((resolve) => {
            const tx = this.db.transaction(store, 'readwrite');
            tx.objectStore(store).delete(docId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
          });
        }
      } catch {}
    },
    async getBlob(docId) {
      try {
        await this.open();
        if (!this.db.objectStoreNames.contains('blobs')) return null;
        return await new Promise((resolve) => {
          const tx = this.db.transaction('blobs', 'readonly');
          const req = tx.objectStore('blobs').get(docId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
      } catch {
        return null;
      }
    },
    async saveOverlays(docId, links) {
      try {
        await this.open();
        if (!this.db.objectStoreNames.contains('overlays')) return;
        await new Promise((resolve) => {
          const tx = this.db.transaction('overlays', 'readwrite');
          tx.objectStore('overlays').put({
            docId,
            links: Array.isArray(links) ? links : [],
            syncedAt: new Date().toISOString()
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch {}
    },
    async getOverlays(docId) {
      try {
        await this.open();
        if (!this.db.objectStoreNames.contains('overlays')) return null;
        return await new Promise((resolve) => {
          const tx = this.db.transaction('overlays', 'readonly');
          const req = tx.objectStore('overlays').get(docId);
          req.onsuccess = () => resolve(req.result ? req.result.links : null);
          req.onerror = () => resolve(null);
        });
      } catch {
        return null;
      }
    },
    async getAllOverlays() {
      try {
        await this.open();
        if (!this.db.objectStoreNames.contains('overlays')) return [];
        return await new Promise((resolve) => {
          const tx = this.db.transaction('overlays', 'readonly');
          const req = tx.objectStore('overlays').getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });
      } catch {
        return [];
      }
    }
  };

  // -----------------------------------------------------------------------
  // 3. ISOLATED MODULE STATE
  // -----------------------------------------------------------------------
  const bpState = {
    initialized: false,
    isOpen: false,
    dropboxConnected: false,
    lockedRoot: DEFAULT_LOCKED_ROOT,
    dbxClientId: '',
    dbxUpdatedAt: null,
    pendingRedirectCode: '',

    activeDoc: null,
    activePage: 1,
    projectFiles: new Map(),
    folderCache: new Map(),
    offlineSets: new Map(),
    memoryBlobs: new Map(),
    pdfProxies: new Map(),
    calloutLinks: [],
    historyStack: [],
    // Auto-Scan & High-Tier Gemini Model Tracking
    scannedPagesCache: new Set(),
    inFlightScans: new Set(),
    isScanningNow: false,
    cachedBlueprintModel: null,
    availableGeminiModels: null,
    scannerSettingsLoaded: false,

    stageW: 1500,
    stageH: 1000,
    zoom: 1,
    minZoom: 0.18,
    maxZoom: 10.0,
    panX: 20,
    panY: 20,
    qualityMultiplier: 1.25,
    isInteracting: false,
    detailDebounceTimer: null,
    activeBaseRenderTask: null,
    renderSerial: 0,
    detailRenderSerial: 0,

    addLinkMode: false,
    activePointers: new Map(),
    isDraggingPan: false,
    panStartX: 0,
    panStartY: 0,
    panOriginX: 0,
    panOriginY: 0,
    pinchStartDist: 0,
    pinchStartZoom: 1,
    isDrawingCallout: false,
    drawStartNormX: 0,
    drawStartNormY: 0,
    pendingRectNorm: null,
    editingCalloutId: null,
    selectedBadgeColor: 'blue',
    selectedTargetKey: null,

    calloutPickerPath: '',
    calloutPickerEntries: [],
    calloutPickerLoading: false,
    dbxPath: '',
    dbxEntries: []
  };

  // -----------------------------------------------------------------------
  // 4. PATH HELPERS (Client mirror of server-enforced locked root)
  // -----------------------------------------------------------------------
  function getLockedRoot() {
    const base = (bpState.lockedRoot || DEFAULT_LOCKED_ROOT).trim();
    if (!base) return DEFAULT_LOCKED_ROOT;
    return (base.startsWith('/') ? base : `/${base}`).replace(/\/+$/, '');
  }

  function clampPath(path = '') {
    const root = getLockedRoot();
    if (!path || path.trim() === '' || path.trim() === '/') return root;
    const norm = (path.startsWith('/') ? path : `/${path}`).replace(/\/+$/, '');
    const lower = norm.toLowerCase();
    const rootLower = root.toLowerCase();
    if (lower === rootLower || lower.startsWith(`${rootLower}/`)) return norm;
    return root;
  }

  function getParentFolderPath(path = '') {
    const clamped = clampPath(path);
    const root = getLockedRoot();
    if (!clamped || clamped.toLowerCase() === root.toLowerCase()) return root;
    const idx = clamped.lastIndexOf('/');
    const parent = idx > 0 ? clamped.slice(0, idx) : '';
    return clampPath(parent);
  }

  function getDocFolderPath(docMeta) {
    if (!docMeta) return clampPath(bpState.dbxPath || '');
    const rawPath = docMeta.dropboxDisplayPath || docMeta.dropboxPath || '';
    if (!rawPath) return clampPath(bpState.dbxPath || '');
    const idx = rawPath.lastIndexOf('/');
    const folder = idx > 0 ? rawPath.slice(0, idx) : '';
    return clampPath(folder);
  }

  function registerProjectSiblingFiles(entries, folderPath) {
    const rootLower = getLockedRoot().toLowerCase();
    if (folderPath) {
      bpState.folderCache.set(folderPath.toLowerCase(), entries);
    }

    (entries || []).forEach((entry) => {
      if (entry['.tag'] === 'file' && entry.name.toLowerCase().endsWith('.pdf')) {
        const pLower = String(entry.path_lower || '').toLowerCase();
        if (!pLower.startsWith(`${rootLower}/`) && pLower !== rootLower) return;
        const docId = `dbx_${pLower}`;
        const existing = bpState.projectFiles.get(docId);
        if (!existing) {
          bpState.projectFiles.set(docId, {
            docId,
            name: entry.name,
            source: 'dropbox',
            dropboxPath: pLower,
            dropboxDisplayPath: entry.path_display || entry.path_lower,
            size: entry.size || 0,
            numPages: 1,
            isOffline: bpState.offlineSets.has(docId)
          });
        } else if (!existing.dropboxDisplayPath && entry.path_display) {
          existing.dropboxDisplayPath = entry.path_display;
        }
      }
    });

    bpState.offlineSets.forEach((offMeta, docId) => {
      if (!bpState.projectFiles.has(docId)) {
        bpState.projectFiles.set(docId, { ...offMeta });
      }
    });
  }

  // -----------------------------------------------------------------------
  // 5. SERVER-SIDE DROPBOX PROXY SERVICE (Zero tokens in browser!)
  // -----------------------------------------------------------------------
  async function extractFunctionError(error) {
    if (!error) return 'Unknown Dropbox proxy error';
    try {
      if (error.context && typeof error.context.json === 'function') {
        const body = await error.context.json();
        if (body && body.error) return body.error;
      }
    } catch {}
    return error.message || 'Dropbox proxy request failed';
  }

  async function invokeDropboxProxy(payload) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase client is not configured.');
    if (!isAppOnline()) throw new Error('Device is offline.');

    const { data, error } = await sb.functions.invoke(PROXY_FN, { body: payload });
    if (error) {
      throw new Error(await extractFunctionError(error));
    }
    if (data && typeof data === 'object' && data.error) {
      throw new Error(data.error);
    }
    return data;
  }

  const DropboxProxy = {
    getRedirectUri() {
      return window.location.origin + window.location.pathname;
    },
    generateCodeVerifier() {
      const arr = new Uint8Array(48);
      crypto.getRandomValues(arr);
      return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    async generateCodeChallenge(verifier) {
      const data = new TextEncoder().encode(verifier);
      const digest = await crypto.subtle.digest('SHA-256', data);
      return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },

    async refreshStatus() {
      if (!getSupabase() || !isAppOnline()) {
        updateConnectionBadges();
        return null;
      }
      try {
        const res = await invokeDropboxProxy({ action: 'status' });
        bpState.dropboxConnected = Boolean(res?.connected);
        if (res?.lockedRoot) bpState.lockedRoot = res.lockedRoot;
        if (res?.clientId) bpState.dbxClientId = res.clientId;
        bpState.dbxUpdatedAt = res?.updatedAt || null;
        updateConnectionBadges();
        return res;
      } catch {
        updateConnectionBadges();
        return null;
      }
    },

    async listFolder(path = '') {
      const target = clampPath(path);
      const res = await invokeDropboxProxy({ action: 'list_folder', path: target });
      if (res?.lockedRoot) bpState.lockedRoot = res.lockedRoot;
      bpState.dropboxConnected = true;
      updateConnectionBadges();
      return Array.isArray(res?.entries) ? res.entries : [];
    },

    async downloadFile(path) {
      const target = clampPath(path);
      try {
        const linkRes = await invokeDropboxProxy({ action: 'get_temp_link', path: target });
        if (linkRes?.link) {
          const cdnRes = await fetch(linkRes.link);
          if (cdnRes.ok) {
            return await cdnRes.arrayBuffer();
          }
        }
      } catch {}

      const sb = getSupabase();
      const { data, error } = await sb.functions.invoke(PROXY_FN, {
        body: { action: 'download_file', path: target }
      });
      if (error) {
        throw new Error(await extractFunctionError(error));
      }
      if (data instanceof Blob) return await data.arrayBuffer();
      if (data instanceof ArrayBuffer) return data;
      throw new Error('Unexpected PDF download response.');
    },

    async startAdminDirectCodeFlow() {
      if (!isAdminUser()) throw new Error('Only Administrators can connect Dropbox.');
      const clientId = (document.getElementById('bpAdminClientIdInput')?.value || bpState.dbxClientId || '').trim();
      if (!clientId) throw new Error('Enter your Dropbox App Key (Client ID) first.');

      SafeStorage.set('bp_dbx_client_id_draft', clientId);
      const verifier = this.generateCodeVerifier();
      const challenge = await this.generateCodeChallenge(verifier);
      SafeStorage.set('bp_dbx_pkce_verifier', verifier);

      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        token_access_type: 'offline'
      });
      window.open(`https://www.dropbox.com/oauth2/authorize?${params.toString()}`, '_blank', 'noopener,noreferrer');
      notify('Dropbox opened in a new tab. Copy the code, enter your Admin PIN, and click Connect.', 'info');
    },

    async startAdminRedirectFlow() {
      if (!isAdminUser()) throw new Error('Only Administrators can connect Dropbox.');
      const clientId = (document.getElementById('bpAdminClientIdInput')?.value || bpState.dbxClientId || '').trim();
      if (!clientId) throw new Error('Enter your Dropbox App Key (Client ID) first.');

      SafeStorage.set('bp_dbx_client_id_draft', clientId);
      const verifier = this.generateCodeVerifier();
      const challenge = await this.generateCodeChallenge(verifier);
      const oauthState = this.generateCodeVerifier().slice(0, 24);
      SafeStorage.set('bp_dbx_pkce_verifier', verifier);
      SafeStorage.set('bp_dbx_oauth_state', oauthState);
      SafeStorage.set('bp_dbx_used_redirect', 'true');

      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        redirect_uri: this.getRedirectUri(),
        token_access_type: 'offline',
        state: oauthState
      });
      window.location.href = `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
    },

    async exchangeAdminCode(code, pin, useRedirectUri = false) {
      if (!isAdminUser()) throw new Error('Only Administrators can connect Dropbox.');
      const cleanCode = String(code || '').trim();
      const cleanPin = String(pin || '').trim();
      const clientId = (
        document.getElementById('bpAdminClientIdInput')?.value ||
        SafeStorage.get('bp_dbx_client_id_draft', '') ||
        bpState.dbxClientId
      ).trim();
      const verifier = SafeStorage.get('bp_dbx_pkce_verifier', '');

      if (!clientId) throw new Error('Enter your Dropbox App Key (Client ID).');
      if (!cleanCode) throw new Error('Paste the authorization code from Dropbox.');
      if (!cleanPin) throw new Error('Enter your 4-digit Admin PIN to authorize.');
      if (!verifier) throw new Error('Missing PKCE session. Click "Step 1: Open Dropbox & Get Code" again.');

      const res = await invokeDropboxProxy({
        action: 'exchange_code',
        clientId,
        code: cleanCode,
        codeVerifier: verifier,
        redirectUri: useRedirectUri ? this.getRedirectUri() : '',
        adminAuth: {
          employeeId: getAdminEmployeeId(),
          pin: cleanPin
        }
      });

      SafeStorage.remove('bp_dbx_pkce_verifier');
      SafeStorage.remove('bp_dbx_oauth_state');
      SafeStorage.remove('bp_dbx_used_redirect');
      bpState.pendingRedirectCode = '';
      bpState.dropboxConnected = Boolean(res?.connected);
      bpState.dbxClientId = clientId;
      if (res?.lockedRoot) bpState.lockedRoot = res.lockedRoot;
      bpState.folderCache.clear();
      await this.refreshStatus();
      return true;
    },

    async disconnectAdmin(pin) {
      if (!isAdminUser()) throw new Error('Only Administrators can disconnect Dropbox.');
      const cleanPin = String(pin || '').trim();
      if (!cleanPin) throw new Error('Enter your 4-digit Admin PIN to confirm disconnect.');

      await invokeDropboxProxy({
        action: 'disconnect',
        adminAuth: {
          employeeId: getAdminEmployeeId(),
          pin: cleanPin
        }
      });
      bpState.dropboxConnected = false;
      bpState.dbxEntries = [];
      bpState.folderCache.clear();
      updateConnectionBadges();
      renderDropboxEntries();
      return true;
    },

    captureRedirectCodeOnBoot() {
      try {
        const url = new URL(window.location.href);
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error_description') || url.searchParams.get('error');
        if (!code && !err) return;

        url.searchParams.delete('code');
        url.searchParams.delete('state');
        url.searchParams.delete('error');
        url.searchParams.delete('error_description');
        window.history.replaceState({}, document.title, url.toString());

        if (code) {
          bpState.pendingRedirectCode = code;
          notify('Dropbox redirect code received. Sign in as Admin → Dropbox Blueprints Setup and enter your PIN to finish.', 'info');
        } else if (err) {
          notify(`Dropbox OAuth error: ${err}`, 'error');
        }
      } catch {}
    }
  };

  // -----------------------------------------------------------------------
  // 6. SUPABASE CALLOUT LINKS & SCANNED-PAGE TRACKING
  // -----------------------------------------------------------------------
  const CalloutRepo = {
    toDbRow(link) {
      return {
        id: link.id,
        source_doc_id: link.sourceDocId,
        source_path: link.sourcePath || (link.sourceDocId?.startsWith('dbx_') ? link.sourceDocId.slice(4) : null),
        source_page: Number(link.sourcePage) || 1,
        target_doc_id: link.targetDocId,
        target_path: link.targetPath || (link.targetDocId?.startsWith('dbx_') ? link.targetDocId.slice(4) : null),
        target_doc_name: link.targetDocName || 'Drawing.pdf',
        target_page: Number(link.targetPage) || 1,
        label: link.label || '',
        detail_title: link.detailTitle || '',
        color: link.color || 'blue',
        x: Number(link.x),
        y: Number(link.y),
        w: Number(link.w) || 0.018,
        h: Number(link.h) || 0.026,
        is_auto_scanned: Boolean(link.isAutoScanned),
        updated_at: new Date().toISOString()
      };
    },
    fromDbRow(row) {
      return {
        id: row.id,
        sourceDocId: row.source_doc_id,
        sourcePath: row.source_path || (row.source_doc_id?.startsWith('dbx_') ? row.source_doc_id.slice(4) : ''),
        sourcePage: Number(row.source_page) || 1,
        targetDocId: row.target_doc_id,
        targetPath: row.target_path || (row.target_doc_id?.startsWith('dbx_') ? row.target_doc_id.slice(4) : ''),
        targetDocName: row.target_doc_name || 'Drawing.pdf',
        targetPage: Number(row.target_page) || 1,
        label: row.label || '',
        detailTitle: row.detail_title || '',
        color: row.color || 'blue',
        x: Number(row.x),
        y: Number(row.y),
        w: Number(row.w) || 0.018,
        h: Number(row.h) || 0.026,
        isAutoScanned: Boolean(row.is_auto_scanned)
      };
    },

    async fetchAllLinks() {
      const sb = getSupabase();
      if (!sb || !isAppOnline()) return null;
      const { data, error } = await sb
        .from(LINKS_TABLE)
        .select('*')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data || []).map((r) => this.fromDbRow(r));
    },

    async fetchLinksForDoc(sourceDocId) {
      const sb = getSupabase();
      if (!sb || !isAppOnline()) return null;
      const { data, error } = await sb
        .from(LINKS_TABLE)
        .select('*')
        .eq('source_doc_id', sourceDocId);
      if (error) throw error;
      return (data || []).map((r) => this.fromDbRow(r));
    },

    async upsertLink(link) {
      const sb = getSupabase();
      if (!sb || !isAppOnline()) return false;
      const { error } = await sb.from(LINKS_TABLE).upsert(this.toDbRow(link));
      if (error) throw error;
      return true;
    },

    async upsertManyLinks(links) {
      const sb = getSupabase();
      if (!sb || !isAppOnline() || !Array.isArray(links) || links.length === 0) return false;
      const rows = links.map((l) => this.toDbRow(l));
      const { error } = await sb.from(LINKS_TABLE).upsert(rows);
      if (error) throw error;
      return true;
    },

    async deleteLink(linkId) {
      const sb = getSupabase();
      if (!sb || !isAppOnline()) return false;
      const { error } = await sb.from(LINKS_TABLE).delete().eq('id', linkId);
      if (error) throw error;
      return true;
    },

    async deleteAutoScannedForPage(sourceDocId, sourcePage) {
      const sb = getSupabase();
      if (!sb || !isAppOnline()) return false;
      const { error } = await sb
        .from(LINKS_TABLE)
        .delete()
        .eq('source_doc_id', sourceDocId)
        .eq('source_page', Number(sourcePage) || 1)
        .eq('is_auto_scanned', true);
      if (error) throw error;
      return true;
    },

    async hasPageBeenScanned(docId, pageNum) {
      const key = `${docId}::${Number(pageNum) || 1}`;
      if (bpState.scannedPagesCache.has(key)) return true;

      const sb = getSupabase();
      if (!sb || !isAppOnline()) return true; // Never burn OCR credits offline or without DB check

      const { data, error } = await sb
        .from(SCANNED_PAGES_TABLE)
        .select('doc_id')
        .eq('doc_id', docId)
        .eq('page_number', Number(pageNum) || 1)
        .maybeSingle();

      if (error) {
        return true;
      }
      if (data) {
        bpState.scannedPagesCache.add(key);
        return true;
      }
      return false;
    },

    async markPageScanned({ docId, pageNum, sourcePath, folderPath, scanMethod, linksFound }) {
      const key = `${docId}::${Number(pageNum) || 1}`;
      bpState.scannedPagesCache.add(key);

      const sb = getSupabase();
      if (!sb || !isAppOnline()) return false;
      const { error } = await sb.from(SCANNED_PAGES_TABLE).upsert({
        doc_id: docId,
        page_number: Number(pageNum) || 1,
        source_path: sourcePath || null,
        folder_path: folderPath || null,
        scan_method: scanMethod || 'hybrid',
        links_found: Number(linksFound) || 0,
        scanned_by: getActiveUserDisplayName(),
        scanned_at: new Date().toISOString()
      });
      if (error) {
        console.warn('Could not record scanned page:', error.message);
        return false;
      }
      return true;
    }
  };

  function mergeLinksIntoState(incomingLinks, replaceSourceDocId = null) {
    if (!Array.isArray(incomingLinks)) return;
    const map = new Map();
    bpState.calloutLinks.forEach((l) => {
      if (replaceSourceDocId && l.sourceDocId === replaceSourceDocId) return;
      map.set(l.id, l);
    });
    incomingLinks.forEach((l) => {
      if (l && l.id) map.set(l.id, l);
    });
    bpState.calloutLinks = Array.from(map.values());
    SafeStorage.setJSON('prodraw_callout_links', bpState.calloutLinks);
  }

  async function syncDocOverlays(docId) {
    if (!docId) return [];
    if (getSupabase() && isAppOnline()) {
      try {
        const remote = await CalloutRepo.fetchLinksForDoc(docId);
        if (Array.isArray(remote)) {
          mergeLinksIntoState(remote, docId);
          if (bpState.offlineSets.has(docId)) {
            await ProDrawOfflineDB.saveOverlays(docId, remote);
          }
          return remote;
        }
      } catch {}
    }
    const cached = await ProDrawOfflineDB.getOverlays(docId);
    if (Array.isArray(cached) && cached.length > 0) {
      mergeLinksIntoState(cached, docId);
      return cached;
    }
    return bpState.calloutLinks.filter((l) => l.sourceDocId === docId);
  }

  function ensureDocMetaRegistered(docId, fallbackLink = null) {
    const existing = bpState.projectFiles.get(docId) || bpState.offlineSets.get(docId);
    if (existing) return existing;

    const dbxPath = fallbackLink?.targetPath || (docId?.startsWith('dbx_') ? docId.slice(4) : '');
    if (!dbxPath) return null;

    const rootLower = getLockedRoot().toLowerCase();
    const pathLower = dbxPath.toLowerCase();
    if (pathLower !== rootLower && !pathLower.startsWith(`${rootLower}/`)) {
      notify('Referenced drawing is outside the permitted folder.', 'warning');
      return null;
    }

    const fileName = fallbackLink?.targetDocName || dbxPath.split('/').pop() || 'Drawing.pdf';
    const synthesized = {
      docId: `dbx_${pathLower}`,
      name: fileName,
      source: 'dropbox',
      dropboxPath: pathLower,
      dropboxDisplayPath: dbxPath,
      size: 0,
      numPages: 1
    };
    bpState.projectFiles.set(synthesized.docId, synthesized);
    return synthesized;
  }

  async function saveDocAndOverlaysOffline(docMeta, includeLinkedTargets = true) {
    if (!docMeta) return;
    const buf = await getDocumentBuffer(docMeta);
    if (!buf) throw new Error(`Could not download "${docMeta.name}".`);

    const docLinks = await syncDocOverlays(docMeta.docId);
    docMeta.isOffline = true;
    await ProDrawOfflineDB.saveDocument(docMeta, buf);
    await ProDrawOfflineDB.saveOverlays(docMeta.docId, docLinks);
    bpState.offlineSets.set(docMeta.docId, docMeta);
    bpState.projectFiles.set(docMeta.docId, docMeta);

    let linkedSaved = 0;
    if (includeLinkedTargets && docLinks.length > 0) {
      const uniqueTargets = new Map();
      docLinks.forEach((l) => {
        if (l.targetDocId && l.targetDocId !== docMeta.docId && !bpState.offlineSets.has(l.targetDocId)) {
          uniqueTargets.set(l.targetDocId, l);
        }
      });
      for (const [targetId, linkRef] of uniqueTargets.entries()) {
        try {
          const targetMeta = ensureDocMetaRegistered(targetId, linkRef);
          if (targetMeta) {
            await saveDocAndOverlaysOffline(targetMeta, false);
            linkedSaved += 1;
          }
        } catch {}
      }
    }

    const suffix = linkedSaved > 0
      ? ` + ${linkedSaved} linked sheet(s) & overlays saved offline`
      : ` & ${docLinks.length} overlay(s) saved offline`;
    notify(`"${docMeta.name}"${suffix}`, 'success');
  }

  async function removeDocAndOverlaysOffline(docId) {
    const meta = bpState.projectFiles.get(docId) || bpState.offlineSets.get(docId);
    await ProDrawOfflineDB.removeDocument(docId);
    if (meta) meta.isOffline = false;
    bpState.offlineSets.delete(docId);
    notify(`Removed "${meta?.name || 'drawing'}" from offline cache`, 'info');
  }

  // -----------------------------------------------------------------------
  // 7. DEDICATED HIGH-TIER GEMINI 4 / 3.1 PRO CALLOUT SCANNER (ADMIN-ONLY)
  // -----------------------------------------------------------------------

  /**
   * Queries /v1beta/models once per session to see which Gemini models are
   * actually enabled for the configured API key, avoiding wasted 404 retries.
   */
  async function discoverAvailableBlueprintModels(key) {
    if (Array.isArray(bpState.availableGeminiModels)) {
      return bpState.availableGeminiModels;
    }
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      const liveNames = (data.models || [])
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean);

      if (liveNames.length > 0) {
        bpState.availableGeminiModels = liveNames;
        return liveNames;
      }
    } catch {}
    return null;
  }

  /**
   * Dedicated Gemini Vision API caller exclusively for blueprint callout scanning.
   * - Targets Gemini 4 (Neon → Carbon → Hydrogen → Argon), Gemini 3.1 Pro, and 2.5 Pro
   * - Leaves ACT receipt OCR (app-core.js) completely untouched on fast Flash models
   * - Uses Structured Outputs responseSchema + 45s timeout + smart 400 retry without thinkingConfig
   */
  async function callGeminiForBlueprints(contents) {
    const key = typeof getCleanApiKey === 'function' ? getCleanApiKey() : '';
    if (!key) {
      return {
        ok: false,
        errorReason: 'No Gemini API Key configured (Admin → OCR API Key Setup).'
      };
    }

    const pref = getBlueprintModelPreference();
    let candidates =
      pref && pref !== 'auto'
        ? [pref, ...BLUEPRINT_GEMINI_MODEL_CHAIN.filter((m) => m !== pref)]
        : [...BLUEPRINT_GEMINI_MODEL_CHAIN];

    // Filter against live models enabled for this key (while always honoring an explicit user choice)
    const liveModels = await discoverAvailableBlueprintModels(key);
    if (Array.isArray(liveModels) && liveModels.length > 0) {
      const liveSet = new Set(liveModels);
      const filteredChain = candidates.filter((m) => liveSet.has(m) || (pref !== 'auto' && m === pref));
      const extraProModels = liveModels.filter(
        (m) => /gemini-(4|3\.1|3|2\.5)-(neon|carbon|hydrogen|argon|pro)/i.test(m) && !filteredChain.includes(m)
      );
      const extraFlashModels = liveModels.filter(
        (m) => /gemini-(3\.8|3|2\.5)-flash/i.test(m) && !filteredChain.includes(m)
      );
      const merged = [...filteredChain, ...extraProModels, ...extraFlashModels];
      if (merged.length > 0) {
        candidates = merged;
      }
    }

    if (bpState.cachedBlueprintModel && candidates.includes(bpState.cachedBlueprintModel)) {
      candidates = [
        bpState.cachedBlueprintModel,
        ...candidates.filter((m) => m !== bpState.cachedBlueprintModel)
      ];
    }

    const errors = [];

    const postModel = async (modelName, includeThinking) => {
      const isGemini4 = /^gemini-4-/i.test(modelName);
      const generationConfig = {
        responseMimeType: 'application/json',
        responseSchema: CALLOUT_RESPONSE_SCHEMA,
        maxOutputTokens: 16384
      };

      // Gemini 4 accepts thinkingLevel ('low'|'medium'|'high') and ignores temperature/topP/topK
      if (isGemini4 && includeThinking) {
        generationConfig.thinkingConfig = { thinkingLevel: 'medium' };
      }

      const payload = { contents, generationConfig };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(key)}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timer);
        const data = await resp.json().catch(() => ({}));
        return { resp, data };
      } catch (fetchErr) {
        clearTimeout(timer);
        throw fetchErr;
      }
    };

    for (const modelName of candidates) {
      try {
        let { resp, data } = await postModel(modelName, true);

        // If a model rejects thinkingConfig with HTTP 400, retry the same model once cleanly without it
        if (!resp.ok && resp.status === 400 && /thinking/i.test(String(data?.error?.message || ''))) {
          ({ resp, data } = await postModel(modelName, false));
        }

        if (resp.ok && data?.candidates?.length) {
          bpState.cachedBlueprintModel = modelName;
          return { ok: true, data, modelUsed: modelName };
        }

        const errMsg = data?.error?.message || `HTTP ${resp.status}`;
        errors.push(`${modelName}: ${errMsg}`);

        if (bpState.cachedBlueprintModel === modelName) {
          bpState.cachedBlueprintModel = null;
        }
      } catch (fetchErr) {
        const msg = fetchErr.name === 'AbortError' ? 'Timed out (45s)' : (fetchErr.message || 'Network error');
        errors.push(`${modelName}: ${msg}`);
        if (bpState.cachedBlueprintModel === modelName) {
          bpState.cachedBlueprintModel = null;
        }
      }
    }

    return { ok: false, errorReason: errors.slice(0, 3).join(' | ') };
  }

  /**
   * Extracts normalized construction sheet identifiers from a PDF filename
   * (e.g., "S2.0 - Footing Details.pdf" -> ["S2.0"], "03_A-101_Plan.pdf" -> ["A101"]).
   */
  function extractSheetCodesFromFilename(filename) {
    const base = String(filename || '').replace(/\.pdf$/i, '').trim();
    const codes = new Set();

    const sheetRegex = /(?:^|[^A-Z0-9])([A-Z]{1,3}[-.\s]?\d{1,3}(?:[.\-]\d{1,3})?[A-Z]?)(?=$|[^A-Z0-9])/gi;
    let m;
    while ((m = sheetRegex.exec(base)) !== null) {
      const canon = canonicalSheetCode(m[1]);
      if (canon.length >= 2 && /[A-Z]/.test(canon) && /\d/.test(canon) && !IGNORED_SHEET_TOKENS.has(canon)) {
        codes.add(canon);
        if (/\.\d+$/.test(canon)) {
          codes.add(canon.replace(/\.0+$/, '.0'));
        }
      }
    }

    const leadToken = base.split(/[\s_]+|\s+-\s+/)[0] || '';
    const leadCanon = canonicalSheetCode(leadToken);
    if (leadCanon.length >= 2 && !IGNORED_SHEET_TOKENS.has(leadCanon)) {
      if (/[A-Z]/.test(leadCanon) && /\d/.test(leadCanon)) {
        codes.add(leadCanon);
      } else if (/^\d{2,4}(?:\.\d+)?$/.test(leadCanon)) {
        codes.add(`NUM:${leadCanon}`);
      }
    }

    return Array.from(codes);
  }

  /**
   * Builds a lookup index for all sibling PDFs in the same folder (excluding self).
   */
  function buildSiblingSheetIndex(activeDocMeta, siblingDocs) {
    const selfCodes = new Set(extractSheetCodesFromFilename(activeDocMeta.name));
    const codeToDoc = new Map();
    const numericToDoc = new Map();
    const filenameToDoc = new Map();

    siblingDocs.forEach((doc) => {
      if (!doc || doc.docId === activeDocMeta.docId) return;
      filenameToDoc.set(doc.name.toLowerCase(), doc);
      filenameToDoc.set(normalizeSheetToken(doc.name.replace(/\.pdf$/i, '')), doc);

      const codes = extractSheetCodesFromFilename(doc.name);
      codes.forEach((c) => {
        if (selfCodes.has(c)) return;
        if (c.startsWith('NUM:')) {
          const num = c.slice(4);
          if (!numericToDoc.has(num)) numericToDoc.set(num, doc);
        } else if (!codeToDoc.has(c)) {
          codeToDoc.set(c, doc);
        }
      });
    });

    return { selfCodes, codeToDoc, numericToDoc, filenameToDoc, siblingDocs };
  }

  function resolveSheetCodeToSibling(rawSheetCode, siblingIndex, allowNumericOnly = false) {
    const canon = canonicalSheetCode(rawSheetCode);
    if (!canon || siblingIndex.selfCodes.has(canon)) return null;

    if (siblingIndex.codeToDoc.has(canon)) {
      return siblingIndex.codeToDoc.get(canon);
    }
    if (/\.\d+$/.test(canon)) {
      const normalizedZero = canon.replace(/\.0+$/, '.0');
      if (siblingIndex.codeToDoc.has(normalizedZero)) {
        return siblingIndex.codeToDoc.get(normalizedZero);
      }
    }
    if (allowNumericOnly && /^\d{2,4}(?:\.\d+)?$/.test(canon) && siblingIndex.numericToDoc.has(canon)) {
      return siblingIndex.numericToDoc.get(canon);
    }
    return null;
  }

  function isLikelyTitleBlockPosition(x, y) {
    if (x > 0.80 && y > 0.80) return true;
    if (x > 0.92) return true;
    return false;
  }

  function normalizeHotspotBox(x, y, w, h) {
    const MIN_W = 0.016;
    const MIN_H = 0.022;
    const MAX_W = 0.085;
    const MAX_H = 0.085;

    const cx = x + w / 2;
    const cy = y + h / 2;
    const finalW = Math.min(MAX_W, Math.max(MIN_W, w + 0.004));
    const finalH = Math.min(MAX_H, Math.max(MIN_H, h + 0.005));

    return {
      x: Math.max(0, Math.min(1 - finalW, cx - finalW / 2)),
      y: Math.max(0, Math.min(1 - finalH, cy - finalH / 2)),
      w: finalW,
      h: finalH
    };
  }

  function deduplicateDetections(candidates, existingManualLinks) {
    const accepted = [];
    const dist = (a, b) => Math.hypot((a.x + a.w / 2) - (b.x + b.w / 2), (a.y + a.h / 2) - (b.y + b.h / 2));

    for (const c of candidates) {
      const hitsManual = existingManualLinks.some((m) => dist(c, m) < 0.024);
      if (hitsManual) continue;

      const dup = accepted.find((a) => a.targetDoc.docId === c.targetDoc.docId && dist(a, c) < 0.032);
      if (dup) {
        if (c.label.includes('/') && !dup.label.includes('/')) {
          dup.label = c.label;
          if (c.detailTitle && !dup.detailTitle) dup.detailTitle = c.detailTitle;
        }
        continue;
      }
      accepted.push(c);
    }
    return accepted;
  }

  /**
   * PASS 1: Fast, pixel-accurate PDF.js native vector text extraction.
   */
  async function scanPageVectorText(page, siblingIndex) {
    const unscaled = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const rawItems = textContent?.items || [];
    if (rawItems.length < 5) {
      return { hasVectorText: false, detections: [] };
    }

    const items = [];
    for (const item of rawItems) {
      const str = String(item.str || '').trim();
      if (!str || !Array.isArray(item.transform) || item.transform.length < 6) continue;

      const tx = pdfjsLib.Util.transform(unscaled.transform, item.transform);
      const fontH = Math.hypot(tx[2], tx[3]) || Math.abs(item.height) || 10;
      const textW = item.width && item.width > 0 ? item.width : Math.max(fontH * 0.58 * str.length, 8);
      const angle = Math.atan2(tx[1], tx[0]);
      const isVertical = Math.abs(Math.sin(angle)) > 0.65;

      let vx, vy, vw, vh;
      if (isVertical) {
        vw = fontH * 1.15;
        vh = textW;
        vx = tx[4] - vw / 2;
        vy = tx[5] - (Math.sin(angle) < 0 ? vh : 0);
      } else {
        vw = textW;
        vh = fontH * 1.15;
        vx = tx[4];
        vy = tx[5] - fontH;
      }

      const x = Math.max(0, Math.min(1, vx / (unscaled.width || 1)));
      const y = Math.max(0, Math.min(1, vy / (unscaled.height || 1)));
      const w = Math.max(0.002, Math.min(0.4, vw / (unscaled.width || 1)));
      const h = Math.max(0.003, Math.min(0.2, vh / (unscaled.height || 1)));

      items.push({ str, x, y, w, h, cx: x + w / 2, cy: y + h / 2 });
    }

    const detections = [];
    const inlineFractionRe = /\b([A-Z0-9]{1,3})\s*\/\s*([A-Z]{1,3}[-.\s]?\d{1,3}(?:[.\-]\d{1,3})?[A-Z]?|\d{2,4}(?:\.\d+)?)\b/gi;
    const standaloneSheetRe = /(?:^|[^A-Z0-9])([A-Z]{1,3}[-.\s]?\d{1,3}(?:[.\-]\d{1,3})?[A-Z]?)(?=$|[^A-Z0-9])/gi;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let matchedInline = false;

      inlineFractionRe.lastIndex = 0;
      let fm;
      while ((fm = inlineFractionRe.exec(it.str)) !== null) {
        const detailNum = fm[1].toUpperCase();
        const sheetRaw = fm[2].toUpperCase();
        const targetDoc = resolveSheetCodeToSibling(sheetRaw, siblingIndex, true);
        if (!targetDoc) continue;

        matchedInline = true;
        const box = normalizeHotspotBox(it.x, it.y, it.w, it.h);
        detections.push({
          ...box,
          label: `${detailNum}/${canonicalSheetCode(sheetRaw)}`,
          detailTitle: 'Auto-linked callout',
          targetDoc
        });
      }
      if (matchedInline) continue;

      if (isLikelyTitleBlockPosition(it.x, it.y)) continue;

      standaloneSheetRe.lastIndex = 0;
      let sm;
      while ((sm = standaloneSheetRe.exec(it.str)) !== null) {
        const sheetRaw = sm[1].toUpperCase();
        const targetDoc = resolveSheetCodeToSibling(sheetRaw, siblingIndex, false);
        if (!targetDoc) continue;

        let detailAbove = null;
        for (let j = 0; j < items.length; j++) {
          if (i === j) continue;
          const cand = items[j];
          if (!/^[A-Z0-9]{1,3}$/i.test(cand.str)) continue;
          const dx = Math.abs(cand.cx - it.cx);
          const dy = it.cy - cand.cy;
          const maxDx = Math.max(it.w * 0.9, 0.015);
          const maxDy = Math.max(it.h * 3.2, 0.025);
          if (dx <= maxDx && dy > 0.002 && dy <= maxDy) {
            detailAbove = cand;
            break;
          }
        }

        let bx = it.x;
        let by = it.y;
        let bw = it.w;
        let bh = it.h;
        let label = canonicalSheetCode(sheetRaw);

        if (detailAbove) {
          bx = Math.min(it.x, detailAbove.x);
          by = Math.min(it.y, detailAbove.y);
          const maxX = Math.max(it.x + it.w, detailAbove.x + detailAbove.w);
          const maxY = Math.max(it.y + it.h, detailAbove.y + detailAbove.h);
          bw = maxX - bx;
          bh = maxY - by;
          label = `${detailAbove.str.toUpperCase()}/${label}`;
        }

        const box = normalizeHotspotBox(bx, by, bw, bh);
        detections.push({
          ...box,
          label,
          detailTitle: 'Auto-linked callout',
          targetDoc
        });
      }
    }

    return { hasVectorText: items.length >= 15, detections };
  }

  /**
   * PASS 2: 2×2 Tiled High-Tier Gemini 4 / 3.1 Pro Vision OCR pass.
   */
  async function scanPageGeminiVisionTiled(page, siblingIndex, onProgress) {
    if (typeof getCleanApiKey === 'function' && !getCleanApiKey()) {
      return {
        ok: false,
        reason: 'Gemini OCR API key not configured (Admin → OCR API Key Setup).',
        detections: [],
        modelUsed: ''
      };
    }

    const siblingCatalog = siblingIndex.siblingDocs.map((doc) => ({
      filename: doc.name,
      codes: extractSheetCodesFromFilename(doc.name).map((c) => c.replace(/^NUM:/, ''))
    }));

    // Render full page at crisp high resolution for 2×2 tiled inspection
    const unscaled = page.getViewport({ scale: 1 });
    const maxDim = 2800;
    const renderScale = Math.min(2.5, maxDim / Math.max(unscaled.width, unscaled.height));
    const vp = page.getViewport({ scale: Math.max(1, renderScale) });

    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = Math.floor(vp.width);
    fullCanvas.height = Math.floor(vp.height);
    const fullCtx = fullCanvas.getContext('2d', { alpha: false });
    await page.render({ canvasContext: fullCtx, viewport: vp }).promise;

    // 2×2 grid with 8% overlap so callout bubbles on center seams are never sliced
    const overlap = 0.08;
    const tiles = [
      { x0: 0, y0: 0, x1: 0.5 + overlap / 2, y1: 0.5 + overlap / 2 },
      { x0: 0.5 - overlap / 2, y0: 0, x1: 1, y1: 0.5 + overlap / 2 },
      { x0: 0, y0: 0.5 - overlap / 2, x1: 0.5 + overlap / 2, y1: 1 },
      { x0: 0.5 - overlap / 2, y0: 0.5 - overlap / 2, x1: 1, y1: 1 }
    ];

    const catalogText = siblingCatalog
      .map((s) => `- "${s.filename}" (sheet codes: ${s.codes.join(', ') || 'filename match'})`)
      .join('\n');

    const promptText = `You are an expert construction blueprint callout detector inspecting a quadrant of an architectural, structural, or civil drawing.
Locate EVERY detail callout bubble, section cut bubble, elevation marker, enlarged plan callout, or sheet reference note (e.g. "3/S2.0", stacked circle with "3" over "S2.0", "SEE SHEET S2.1") that points to one of the sibling PDF drawings in the same folder listed below.

VALID TARGET DRAWINGS IN THIS FOLDER (ONLY return callouts that match one of these exact filenames):
${catalogText}

STRICT RULES:
1. Ignore the drawing's own title block, revision table, and general sheet index tables.
2. Only return callouts whose referenced sheet number matches one of the valid target drawings listed above. Do NOT invent filenames.
3. For each callout, provide a tight bounding box [ymin, xmin, ymax, xmax] scaled 0 to 1000 relative to THIS image crop, centered directly on the callout bubble or reference text.
4. Keep detail_title short (e.g., "Wall Footing Section") or empty string if none is printed nearby.
5. Return ONLY JSON matching the response schema (empty "callouts" array if none are present in this quadrant).`;

    const detections = [];
    let completedTiles = 0;
    let succeededTiles = 0;
    let modelUsed = '';
    let lastErrorReason = '';

    const scanSingleTile = async (tile) => {
      const sx = Math.floor(tile.x0 * fullCanvas.width);
      const sy = Math.floor(tile.y0 * fullCanvas.height);
      const sw = Math.max(100, Math.floor((tile.x1 - tile.x0) * fullCanvas.width));
      const sh = Math.max(100, Math.floor((tile.y1 - tile.y0) * fullCanvas.height));

      const tileCanvas = document.createElement('canvas');
      tileCanvas.width = sw;
      tileCanvas.height = sh;
      tileCanvas.getContext('2d', { alpha: false }).drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
      const b64 = tileCanvas.toDataURL('image/jpeg', 0.86).split(',')[1];

      const res = await callGeminiForBlueprints([
        {
          role: 'user',
          parts: [
            { text: promptText },
            { inlineData: { mimeType: 'image/jpeg', data: b64 } }
          ]
        }
      ]);

      completedTiles += 1;
      if (res.ok && res.modelUsed) modelUsed = res.modelUsed;
      if (typeof onProgress === 'function') {
        onProgress(completedTiles, tiles.length, modelUsed);
      }

      if (!res.ok) {
        lastErrorReason = res.errorReason || 'Gemini Vision scan failed.';
        return;
      }
      succeededTiles += 1;

      const rawText = (res.data?.candidates?.[0]?.content?.parts || [])
        .filter((p) => !p.thought && p.text)
        .map((p) => p.text)
        .join('\n');
      const cleaned = rawText.replace(/```json|```/gi, '').trim();
      let parsed = null;
      try {
        parsed = JSON.parse(cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned);
      } catch {
        return;
      }

      const callouts = Array.isArray(parsed?.callouts) ? parsed.callouts : [];
      for (const c of callouts) {
        if (!Array.isArray(c.box_2d) || c.box_2d.length !== 4) continue;
        const [rawY1, rawX1, rawY2, rawX2] = c.box_2d.map(Number);
        if ([rawY1, rawX1, rawY2, rawX2].some((n) => isNaN(n))) continue;
        const ymin = Math.min(rawY1, rawY2);
        const ymax = Math.max(rawY1, rawY2);
        const xmin = Math.min(rawX1, rawX2);
        const xmax = Math.max(rawX1, rawX2);

        const fnameLower = String(c.target_filename || '').trim().toLowerCase();
        let targetDoc =
          siblingIndex.filenameToDoc.get(fnameLower) ||
          siblingIndex.filenameToDoc.get(normalizeSheetToken(fnameLower.replace(/\.pdf$/i, '')));

        if (!targetDoc && c.label) {
          const sheetPart = String(c.label).includes('/') ? String(c.label).split('/').pop() : String(c.label);
          targetDoc = resolveSheetCodeToSibling(sheetPart, siblingIndex, true);
        }
        if (!targetDoc) continue;

        const tileW = tile.x1 - tile.x0;
        const tileH = tile.y1 - tile.y0;
        const gx = tile.x0 + (Math.max(0, Math.min(1000, xmin)) / 1000) * tileW;
        const gy = tile.y0 + (Math.max(0, Math.min(1000, ymin)) / 1000) * tileH;
        const gw = (Math.max(1, Math.min(1000, xmax) - Math.max(0, xmin)) / 1000) * tileW;
        const gh = (Math.max(1, Math.min(1000, ymax) - Math.max(0, ymin)) / 1000) * tileH;

        if (isLikelyTitleBlockPosition(gx, gy) && !String(c.label || '').includes('/')) continue;

        const box = normalizeHotspotBox(gx, gy, gw, gh);
        detections.push({
          ...box,
          label: String(c.label || targetDoc.name.replace(/\.pdf$/i, '')).trim(),
          detailTitle: String(c.detail_title || 'AI callout').trim(),
          targetDoc
        });
      }
    };

    // Prime tile 1 first if model isn't cached yet so tiles 2-4 skip fallback retries cleanly
    if (!bpState.cachedBlueprintModel) {
      await scanSingleTile(tiles[0]);
      await Promise.all([scanSingleTile(tiles[1]), scanSingleTile(tiles[2])]);
      await scanSingleTile(tiles[3]);
    } else {
      await Promise.all([scanSingleTile(tiles[0]), scanSingleTile(tiles[1])]);
      await Promise.all([scanSingleTile(tiles[2]), scanSingleTile(tiles[3])]);
    }

    if (succeededTiles === 0) {
      return {
        ok: false,
        reason: lastErrorReason || 'Gemini Vision scan failed.',
        detections: [],
        modelUsed: ''
      };
    }

    return { ok: true, detections, modelUsed };
  }

  /**
   * Main page callout scanner:
   * - First-open Auto-Scan triggers for ALL user roles (strictly once per doc+page across all devices)
   * - Manual Re-Scan is restricted strictly to Administrators
   */
  async function scanActivePageForCallouts({ isManualRescan = false } = {}) {
    if (isManualRescan && !isAdminUser()) {
      notify('Only Administrators can manually re-scan drawings for callout links.', 'warning');
      return;
    }
    if (!bpState.activeDoc || !isAppOnline()) {
      if (isManualRescan) notify('Open a drawing while online to scan callout links.', 'warning');
      return;
    }

    // Ensure non-Admin devices have the Admin's chosen Gemini model & auto-scan settings before scanning
    if (!bpState.scannerSettingsLoaded) {
      await loadScannerSettingsFromSupabase();
    }

    const docMeta = bpState.activeDoc;
    const pageNum = bpState.activePage;
    const scanKey = `${docMeta.docId}::${pageNum}`;

    if (bpState.inFlightScans.has(scanKey)) return;

    if (!isManualRescan) {
      if (!isAutoScanEnabled()) return;
      const alreadyScanned = await CalloutRepo.hasPageBeenScanned(docMeta.docId, pageNum);
      if (alreadyScanned) return;
    }

    bpState.inFlightScans.add(scanKey);
    bpState.isScanningNow = true;
    updateRescanButtonUI();

    const busy = document.getElementById('bpPdfBusyIndicator');
    const busyText = document.getElementById('bpPdfBusyText');
    const setBusy = (msg) => {
      if (busyText) busyText.textContent = msg;
      busy?.classList.remove('hidden');
    };

    try {
      setBusy(isManualRescan ? 'Re-scanning folder & sheet callouts...' : 'First-open Auto-Scan: checking sibling drawings...');

      // 1. Gather sibling PDFs strictly in the SAME folder as the parent drawing
      const folderPath = getDocFolderPath(docMeta);
      let folderEntries = [];
      if (docMeta.source === 'dropbox' && bpState.dropboxConnected) {
        const cacheKey = folderPath.toLowerCase();
        if (!isManualRescan && bpState.folderCache.has(cacheKey)) {
          folderEntries = bpState.folderCache.get(cacheKey);
        } else {
          folderEntries = await DropboxProxy.listFolder(folderPath);
          registerProjectSiblingFiles(folderEntries, folderPath);
        }
      }

      const siblingDocs = folderEntries
        .filter((e) => e['.tag'] === 'file' && String(e.name || '').toLowerCase().endsWith('.pdf'))
        .map((e) => bpState.projectFiles.get(`dbx_${String(e.path_lower || '').toLowerCase()}`))
        .filter((d) => d && d.docId !== docMeta.docId);

      if (siblingDocs.length === 0) {
        await CalloutRepo.markPageScanned({
          docId: docMeta.docId,
          pageNum,
          sourcePath: docMeta.dropboxPath || '',
          folderPath,
          scanMethod: 'skipped_no_siblings',
          linksFound: 0
        });
        if (isManualRescan) {
          notify('No other PDF drawings found in this folder to link to.', 'info');
        }
        return;
      }

      const siblingIndex = buildSiblingSheetIndex(docMeta, siblingDocs);
      const proxy = await getOrLoadPdfProxy(docMeta.docId);
      const page = await proxy.getPage(pageNum);
      const scanMode = getBlueprintScanMode(); // 'combined' | 'hybrid' | 'vision_only'

      let vectorDetections = [];
      let ocrDetections = [];
      let ocrModelUsed = '';
      let scanMethod = 'vector_text';

      // 2. Pass 1: Fast PDF.js vector text extraction (unless set to vision_only)
      if (scanMode !== 'vision_only') {
        setBusy('Scanning PDF vector text for callouts...');
        const vectorResult = await scanPageVectorText(page, siblingIndex);
        vectorDetections = vectorResult.detections || [];
      }

      // 3. Pass 2: High-tier Gemini 4 / 3.1 Pro Vision OCR
      const shouldRunVision =
        scanMode === 'combined' ||
        scanMode === 'vision_only' ||
        isManualRescan ||
        vectorDetections.length === 0;

      if (shouldRunVision) {
        setBusy('Running Gemini Vision callout scan (tile 0/4)...');
        const ocrResult = await scanPageGeminiVisionTiled(page, siblingIndex, (done, total, activeModel) => {
          const tag = activeModel ? ` [${activeModel}]` : '';
          setBusy(`Gemini Vision callout scan${tag} (tile ${done}/${total})...`);
        });
        if (ocrResult.ok) {
          ocrDetections = ocrResult.detections || [];
          ocrModelUsed = ocrResult.modelUsed || 'gemini-vision';
          scanMethod = vectorDetections.length > 0 ? `vector+${ocrModelUsed}` : ocrModelUsed;
        } else {
          scanMethod = vectorDetections.length > 0 ? 'vector_only_ocr_error' : 'failed_ocr';
          if (isManualRescan) {
            notify(ocrResult.reason || 'Gemini Vision scan unavailable.', 'warning');
          }
        }
      }

      // Vector matches go first so pixel-exact CAD coordinates win deduplication,
      // while Gemini Vision catches graphical/stroked callout bubbles vector text misses.
      const combinedDetections = [...vectorDetections, ...ocrDetections];

      // 4. Preserve manual callout links; replace only previous auto-scanned links on Re-Scan
      const manualLinksOnPage = bpState.calloutLinks.filter(
        (l) => l.sourceDocId === docMeta.docId && Number(l.sourcePage) === Number(pageNum) && !l.isAutoScanned
      );
      const finalDetections = deduplicateDetections(combinedDetections, manualLinksOnPage);

      if (isManualRescan) {
        try {
          await CalloutRepo.deleteAutoScannedForPage(docMeta.docId, pageNum);
        } catch (delErr) {
          console.warn('Could not clear old auto-scanned links:', delErr);
        }
        bpState.calloutLinks = bpState.calloutLinks.filter(
          (l) => !(l.sourceDocId === docMeta.docId && Number(l.sourcePage) === Number(pageNum) && l.isAutoScanned)
        );
      }

      const nowTs = Date.now();
      const newLinkObjects = finalDetections.map((d, idx) => ({
        id: `auto_${nowTs}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
        sourceDocId: docMeta.docId,
        sourcePath: docMeta.dropboxPath || '',
        sourcePage: pageNum,
        targetDocId: d.targetDoc.docId,
        targetPath: d.targetDoc.dropboxPath || '',
        targetDocName: d.targetDoc.name,
        targetPage: 1,
        label: d.label,
        detailTitle: d.detailTitle || '',
        color: 'blue',
        x: d.x,
        y: d.y,
        w: d.w,
        h: d.h,
        isAutoScanned: true
      }));

      if (newLinkObjects.length > 0) {
        bpState.calloutLinks.push(...newLinkObjects);
        SafeStorage.setJSON('prodraw_callout_links', bpState.calloutLinks);
        await CalloutRepo.upsertManyLinks(newLinkObjects);

        if (bpState.offlineSets.has(docMeta.docId)) {
          const docLinks = bpState.calloutLinks.filter((l) => l.sourceDocId === docMeta.docId);
          await ProDrawOfflineDB.saveOverlays(docMeta.docId, docLinks);
        }
      } else if (isManualRescan) {
        SafeStorage.setJSON('prodraw_callout_links', bpState.calloutLinks);
        if (bpState.offlineSets.has(docMeta.docId)) {
          const docLinks = bpState.calloutLinks.filter((l) => l.sourceDocId === docMeta.docId);
          await ProDrawOfflineDB.saveOverlays(docMeta.docId, docLinks);
        }
      }

      // 5. Mark page scanned in Supabase across all devices (skip marking if OCR completely failed with 0 links)
      if (scanMethod !== 'failed_ocr') {
        await CalloutRepo.markPageScanned({
          docId: docMeta.docId,
          pageNum,
          sourcePath: docMeta.dropboxPath || '',
          folderPath,
          scanMethod,
          linksFound: newLinkObjects.length
        });
      }

      if (bpState.activeDoc?.docId === docMeta.docId && bpState.activePage === pageNum) {
        renderCalloutOverlays();
      }

      const engineTag = ocrModelUsed ? `Gemini (${ocrModelUsed})` : 'Vector Scan';
      if (newLinkObjects.length > 0) {
        notify(`${engineTag}: auto-linked ${newLinkObjects.length} callout(s) to sibling drawings!`, 'success');
      } else if (isManualRescan) {
        notify(`${engineTag} complete: no matching sibling callouts found on this page.`, 'info');
      }
    } catch (err) {
      console.error('Blueprint callout scan error:', err);
      if (isManualRescan) {
        notify(`Scan error: ${err.message}`, 'error');
      }
    } finally {
      bpState.inFlightScans.delete(scanKey);
      bpState.isScanningNow = bpState.inFlightScans.size > 0;
      if (!bpState.isScanningNow) {
        busy?.classList.add('hidden');
      }
      updateRescanButtonUI();
    }
  }

  function updateRescanButtonUI() {
    const btn = document.getElementById('bpRescanPageBtn');
    const lbl = document.getElementById('bpRescanPageLabel');
    if (!btn) return;
    if (!isAdminUser()) {
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');
    btn.disabled = bpState.isScanningNow || !bpState.activeDoc;
    if (lbl) lbl.textContent = bpState.isScanningNow ? 'Scanning...' : 'Re-Scan Links';
  }

  // -----------------------------------------------------------------------
  // 8. PDF LOADING, RENDERING & VIEWPORT INTERACTION
  // -----------------------------------------------------------------------
  async function getDocumentBuffer(docMeta) {
    if (!docMeta || !docMeta.docId) return null;
    if (bpState.memoryBlobs.has(docMeta.docId)) {
      return bpState.memoryBlobs.get(docMeta.docId);
    }
    const cached = await ProDrawOfflineDB.getBlob(docMeta.docId);
    if (cached) {
      bpState.memoryBlobs.set(docMeta.docId, cached);
      return cached;
    }
    if (docMeta.source === 'dropbox' && docMeta.dropboxPath) {
      if (!isAppOnline()) {
        throw new Error(`"${docMeta.name}" is not saved offline on this device.`);
      }
      const buf = await DropboxProxy.downloadFile(docMeta.dropboxPath);
      bpState.memoryBlobs.set(docMeta.docId, buf);
      return buf;
    }
    throw new Error(`Unable to load PDF binary for "${docMeta.name}".`);
  }

  async function getOrLoadPdfProxy(docId) {
    if (bpState.pdfProxies.has(docId)) {
      return bpState.pdfProxies.get(docId);
    }
    const meta = bpState.projectFiles.get(docId) || bpState.offlineSets.get(docId);
    if (!meta) throw new Error('Drawing metadata not found.');
    if (!window.pdfjsLib) throw new Error('PDF.js engine is not loaded.');

    const buf = await getDocumentBuffer(meta);
    if (!buf) throw new Error(`Could not retrieve PDF data for "${meta.name}".`);

    const loadingTask = window.pdfjsLib.getDocument({ data: buf.slice(0) });
    const proxy = await loadingTask.promise;
    meta.numPages = proxy.numPages || 1;
    bpState.pdfProxies.set(docId, proxy);
    return proxy;
  }

  async function openBlueprintDocument(docId, pageNum = 1, pushHistory = false, linkFallback = null) {
    const meta = ensureDocMetaRegistered(docId, linkFallback);
    if (!meta) {
      notify('Target drawing not found.', 'error');
      return;
    }
    if (pushHistory && bpState.activeDoc) {
      bpState.historyStack.push({
        doc: bpState.activeDoc,
        page: bpState.activePage,
        zoom: bpState.zoom,
        panX: bpState.panX,
        panY: bpState.panY
      });
    }

    const busy = document.getElementById('bpPdfBusyIndicator');
    const busyText = document.getElementById('bpPdfBusyText');
    if (busyText) busyText.textContent = `Opening ${meta.name}...`;
    busy?.classList.remove('hidden');

    let openedOk = false;
    try {
      const [proxy] = await Promise.all([
        getOrLoadPdfProxy(meta.docId),
        syncDocOverlays(meta.docId)
      ]);
      bpState.activeDoc = meta;
      bpState.activePage = Math.min(Math.max(1, Number(pageNum) || 1), proxy.numPages || 1);
      await renderActivePageBase(true);
      updateViewerHeaderBar();
      openedOk = true;
    } catch (err) {
      notify(`Error opening PDF: ${err.message}`, 'error');
    } finally {
      if (!bpState.isScanningNow) {
        busy?.classList.add('hidden');
      }
    }

    // First-open automatic callout scan for all roles (runs strictly once per doc+page across all devices)
    if (openedOk && isAppOnline()) {
      scanActivePageForCallouts({ isManualRescan: false }).catch(() => {});
    }
  }

  async function renderActivePageBase(shouldFit = true) {
    const stage = document.getElementById('bpDrawingStage');
    const emptyEl = document.getElementById('bpEmptyViewportState');
    const baseCanvas = document.getElementById('bpPdfBaseCanvas');
    const detailCanvas = document.getElementById('bpPdfDetailCanvas');

    if (!bpState.activeDoc) {
      stage?.classList.add('hidden');
      emptyEl?.classList.remove('hidden');
      updateViewerHeaderBar();
      return;
    }

    stage?.classList.remove('hidden');
    emptyEl?.classList.add('hidden');
    detailCanvas?.classList.add('hidden');

    const serial = ++bpState.renderSerial;
    const proxy = await getOrLoadPdfProxy(bpState.activeDoc.docId);
    if (serial !== bpState.renderSerial) return;

    const page = await proxy.getPage(bpState.activePage);
    if (serial !== bpState.renderSerial) return;

    const unscaled = page.getViewport({ scale: 1 });
    bpState.stageW = unscaled.width;
    bpState.stageH = unscaled.height;

    stage.style.width = `${bpState.stageW}px`;
    stage.style.height = `${bpState.stageH}px`;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const maxSide = 4096;
    const targetScale = Math.min(
      dpr * bpState.qualityMultiplier * 1.5,
      maxSide / Math.max(bpState.stageW, bpState.stageH)
    );
    const vp = page.getViewport({ scale: Math.max(1, targetScale) });

    baseCanvas.width = Math.floor(vp.width);
    baseCanvas.height = Math.floor(vp.height);
    baseCanvas.style.width = `${bpState.stageW}px`;
    baseCanvas.style.height = `${bpState.stageH}px`;

    if (bpState.activeBaseRenderTask) {
      try { bpState.activeBaseRenderTask.cancel(); } catch {}
    }

    const ctx = baseCanvas.getContext('2d', { alpha: false });
    const renderTask = page.render({ canvasContext: ctx, viewport: vp });
    bpState.activeBaseRenderTask = renderTask;

    try {
      await renderTask.promise;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') throw err;
      return;
    }

    if (shouldFit) fitViewport('page');
    else applyStageTransform();

    renderCalloutOverlays();
    window.ACTBlueprintMeasure?.onPageRendered?.();
    updateViewerHeaderBar();
    scheduleViewportDetailRender();
  }

  function scheduleViewportDetailRender() {
    clearTimeout(bpState.detailDebounceTimer);
    if (!bpState.activeDoc || bpState.zoom <= 1.05 || !bpState.isOpen) {
      document.getElementById('bpPdfDetailCanvas')?.classList.add('hidden');
      return;
    }
    bpState.detailDebounceTimer = setTimeout(() => renderViewportDetailOverlay(), 140);
  }

  async function renderViewportDetailOverlay() {
    if (!bpState.activeDoc || bpState.zoom <= 1.05 || bpState.isInteracting || !bpState.isOpen) return;
    const viewport = document.getElementById('bpCanvasViewport');
    const detailCanvas = document.getElementById('bpPdfDetailCanvas');
    if (!viewport || !detailCanvas) return;

    const serial = ++bpState.detailRenderSerial;
    const proxy = await getOrLoadPdfProxy(bpState.activeDoc.docId);
    const page = await proxy.getPage(bpState.activePage);
    if (serial !== bpState.detailRenderSerial) return;

    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const margin = 0.2;

    const leftStage = Math.max(0, (-bpState.panX / bpState.zoom) - (vw / bpState.zoom) * margin);
    const topStage = Math.max(0, (-bpState.panY / bpState.zoom) - (vh / bpState.zoom) * margin);
    const rightStage = Math.min(bpState.stageW, ((-bpState.panX + vw) / bpState.zoom) + (vw / bpState.zoom) * margin);
    const bottomStage = Math.min(bpState.stageH, ((-bpState.panY + vh) / bpState.zoom) + (vh / bpState.zoom) * margin);

    const cropW = rightStage - leftStage;
    const cropH = bottomStage - topStage;
    if (cropW <= 10 || cropH <= 10) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const effScale = Math.min(bpState.zoom * dpr * bpState.qualityMultiplier, 4096 / Math.max(cropW, cropH));
    const outW = Math.floor(cropW * effScale);
    const outH = Math.floor(cropH * effScale);
    if (outW <= 0 || outH <= 0) return;

    const offscreen = document.createElement('canvas');
    offscreen.width = outW;
    offscreen.height = outH;

    const vp = page.getViewport({
      scale: effScale,
      offsetX: -leftStage * effScale,
      offsetY: -topStage * effScale
    });

    const task = page.render({ canvasContext: offscreen.getContext('2d', { alpha: false }), viewport: vp });
    try {
      await task.promise;
    } catch {
      return;
    }
    if (serial !== bpState.detailRenderSerial) return;

    detailCanvas.width = outW;
    detailCanvas.height = outH;
    detailCanvas.style.left = `${leftStage}px`;
    detailCanvas.style.top = `${topStage}px`;
    detailCanvas.style.width = `${cropW}px`;
    detailCanvas.style.height = `${cropH}px`;
    detailCanvas.getContext('2d').drawImage(offscreen, 0, 0);
    detailCanvas.classList.remove('hidden');
  }

  function fitViewport(mode = 'page') {
    const viewport = document.getElementById('bpCanvasViewport');
    if (!viewport || !bpState.stageW || !bpState.stageH) return;
    const pad = 24;
    const availW = Math.max(100, viewport.clientWidth - pad * 2);
    const availH = Math.max(100, viewport.clientHeight - pad * 2);
    const nextZoom = mode === 'width'
      ? availW / bpState.stageW
      : Math.min(availW / bpState.stageW, availH / bpState.stageH);
    bpState.zoom = Math.min(bpState.maxZoom, Math.max(bpState.minZoom, nextZoom));
    bpState.panX = (viewport.clientWidth - bpState.stageW * bpState.zoom) / 2;
    bpState.panY = (viewport.clientHeight - bpState.stageH * bpState.zoom) / 2;
    applyStageTransform();
    scheduleViewportDetailRender();
  }

  function applyStageTransform() {
    const stage = document.getElementById('bpDrawingStage');
    if (stage) {
      stage.style.transform = `translate3d(${bpState.panX}px, ${bpState.panY}px, 0) scale(${bpState.zoom})`;
    }
    const zoomLabel = document.getElementById('bpZoomPercentLabel');
    if (zoomLabel) zoomLabel.textContent = `${Math.round(bpState.zoom * 100)}%`;
    window.ACTBlueprintMeasure?.onTransformChanged?.(bpState.zoom);
  }

  function renderCalloutOverlays() {
    const layer = document.getElementById('bpCalloutOverlayLayer');
    if (!layer) return;
    layer.innerHTML = '';
    if (!bpState.activeDoc) return;
   

    const pageLinks = bpState.calloutLinks.filter(
      (l) => l.sourceDocId === bpState.activeDoc.docId && Number(l.sourcePage) === Number(bpState.activePage)
    );

    pageLinks.forEach((link) => {
      const badge = document.createElement('div');
      const colorCls = link.color === 'amber' ? 'bp-callout-amber'
        : link.color === 'emerald' ? 'bp-callout-emerald'
        : 'bp-callout-blue';
      badge.className = `bp-callout-badge ${colorCls}`;
      badge.style.left = `${(link.x * 100).toFixed(4)}%`;
      badge.style.top = `${(link.y * 100).toFixed(4)}%`;
      badge.style.width = `${((link.w || 0.018) * 100).toFixed(4)}%`;
      badge.style.height = `${((link.h || 0.026) * 100).toFixed(4)}%`;
      const autoTag = link.isAutoScanned ? ' [Auto-Scanned]' : '';
      badge.title = `${link.label}${link.detailTitle ? ` — ${link.detailTitle}` : ''} → ${link.targetDocName} (Pg ${link.targetPage})${autoTag}`;

      badge.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (bpState.addLinkMode && canEditCallouts()) {
          openCalloutModalForEdit(link);
          return;
        }
        await openBlueprintDocument(link.targetDocId, link.targetPage || 1, true, link);
      });
      layer.appendChild(badge);
    });
  }

  function bindViewportInteractions() {
    const viewport = document.getElementById('bpCanvasViewport');
    const rubberband = document.getElementById('bpCalloutRubberband');
    if (!viewport) return;

    const clientToNorm = (clientX, clientY) => {
      const rect = viewport.getBoundingClientRect();
      const stageX = (clientX - rect.left - bpState.panX) / bpState.zoom;
      const stageY = (clientY - rect.top - bpState.panY) / bpState.zoom;
      return {
        x: Math.max(0, Math.min(1, stageX / (bpState.stageW || 1))),
        y: Math.max(0, Math.min(1, stageY / (bpState.stageH || 1)))
      };
    };

    viewport.addEventListener('wheel', (e) => {
      if (!bpState.activeDoc || !bpState.isOpen) return;
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const nextZoom = Math.min(bpState.maxZoom, Math.max(bpState.minZoom, bpState.zoom * factor));
      bpState.panX = mx - (mx - bpState.panX) * (nextZoom / bpState.zoom);
      bpState.panY = my - (my - bpState.panY) * (nextZoom / bpState.zoom);
      bpState.zoom = nextZoom;
      applyStageTransform();
      scheduleViewportDetailRender();
    }, { passive: false });

    viewport.addEventListener('pointerdown', (e) => {
      if (!bpState.activeDoc || !bpState.isOpen) return;
      if (e.target.closest('.bp-callout-badge') || e.target.closest('button')) return;
      if (e.target.closest('[data-bp-measure-ui]') || e.target.closest('.bp-m-handle')) return;

      viewport.setPointerCapture(e.pointerId);
      bpState.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (bpState.addLinkMode && canEditCallouts() && bpState.activePointers.size === 1) {
        bpState.isDrawingCallout = true;
        const pt = clientToNorm(e.clientX, e.clientY);
        bpState.drawStartNormX = pt.x;
        bpState.drawStartNormY = pt.y;
        if (rubberband) {
          rubberband.style.left = `${pt.x * 100}%`;
          rubberband.style.top = `${pt.y * 100}%`;
          rubberband.style.width = '0%';
          rubberband.style.height = '0%';
          rubberband.classList.remove('hidden');
        }
        return;
      }

      if (bpState.activePointers.size === 1) {
        bpState.isDraggingPan = true;
        bpState.isInteracting = true;
        bpState.panStartX = e.clientX;
        bpState.panStartY = e.clientY;
        bpState.panOriginX = bpState.panX;
        bpState.panOriginY = bpState.panY;
        viewport.classList.replace('cursor-grab', 'cursor-grabbing');
      } else if (bpState.activePointers.size === 2) {
        bpState.isDraggingPan = false;
        const pts = Array.from(bpState.activePointers.values());
        bpState.pinchStartDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
        bpState.pinchStartZoom = bpState.zoom;
      }
    });

    viewport.addEventListener('pointermove', (e) => {
      if (!bpState.activePointers.has(e.pointerId)) return;
      bpState.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (bpState.isDrawingCallout) {
        const pt = clientToNorm(e.clientX, e.clientY);
        const x = Math.min(bpState.drawStartNormX, pt.x);
        const y = Math.min(bpState.drawStartNormY, pt.y);
        const w = Math.abs(pt.x - bpState.drawStartNormX);
        const h = Math.abs(pt.y - bpState.drawStartNormY);
        if (rubberband) {
          rubberband.style.left = `${x * 100}%`;
          rubberband.style.top = `${y * 100}%`;
          rubberband.style.width = `${w * 100}%`;
          rubberband.style.height = `${h * 100}%`;
        }
        return;
      }

      if (bpState.activePointers.size === 2) {
        const pts = Array.from(bpState.activePointers.values());
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        const rect = viewport.getBoundingClientRect();
        const vx = midX - rect.left;
        const vy = midY - rect.top;
        const nextZoom = Math.min(
          bpState.maxZoom,
          Math.max(bpState.minZoom, bpState.pinchStartZoom * (dist / bpState.pinchStartDist))
        );
        bpState.panX = vx - (vx - bpState.panX) * (nextZoom / bpState.zoom);
        bpState.panY = vy - (vy - bpState.panY) * (nextZoom / bpState.zoom);
        bpState.zoom = nextZoom;
        applyStageTransform();
        return;
      }

      if (bpState.isDraggingPan) {
        bpState.panX = bpState.panOriginX + (e.clientX - bpState.panStartX);
        bpState.panY = bpState.panOriginY + (e.clientY - bpState.panStartY);
        applyStageTransform();
      }
    });

    const endPointer = (e) => {
      bpState.activePointers.delete(e.pointerId);
      if (bpState.isDrawingCallout) {
        bpState.isDrawingCallout = false;
        rubberband?.classList.add('hidden');
        const pt = clientToNorm(e.clientX, e.clientY);
        const rawW = Math.abs(pt.x - bpState.drawStartNormX);
        const rawH = Math.abs(pt.y - bpState.drawStartNormY);
        const STANDARD_W = 0.018;
        const STANDARD_H = 0.026;

        let rect;
        if (rawW < 0.005 && rawH < 0.005) {
          rect = {
            x: Math.max(0, Math.min(1 - STANDARD_W, pt.x - STANDARD_W / 2)),
            y: Math.max(0, Math.min(1 - STANDARD_H, pt.y - STANDARD_H / 2)),
            w: STANDARD_W,
            h: STANDARD_H
          };
        } else {
          rect = {
            x: Math.min(bpState.drawStartNormX, pt.x),
            y: Math.min(bpState.drawStartNormY, pt.y),
            w: Math.max(0.005, rawW),
            h: Math.max(0.005, rawH)
          };
        }
        openCalloutModalForNewLink(rect);
      }

      if (bpState.activePointers.size === 0) {
        bpState.isDraggingPan = false;
        bpState.isInteracting = false;
        viewport.classList.replace('cursor-grabbing', 'cursor-grab');
        scheduleViewportDetailRender();
      }
    };

    viewport.addEventListener('pointerup', endPointer);
    viewport.addEventListener('pointercancel', endPointer);

    window.addEventListener('resize', () => {
      if (bpState.isOpen) {
        positionBlueprintsSection();
        if (bpState.activeDoc) scheduleViewportDetailRender();
      }
    });
  }

  // -----------------------------------------------------------------------
  // 9. DROPBOX BROWSER & OFFLINE LIBRARY MODAL UI
  // -----------------------------------------------------------------------
  function updateConnectionBadges() {
    const connected = bpState.dropboxConnected;
    const dot1 = document.getElementById('bpStatusDot');
    const dot2 = document.getElementById('bpModalDbxStatusDot');
    const sub = document.getElementById('bpModalDbxAccountSubtitle');
    const drawerBadge = document.getElementById('drawerDbxBpStatus');
    const adminBadge = document.getElementById('bpAdminConnBadge');
    const adminInfo = document.getElementById('bpAdminStatusInfo');
    const adminRootLbl = document.getElementById('bpAdminLockedRootLabel');
    const adminDiscBtn = document.getElementById('bpAdminDisconnectBtn');
    const adminClientInput = document.getElementById('bpAdminClientIdInput');
    const adminRedirInput = document.getElementById('bpAdminRedirectUriInput');
    const autoScanToggle = document.getElementById('bpAdminAutoScanToggle');
    const modelSelect = document.getElementById('bpAdminGeminiModelSelect');
    const scanModeSelect = document.getElementById('bpAdminScanModeSelect');

    if (adminRootLbl) adminRootLbl.textContent = getLockedRoot();
    if (adminRedirInput) adminRedirInput.value = DropboxProxy.getRedirectUri();
    if (autoScanToggle) autoScanToggle.checked = isAutoScanEnabled();
    if (modelSelect) modelSelect.value = getBlueprintModelPreference();
    if (scanModeSelect) scanModeSelect.value = getBlueprintScanMode();
    if (adminClientInput && !adminClientInput.value) {
      adminClientInput.value = bpState.dbxClientId || SafeStorage.get('bp_dbx_client_id_draft', '');
    }

    if (connected) {
      dot1?.classList.remove('bg-amber-300');
      dot1?.classList.add('bg-emerald-400');
      dot2?.classList.remove('bg-amber-400');
      dot2?.classList.add('bg-emerald-400');
      if (sub) sub.textContent = `Connected via Server Proxy • Locked to ${getLockedRoot()}`;
      if (drawerBadge) {
        drawerBadge.textContent = 'Synced';
        drawerBadge.className = 'text-[10px] text-emerald-400 font-mono font-bold';
      }
      if (adminBadge) {
        adminBadge.textContent = 'Connected';
        adminBadge.className = 'text-[11px] font-mono px-2.5 py-1 rounded-lg bg-emerald-950 text-emerald-300 border border-emerald-500/40 shrink-0';
      }
      if (adminInfo) {
        const ts = bpState.dbxUpdatedAt ? new Date(bpState.dbxUpdatedAt).toLocaleString() : 'Active';
        adminInfo.textContent = `Server-side Dropbox token is active (last refreshed: ${ts}). Re-authorizing below rotates the stored token for all devices.`;
      }
      adminDiscBtn?.classList.remove('hidden');
    } else {
      dot1?.classList.remove('bg-emerald-400');
      dot1?.classList.add('bg-amber-300');
      dot2?.classList.remove('bg-emerald-400');
      dot2?.classList.add('bg-amber-400');
      if (sub) {
        sub.textContent = isAdminUser()
          ? 'Not Connected • Click Admin Setup to authorize Dropbox'
          : 'Not Connected • Ask an ACT Administrator to connect Dropbox';
      }
      if (drawerBadge) {
        drawerBadge.textContent = 'Setup';
        drawerBadge.className = 'text-[10px] text-amber-400 font-mono font-bold';
      }
      if (adminBadge) {
        adminBadge.textContent = 'Not Connected';
        adminBadge.className = 'text-[11px] font-mono px-2.5 py-1 rounded-lg bg-slate-900 text-amber-400 shrink-0';
      }
      if (adminInfo) {
        adminInfo.textContent = bpState.pendingRedirectCode
          ? 'Redirect authorization code captured! Enter your 4-digit Admin PIN and click Connect below to finish.'
          : 'Not connected yet. Enter your Dropbox App Key and 4-digit Admin PIN below to authorize read-only access for all ACT users.';
      }
      adminDiscBtn?.classList.add('hidden');
    }
  }

  async function loadDropboxFolder(path = '') {
    const targetPath = clampPath(path);
    bpState.dbxPath = targetPath;

    const container = document.getElementById('bpDbxEntriesContainer');
    const crumbBar = document.getElementById('bpDbxBreadcrumbBar');

    if (crumbBar) {
      crumbBar.innerHTML = '';
      const lockedRoot = getLockedRoot();
      const parts = targetPath.split('/').filter(Boolean);
      let running = '';

      parts.forEach((seg) => {
        running += '/' + seg;
        const segPath = running;
        if (segPath.toLowerCase().length < lockedRoot.toLowerCase().length) return;
        if (crumbBar.children.length > 0) {
          const sep = document.createElement('span');
          sep.className = 'text-slate-400';
          sep.textContent = '/';
          crumbBar.appendChild(sep);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-900 shrink-0';
        btn.textContent = seg;
        btn.addEventListener('click', () => loadDropboxFolder(segPath));
        crumbBar.appendChild(btn);
      });
    }

    if (!isAppOnline()) {
      if (container) {
        container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">Device is offline. Switch to the <strong>Offline Saved PDFs</strong> tab above to view cached drawings.</div>`;
      }
      return;
    }

    if (container) {
      container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">Loading folder...</div>`;
    }

    try {
      const entries = await DropboxProxy.listFolder(targetPath);
      bpState.dbxEntries = entries;
      registerProjectSiblingFiles(entries, targetPath);
      renderDropboxEntries();
      updateViewerHeaderBar();
    } catch (err) {
      if (container) {
        container.innerHTML = `<div class="p-4 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">${escapeHtml(err.message)}</div>`;
      }
    }
  }

  function renderDropboxEntries() {
    const container = document.getElementById('bpDbxEntriesContainer');
    if (!container) return;

    const filtered = (bpState.dbxEntries || [])
      .filter((e) => e['.tag'] === 'folder' || (e['.tag'] === 'file' && e.name.toLowerCase().endsWith('.pdf')))
      .sort((a, b) => (a['.tag'] !== b['.tag']
        ? (a['.tag'] === 'folder' ? -1 : 1)
        : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));

    if (filtered.length === 0) {
      container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">No subfolders or PDF blueprints found in this folder.</div>`;
      return;
    }

    container.innerHTML = '';
    filtered.forEach((entry) => {
      const isFolder = entry['.tag'] === 'folder';
      const row = document.createElement('div');
      row.className = 'p-2.5 rounded-xl bg-white hover:bg-sky-50/60 border border-slate-200 flex items-center justify-between gap-2 cursor-pointer transition';

      if (isFolder) {
        row.innerHTML = `
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="text-amber-500 font-bold text-sm">📁</span>
            <span class="text-xs font-bold text-slate-900 truncate">${escapeHtml(entry.name)}</span>
          </div>
          <span class="text-xs text-slate-400">→</span>
        `;
        row.addEventListener('click', () => loadDropboxFolder(entry.path_display || entry.path_lower));
      } else {
        const docId = `dbx_${String(entry.path_lower || '').toLowerCase()}`;
        const isOff = bpState.offlineSets.has(docId);
        row.innerHTML = `
          <div class="flex items-center gap-2.5 min-w-0 flex-1">
            <span class="text-sky-600 font-bold text-sm">📄</span>
            <div class="min-w-0 flex-1">
              <div class="text-xs font-bold text-slate-900 truncate">${escapeHtml(entry.name)}</div>
              <div class="text-[10px] font-mono text-slate-500">${formatBytes(entry.size)} ${isOff ? '• Available Offline' : ''}</div>
            </div>
          </div>
          <button type="button" data-off-btn="1"
            class="px-2.5 py-1 rounded-lg text-[11px] font-bold border shrink-0 ${isOff ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'}">
            ${isOff ? '✓ Offline' : 'Make Offline'}
          </button>
        `;
        row.addEventListener('click', async (e) => {
          if (e.target.closest('[data-off-btn]')) return;
          document.getElementById('bpDropboxModal')?.classList.add('hidden');
          await openBlueprintDocument(docId, 1);
        });
        row.querySelector('[data-off-btn]')?.addEventListener('click', async (e) => {
          e.stopPropagation();
          const meta = bpState.projectFiles.get(docId);
          if (!meta) return;
          try {
            if (bpState.offlineSets.has(docId)) {
              await removeDocAndOverlaysOffline(docId);
            } else {
              await saveDocAndOverlaysOffline(meta, true);
            }
          } catch (err) {
            notify(err.message, 'error');
          }
          renderDropboxEntries();
          renderOfflineModalList();
          updateViewerHeaderBar();
        });
      }
      container.appendChild(row);
    });
  }

  function renderOfflineModalList() {
    const modalList = document.getElementById('bpModalPanelOffline');
    const docs = Array.from(bpState.offlineSets.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );
    const countEl = document.getElementById('bpModalOfflineCount');
    if (countEl) countEl.textContent = String(docs.length);

    if (!modalList) return;
    if (docs.length === 0) {
      modalList.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">No blueprints saved offline on this device yet.</div>`;
      return;
    }

    modalList.innerHTML = '';
    docs.forEach((doc) => {
      const row = document.createElement('div');
      row.className = 'p-2.5 rounded-xl bg-white hover:bg-sky-50/60 border border-slate-200 flex items-center justify-between gap-2 cursor-pointer transition';
      row.innerHTML = `
        <div class="min-w-0 flex-1">
          <div class="text-xs font-bold truncate text-slate-900">${escapeHtml(doc.name)}</div>
          <div class="text-[10px] font-mono text-slate-500">Offline Ready • ${formatBytes(doc.size)}</div>
        </div>
        <button type="button" data-rm-off="1"
          class="px-2 py-1 rounded-lg text-[10px] font-bold shrink-0 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200">
          Remove
        </button>
      `;
      row.addEventListener('click', async (e) => {
        if (e.target.closest('[data-rm-off]')) return;
        document.getElementById('bpDropboxModal')?.classList.add('hidden');
        await openBlueprintDocument(doc.docId, 1);
      });
      row.querySelector('[data-rm-off]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await removeDocAndOverlaysOffline(doc.docId);
        renderOfflineModalList();
        renderDropboxEntries();
        updateViewerHeaderBar();
      });
      modalList.appendChild(row);
    });
  }

  function openDropboxModal() {
    document.getElementById('bpDropboxModal')?.classList.remove('hidden');
    const adminBtn = document.getElementById('bpOpenAdminSetupShortcutBtn');
    if (adminBtn) adminBtn.classList.toggle('hidden', !isAdminUser());
    updateConnectionBadges();
    renderOfflineModalList();

    const startPath = bpState.dbxPath || getDocFolderPath(bpState.activeDoc) || getLockedRoot();
    loadDropboxFolder(startPath);
  }

  // -----------------------------------------------------------------------
  // 10. CALLOUT LINK MODAL (CURRENT-FOLDER-FIRST PICKER, ROLE-GUARDED)
  // -----------------------------------------------------------------------
  function setModalBadgeColor(color) {
    bpState.selectedBadgeColor = color || 'blue';
    document.querySelectorAll('.bp-callout-color-choice').forEach((btn) => {
      const active = btn.getAttribute('data-badge-color') === bpState.selectedBadgeColor;
      btn.className = active
        ? 'bp-callout-color-choice py-1.5 px-1 rounded-lg border-2 border-slate-900 bg-slate-900 text-white font-bold text-[10px]'
        : 'bp-callout-color-choice py-1.5 px-1 rounded-lg border border-slate-300 bg-white text-slate-700 font-bold text-[10px]';
    });
  }

  function updateSelectedTargetSummary() {
    const summaryEl = document.getElementById('bpSelectedTargetSummaryText');
    const folderEl = document.getElementById('bpSelectedTargetFolderText');
    const pageVal = Math.max(1, Number(document.getElementById('bpCalloutTargetPageInput')?.value) || 1);
    const selectedDoc = bpState.selectedTargetKey ? bpState.projectFiles.get(bpState.selectedTargetKey) : null;

    if (summaryEl) {
      summaryEl.textContent = selectedDoc ? `${selectedDoc.name} (Pg ${pageVal})` : 'None selected';
    }
    if (folderEl) {
      folderEl.textContent = selectedDoc && selectedDoc.dropboxPath ? getDocFolderPath(selectedDoc) : '';
    }
  }

  async function loadCalloutPickerFolder(folderPath) {
    const clamped = clampPath(folderPath);
    bpState.calloutPickerPath = clamped;
    const root = getLockedRoot();
    const activeDocFolder = getDocFolderPath(bpState.activeDoc);

    const pathLabel = document.getElementById('bpCalloutFolderPathLabel');
    const upBtn = document.getElementById('bpCalloutFolderUpBtn');
    const rootBtn = document.getElementById('bpCalloutFolderRootBtn');
    const resetBtn = document.getElementById('bpCalloutFolderResetToCurrentBtn');

    if (pathLabel) pathLabel.textContent = clamped || '/';

    const canGoUp = Boolean(clamped && clamped.toLowerCase() !== root.toLowerCase());
    upBtn?.classList.toggle('hidden', !canGoUp);
    rootBtn?.classList.toggle('hidden', !canGoUp);
    resetBtn?.classList.toggle('hidden', !(activeDocFolder && clamped.toLowerCase() !== activeDocFolder.toLowerCase()));

    if (!isAppOnline()) {
      const localMatches = Array.from(bpState.projectFiles.values()).filter((d) => {
        if (!d.dropboxPath) return true;
        return getDocFolderPath(d).toLowerCase() === clamped.toLowerCase();
      });
      bpState.calloutPickerEntries = localMatches.map((d) => ({
        '.tag': 'file',
        name: d.name,
        path_lower: d.dropboxPath || '',
        docId: d.docId,
        size: d.size || 0
      }));
      bpState.calloutPickerLoading = false;
      renderCalloutTargetCandidates();
      return;
    }

    const cacheKey = clamped.toLowerCase();
    if (bpState.folderCache.has(cacheKey)) {
      bpState.calloutPickerEntries = bpState.folderCache.get(cacheKey);
      bpState.calloutPickerLoading = false;
      renderCalloutTargetCandidates();
    } else {
      bpState.calloutPickerLoading = true;
      renderCalloutTargetCandidates();
    }

    try {
      const entries = await DropboxProxy.listFolder(clamped);
      registerProjectSiblingFiles(entries, clamped);
      if (bpState.calloutPickerPath.toLowerCase() === cacheKey) {
        bpState.calloutPickerEntries = entries;
        bpState.calloutPickerLoading = false;
        renderCalloutTargetCandidates();
      }
    } catch (err) {
      if (bpState.calloutPickerPath.toLowerCase() === cacheKey) {
        bpState.calloutPickerLoading = false;
        const listEl = document.getElementById('bpCalloutTargetListContainer');
        if (listEl) {
          listEl.innerHTML = `<div class="p-3 text-center text-[11px] text-rose-700">${escapeHtml(err.message)}</div>`;
        }
      }
    }
  }

  function renderCalloutTargetCandidates() {
    const listEl = document.getElementById('bpCalloutTargetListContainer');
    updateSelectedTargetSummary();
    if (!listEl) return;

    if (bpState.calloutPickerLoading) {
      listEl.innerHTML = `<div class="p-4 text-center text-[11px] text-slate-500">Loading folder...</div>`;
      return;
    }

    const q = (document.getElementById('bpTargetSearchInput')?.value || '').trim().toLowerCase();
    const items = (bpState.calloutPickerEntries || [])
      .filter((e) => e['.tag'] === 'folder' || (e['.tag'] === 'file' && e.name.toLowerCase().endsWith('.pdf')))
      .filter((e) => !q || e.name.toLowerCase().includes(q))
      .sort((a, b) => (a['.tag'] !== b['.tag']
        ? (a['.tag'] === 'folder' ? -1 : 1)
        : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));

    listEl.innerHTML = '';
    if (items.length === 0) {
      listEl.innerHTML = `<div class="p-3 text-center text-[11px] text-slate-500">No PDFs or subfolders found here. Use "↑ Up Folder" above to browse another folder.</div>`;
      return;
    }

    items.forEach((entry) => {
      const isFolder = entry['.tag'] === 'folder';
      const row = document.createElement('button');
      row.type = 'button';

      if (isFolder) {
        row.className = 'w-full text-left px-3 py-2 flex items-center justify-between gap-2 bg-amber-50/40 hover:bg-amber-50 text-slate-800 transition';
        row.innerHTML = `
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="text-amber-500 text-xs shrink-0">📁</span>
            <span class="text-xs font-bold truncate">${escapeHtml(entry.name)}</span>
          </div>
          <span class="text-[10px] font-semibold text-slate-500 shrink-0">Open →</span>
        `;
        row.addEventListener('click', () => {
          const inp = document.getElementById('bpTargetSearchInput');
          if (inp) inp.value = '';
          loadCalloutPickerFolder(entry.path_display || entry.path_lower);
        });
      } else {
        const docId = entry.docId || `dbx_${String(entry.path_lower || '').toLowerCase()}`;
        const isSelected = docId === bpState.selectedTargetKey;
        const isCurrent = bpState.activeDoc && docId === bpState.activeDoc.docId;
        const isOffline = bpState.offlineSets.has(docId);

        row.className = `w-full text-left px-3 py-2 flex items-center justify-between gap-2 transition ${
          isSelected ? 'bg-sky-100 text-sky-950 font-bold' : 'hover:bg-slate-50 text-slate-800'
        }`;
        row.innerHTML = `
          <div class="min-w-0 flex-1">
            <div class="text-xs truncate">📄 ${escapeHtml(entry.name)}</div>
            <div class="text-[10px] font-mono text-slate-500">${isOffline ? 'Offline Ready' : 'Dropbox'}${isCurrent ? ' • Current Sheet' : ''}</div>
          </div>
          ${isSelected ? '<span class="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-sky-600 text-white shrink-0">Selected</span>' : ''}
        `;
        row.addEventListener('click', () => {
          bpState.selectedTargetKey = docId;
          renderCalloutTargetCandidates();
        });
      }
      listEl.appendChild(row);
    });
  }

  function openCalloutModalForNewLink(normRect) {
    if (!canEditCallouts()) return;
    bpState.editingCalloutId = null;
    bpState.pendingRectNorm = normRect;
    bpState.selectedTargetKey = null;
    document.getElementById('bpCalloutModalTitle').textContent = 'Create Callout Link';
    document.getElementById('bpDeleteCalloutBtn')?.classList.add('hidden');
    const srcSub = document.getElementById('bpCalloutModalSourceSubtitle');
    if (srcSub && bpState.activeDoc) {
      srcSub.textContent = `From: ${bpState.activeDoc.name} (Page ${bpState.activePage})`;
    }
    document.getElementById('bpCalloutLabelInput').value = '';
    document.getElementById('bpCalloutDetailTitleInput').value = '';
    document.getElementById('bpCalloutTargetPageInput').value = '1';
    document.getElementById('bpTargetSearchInput').value = '';
    document.getElementById('bpSmartMatchBanner')?.classList.add('hidden');
    setModalBadgeColor('blue');
    document.getElementById('bpCalloutModal').classList.remove('hidden');

    loadCalloutPickerFolder(getDocFolderPath(bpState.activeDoc));
  }

  function openCalloutModalForEdit(link) {
    if (!canEditCallouts()) return;
    bpState.editingCalloutId = link.id;
    bpState.pendingRectNorm = { x: link.x, y: link.y, w: link.w || 0.018, h: link.h || 0.026 };
    bpState.selectedTargetKey = link.targetDocId;
    ensureDocMetaRegistered(link.targetDocId, link);
    document.getElementById('bpCalloutModalTitle').textContent = link.isAutoScanned
      ? 'Edit Auto-Scanned Callout Link'
      : 'Edit Callout Link';
    document.getElementById('bpDeleteCalloutBtn')?.classList.remove('hidden');
    const srcSub = document.getElementById('bpCalloutModalSourceSubtitle');
    if (srcSub && bpState.activeDoc) {
      srcSub.textContent = `From: ${bpState.activeDoc.name} (Page ${bpState.activePage})`;
    }
    document.getElementById('bpCalloutLabelInput').value = link.label || '';
    document.getElementById('bpCalloutDetailTitleInput').value = link.detailTitle || '';
    document.getElementById('bpCalloutTargetPageInput').value = String(link.targetPage || 1);
    document.getElementById('bpTargetSearchInput').value = '';
    document.getElementById('bpSmartMatchBanner')?.classList.add('hidden');
    setModalBadgeColor(link.color || 'blue');
    document.getElementById('bpCalloutModal').classList.remove('hidden');

    loadCalloutPickerFolder(getDocFolderPath(bpState.activeDoc));
  }

  function closeCalloutModal() {
    document.getElementById('bpCalloutModal')?.classList.add('hidden');
    document.getElementById('bpSmartMatchBanner')?.classList.add('hidden');
    bpState.pendingRectNorm = null;
    bpState.editingCalloutId = null;
  }

  async function deleteCalloutLinkById(linkId) {
    if (!canEditCallouts()) return;
    const existing = bpState.calloutLinks.find((l) => l.id === linkId);
    bpState.calloutLinks = bpState.calloutLinks.filter((l) => l.id !== linkId);
    SafeStorage.setJSON('prodraw_callout_links', bpState.calloutLinks);
    if (existing && bpState.offlineSets.has(existing.sourceDocId)) {
      const remaining = bpState.calloutLinks.filter((l) => l.sourceDocId === existing.sourceDocId);
      await ProDrawOfflineDB.saveOverlays(existing.sourceDocId, remaining);
    }
    try {
      await CalloutRepo.deleteLink(linkId);
    } catch (err) {
      notify(`Deleted locally (cloud sync pending): ${err.message}`, 'warning');
    }
    renderCalloutOverlays();
    notify('Callout link deleted.', 'info');
  }

  // -----------------------------------------------------------------------
  // 11. HEADER BAR, ROLE VISIBILITY & ACT LAYOUT MOUNTING
  // -----------------------------------------------------------------------
  function setAddLinkMode(enabled) {
    bpState.addLinkMode = Boolean(enabled) && canEditCallouts();
    const btn = document.getElementById('bpToggleAddLinkBtn');
    const banner = document.getElementById('bpAddLinkBanner');
    if (bpState.addLinkMode) {
      btn?.classList.add('bg-amber-500', 'text-slate-950');
      banner?.classList.remove('hidden');
      window.ACTBlueprintMeasure?.setActive?.(false);
    } else {
      btn?.classList.remove('bg-amber-500', 'text-slate-950');
      banner?.classList.add('hidden');
    }
  }

  function updateViewerHeaderBar() {
    const pillText = document.getElementById('bpActiveSheetPillText');
    const sourceTag = document.getElementById('bpActiveSetSourceTag');
    const stepper = document.getElementById('bpMultiPageStepperWrap');
    const pageInd = document.getElementById('bpMultiPageIndicatorText');
    const offPill = document.getElementById('bpOfflineBadgePill');
    const backBtn = document.getElementById('bpBackHistoryPillBtn');
    const backText = document.getElementById('bpBackHistoryPillText');
    const addLinkBtn = document.getElementById('bpToggleAddLinkBtn');

    if (addLinkBtn) {
      addLinkBtn.classList.toggle('hidden', !canEditCallouts());
    }
    if (!canEditCallouts() && bpState.addLinkMode) {
      setAddLinkMode(false);
    }
    updateRescanButtonUI();

    if (!bpState.activeDoc) {
      if (pillText) pillText.textContent = 'Select Blueprint...';
      if (sourceTag) sourceTag.textContent = 'PDF';
      stepper?.classList.add('hidden');
      offPill?.classList.add('hidden');
    } else {
      if (pillText) pillText.textContent = bpState.activeDoc.name;
      if (sourceTag) sourceTag.textContent = bpState.activeDoc.source === 'dropbox' ? 'DBX' : 'PDF';
      const total = bpState.activeDoc.numPages || 1;
      if (total > 1) {
        stepper?.classList.remove('hidden');
        stepper?.classList.add('flex');
        if (pageInd) pageInd.textContent = `${bpState.activePage}/${total}`;
      } else {
        stepper?.classList.add('hidden');
      }

      const isOff = bpState.offlineSets.has(bpState.activeDoc.docId);
      if (offPill) {
        offPill.classList.remove('hidden');
        offPill.textContent = isOff ? 'ON' : 'OFF';
        offPill.className = isOff
          ? 'text-[10px] font-mono uppercase px-1.5 py-0.2 rounded bg-emerald-500/25 text-emerald-300 border border-emerald-500/50'
          : 'text-[10px] font-mono uppercase px-1.5 py-0.2 rounded bg-slate-700 text-slate-300 border border-slate-600';
      }
    }

    if (bpState.historyStack.length > 0) {
      const prev = bpState.historyStack[bpState.historyStack.length - 1];
      backBtn?.classList.remove('hidden');
      backBtn?.classList.add('flex');
      if (backText) backText.textContent = `← Back to ${prev.doc.name} (Pg ${prev.page})`;
    } else {
      backBtn?.classList.add('hidden');
      backBtn?.classList.remove('flex');
    }
    window.ACTBlueprintMeasure?.onHeaderUpdated?.();
  }

  function positionBlueprintsSection() {
    const view = document.getElementById('viewBlueprints');
    const actHeader = document.querySelector('body > header');
    if (!view) return;
    const topPx = actHeader ? Math.round(actHeader.getBoundingClientRect().height) : 53;
    view.style.top = `${topPx}px`;
  }

  async function openBlueprintsView() {
    await ensureInitialized();
    bpState.isOpen = true;

    ['viewCrew', 'viewAdmin', 'viewOtherModule', 'viewPmPortal', 'roleWorkspaceQuickBar'].forEach((id) => {
      document.getElementById(id)?.classList.add('hidden');
    });

    const view = document.getElementById('viewBlueprints');
    positionBlueprintsSection();
    view?.classList.remove('hidden');
    document.body.classList.add('bp-viewer-open');

    const titleEl = document.getElementById('topBarPageTitle');
    if (titleEl) titleEl.textContent = 'Blueprints';

    if (typeof closeSideMenu === 'function') closeSideMenu();

    updateViewerHeaderBar();
    updateConnectionBadges();

    DropboxProxy.refreshStatus().catch(() => {});
    loadScannerSettingsFromSupabase().catch(() => {});
    if (getSupabase() && isAppOnline()) {
      CalloutRepo.fetchAllLinks()
        .then((allLinks) => {
          if (Array.isArray(allLinks)) {
            mergeLinksIntoState(allLinks);
            renderCalloutOverlays();
          }
        })
        .catch(() => {});
    }

    if (bpState.activeDoc) {
      fitViewport('page');
    }
  }

  function closeBlueprintsView() {
    bpState.isOpen = false;
    setAddLinkMode(false);
    window.ACTBlueprintMeasure?.onViewerClosed?.();
    document.getElementById('viewBlueprints')?.classList.add('hidden');
    document.getElementById('bpDropboxModal')?.classList.add('hidden');
    document.getElementById('bpCalloutModal')?.classList.add('hidden');
    document.body.classList.remove('bp-viewer-open');
    clearTimeout(bpState.detailDebounceTimer);
    if (bpState.activeBaseRenderTask) {
      try { bpState.activeBaseRenderTask.cancel(); } catch {}
    }
  }

  function openAdminDropboxSetupPage() {
    if (!isAdminUser()) {
      notify('Only Administrators can manage Dropbox connection setup.', 'warning');
      return;
    }
    closeBlueprintsView();
    document.getElementById('viewOtherModule')?.classList.add('hidden');
    document.getElementById('viewCrew')?.classList.add('hidden');
    document.getElementById('viewPmPortal')?.classList.add('hidden');
    document.getElementById('viewAdmin')?.classList.remove('hidden');

    document.querySelectorAll('[id^="adminPage_"]').forEach((el) => {
      el.classList.toggle('hidden', el.id !== 'adminPage_dropbox_setup');
    });
    document.querySelectorAll('[id^="navAdmin_"]').forEach((btn) => {
      const active = btn.id === 'navAdmin_dropbox_setup';
      btn.className = active
        ? 'w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 transition'
        : 'w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition';
    });

    const titleEl = document.getElementById('topBarPageTitle');
    if (titleEl) titleEl.textContent = 'Dropbox Blueprints Setup';

    const codeInp = document.getElementById('bpAdminDirectCodeInput');
    if (codeInp && bpState.pendingRedirectCode && !codeInp.value) {
      codeInp.value = bpState.pendingRedirectCode;
    }

    if (typeof closeSideMenu === 'function') closeSideMenu();
    ensureInitialized().then(() =>
      Promise.all([
        DropboxProxy.refreshStatus(),
        loadScannerSettingsFromSupabase()
      ])
    );
  }

  function copyTextToClipboard(text, successMsg) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      notify(successMsg, 'success');
    } catch {
      notify('Unable to copy automatically.', 'warning');
    }
  }

  // -----------------------------------------------------------------------
  // 12. UI EVENT BINDINGS
  // -----------------------------------------------------------------------
  function bindUIEvents() {
    // Open / Close Dropbox Browser Modal
    document.getElementById('bpOpenDropboxModalBtn')?.addEventListener('click', openDropboxModal);
    document.getElementById('bpActiveSheetPillBtn')?.addEventListener('click', openDropboxModal);
    document.getElementById('bpEmptyOpenDropboxBtn')?.addEventListener('click', openDropboxModal);
    document.getElementById('bpCloseDropboxModalBtn')?.addEventListener('click', () => {
      document.getElementById('bpDropboxModal')?.classList.add('hidden');
    });
    document.getElementById('bpOpenAdminSetupShortcutBtn')?.addEventListener('click', () => {
      document.getElementById('bpDropboxModal')?.classList.add('hidden');
      openAdminDropboxSetupPage();
    });

    // Dropbox Modal Tabs
    document.getElementById('bpModalTabDropboxBtn')?.addEventListener('click', () => {
      document.getElementById('bpModalPanelOffline')?.classList.add('hidden');
      document.getElementById('bpModalPanelDropbox')?.classList.remove('hidden');
      document.getElementById('bpModalTabDropboxBtn').className =
        'px-3 py-1.5 rounded-t-lg text-xs font-bold bg-white text-slate-900 border-t border-x border-slate-200';
      document.getElementById('bpModalTabOfflineBtn').className =
        'px-3 py-1.5 rounded-t-lg text-xs font-semibold text-slate-600 hover:text-slate-900';
    });
    document.getElementById('bpModalTabOfflineBtn')?.addEventListener('click', () => {
      renderOfflineModalList();
      document.getElementById('bpModalPanelDropbox')?.classList.add('hidden');
      document.getElementById('bpModalPanelOffline')?.classList.remove('hidden');
      document.getElementById('bpModalTabOfflineBtn').className =
        'px-3 py-1.5 rounded-t-lg text-xs font-bold bg-white text-slate-900 border-t border-x border-slate-200';
      document.getElementById('bpModalTabDropboxBtn').className =
        'px-3 py-1.5 rounded-t-lg text-xs font-semibold text-slate-600 hover:text-slate-900';
    });

    // Local PDF Import
    document.getElementById('bpOpenLocalPdfPickerBtn')?.addEventListener('click', () => {
      document.getElementById('bpLocalPdfInput')?.click();
    });
    document.getElementById('bpLocalPdfInput')?.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const docId = `local_${file.name}_${file.size}`;
        const meta = {
          docId,
          name: file.name,
          source: 'local',
          size: file.size,
          numPages: 1,
          isOffline: true
        };
        bpState.memoryBlobs.set(docId, buf);
        await ProDrawOfflineDB.saveDocument(meta, buf);
        bpState.offlineSets.set(docId, meta);
        bpState.projectFiles.set(docId, meta);
        document.getElementById('bpDropboxModal')?.classList.add('hidden');
        await openBlueprintDocument(docId, 1);
      }
      renderOfflineModalList();
      e.target.value = '';
    });

    // Offline Toggle
    document.getElementById('bpSaveOfflineBtn')?.addEventListener('click', async () => {
      if (!bpState.activeDoc) {
        notify('Open a blueprint first.', 'info');
        return;
      }
      try {
        if (bpState.offlineSets.has(bpState.activeDoc.docId)) {
          await removeDocAndOverlaysOffline(bpState.activeDoc.docId);
        } else {
          await saveDocAndOverlaysOffline(bpState.activeDoc, true);
        }
      } catch (err) {
        notify(err.message, 'error');
      }
      updateViewerHeaderBar();
      renderOfflineModalList();
      renderDropboxEntries();
    });

    // Admin-Only Manual Re-Scan Button
    document.getElementById('bpRescanPageBtn')?.addEventListener('click', () => {
      scanActivePageForCallouts({ isManualRescan: true });
    });

    // Zoom & Multi-Page Controls
    document.getElementById('bpZoomInBtn')?.addEventListener('click', () => {
      bpState.zoom = Math.min(bpState.maxZoom, bpState.zoom * 1.25);
      applyStageTransform();
      scheduleViewportDetailRender();
    });
    document.getElementById('bpZoomOutBtn')?.addEventListener('click', () => {
      bpState.zoom = Math.max(bpState.minZoom, bpState.zoom / 1.25);
      applyStageTransform();
      scheduleViewportDetailRender();
    });
    document.getElementById('bpZoomFitBtn')?.addEventListener('click', () => fitViewport('page'));

    document.getElementById('bpPrevPageBtn')?.addEventListener('click', async () => {
      if (!bpState.activeDoc || bpState.activePage <= 1) return;
      bpState.activePage -= 1;
      await renderActivePageBase(true);
      if (isAppOnline()) {
        scanActivePageForCallouts({ isManualRescan: false }).catch(() => {});
      }
    });
    document.getElementById('bpNextPageBtn')?.addEventListener('click', async () => {
      if (!bpState.activeDoc || bpState.activePage >= (bpState.activeDoc.numPages || 1)) return;
      bpState.activePage += 1;
      await renderActivePageBase(true);
      if (isAppOnline()) {
        scanActivePageForCallouts({ isManualRescan: false }).catch(() => {});
      }
    });

    // Add / Edit Callout Link Mode Toggle
    document.getElementById('bpToggleAddLinkBtn')?.addEventListener('click', () => {
      if (!canEditCallouts()) return;
      setAddLinkMode(!bpState.addLinkMode);
    });
    document.getElementById('bpCancelAddLinkBannerBtn')?.addEventListener('click', () => setAddLinkMode(false));

    // Back Navigation History Pill
    document.getElementById('bpBackHistoryPillBtn')?.addEventListener('click', async () => {
      if (bpState.historyStack.length === 0) return;
      const prev = bpState.historyStack.pop();
      bpState.activeDoc = prev.doc;
      bpState.activePage = prev.page;
      bpState.zoom = prev.zoom;
      bpState.panX = prev.panX;
      bpState.panY = prev.panY;
      await renderActivePageBase(false);
      applyStageTransform();
    });

    // Callout Link Modal Folder Navigation
    document.getElementById('bpCalloutFolderUpBtn')?.addEventListener('click', () => {
      const inp = document.getElementById('bpTargetSearchInput');
      if (inp) inp.value = '';
      loadCalloutPickerFolder(getParentFolderPath(bpState.calloutPickerPath));
    });
    document.getElementById('bpCalloutFolderRootBtn')?.addEventListener('click', () => {
      const inp = document.getElementById('bpTargetSearchInput');
      if (inp) inp.value = '';
      loadCalloutPickerFolder(getLockedRoot());
    });
    document.getElementById('bpCalloutFolderResetToCurrentBtn')?.addEventListener('click', () => {
      const inp = document.getElementById('bpTargetSearchInput');
      if (inp) inp.value = '';
      loadCalloutPickerFolder(getDocFolderPath(bpState.activeDoc));
    });

    // Smart Auto-Match on Callout Label Input
    document.getElementById('bpCalloutLabelInput')?.addEventListener('input', (e) => {
      const val = String(e.target.value || '').trim();
      const banner = document.getElementById('bpSmartMatchBanner');
      const bannerText = document.getElementById('bpSmartMatchBannerText');
      const sheetPart = val.includes('/') ? val.split('/').pop().trim() : val;
      const token = normalizeSheetToken(sheetPart);
      if (!token || token.length < 2) {
        banner?.classList.add('hidden');
        return;
      }

      const currentFolderPdfs = (bpState.calloutPickerEntries || [])
        .filter((entry) => entry['.tag'] === 'file' && entry.name.toLowerCase().endsWith('.pdf'))
        .map((entry) => bpState.projectFiles.get(entry.docId || `dbx_${String(entry.path_lower || '').toLowerCase()}`))
        .filter(Boolean);

      const match =
        currentFolderPdfs.find((d) => normalizeSheetToken(d.name.replace(/\.pdf$/i, '')).includes(token)) ||
        Array.from(bpState.projectFiles.values()).find((d) => normalizeSheetToken(d.name.replace(/\.pdf$/i, '')).includes(token));

      if (match) {
        bpState.selectedTargetKey = match.docId;
        if (bannerText) bannerText.textContent = `Auto-matched: ${match.name}`;
        banner?.classList.remove('hidden');
        renderCalloutTargetCandidates();
      } else {
        banner?.classList.add('hidden');
      }
    });

    document.getElementById('bpTargetSearchInput')?.addEventListener('input', renderCalloutTargetCandidates);
    document.getElementById('bpCalloutTargetPageInput')?.addEventListener('input', updateSelectedTargetSummary);
    document.querySelectorAll('.bp-callout-color-choice').forEach((btn) => {
      btn.addEventListener('click', () => setModalBadgeColor(btn.getAttribute('data-badge-color')));
    });

    document.getElementById('bpCloseCalloutModalBtn')?.addEventListener('click', closeCalloutModal);
    document.getElementById('bpCancelCalloutModalBtn')?.addEventListener('click', closeCalloutModal);
    document.getElementById('bpDeleteCalloutBtn')?.addEventListener('click', async () => {
      if (!bpState.editingCalloutId) return;
      const id = bpState.editingCalloutId;
      closeCalloutModal();
      await deleteCalloutLinkById(id);
    });
    document.getElementById('bpSaveCalloutModalBtn')?.addEventListener('click', async () => {
      if (!canEditCallouts() || !bpState.activeDoc || !bpState.pendingRectNorm) {
        closeCalloutModal();
        return;
      }
      const targetDoc = bpState.selectedTargetKey ? bpState.projectFiles.get(bpState.selectedTargetKey) : null;
      if (!targetDoc) {
        notify('Select a target PDF from the list first.', 'warning');
        return;
      }

      const targetPage = Math.max(1, Number(document.getElementById('bpCalloutTargetPageInput')?.value) || 1);
      const label = document.getElementById('bpCalloutLabelInput')?.value.trim() || targetDoc.name.replace(/\.pdf$/i, '');
      const detailTitle = document.getElementById('bpCalloutDetailTitleInput')?.value.trim() || '';

      const linkObj = {
        id: bpState.editingCalloutId || `link_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        sourceDocId: bpState.activeDoc.docId,
        sourcePath: bpState.activeDoc.dropboxPath || '',
        sourcePage: bpState.activePage,
        targetDocId: targetDoc.docId,
        targetPath: targetDoc.dropboxPath || '',
        targetDocName: targetDoc.name,
        targetPage,
        label,
        detailTitle,
        color: bpState.selectedBadgeColor || 'blue',
        x: bpState.pendingRectNorm.x,
        y: bpState.pendingRectNorm.y,
        w: bpState.pendingRectNorm.w,
        h: bpState.pendingRectNorm.h,
        isAutoScanned: false
      };

      bpState.calloutLinks = bpState.calloutLinks.filter((l) => l.id !== linkObj.id);
      bpState.calloutLinks.push(linkObj);
      SafeStorage.setJSON('prodraw_callout_links', bpState.calloutLinks);

      if (bpState.offlineSets.has(bpState.activeDoc.docId)) {
        const docLinks = bpState.calloutLinks.filter((l) => l.sourceDocId === bpState.activeDoc.docId);
        await ProDrawOfflineDB.saveOverlays(bpState.activeDoc.docId, docLinks);
      }

      let synced = false;
      try {
        synced = await CalloutRepo.upsertLink(linkObj);
      } catch (err) {
        notify(`Saved locally (cloud sync warning: ${err.message})`, 'warning');
      }

      renderCalloutOverlays();
      closeCalloutModal();
      notify(
        synced ? `Callout to "${targetDoc.name}" synced to Supabase!` : `Callout to "${targetDoc.name}" saved locally!`,
        'success'
      );
    });

    // Admin Dropbox Setup Page Events
    const showAdminErr = (msg) => {
      const el = document.getElementById('bpAdminErrorBanner');
      if (!el) return;
      if (!msg) {
        el.classList.add('hidden');
        el.textContent = '';
      } else {
        el.textContent = msg;
        el.classList.remove('hidden');
      }
    };

    document.getElementById('bpAdminStartDirectAuthBtn')?.addEventListener('click', async () => {
      showAdminErr('');
      try {
        await DropboxProxy.startAdminDirectCodeFlow();
      } catch (err) {
        showAdminErr(err.message);
      }
    });

    document.getElementById('bpAdminCompleteDirectBtn')?.addEventListener('click', async () => {
      showAdminErr('');
      const code = document.getElementById('bpAdminDirectCodeInput')?.value || '';
      const pin = document.getElementById('bpAdminVerifyPinInput')?.value || '';
      const usedRedirect = Boolean(bpState.pendingRedirectCode && code.trim() === bpState.pendingRedirectCode.trim());
      try {
        await DropboxProxy.exchangeAdminCode(code, pin, usedRedirect);
        const codeInp = document.getElementById('bpAdminDirectCodeInput');
        const pinInp = document.getElementById('bpAdminVerifyPinInput');
        if (codeInp) codeInp.value = '';
        if (pinInp) pinInp.value = '';
        notify('Dropbox connected & saved securely on server!', 'success');
      } catch (err) {
        showAdminErr(err.message);
      }
    });

    document.getElementById('bpAdminCopyRedirectUriBtn')?.addEventListener('click', () => {
      copyTextToClipboard(DropboxProxy.getRedirectUri(), 'Redirect URI copied!');
    });

    document.getElementById('bpAdminStartRedirectBtn')?.addEventListener('click', async () => {
      showAdminErr('');
      try {
        await DropboxProxy.startAdminRedirectFlow();
      } catch (err) {
        showAdminErr(err.message);
      }
    });

    document.getElementById('bpAdminDisconnectBtn')?.addEventListener('click', async () => {
      showAdminErr('');
      const pin = document.getElementById('bpAdminVerifyPinInput')?.value || '';
      try {
        await DropboxProxy.disconnectAdmin(pin);
        const pinInp = document.getElementById('bpAdminVerifyPinInput');
        if (pinInp) pinInp.value = '';
        notify('Dropbox disconnected on server.', 'info');
      } catch (err) {
        showAdminErr(err.message);
      }
    });

    document.getElementById('bpAdminAutoScanToggle')?.addEventListener('change', async (e) => {
      if (!isAdminUser()) return;
      const enabled = Boolean(e.target.checked);
      SafeStorage.set('bp_admin_autoscan_enabled', enabled ? 'true' : 'false');
      const synced = await saveScannerSettingsToSupabase();
      notify(
        enabled
          ? `First-open callout Auto-Scan enabled for all users${synced ? ' (synced to all devices)' : ''}.`
          : `First-open callout Auto-Scan paused${synced ? ' (synced to all devices)' : ''}. Admins can still use Re-Scan Links manually.`,
        'info'
      );
    });

    document.getElementById('bpAdminGeminiModelSelect')?.addEventListener('change', async (e) => {
      if (!isAdminUser()) return;
      const val = String(e.target.value || 'auto');
      SafeStorage.set('bp_admin_gemini_model', val);
      bpState.cachedBlueprintModel = null;
      const synced = await saveScannerSettingsToSupabase();
      notify(
        `Blueprint Callout AI Model set to: ${val === 'auto' ? 'Auto (Gemini 4 Best Available)' : val}${synced ? ' (synced to all devices)' : ''}`,
        'success'
      );
    });

    document.getElementById('bpAdminScanModeSelect')?.addEventListener('change', async (e) => {
      if (!isAdminUser()) return;
      const val = String(e.target.value || 'combined');
      SafeStorage.set('bp_admin_scan_mode', val);
      const synced = await saveScannerSettingsToSupabase();
      notify(`Blueprint Scan Engine Mode updated${synced ? ' & synced to all devices' : ''}.`, 'info');
    });
  }

  // -----------------------------------------------------------------------
  // 13. INITIALIZATION & CLEAN ACT HOOK WRAPPERS
  // -----------------------------------------------------------------------
  async function ensureInitialized() {
    if (bpState.initialized) return;
    bpState.initialized = true;

    bpState.calloutLinks = SafeStorage.getJSON('prodraw_callout_links', []);
    bindViewportInteractions();
    bindUIEvents();
    DropboxProxy.captureRedirectCodeOnBoot();

    const [offlineDocs, offlineOverlays] = await Promise.all([
      ProDrawOfflineDB.getAllDocuments(),
      ProDrawOfflineDB.getAllOverlays()
    ]);

    offlineDocs.forEach((d) => {
      d.isOffline = true;
      bpState.offlineSets.set(d.docId, d);
      bpState.projectFiles.set(d.docId, d);
    });
    offlineOverlays.forEach((entry) => {
      if (Array.isArray(entry.links)) {
        mergeLinksIntoState(entry.links);
      }
    });

    updateConnectionBadges();
    updateViewerHeaderBar();
    renderOfflineModalList();
  }

  function installActNavigationHooks() {
    const prevSelectMenu = window.selectMenuFeature;
    window.selectMenuFeature = function (featureKey) {
      if (featureKey === 'blueprints') {
        openBlueprintsView();
        return;
      }
      closeBlueprintsView();
      if (typeof prevSelectMenu === 'function') {
        return prevSelectMenu.apply(this, arguments);
      }
    };

    const prevOpenAdmin = window.openAdminPage;
    window.openAdminPage = function (pageKey) {
      if (pageKey === 'dropbox_setup') {
        openAdminDropboxSetupPage();
        return;
      }
      closeBlueprintsView();
      document.getElementById('adminPage_dropbox_setup')?.classList.add('hidden');
      const navBtn = document.getElementById('navAdmin_dropbox_setup');
      if (navBtn) {
        navBtn.className = 'w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition';
      }
      if (typeof prevOpenAdmin === 'function') {
        return prevOpenAdmin.apply(this, arguments);
      }
    };

    const prevPersonalCard = window.openMyPersonalCardView;
    if (typeof prevPersonalCard === 'function') {
      window.openMyPersonalCardView = function () {
        closeBlueprintsView();
        return prevPersonalCard.apply(this, arguments);
      };
    }

    const prevLogout = window.logoutUser;
    if (typeof prevLogout === 'function') {
      window.logoutUser = function () {
        closeBlueprintsView();
        return prevLogout.apply(this, arguments);
      };
    }

    const syncRoleControls = () => {
      const bpBtn = document.getElementById('menuFeatBlueprints');
      if (bpBtn) bpBtn.classList.remove('hidden');
      updateViewerHeaderBar();
      updateConnectionBadges();
    };

    const prevRefreshRole = window.refreshRoleUiVisibility;
    if (typeof prevRefreshRole === 'function') {
      window.refreshRoleUiVisibility = function () {
        const res = prevRefreshRole.apply(this, arguments);
        syncRoleControls();
        return res;
      };
    }

    const prevUpdateTopBar = window.updateTopBarIndicators;
    if (typeof prevUpdateTopBar === 'function') {
      window.updateTopBarIndicators = function () {
        const res = prevUpdateTopBar.apply(this, arguments);
        syncRoleControls();
        return res;
      };
    }

    syncRoleControls();
  }

 window.ACTBlueprints = {
    open: openBlueprintsView,
    close: closeBlueprintsView,
    openAdminSetup: openAdminDropboxSetupPage,
    rescanActivePage: () => scanActivePageForCallouts({ isManualRescan: true }),
    refreshStatus: () => DropboxProxy.refreshStatus(),
    _bridge: {
      getState: () => ({
        activeDoc: bpState.activeDoc,
        activePage: bpState.activePage,
        stageW: bpState.stageW,
        stageH: bpState.stageH,
        zoom: bpState.zoom,
        panX: bpState.panX,
        panY: bpState.panY,
        isOpen: bpState.isOpen,
        canCalibrate: canEditCallouts(),
        userName: getActiveUserDisplayName(),
        supabase: getSupabase(),
        isOnline: isAppOnline()
      }),
      disableAddLinkMode: () => setAddLinkMode(false),
      notify: (msg, type) => notify(msg, type)
    }
  };

  window.addEventListener('online', () => {
    updateConnectionBadges();
    DropboxProxy.refreshStatus().catch(() => {});
  });
  window.addEventListener('offline', () => {
    updateConnectionBadges();
  });

  installActNavigationHooks();
  ensureInitialized()
    .then(() => {
      setTimeout(() => {
        DropboxProxy.refreshStatus().catch(() => {});
      }, 350);
    })
    .catch((err) => console.error('ACT Blueprints init error:', err));
})();
