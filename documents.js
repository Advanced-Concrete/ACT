// =========================================================================
// ACT MASTER - COMPANY DOCUMENTS MODULE (documents.js)
// Zero-conflict drop-in company document library (Handbook, Insurance, Safety, etc.)
// - Files stored in Supabase Storage bucket `company-documents`
// - Metadata synced via `company_documents` table
// - Role guards:
//     Admin:                Upload, Edit, Delete, View & Download
//     PM / Supv / Crew:     View & Download only
// - Compact single-row list UI (tap row to open in built-in PDF.js/image viewer)
// =========================================================================
(function initACTDocuments() {
  'use strict';

  if (window.pdfjsLib && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  const DOCS_TABLE = 'company_documents';
  const STORAGE_BUCKET = 'company-documents';
  const CACHE_KEY = 'act_company_docs_list_v1';
  const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

  const CATEGORIES = [
    'Handbook',
    'Insurance',
    'Safety',
    'Benefits',
    'Forms',
    'Other'
  ];

  const CATEGORY_BADGES = {
    Handbook:  'bg-sky-500/20 text-sky-300 border-sky-400/40',
    Insurance: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40',
    Safety:    'bg-amber-500/20 text-amber-300 border-amber-400/40',
    Benefits:  'bg-violet-500/20 text-violet-300 border-violet-400/40',
    Forms:     'bg-cyan-500/20 text-cyan-300 border-cyan-400/40',
    Other:     'bg-slate-600/30 text-slate-300 border-slate-500/40'
  };

  const docState = {
    isOpen: false,
    docs: [],
    loading: false,
    errorMsg: '',
    activeCategory: 'All',
    searchQuery: '',
    editingDocId: null,
    viewerRenderSerial: 0,
    activeObjectUrls: []
  };

  // =========================================================================
  // 1. SAFE ACT BRIDGES & HELPERS
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

  function toast(msg, isError = false) {
    if (typeof showSimpleToast === 'function') {
      showSimpleToast(msg, isError);
    } else {
      console.log(`[Documents${isError ? ' Error' : ''}]`, msg);
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

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return '0 KB';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDateShort(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function sanitizeFileName(name) {
    return String(name || 'document')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 120) || 'document';
  }

  function getFileKind(doc) {
    const mime = String(doc.mime_type || '').toLowerCase();
    const fname = String(doc.file_name || '').toLowerCase();
    if (mime === 'application/pdf' || fname.endsWith('.pdf')) {
      return { kind: 'pdf', badge: 'PDF', cls: 'bg-rose-500/20 text-rose-300 border-rose-400/40' };
    }
    if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(fname)) {
      return { kind: 'image', badge: 'IMG', cls: 'bg-sky-500/20 text-sky-300 border-sky-400/40' };
    }
    if (/\.(docx?|rtf)$/i.test(fname)) {
      return { kind: 'other', badge: 'DOC', cls: 'bg-blue-500/20 text-blue-300 border-blue-400/40' };
    }
    if (/\.(xlsx?|csv)$/i.test(fname)) {
      return { kind: 'other', badge: 'XLS', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40' };
    }
    return { kind: 'other', badge: 'FILE', cls: 'bg-slate-700 text-slate-200 border-slate-500/50' };
  }

  function revokeActiveObjectUrls() {
    docState.activeObjectUrls.forEach((u) => {
      try { URL.revokeObjectURL(u); } catch {}
    });
    docState.activeObjectUrls = [];
  }

  // =========================================================================
  // 2. SUPABASE DATA & STORAGE OPERATIONS
  // =========================================================================
  async function loadDocuments(force = false) {
    const sb = getSupabase();
    if (!force && docState.docs.length === 0) {
      const cached = loadJSON(CACHE_KEY, []);
      if (Array.isArray(cached) && cached.length > 0) {
        docState.docs = cached;
        renderDocumentsBody();
      }
    }

    if (!sb || !isAppOnline()) {
      docState.loading = false;
      renderDocumentsBody();
      return;
    }

    docState.loading = true;
    docState.errorMsg = '';
    renderDocumentsBody();

    try {
      const { data, error } = await sb
        .from(DOCS_TABLE)
        .select('*')
        .order('category', { ascending: true })
        .order('title', { ascending: true });

      if (error) throw error;
      docState.docs = Array.isArray(data) ? data : [];
      saveJSON(CACHE_KEY, docState.docs);
    } catch (err) {
      docState.errorMsg = err.message || 'Could not load company documents.';
    } finally {
      docState.loading = false;
      renderDocumentsBody();
    }
  }

  async function createSignedUrlForDoc(storagePath) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase client not configured.');
    const { data, error } = await sb.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, 3600);
    if (error || !data?.signedUrl) {
      throw new Error(error?.message || 'Could not generate file link.');
    }
    return data.signedUrl;
  }

  async function downloadBlobForDoc(storagePath) {
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase client not configured.');
    const { data, error } = await sb.storage.from(STORAGE_BUCKET).download(storagePath);
    if (error || !data) {
      throw new Error(error?.message || 'Could not download document.');
    }
    return data;
  }

  async function saveDocumentFromForm({ id, title, category, description, file }) {
    if (!isAdminUser()) throw new Error('Only Administrators can upload or edit documents.');
    const sb = getSupabase();
    if (!sb || !isAppOnline()) throw new Error('Must be online to upload documents.');

    const existing = id ? docState.docs.find((d) => d.id === id) : null;
    if (!existing && !file) {
      throw new Error('Choose a file to upload.');
    }
    if (file && file.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large (${formatBytes(file.size)}). Maximum size is 25 MB.`);
    }

    let storagePath = existing?.storage_path || '';
    let fileName = existing?.file_name || '';
    let mimeType = existing?.mime_type || 'application/octet-stream';
    let fileSize = existing?.file_size || 0;
    let newlyUploadedPath = '';
    const oldStoragePathToReplace = existing && file ? existing.storage_path : '';

    if (file) {
      const cleanName = sanitizeFileName(file.name);
      const uniquePath = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${cleanName}`;
      const { error: uploadErr } = await sb.storage
        .from(STORAGE_BUCKET)
        .upload(uniquePath, file, {
          contentType: file.type || 'application/octet-stream',
          upsert: false
        });
      if (uploadErr) {
        throw new Error(`Upload failed: ${uploadErr.message}`);
      }
      newlyUploadedPath = uniquePath;
      storagePath = uniquePath;
      fileName = file.name;
      mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
      fileSize = file.size || 0;
    }

    const nowIso = new Date().toISOString();
    const record = {
      id: existing?.id || `doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: title.trim(),
      category: CATEGORIES.includes(category) ? category : 'Other',
      description: description.trim(),
      file_name: fileName,
      storage_path: storagePath,
      mime_type: mimeType,
      file_size: fileSize,
      uploaded_by: existing?.uploaded_by || getActiveUserDisplayName(),
      created_at: existing?.created_at || nowIso,
      updated_at: nowIso
    };

    const { error: dbErr } = await sb.from(DOCS_TABLE).upsert(record);
    if (dbErr) {
      if (newlyUploadedPath) {
        sb.storage.from(STORAGE_BUCKET).remove([newlyUploadedPath]).catch(() => {});
      }
      throw new Error(`Database save failed: ${dbErr.message}`);
    }

    if (oldStoragePathToReplace && oldStoragePathToReplace !== storagePath) {
      sb.storage.from(STORAGE_BUCKET).remove([oldStoragePathToReplace]).catch(() => {});
    }

    return record;
  }

  async function deleteDocumentById(docId) {
    if (!isAdminUser()) {
      toast('Only Administrators can delete company documents.', true);
      return;
    }
    const sb = getSupabase();
    if (!sb || !isAppOnline()) {
      toast('Must be online to delete documents.', true);
      return;
    }

    const target = docState.docs.find((d) => d.id === docId);
    if (!target) return;

    if (!confirm(`Delete "${target.title}" for all employees? This cannot be undone.`)) {
      return;
    }

    try {
      const { error: dbErr } = await sb.from(DOCS_TABLE).delete().eq('id', docId);
      if (dbErr) throw dbErr;

      if (target.storage_path) {
        await sb.storage.from(STORAGE_BUCKET).remove([target.storage_path]).catch(() => {});
      }

      docState.docs = docState.docs.filter((d) => d.id !== docId);
      saveJSON(CACHE_KEY, docState.docs);
      renderDocumentsBody();
      toast(`Deleted "${target.title}".`, false);
    } catch (err) {
      toast(`Delete failed: ${err.message}`, true);
    }
  }

  // =========================================================================
  // 3. DOM INJECTION (SIDE MENU + MAIN VIEW + VIEWER & UPLOAD MODALS)
  // =========================================================================
  function injectStyles() {
    if (document.getElementById('actDocsStyles')) return;
    const style = document.createElement('style');
    style.id = 'actDocsStyles';
    style.textContent = `
      .act-docs-no-scrollbar::-webkit-scrollbar { display: none; }
      .act-docs-no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      #viewCompanyDocuments {
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }
    `;
    document.head.appendChild(style);
  }

  function ensureMenuButton() {
    let btn = document.getElementById('menuFeatDocuments');
    if (!btn) {
      const anchor =
        document.getElementById('menuFeatCalendar') ||
        document.getElementById('menuFeatBlueprints');
      if (!anchor || !anchor.parentNode) return null;

      btn = document.createElement('button');
      btn.id = 'menuFeatDocuments';
      btn.type = 'button';
      btn.className = anchor.className.replace(/\bhidden\b/g, '').trim();
      btn.innerHTML = `
        <span class="flex items-center gap-2.5 min-w-0">
          <span class="text-base leading-none">📄</span>
          <span class="truncate">Company Docs</span>
        </span>
        <span class="text-[10px] font-mono text-slate-400">PDF</span>
      `;
      btn.addEventListener('click', () => {
        if (typeof window.selectMenuFeature === 'function') {
          window.selectMenuFeature('documents');
        } else {
          openDocumentsView();
        }
      });

      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    }

    btn.classList.remove('hidden');
    return btn;
  }

  function positionDocumentsSection() {
    const view = document.getElementById('viewCompanyDocuments');
    const actHeader = document.querySelector('body > header');
    if (!view) return;
    const topPx = actHeader ? Math.round(actHeader.getBoundingClientRect().height) : 53;
    view.style.top = `${topPx}px`;
  }

  function ensureDocumentsView() {
    injectStyles();
    let view = document.getElementById('viewCompanyDocuments');
    if (view) return view;

    view = document.createElement('section');
    view.id = 'viewCompanyDocuments';
    view.className =
      'hidden fixed inset-x-0 bottom-0 z-30 bg-slate-950 text-slate-100 flex flex-col overflow-hidden';
    view.innerHTML = `
      <div id="actDocsToolbar" class="shrink-0 bg-slate-900/95 border-b border-slate-800 px-3 py-2 space-y-2"></div>
      <div id="actDocsBody" class="flex-1 min-h-0 overflow-y-auto p-2.5 sm:p-4"></div>
    `;
    document.body.appendChild(view);

    window.addEventListener('resize', () => {
      if (docState.isOpen) positionDocumentsSection();
    });

    return view;
  }

  function ensureViewerModal() {
    if (document.getElementById('actDocsViewerModal')) return;
    const modal = document.createElement('div');
    modal.id = 'actDocsViewerModal';
    modal.className =
      'hidden fixed inset-0 z-[92] bg-slate-950/95 flex flex-col overflow-hidden text-slate-100';
    modal.innerHTML = `
      <div class="shrink-0 bg-slate-900 border-b border-slate-800 px-3 py-2 flex items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div id="actDocsViewerTitle" class="text-sm font-extrabold text-white truncate"></div>
          <div id="actDocsViewerSub" class="text-[11px] text-slate-400 truncate"></div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button id="actDocsViewerDownloadBtn" type="button"
            class="h-8 px-3 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-extrabold flex items-center gap-1">
            <span>↓</span><span>Download</span>
          </button>
          <button id="actDocsViewerCloseBtn" type="button"
            class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-lg leading-none text-slate-200 flex items-center justify-center">&times;</button>
        </div>
      </div>
      <div id="actDocsViewerBody" class="flex-1 min-h-0 overflow-y-auto p-3 sm:p-5 flex flex-col items-center gap-3"></div>
    `;
    document.body.appendChild(modal);

    document.getElementById('actDocsViewerCloseBtn').onclick = closeViewerModal;
  }

  function ensureUploadModal() {
    if (document.getElementById('actDocsUploadModal')) return;
    const modal = document.createElement('div');
    modal.id = 'actDocsUploadModal';
    modal.className =
      'hidden fixed inset-0 z-[94] bg-slate-950/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4';
    modal.innerHTML = `
      <div class="w-full max-w-md rounded-t-2xl sm:rounded-xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden text-slate-100">
        <div class="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div>
            <h3 id="actDocsUploadHeading" class="text-base font-extrabold text-white">Upload Company Document</h3>
            <p class="text-[11px] text-slate-400">Visible to all employees (read-only)</p>
          </div>
          <button id="actDocsUploadCloseBtn" type="button"
            class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-lg leading-none text-slate-300">&times;</button>
        </div>
        <form id="actDocsUploadForm" class="p-4 space-y-3 max-h-[82vh] overflow-y-auto"></form>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
    document.getElementById('actDocsUploadCloseBtn').onclick = () => modal.classList.add('hidden');
  }

  // =========================================================================
  // 4. RENDER COMPACT TOOLBAR & SINGLE-ROW DOCUMENT LIST
  // =========================================================================
  function renderToolbar() {
    const bar = document.getElementById('actDocsToolbar');
    if (!bar) return;

    const usedCategories = new Set(docState.docs.map((d) => d.category || 'Other'));
    if (docState.activeCategory !== 'All' && !usedCategories.has(docState.activeCategory)) {
      docState.activeCategory = 'All';
    }

    const showCategoryRow = usedCategories.size > 1;
    const pillCategories = ['All', ...CATEGORIES.filter((c) => usedCategories.has(c))];

    const pillsHtml = pillCategories
      .map((cat) => {
        const active = docState.activeCategory === cat;
        return `
          <button type="button" data-doc-cat="${esc(cat)}"
            class="h-7 px-2.5 rounded-md border text-[11px] font-bold shrink-0 transition ${
              active
                ? 'bg-sky-500 text-slate-950 border-sky-400'
                : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-600'
            }">
            ${esc(cat)}
          </button>
        `;
      })
      .join('');

    bar.innerHTML = `
      <div class="flex items-center gap-1.5 max-w-4xl mx-auto w-full">
        <div class="relative flex-1 min-w-0">
          <input id="actDocsSearchInput" type="search" placeholder="Search documents…"
            value="${esc(docState.searchQuery)}"
            class="w-full h-9 pl-3 pr-2.5 rounded-lg bg-slate-950 border border-slate-700/80 text-xs sm:text-sm text-white placeholder-slate-500 focus:outline-none focus:border-sky-500" />
        </div>
        <button id="actDocsRefreshBtn" type="button" title="Refresh list" ${docState.loading ? 'disabled' : ''}
          class="w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700/80 text-xs font-bold text-slate-200 flex items-center justify-center shrink-0">
          ${docState.loading ? '…' : '↻'}
        </button>
        ${
          isAdminUser()
            ? `<button id="actDocsOpenUploadBtn" type="button"
                class="h-9 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-extrabold flex items-center gap-1 shrink-0">
                <span>+</span><span>Upload</span>
              </button>`
            : ''
        }
      </div>

      ${
        showCategoryRow
          ? `<div class="act-docs-no-scrollbar flex items-center gap-1.5 overflow-x-auto max-w-4xl mx-auto w-full">${pillsHtml}</div>`
          : ''
      }
    `;

    const searchInput = document.getElementById('actDocsSearchInput');
    searchInput.oninput = (e) => {
      docState.searchQuery = e.target.value || '';
      renderDocumentsListOnly();
    };

    document.getElementById('actDocsRefreshBtn').onclick = () => loadDocuments(true);

    const upBtn = document.getElementById('actDocsOpenUploadBtn');
    if (upBtn) upBtn.onclick = () => openUploadModal(null);

    bar.querySelectorAll('[data-doc-cat]').forEach((btn) => {
      btn.onclick = () => {
        docState.activeCategory = btn.getAttribute('data-doc-cat');
        renderDocumentsBody();
      };
    });
  }

  function renderDocumentsBody() {
    renderToolbar();
    renderDocumentsListOnly();
  }

  function renderDocumentsListOnly() {
    const body = document.getElementById('actDocsBody');
    if (!body) return;

    const notes = [];
    if (!isAppOnline()) {
      notes.push('Offline mode — showing cached list. Connect to open or download files.');
    }
    if (docState.errorMsg) notes.push(docState.errorMsg);

    const bannerHtml = notes.length
      ? `
        <div class="max-w-4xl mx-auto mb-2.5 rounded-lg bg-amber-500/15 border border-amber-400/40 px-3 py-2 text-xs text-amber-200 space-y-1">
          ${notes.map((n) => `<div>${esc(n)}</div>`).join('')}
        </div>
      `
      : '';

    if (docState.loading && docState.docs.length === 0) {
      body.innerHTML = `${bannerHtml}<div class="py-16 text-center text-sm text-slate-400">Loading company documents…</div>`;
      return;
    }

    const q = docState.searchQuery.trim().toLowerCase();
    const filtered = docState.docs.filter((d) => {
      const catMatch = docState.activeCategory === 'All' || (d.category || 'Other') === docState.activeCategory;
      if (!catMatch) return false;
      if (!q) return true;
      return (
        String(d.title || '').toLowerCase().includes(q) ||
        String(d.category || '').toLowerCase().includes(q) ||
        String(d.description || '').toLowerCase().includes(q) ||
        String(d.file_name || '').toLowerCase().includes(q)
      );
    });

    if (filtered.length === 0) {
      const isFiltered = docState.docs.length > 0;
      body.innerHTML = `
        ${bannerHtml}
        <div class="max-w-md mx-auto mt-10 rounded-xl bg-slate-900 border border-slate-800 p-6 text-center space-y-3">
          <div class="text-3xl">📄</div>
          <h3 class="text-base font-extrabold text-white">
            ${isFiltered ? 'No Matching Documents' : 'No Company Documents Yet'}
          </h3>
          <p class="text-xs text-slate-400">
            ${
              isFiltered
                ? 'Try clearing your search or switching back to "All" categories.'
                : isAdminUser()
                ? 'Upload your Employee Handbook, insurance info, safety policies, or company forms for all employees.'
                : 'Company handbooks, insurance details, and reference documents will appear here once uploaded.'
            }
          </p>
          ${
            !isFiltered && isAdminUser()
              ? `<button id="actDocsEmptyUploadBtn" type="button"
                  class="px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-xs">
                  + Upload First Document
                </button>`
              : ''
          }
        </div>
      `;
      const emptyBtn = document.getElementById('actDocsEmptyUploadBtn');
      if (emptyBtn) emptyBtn.onclick = () => openUploadModal(null);
      return;
    }

    const admin = isAdminUser();
    const usedCategories = new Set(docState.docs.map((d) => d.category || 'Other'));
    const showRowCategoryPill = docState.activeCategory === 'All' && usedCategories.size > 1;

    const rowsHtml = filtered
      .map((doc) => {
        const fk = getFileKind(doc);
        const cat = doc.category || 'Other';
        const catCls = CATEGORY_BADGES[cat] || CATEGORY_BADGES.Other;

        return `
          <div class="flex items-center gap-2 px-3 py-2.5 border-b border-slate-800 last:border-b-0 hover:bg-slate-800/60 transition">
            <button type="button" data-view-doc="${esc(doc.id)}"
              class="flex items-center gap-2.5 min-w-0 flex-1 text-left">
              <div class="w-9 h-9 rounded-lg border ${fk.cls} flex items-center justify-center text-[10px] font-extrabold shrink-0">
                ${fk.badge}
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-sm font-bold text-white truncate">${esc(doc.title)}</span>
                  ${
                    showRowCategoryPill
                      ? `<span class="px-1.5 py-0.5 rounded border text-[9px] font-bold shrink-0 ${catCls}">${esc(cat)}</span>`
                      : ''
                  }
                </div>
                <div class="text-[11px] text-slate-400 truncate mt-0.5">
                  ${
                    doc.description
                      ? `${esc(doc.description)} • `
                      : ''
                  }<span class="font-mono text-slate-500">${esc(formatBytes(doc.file_size))}${doc.updated_at ? ` • ${esc(formatDateShort(doc.updated_at))}` : ''}</span>
                </div>
              </div>
            </button>

            ${
              admin
                ? `
                  <div class="flex items-center gap-1 shrink-0">
                    <button type="button" data-edit-doc="${esc(doc.id)}" title="Edit document"
                      class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-bold flex items-center justify-center">
                      ✎
                    </button>
                    <button type="button" data-delete-doc="${esc(doc.id)}" title="Delete document"
                      class="w-8 h-8 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 border border-rose-500/30 text-rose-300 text-xs font-bold flex items-center justify-center">
                      ✕
                    </button>
                  </div>
                `
                : `<span class="text-slate-500 text-sm font-bold px-1 shrink-0 pointer-events-none">›</span>`
            }
          </div>
        `;
      })
      .join('');

    body.innerHTML = `
      ${bannerHtml}
      <div class="max-w-4xl mx-auto rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
        ${rowsHtml}
      </div>
    `;

    body.querySelectorAll('[data-view-doc]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-view-doc');
        const doc = docState.docs.find((d) => d.id === id);
        if (doc) openDocumentViewer(doc);
      };
    });

    body.querySelectorAll('[data-edit-doc]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-edit-doc');
        const doc = docState.docs.find((d) => d.id === id);
        if (doc) openUploadModal(doc);
      };
    });

    body.querySelectorAll('[data-delete-doc]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-delete-doc');
        deleteDocumentById(id);
      };
    });
  }

  // =========================================================================
  // 5. BUILT-IN DOCUMENT VIEWER MODAL (PDF.JS + IMAGE + DOWNLOAD)
  // =========================================================================
  function closeViewerModal() {
    docState.viewerRenderSerial += 1;
    revokeActiveObjectUrls();
    const modal = document.getElementById('actDocsViewerModal');
    const body = document.getElementById('actDocsViewerBody');
    if (body) body.innerHTML = '';
    modal?.classList.add('hidden');
  }

  async function triggerExternalDownload(doc) {
    try {
      const signedUrl = await createSignedUrlForDoc(doc.storage_path);
      const a = document.createElement('a');
      a.href = signedUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.download = doc.file_name || `${doc.title}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      toast(`Download failed: ${err.message}`, true);
    }
  }

  async function openDocumentViewer(doc) {
    if (!isAppOnline()) {
      toast('Connect to the internet to open this document.', true);
      return;
    }

    ensureViewerModal();
    const modal = document.getElementById('actDocsViewerModal');
    const titleEl = document.getElementById('actDocsViewerTitle');
    const subEl = document.getElementById('actDocsViewerSub');
    const body = document.getElementById('actDocsViewerBody');
    const dlBtn = document.getElementById('actDocsViewerDownloadBtn');

    revokeActiveObjectUrls();
    const serial = ++docState.viewerRenderSerial;

    titleEl.textContent = doc.title;
    subEl.textContent = `${doc.category || 'Document'} • ${formatBytes(doc.file_size)}`;
    dlBtn.onclick = () => triggerExternalDownload(doc);
    body.innerHTML = `<div class="py-16 text-sm text-slate-400">Loading document…</div>`;
    modal.classList.remove('hidden');

    const fk = getFileKind(doc);

    try {
      if (fk.kind === 'image') {
        const blob = await downloadBlobForDoc(doc.storage_path);
        if (serial !== docState.viewerRenderSerial) return;
        const objUrl = URL.createObjectURL(blob);
        docState.activeObjectUrls.push(objUrl);
        body.innerHTML = `
          <img src="${objUrl}" alt="${esc(doc.title)}"
            class="max-w-full rounded-lg border border-slate-800 shadow-2xl" />
        `;
        return;
      }

      if (fk.kind === 'pdf' && window.pdfjsLib) {
        const blob = await downloadBlobForDoc(doc.storage_path);
        if (serial !== docState.viewerRenderSerial) return;
        const buf = await blob.arrayBuffer();
        if (serial !== docState.viewerRenderSerial) return;

        const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
        if (serial !== docState.viewerRenderSerial) return;

        const totalPages = pdf.numPages || 1;
        subEl.textContent = `${doc.category || 'PDF'} • ${totalPages} page${totalPages === 1 ? '' : 's'} • ${formatBytes(doc.file_size)}`;
        body.innerHTML = '';

        const availWidth = Math.min(body.clientWidth - 24, 920);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
          if (serial !== docState.viewerRenderSerial) return;

          const page = await pdf.getPage(pageNum);
          if (serial !== docState.viewerRenderSerial) return;

          const unscaled = page.getViewport({ scale: 1 });
          const cssScale = Math.max(0.5, availWidth / (unscaled.width || 612));
          const renderVp = page.getViewport({ scale: cssScale * dpr });

          const wrap = document.createElement('div');
          wrap.className = 'w-full flex flex-col items-center gap-1';

          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(renderVp.width);
          canvas.height = Math.floor(renderVp.height);
          canvas.style.width = `${Math.floor(unscaled.width * cssScale)}px`;
          canvas.style.height = `${Math.floor(unscaled.height * cssScale)}px`;
          canvas.className = 'max-w-full rounded shadow-xl bg-white';

          wrap.appendChild(canvas);
          if (totalPages > 1) {
            const cap = document.createElement('div');
            cap.className = 'text-[10px] font-mono text-slate-500';
            cap.textContent = `Page ${pageNum} of ${totalPages}`;
            wrap.appendChild(cap);
          }
          body.appendChild(wrap);

          await page.render({
            canvasContext: canvas.getContext('2d', { alpha: false }),
            viewport: renderVp
          }).promise;
        }
        return;
      }

      body.innerHTML = `
        <div class="max-w-sm w-full mt-10 rounded-xl bg-slate-900 border border-slate-800 p-6 text-center space-y-3">
          <div class="text-3xl">📎</div>
          <div class="text-sm font-extrabold text-white">${esc(doc.file_name)}</div>
          <p class="text-xs text-slate-400">
            This file type opens using your device's native viewer. Tap below to open or save a copy.
          </p>
          <button id="actDocsOpenNativeBtn" type="button"
            class="w-full py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-extrabold text-xs">
            Open / Download File
          </button>
        </div>
      `;
      document.getElementById('actDocsOpenNativeBtn').onclick = () => triggerExternalDownload(doc);
    } catch (err) {
      if (serial !== docState.viewerRenderSerial) return;
      body.innerHTML = `
        <div class="max-w-md w-full mt-8 rounded-xl bg-rose-500/15 border border-rose-400/40 p-5 text-center space-y-3">
          <div class="text-xs text-rose-200">${esc(err.message)}</div>
          <button id="actDocsFallbackDlBtn" type="button"
            class="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-extrabold text-xs">
            Try Direct Download
          </button>
        </div>
      `;
      document.getElementById('actDocsFallbackDlBtn').onclick = () => triggerExternalDownload(doc);
    }
  }

  // =========================================================================
  // 6. ADMIN UPLOAD / EDIT MODAL
  // =========================================================================
  function openUploadModal(docToEdit = null) {
    if (!isAdminUser()) {
      toast('Only Administrators can upload or edit company documents.', true);
      return;
    }

    ensureUploadModal();
    docState.editingDocId = docToEdit?.id || null;

    const modal = document.getElementById('actDocsUploadModal');
    const heading = document.getElementById('actDocsUploadHeading');
    const form = document.getElementById('actDocsUploadForm');

    heading.textContent = docToEdit ? 'Edit Document' : 'Upload Company Document';

    const catOptions = CATEGORIES.map(
      (c) => `<option value="${esc(c)}" ${(docToEdit?.category || 'Handbook') === c ? 'selected' : ''}>${esc(c)}</option>`
    ).join('');

    form.innerHTML = `
      <div>
        <label class="block text-[11px] font-bold text-slate-400 mb-1">
          ${docToEdit ? 'Replace File (optional)' : 'Select File (PDF, Image, Word, Excel — max 25 MB)'}
        </label>
        <input id="actDocsFileInput" type="file" ${docToEdit ? '' : 'required'}
          accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.txt"
          class="w-full text-xs text-slate-300 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-bold file:bg-slate-800 file:text-slate-100 hover:file:bg-slate-700 bg-slate-950 border border-slate-700 rounded-lg p-1.5" />
        ${
          docToEdit
            ? `<div class="text-[10px] font-mono text-slate-500 mt-1 truncate">Current: ${esc(docToEdit.file_name)} (${formatBytes(docToEdit.file_size)})</div>`
            : ''
        }
      </div>

      <div>
        <label class="block text-[11px] font-bold text-slate-400 mb-1">Document Title</label>
        <input id="actDocsTitleInput" type="text" required placeholder="e.g. 2026 Employee Handbook, Health Insurance Guide"
          value="${esc(docToEdit?.title || '')}"
          class="w-full h-9 px-3 rounded-lg bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-sky-500" />
      </div>

      <div>
        <label class="block text-[11px] font-bold text-slate-400 mb-1">Category</label>
        <select id="actDocsCategorySelect"
          class="w-full h-9 px-3 rounded-lg bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-sky-500">
          ${catOptions}
        </select>
      </div>

      <div>
        <label class="block text-[11px] font-bold text-slate-400 mb-1">Short Note (optional)</label>
        <textarea id="actDocsDescInput" rows="2" placeholder="e.g. Group #12345 — updated Nov 2026"
          class="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white focus:outline-none focus:border-sky-500">${esc(docToEdit?.description || '')}</textarea>
      </div>

      <div id="actDocsUploadErr" class="hidden rounded-lg bg-rose-500/15 border border-rose-400/40 px-3 py-2 text-xs text-rose-200"></div>

      <button id="actDocsUploadSubmitBtn" type="submit"
        class="w-full h-10 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-extrabold text-xs transition">
        ${docToEdit ? 'Save Changes' : 'Upload Document'}
      </button>
    `;

    const fileInp = document.getElementById('actDocsFileInput');
    const titleInp = document.getElementById('actDocsTitleInput');

    fileInp.onchange = () => {
      const f = fileInp.files?.[0];
      if (f && !titleInp.value.trim()) {
        titleInp.value = f.name
          .replace(/\.[^.]+$/, '')
          .replace(/[_-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('actDocsUploadSubmitBtn');
      const errBox = document.getElementById('actDocsUploadErr');
      errBox.classList.add('hidden');
      errBox.textContent = '';

      const title = titleInp.value.trim();
      const category = document.getElementById('actDocsCategorySelect').value;
      const description = document.getElementById('actDocsDescInput').value;
      const file = fileInp.files?.[0] || null;

      if (!title) {
        errBox.textContent = 'Enter a document title.';
        errBox.classList.remove('hidden');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = file ? 'Uploading…' : 'Saving…';

      try {
        await saveDocumentFromForm({
          id: docState.editingDocId,
          title,
          category,
          description,
          file
        });
        modal.classList.add('hidden');
        toast(docState.editingDocId ? `Updated "${title}".` : `Uploaded "${title}".`, false);
        await loadDocuments(true);
      } catch (err) {
        errBox.textContent = err.message || 'Upload failed.';
        errBox.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = docToEdit ? 'Save Changes' : 'Upload Document';
      }
    };

    modal.classList.remove('hidden');
  }

  // =========================================================================
  // 7. VIEW LIFECYCLE & ACT NAVIGATION HOOKS
  // =========================================================================
  async function openDocumentsView() {
    window.ACTBlueprints?.close?.();
    window.ACTCalendar?.close?.();
    ['viewCrew', 'viewAdmin', 'viewOtherModule', 'viewPmPortal', 'roleWorkspaceQuickBar'].forEach(
      (id) => document.getElementById(id)?.classList.add('hidden')
    );

    const view = ensureDocumentsView();
    positionDocumentsSection();
    view.classList.remove('hidden');
    docState.isOpen = true;

    const titleEl = document.getElementById('topBarPageTitle');
    if (titleEl) titleEl.textContent = 'Company Docs';

    if (typeof closeSideMenu === 'function') closeSideMenu();

    renderDocumentsBody();
    await loadDocuments(false);
  }

  function closeDocumentsView() {
    docState.isOpen = false;
    closeViewerModal();
    document.getElementById('viewCompanyDocuments')?.classList.add('hidden');
    document.getElementById('actDocsUploadModal')?.classList.add('hidden');
  }

  function syncRoleUI() {
    ensureMenuButton();
    if (docState.isOpen) {
      if (!isAdminUser()) {
        document.getElementById('actDocsUploadModal')?.classList.add('hidden');
      }
      renderDocumentsBody();
    }
  }

  function installNavigationHooks() {
    const prevSelectMenu = window.selectMenuFeature;
    window.selectMenuFeature = function (featureKey) {
      if (featureKey === 'documents') {
        openDocumentsView();
        return;
      }
      closeDocumentsView();
      if (typeof prevSelectMenu === 'function') {
        return prevSelectMenu.apply(this, arguments);
      }
    };

    const prevOpenAdmin = window.openAdminPage;
    if (typeof prevOpenAdmin === 'function') {
      window.openAdminPage = function () {
        closeDocumentsView();
        return prevOpenAdmin.apply(this, arguments);
      };
    }

    const prevPersonalCard = window.openMyPersonalCardView;
    if (typeof prevPersonalCard === 'function') {
      window.openMyPersonalCardView = function () {
        closeDocumentsView();
        return prevPersonalCard.apply(this, arguments);
      };
    }

    const prevLogout = window.logoutUser;
    if (typeof prevLogout === 'function') {
      window.logoutUser = function () {
        closeDocumentsView();
        return prevLogout.apply(this, arguments);
      };
    }

    const prevRefreshRole = window.refreshRoleUiVisibility;
    if (typeof prevRefreshRole === 'function') {
      window.refreshRoleUiVisibility = function () {
        const res = prevRefreshRole.apply(this, arguments);
        syncRoleUI();
        return res;
      };
    }

    const prevUpdateTopBar = window.updateTopBarIndicators;
    if (typeof prevUpdateTopBar === 'function') {
      window.updateTopBarIndicators = function () {
        const res = prevUpdateTopBar.apply(this, arguments);
        syncRoleUI();
        return res;
      };
    }

    syncRoleUI();
  }

  window.ACTDocuments = {
    open: openDocumentsView,
    close: closeDocumentsView,
    refresh: () => loadDocuments(true)
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
