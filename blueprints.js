// ========================================================================= 
// ACT MASTER - BLUEPRINTS MODULE (blueprints.js)
// Zero-conflict drop-in PDF blueprint & cross-sheet callout viewer
// - All Dropbox calls route through Supabase Edge Function `dropbox-proxy`
// - Shared callout overlays sync via `supabaseClient` (`blueprint_callout_links`)
// - Offline PDFs + overlay snapshots + linked target sheets cached in IndexedDB
// - Role guards: Admin (setup + edit), PM/Supervisor (edit), Crew (view + offline)
// =========================================================================
(function () {
  'use strict';

  if (window.pdfjsLib && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  const LINKS_TABLE = 'blueprint_callout_links';
  const PROXY_FN = 'dropbox-proxy';
  const DEFAULT_LOCKED_ROOT = '/Current Jobs';

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

  function getAdminEmployeeId() {
    if (typeof activeCrewEmployeeId !== 'undefined' && activeCrewEmployeeId) {
      return activeCrewEmployeeId;
    }
    return isAdminUser() ? 'ADMIN' : '';
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
      } catch (err) {
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
      // Fast path: 4-hour temporary Dropbox CDN URL (no token exposed to browser)
      try {
        const linkRes = await invokeDropboxProxy({ action: 'get_temp_link', path: target });
        if (linkRes?.link) {
          const cdnRes = await fetch(linkRes.link);
          if (cdnRes.ok) {
            return await cdnRes.arrayBuffer();
          }
        }
      } catch {}

      // Binary fallback through Edge Function if CDN fetch fails
      const sb = getSupabase();
      const { data, error } = await sb.functions.invoke(PROXY_FN, {
        body: { action: 'download_file', path: target }
      });
      if (error) {
        throw new Error(await extractFunctionError(error));
      }
      if (data instanceof Blob) {
        return await data.arrayBuffer();
      }
      if (data instanceof ArrayBuffer) {
        return data;
      }
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
      if (res?.lockedRoot) bpState.lockedRoot = res.lockedRoot;
      bpState.dbxClientId = clientId;
      bpState.folderCache.clear();
      updateConnectionBadges();
      return res;
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
    },

    captureRedirectCodeOnBoot() {
      try {
        const url = new URL(window.location.href);
        const code = url.searchParams.get('code');
        const hasVerifier = Boolean(SafeStorage.get('bp_dbx_pkce_verifier', ''));
        if (code && hasVerifier) {
          bpState.pendingRedirectCode = code;
          url.searchParams.delete('code');
          url.searchParams.delete('state');
          url.searchParams.delete('error');
          url.searchParams.delete('error_description');
          window.history.replaceState({}, document.title, url.toString());
        }
      } catch {}
    }
  };

  // -----------------------------------------------------------------------
  // 6. SHARED CALLOUT OVERLAYS SERVICE (Via ACT's supabaseClient)
  // -----------------------------------------------------------------------
  const OverlayService = {
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
        h: Number(row.h) || 0.026
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
    async deleteLink(linkId) {
      const sb = getSupabase();
      if (!sb || !isAppOnline()) return false;
      const { error } = await sb.from(LINKS_TABLE).delete().eq('id', linkId);
      if (error) throw error;
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
        const remoteLinks = await OverlayService.fetchLinksForDoc(docId);
        if (Array.isArray(remoteLinks)) {
          mergeLinksIntoState(remoteLinks, docId);
          if (bpState.offlineSets.has(docId)) {
            await ProDrawOfflineDB.saveOverlays(docId, remoteLinks);
          }
          return remoteLinks;
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
    const pLower = dbxPath.toLowerCase();
    if (!pLower.startsWith(`${rootLower}/`) && pLower !== rootLower) {
      notify('Referenced drawing is outside the permitted folder.', 'warning');
      return null;
    }

    const fileName = fallbackLink?.targetDocName || dbxPath.split('/').pop() || 'Drawing.pdf';
    const synthesized = {
      docId: `dbx_${pLower}`,
      name: fileName,
      source: 'dropbox',
      dropboxPath: pLower,
      dropboxDisplayPath: dbxPath,
      size: 0,
      numPages: 1
    };
    bpState.projectFiles.set(synthesized.docId, synthesized);
    return synthesized;
  }

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
    if (!window.pdfjsLib) throw new Error('PDF.js engine failed to load.');

    const buf = await getDocumentBuffer(meta);
    if (!buf) throw new Error(`Could not retrieve PDF data for "${meta.name}".`);

    const loadingTask = window.pdfjsLib.getDocument({ data: buf.slice(0) });
    const proxy = await loadingTask.promise;
    meta.numPages = proxy.numPages || 1;
    bpState.pdfProxies.set(docId, proxy);
    return proxy;
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

    let linkedSavedCount = 0;
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
            linkedSavedCount += 1;
          }
        } catch {}
      }
    }

    const extraMsg = linkedSavedCount > 0
      ? ` + ${linkedSavedCount} linked sheet(s) & overlays saved offline!`
      : ` & ${docLinks.length} overlay(s) saved offline!`;
    notify(`"${docMeta.name}"${extraMsg}`, 'success');
  }

  async function removeDocAndOverlaysOffline(docId) {
    const meta = bpState.projectFiles.get(docId) || bpState.offlineSets.get(docId);
    await ProDrawOfflineDB.removeDocument(docId);
    if (meta) meta.isOffline = false;
    bpState.offlineSets.delete(docId);
    notify(`Removed "${meta?.name || 'drawing'}" from offline storage.`, 'info');
  }

  // -----------------------------------------------------------------------
  // 7. CONNECTION BADGES & ROLE PERMISSIONS UI
  // -----------------------------------------------------------------------
  function updateConnectionBadges() {
    const connected = bpState.dropboxConnected;
    const dot1 = document.getElementById('bpStatusDot');
    const dot2 = document.getElementById('bpModalDbxStatusDot');
    const sub = document.getElementById('bpModalDbxAccountSubtitle');
    const drawerBadge = document.getElementById('drawerDbxBpStatus');
    const adminBadge = document.getElementById('bpAdminConnBadge');
    const adminRootLbl = document.getElementById('bpAdminLockedRootLabel');
    const adminClientInp = document.getElementById('bpAdminClientIdInput');
    const adminRedirInp = document.getElementById('bpAdminRedirectUriInput');
    const adminDiscBtn = document.getElementById('bpAdminDisconnectBtn');
    const adminStatusInfo = document.getElementById('bpAdminStatusInfo');

    if (adminRootLbl) adminRootLbl.textContent = getLockedRoot();
    if (adminRedirInp) adminRedirInp.value = DropboxProxy.getRedirectUri();
    if (adminClientInp && !adminClientInp.value) {
      adminClientInp.value = bpState.dbxClientId || SafeStorage.get('bp_dbx_client_id_draft', '');
    }

    if (connected) {
      dot1?.classList.remove('bg-amber-300');
      dot1?.classList.add('bg-emerald-400');
      dot2?.classList.remove('bg-amber-400');
      dot2?.classList.add('bg-emerald-400');
      if (sub) sub.textContent = `Connected via Server Proxy • ${getLockedRoot()}`;
      if (drawerBadge) {
        drawerBadge.textContent = 'Synced';
        drawerBadge.className = 'text-[10px] text-emerald-400 font-mono font-bold';
      }
      if (adminBadge) {
        adminBadge.textContent = 'Connected (Server Proxy)';
        adminBadge.className = 'text-[11px] font-mono px-2.5 py-1 rounded-lg bg-emerald-950 text-emerald-300 border border-emerald-500/40 shrink-0';
      }
      adminDiscBtn?.classList.remove('hidden');
      if (adminStatusInfo) {
        const when = bpState.dbxUpdatedAt ? new Date(bpState.dbxUpdatedAt).toLocaleString() : 'Active';
        adminStatusInfo.textContent = `Tokens are stored server-side only (never sent to browsers). Last refreshed: ${when}`;
      }
    } else {
      dot1?.classList.remove('bg-emerald-400');
      dot1?.classList.add('bg-amber-300');
      dot2?.classList.remove('bg-emerald-400');
      dot2?.classList.add('bg-amber-400');
      if (sub) sub.textContent = 'Not Connected — Admin must authorize in Admin → Dropbox Blueprints Setup';
      if (drawerBadge) {
        drawerBadge.textContent = 'Setup';
        drawerBadge.className = 'text-[10px] text-amber-400 font-mono font-bold';
      }
      if (adminBadge) {
        adminBadge.textContent = 'Not Connected';
        adminBadge.className = 'text-[11px] font-mono px-2.5 py-1 rounded-lg bg-slate-900 text-amber-400 shrink-0';
      }
      adminDiscBtn?.classList.add('hidden');
      if (adminStatusInfo) {
        adminStatusInfo.textContent = 'Authorize once as an Admin below. All field devices will then browse blueprints automatically through Supabase Edge Functions.';
      }
    }
  }

  function applyRolePermissionsUI() {
    const editable = canEditCallouts();
    const admin = isAdminUser();

    const addEditBtn = document.getElementById('bpToggleAddLinkBtn');
    const addBanner = document.getElementById('bpAddLinkBanner');
    const adminSetupShortcut = document.getElementById('bpOpenAdminSetupShortcutBtn');

    if (!editable) {
      bpState.addLinkMode = false;
      addEditBtn?.classList.add('hidden');
      addEditBtn?.classList.remove('bg-amber-500', 'text-slate-950');
      addBanner?.classList.add('hidden');
    } else {
      addEditBtn?.classList.remove('hidden');
    }

    if (adminSetupShortcut) {
      adminSetupShortcut.classList.toggle('hidden', !admin);
    }

    // Blueprints tab in Side Menu is visible to ALL 4 roles (admin, pm, supervisor, crew)
    const menuBtn = document.getElementById('menuFeatBlueprints');
    if (menuBtn) {
      menuBtn.classList.remove('hidden');
    }
  }

  // -----------------------------------------------------------------------
  // 8. DROPBOX BROWSER & OFFLINE LIBRARY MODAL
  // -----------------------------------------------------------------------
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
        container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">You are currently offline. Switch to the <strong>Offline Saved PDFs</strong> tab above to open saved blueprints.</div>`;
      }
      return;
    }

    if (!bpState.dropboxConnected) {
      await DropboxProxy.refreshStatus();
    }

    if (!bpState.dropboxConnected) {
      if (container) {
        const msg = isAdminUser()
          ? `Dropbox is not connected yet. Open <strong>Admin → Dropbox Blueprints Setup</strong> to connect once for all devices.`
          : `Dropbox is not connected yet. Please ask an ACT Administrator to connect Dropbox in Admin Setup.`;
        container.innerHTML = `<div class="p-6 text-center text-xs text-slate-600">${msg}</div>`;
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
      .sort((a, b) =>
        a['.tag'] !== b['.tag']
          ? a['.tag'] === 'folder' ? -1 : 1
          : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );

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
        const docId = `dbx_${entry.path_lower}`;
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
            class="px-2.5 py-1 rounded-lg text-[11px] font-bold border shrink-0 ${
              isOff
                ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
            }">
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

  function openDropboxModal(overrideFolderPath = null) {
    document.getElementById('bpDropboxModal')?.classList.remove('hidden');
    applyRolePermissionsUI();
    updateConnectionBadges();
    renderOfflineModalList();

    if (!isAppOnline()) {
      document.getElementById('bpModalTabOfflineBtn')?.click();
      return;
    }

    const startPath = overrideFolderPath || bpState.dbxPath || getDocFolderPath(bpState.activeDoc) || '';
    loadDropboxFolder(startPath);
  }

  // -----------------------------------------------------------------------
  // 9. HIGH-DPI PDF VIEWER, PAN/PINCH-ZOOM & CALLOUT OVERLAYS
  // -----------------------------------------------------------------------
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

    try {
      const [proxy] = await Promise.all([
        getOrLoadPdfProxy(meta.docId),
        syncDocOverlays(meta.docId)
      ]);
      bpState.activeDoc = meta;
      bpState.activePage = Math.min(Math.max(1, Number(pageNum) || 1), proxy.numPages || 1);
      await renderActivePageBase(true);
      updateViewerHeaderBar();
    } catch (err) {
      notify(`Error opening PDF: ${err.message}`, 'error');
    } finally {
      busy?.classList.add('hidden');
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
    updateViewerHeaderBar();
    scheduleViewportDetailRender();
  }

  function scheduleViewportDetailRender() {
    clearTimeout(bpState.detailDebounceTimer);
    if (!bpState.isOpen || !bpState.activeDoc || bpState.zoom <= 1.05) {
      document.getElementById('bpPdfDetailCanvas')?.classList.add('hidden');
      return;
    }
    bpState.detailDebounceTimer = setTimeout(() => renderViewportDetailOverlay(), 140);
  }

  async function renderViewportDetailOverlay() {
    if (!bpState.isOpen || !bpState.activeDoc || bpState.zoom <= 1.05 || bpState.isInteracting) return;
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
  }

  function updateViewerHeaderBar() {
    const pillText = document.getElementById('bpActiveSheetPillText');
    const sourceTag = document.getElementById('bpActiveSetSourceTag');
    const stepper = document.getElementById('bpMultiPageStepperWrap');
    const pageInd = document.getElementById('bpMultiPageIndicatorText');
    const offLabel = document.getElementById('bpSaveOfflineLabel');
    const offPill = document.getElementById('bpOfflineBadgePill');
    const backBtn = document.getElementById('bpBackHistoryPillBtn');
    const backText = document.getElementById('bpBackHistoryPillText');

    if (!bpState.activeDoc) {
      if (pillText) pillText.textContent = 'Select Blueprint...';
      if (sourceTag) sourceTag.textContent = 'PDF';
      stepper?.classList.add('hidden');
      if (offLabel) offLabel.textContent = 'Available Offline';
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
  }

  async function toggleActiveDocOffline() {
    if (!bpState.activeDoc) {
      notify('Open a blueprint first.', 'info');
      return;
    }
    const docId = bpState.activeDoc.docId;
    try {
      if (bpState.offlineSets.has(docId)) {
        await removeDocAndOverlaysOffline(docId);
      } else {
        await saveDocAndOverlaysOffline(bpState.activeDoc, true);
      }
    } catch (err) {
      notify(err.message, 'error');
    }
    updateViewerHeaderBar();
    renderOfflineModalList();
    renderDropboxEntries();
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
      badge.title = `${link.label}${link.detailTitle ? ` — ${link.detailTitle}` : ''} → ${link.targetDocName} (Pg ${link.targetPage})`;

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
      if (!bpState.activeDoc) return;
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
      if (!bpState.activeDoc) return;
      if (e.target.closest('.bp-callout-badge') || e.target.closest('button')) return;

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
        positionBlueprintsViewport();
        if (bpState.activeDoc) scheduleViewportDetailRender();
      }
    });
  }

  // -----------------------------------------------------------------------
  // 10. CALLOUT LINK MODAL (CURRENT-FOLDER-FIRST TARGET PICKER)
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

    if (!bpState.dropboxConnected || !isAppOnline()) {
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
      .sort((a, b) =>
        a['.tag'] !== b['.tag']
          ? a['.tag'] === 'folder' ? -1 : 1
          : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );

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
        const docId = entry.docId || `dbx_${entry.path_lower}`;
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
    document.getElementById('bpCalloutModal')?.classList.remove('hidden');

    loadCalloutPickerFolder(getDocFolderPath(bpState.activeDoc));
  }

  function openCalloutModalForEdit(link) {
    if (!canEditCallouts()) return;
    bpState.editingCalloutId = link.id;
    bpState.pendingRectNorm = { x: link.x, y: link.y, w: link.w || 0.018, h: link.h || 0.026 };
    bpState.selectedTargetKey = link.targetDocId;
    ensureDocMetaRegistered(link.targetDocId, link);
    document.getElementById('bpCalloutModalTitle').textContent = 'Edit Callout Link';
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
    document.getElementById('bpCalloutModal')?.classList.remove('hidden');

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
      await OverlayService.deleteLink(linkId);
    } catch (err) {
      notify(`Deleted locally (cloud sync pending): ${err.message}`, 'warning');
    }
    renderCalloutOverlays();
    notify('Callout link deleted.', 'info');
  }

  // -----------------------------------------------------------------------
  // 11. ADMIN DROPBOX SETUP PAGE HANDLERS
  // -----------------------------------------------------------------------
  function setAdminSetupError(msg) {
    const el = document.getElementById('bpAdminErrorBanner');
    if (!el) return;
    if (!msg) {
      el.classList.add('hidden');
      el.textContent = '';
    } else {
      el.textContent = msg;
      el.classList.remove('hidden');
    }
  }

  async function refreshAdminSetupPage() {
    setAdminSetupError('');
    await DropboxProxy.refreshStatus();
    if (bpState.pendingRedirectCode) {
      const codeInp = document.getElementById('bpAdminDirectCodeInput');
      if (codeInp && !codeInp.value) codeInp.value = bpState.pendingRedirectCode;
      notify('Dropbox code received! Enter your Admin PIN and click Connect to finish.', 'info');
    }
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
      notify(successMsg || 'Copied!', 'success');
    } catch {
      notify('Copy failed—please copy manually.', 'warning');
    }
  }

  // -----------------------------------------------------------------------
  // 12. EVENT BINDINGS & VIEWPORT LIFECYCLE
  // -----------------------------------------------------------------------
  function positionBlueprintsViewport() {
    const viewEl = document.getElementById('viewBlueprints');
    if (!viewEl) return;
    const headerEl = document.querySelector('body > header');
    const topPx = headerEl ? Math.ceil(headerEl.getBoundingClientRect().height) : 53;
    viewEl.style.top = `${topPx}px`;
  }

  function bindAllEvents() {
    // Viewer toolbar & Dropbox modal
    document.getElementById('bpOpenDropboxModalBtn')?.addEventListener('click', () => openDropboxModal());
    document.getElementById('bpActiveSheetPillBtn')?.addEventListener('click', () => openDropboxModal());
    document.getElementById('bpEmptyOpenDropboxBtn')?.addEventListener('click', () => openDropboxModal());
    document.getElementById('bpCloseDropboxModalBtn')?.addEventListener('click', () => {
      document.getElementById('bpDropboxModal')?.classList.add('hidden');
    });
    document.getElementById('bpOpenAdminSetupShortcutBtn')?.addEventListener('click', () => {
      if (!isAdminUser()) return;
      document.getElementById('bpDropboxModal')?.classList.add('hidden');
      if (typeof window.openAdminPage === 'function') window.openAdminPage('dropbox_setup');
    });

    // Dropbox Modal tabs
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

    // Local PDF picker
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

    // Zoom, Page, Offline & History controls
    document.getElementById('bpSaveOfflineBtn')?.addEventListener('click', toggleActiveDocOffline);
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
    });
    document.getElementById('bpNextPageBtn')?.addEventListener('click', async () => {
      if (!bpState.activeDoc || bpState.activePage >= (bpState.activeDoc.numPages || 1)) return;
      bpState.activePage += 1;
      await renderActivePageBase(true);
    });

    document.getElementById('bpToggleAddLinkBtn')?.addEventListener('click', () => {
      if (!canEditCallouts()) {
        notify('Only Admins, Project Managers, and Supervisors can add or edit callout links.', 'warning');
        return;
      }
      bpState.addLinkMode = !bpState.addLinkMode;
      const btn = document.getElementById('bpToggleAddLinkBtn');
      const banner = document.getElementById('bpAddLinkBanner');
      if (bpState.addLinkMode) {
        btn?.classList.add('bg-amber-500', 'text-slate-950');
        banner?.classList.remove('hidden');
      } else {
        btn?.classList.remove('bg-amber-500', 'text-slate-950');
        banner?.classList.add('hidden');
      }
    });
    document.getElementById('bpCancelAddLinkBannerBtn')?.addEventListener('click', () => {
      bpState.addLinkMode = false;
      document.getElementById('bpToggleAddLinkBtn')?.classList.remove('bg-amber-500', 'text-slate-950');
      document.getElementById('bpAddLinkBanner')?.classList.add('hidden');
    });

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

    // Callout Modal Folder Navigation & Smart Label Match
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
    document.getElementById('bpTargetSearchInput')?.addEventListener('input', renderCalloutTargetCandidates);
    document.getElementById('bpCalloutTargetPageInput')?.addEventListener('input', updateSelectedTargetSummary);

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
        .map((entry) => bpState.projectFiles.get(entry.docId || `dbx_${entry.path_lower}`))
        .filter(Boolean);

      const match =
        currentFolderPdfs.find((d) => normalizeSheetToken(d.name.replace(/\.pdf$/i, '')).includes(token)) ||
        Array.from(bpState.projectFiles.values()).find((d) =>
          normalizeSheetToken(d.name.replace(/\.pdf$/i, '')).includes(token)
        );

      if (match) {
        bpState.selectedTargetKey = match.docId;
        if (bannerText) bannerText.textContent = `Auto-matched: ${match.name}`;
        banner?.classList.remove('hidden');
        renderCalloutTargetCandidates();
      } else {
        banner?.classList.add('hidden');
      }
    });

    document.querySelectorAll('.bp-callout-color-choice').forEach((btn) => {
      btn.addEventListener('click', () => setModalBadgeColor(btn.getAttribute('data-badge-color')));
    });
    document.getElementById('bpCloseCalloutModalBtn')?.addEventListener('click', closeCalloutModal);
    document.getElementById('bpCancelCalloutModalBtn')?.addEventListener('click', closeCalloutModal);
    document.getElementById('bpDeleteCalloutBtn')?.addEventListener('click', async () => {
      if (!bpState.editingCalloutId || !canEditCallouts()) return;
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
        notify('Please select a target PDF from the list first.', 'warning');
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
        h: bpState.pendingRectNorm.h
      };

      bpState.calloutLinks = bpState.calloutLinks.filter((l) => l.id !== linkObj.id);
      bpState.calloutLinks.push(linkObj);
      SafeStorage.setJSON('prodraw_callout_links', bpState.calloutLinks);

      if (bpState.offlineSets.has(bpState.activeDoc.docId)) {
        const docLinks = bpState.calloutLinks.filter((l) => l.sourceDocId === bpState.activeDoc.docId);
        await ProDrawOfflineDB.saveOverlays(bpState.activeDoc.docId, docLinks);
      }

      let syncedToCloud = false;
      try {
        syncedToCloud = await OverlayService.upsertLink(linkObj);
      } catch (err) {
        notify(`Saved locally (cloud sync warning: ${err.message})`, 'warning');
      }

      renderCalloutOverlays();
      closeCalloutModal();
      notify(
        syncedToCloud
          ? `Shared callout to "${targetDoc.name}" saved!`
          : `Callout link to "${targetDoc.name}" saved locally!`,
        'success'
      );
    });

    // Admin Dropbox Setup Page Events
    document.getElementById('bpAdminStartDirectAuthBtn')?.addEventListener('click', async () => {
      setAdminSetupError('');
      try {
        await DropboxProxy.startAdminDirectCodeFlow();
      } catch (err) {
        setAdminSetupError(err.message);
      }
    });
    document.getElementById('bpAdminCompleteDirectBtn')?.addEventListener('click', async () => {
      setAdminSetupError('');
      const code = document.getElementById('bpAdminDirectCodeInput')?.value || '';
      const pin = document.getElementById('bpAdminVerifyPinInput')?.value || '';
      const usedRedirect = SafeStorage.get('bp_dbx_used_redirect', '') === 'true';
      try {
        await DropboxProxy.exchangeAdminCode(code, pin, usedRedirect);
        const codeInp = document.getElementById('bpAdminDirectCodeInput');
        const pinInp = document.getElementById('bpAdminVerifyPinInput');
        if (codeInp) codeInp.value = '';
        if (pinInp) pinInp.value = '';
        notify('Dropbox connected & saved securely on server for all devices!', 'success');
      } catch (err) {
        setAdminSetupError(err.message);
      }
    });
    document.getElementById('bpAdminCopyRedirectUriBtn')?.addEventListener('click', () => {
      copyTextToClipboard(DropboxProxy.getRedirectUri(), 'Redirect URI copied!');
    });
    document.getElementById('bpAdminStartRedirectBtn')?.addEventListener('click', async () => {
      setAdminSetupError('');
      try {
        await DropboxProxy.startAdminRedirectFlow();
      } catch (err) {
        setAdminSetupError(err.message);
      }
    });
    document.getElementById('bpAdminDisconnectBtn')?.addEventListener('click', async () => {
      setAdminSetupError('');
      const pin = document.getElementById('bpAdminVerifyPinInput')?.value || '';
      try {
        await DropboxProxy.disconnectAdmin(pin);
        const pinInp = document.getElementById('bpAdminVerifyPinInput');
        if (pinInp) pinInp.value = '';
        notify('Dropbox disconnected on server.', 'info');
      } catch (err) {
        setAdminSetupError(err.message);
      }
    });
  }

  async function initOnce() {
    if (bpState.initialized) return;
    bpState.initialized = true;
    bpState.calloutLinks = SafeStorage.getJSON('prodraw_callout_links', []);

    DropboxProxy.captureRedirectCodeOnBoot();
    bindViewportInteractions();
    bindAllEvents();
    applyRolePermissionsUI();

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

    if (getSupabase() && isAppOnline()) {
      OverlayService.fetchAllLinks()
        .then((allLinks) => {
          if (Array.isArray(allLinks)) {
            mergeLinksIntoState(allLinks);
            renderCalloutOverlays();
          }
        })
        .catch(() => {});

      DropboxProxy.refreshStatus().catch(() => {});
    }

    renderOfflineModalList();
    updateViewerHeaderBar();
  }

  // -----------------------------------------------------------------------
  // 13. ACT LIFECYCLE HOOKS (Zero edits needed in app-core.js or pm-hub-roles.js)
  // -----------------------------------------------------------------------
  function setBlueprintsMenuActive(active) {
    const btn = document.getElementById('menuFeatBlueprints');
    if (!btn) return;
    btn.className = active
      ? 'w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-bold bg-sky-500/15 text-sky-400 border border-sky-500/30 transition'
      : 'w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition';
  }

  const ACTBlueprints = {
    async open(initialFolderPath = null) {
      await initOnce();
      bpState.isOpen = true;
      applyRolePermissionsUI();
      setBlueprintsMenuActive(true);

      document.getElementById('viewCrew')?.classList.add('hidden');
      document.getElementById('viewAdmin')?.classList.add('hidden');
      document.getElementById('viewOtherModule')?.classList.add('hidden');
      document.getElementById('viewPmPortal')?.classList.add('hidden');

      const titleEl = document.getElementById('topBarPageTitle');
      if (titleEl) titleEl.textContent = 'Blueprints';

      const viewEl = document.getElementById('viewBlueprints');
      if (viewEl) {
        positionBlueprintsViewport();
        viewEl.classList.remove('hidden');
      }
      document.body.classList.add('bp-viewer-open');

      if (typeof closeSideMenu === 'function') closeSideMenu();

      // Refresh status & shared overlays when opening
      if (isAppOnline()) {
        DropboxProxy.refreshStatus().catch(() => {});
        OverlayService.fetchAllLinks()
          .then((links) => {
            if (Array.isArray(links)) {
              mergeLinksIntoState(links);
              renderCalloutOverlays();
            }
          })
          .catch(() => {});
      }

      if (initialFolderPath) {
        openDropboxModal(initialFolderPath);
      } else if (bpState.activeDoc) {
        await renderActivePageBase(false);
        applyStageTransform();
      } else {
        updateViewerHeaderBar();
      }
    },

    onDeactivate() {
      if (!bpState.isOpen) return;
      bpState.isOpen = false;
      bpState.addLinkMode = false;
      clearTimeout(bpState.detailDebounceTimer);
      if (bpState.activeBaseRenderTask) {
        try { bpState.activeBaseRenderTask.cancel(); } catch {}
        bpState.activeBaseRenderTask = null;
      }
      document.getElementById('bpToggleAddLinkBtn')?.classList.remove('bg-amber-500', 'text-slate-950');
      document.getElementById('bpAddLinkBanner')?.classList.add('hidden');
      document.getElementById('bpDropboxModal')?.classList.add('hidden');
      document.getElementById('bpCalloutModal')?.classList.add('hidden');
      document.getElementById('viewBlueprints')?.classList.add('hidden');
      document.body.classList.remove('bp-viewer-open');
      setBlueprintsMenuActive(false);
    },

    refreshPermissions() {
      applyRolePermissionsUI();
      updateConnectionBadges();
    },

    async openAdminSetup() {
      if (!isAdminUser()) {
        notify('Only Administrators can access Dropbox Setup.', 'warning');
        return;
      }
      await initOnce();
      ACTBlueprints.onDeactivate();
      document.getElementById('viewPmPortal')?.classList.add('hidden');
      document.getElementById('viewOtherModule')?.classList.add('hidden');
      document.getElementById('viewCrew')?.classList.add('hidden');
      document.getElementById('viewAdmin')?.classList.remove('hidden');

      const allPages = [
        'reconcile', 'employees', 'jobs', 'statement_csv', 'batch_receipts',
        'supabase_sage', 'ocr_key', 'export_csv', 'network', 'reset_data', 'dropbox_setup'
      ];
      allPages.forEach((k) => {
        document.getElementById(`adminPage_${k}`)?.classList.toggle('hidden', k !== 'dropbox_setup');
        const navBtn = document.getElementById(`navAdmin_${k}`);
        if (navBtn) {
          navBtn.className = k === 'dropbox_setup'
            ? 'w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 transition'
            : 'w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition';
        }
      });

      const titleEl = document.getElementById('topBarPageTitle');
      if (titleEl) titleEl.textContent = 'Dropbox Blueprints Setup';
      if (typeof closeSideMenu === 'function') closeSideMenu();
      await refreshAdminSetupPage();
    }
  };

  window.ACTBlueprints = ACTBlueprints;

  // Wrap ACT navigation & role functions cleanly
  const _origSelectMenuFeature = window.selectMenuFeature;
  window.selectMenuFeature = function (featureKey) {
    if (featureKey === 'blueprints') {
      ACTBlueprints.open();
      return;
    }
    ACTBlueprints.onDeactivate();
    if (typeof _origSelectMenuFeature === 'function') {
      _origSelectMenuFeature.apply(this, arguments);
    }
  };

  const _origOpenAdminPage = window.openAdminPage;
  window.openAdminPage = function (pageKey) {
    if (pageKey === 'dropbox_setup') {
      ACTBlueprints.openAdminSetup();
      return;
    }
    ACTBlueprints.onDeactivate();
    document.getElementById('adminPage_dropbox_setup')?.classList.add('hidden');
    const navBtn = document.getElementById('navAdmin_dropbox_setup');
    if (navBtn) {
      navBtn.className = 'w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition';
    }
    if (typeof _origOpenAdminPage === 'function') {
      _origOpenAdminPage.apply(this, arguments);
    }
  };

  const _origOpenMyPersonalCardView = window.openMyPersonalCardView;
  if (typeof _origOpenMyPersonalCardView === 'function') {
    window.openMyPersonalCardView = function () {
      ACTBlueprints.onDeactivate();
      return _origOpenMyPersonalCardView.apply(this, arguments);
    };
  }

  const _origLogoutUser = window.logoutUser;
  if (typeof _origLogoutUser === 'function') {
    window.logoutUser = function () {
      ACTBlueprints.onDeactivate();
      return _origLogoutUser.apply(this, arguments);
    };
  }

  const _origRefreshRoleUiVisibility = window.refreshRoleUiVisibility;
  if (typeof _origRefreshRoleUiVisibility === 'function') {
    window.refreshRoleUiVisibility = function () {
      const res = _origRefreshRoleUiVisibility.apply(this, arguments);
      ACTBlueprints.refreshPermissions();
      return res;
    };
  }

  // Boot lazily after DOM is ready
  window.addEventListener('load', () => {
    initOnce().catch((err) => console.warn('ACTBlueprints init warning:', err));
  });
})();
