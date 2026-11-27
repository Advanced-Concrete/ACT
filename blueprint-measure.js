// =========================================================================
// ACT MASTER - BLUEPRINT REFERENCE MEASUREMENTS & TOOLBAR POLISH (blueprint-measure.js)
// Drop-in Distance & Surface Area measurement overlay + Landscape/Fullscreen/Toolbar UX
// - Role guards:
//     Supervisor / PM / Admin: Calibrate & Recalibrate sheets (shared in Supabase)
//     Crew:                    Measure Distance & Area on calibrated sheets (read-only scale)
// - Top "Measured Totals" dropdown: select any measurement to highlight its lines
//   and individual segment lengths on screen
// - Per-user saved measurements synced across devices via `blueprint_user_measurements`
// - Phone Landscape: Auto-compacts Measure Dock into a single ~42px horizontal strip
// - Collapsible Measure Dock (▾) + One-tap Fullscreen (⛶ Full)
// - Clean Mobile Toolbar: packs secondary Blueprint tools into ⋯ popover &
//   hides the drawing action strip when no blueprint is open
// =========================================================================
(function initBlueprintMeasure() {
  'use strict';

  const SCALES_TABLE = 'blueprint_page_scales';
  const USER_MEASURES_TABLE = 'blueprint_user_measurements';
  const LOCAL_SCALE_CACHE_KEY = 'bp_page_scales_cache_v1';
  const LOCAL_MEASURES_CACHE_KEY = 'bp_user_measures_cache_v1';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const ARCHITECTURAL_PRESETS = [
    { label: '1/16" = 1\'-0"', ftPerIn: 16 },
    { label: '3/32" = 1\'-0"', ftPerIn: 32 / 3 },
    { label: '1/8" = 1\'-0"', ftPerIn: 8 },
    { label: '3/16" = 1\'-0"', ftPerIn: 16 / 3 },
    { label: '1/4" = 1\'-0"', ftPerIn: 4 },
    { label: '3/8" = 1\'-0"', ftPerIn: 8 / 3 },
    { label: '1/2" = 1\'-0"', ftPerIn: 2 },
    { label: '3/4" = 1\'-0"', ftPerIn: 4 / 3 },
    { label: '1" = 1\'-0"', ftPerIn: 1 }
  ];

  const ENGINEERING_PRESETS = [
    { label: '1" = 10\'', ftPerIn: 10 },
    { label: '1" = 20\'', ftPerIn: 20 },
    { label: '1" = 30\'', ftPerIn: 30 },
    { label: '1" = 40\'', ftPerIn: 40 },
    { label: '1" = 50\'', ftPerIn: 50 },
    { label: '1" = 100\'', ftPerIn: 100 }
  ];

  const mState = {
    active: false,
    tool: 'distance', // 'distance' | 'area' | 'calibrate'
    orthoSnap: false,
    dockCollapsed: false,
    fullscreen: false,
    toolsPopoverOpen: false,
    pageScale: null, // { scale_label, calibration_mode, width_ft, height_ft, calibrated_by, updated_at }
    scaleCache: loadLocalJSON(LOCAL_SCALE_CACHE_KEY, {}),
    savedCache: loadLocalJSON(LOCAL_MEASURES_CACHE_KEY, {}),
    currentDocKey: '',
    currentUserPageKey: '',

    // Measurements on active page (unsaved + current user's saved)
    shapes: [],
    activeShapeId: null,
    selectedShapeId: null,
    totalsDropdownOpen: false,
    isSaving: false,

    // 2-Point Calibration points
    calPoints: [],

    // Tap vs Pan detection on viewport
    tapCandidate: null,
    multiTouchSeen: false,
    activePointerIds: new Set(),

    // Vertex drag fine-tuning
    draggingHandle: null,

    // Modal & mount state
    modalTab: 'two_point',
    mounted: false,
    viewObserver: null
  };

  // =========================================================================
  // 1. BRIDGE, USER IDENTITY & STORAGE HELPERS
  // =========================================================================
  function getBridge() {
    return window.ACTBlueprints?._bridge || null;
  }

  function getViewerState() {
    const b = getBridge();
    return b ? b.getState() : null;
  }

  function getCurrentUserId() {
    try {
      if (typeof activeCrewEmployeeId !== 'undefined' && activeCrewEmployeeId) {
        return String(activeCrewEmployeeId);
      }
    } catch {}
    try {
      const role =
        typeof getActiveUserEffectiveRole === 'function'
          ? getActiveUserEffectiveRole()
          : typeof currentRole !== 'undefined'
          ? currentRole
          : '';
      if (String(role).toLowerCase() === 'admin') return 'ADMIN';
    } catch {}
    const s = getViewerState();
    if (s?.userName) {
      return `user_${String(s.userName).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    }
    return 'local_user';
  }

  function toast(msg, type = 'info') {
    const b = getBridge();
    if (b?.notify) b.notify(msg, type);
    else if (typeof showSimpleToast === 'function') showSimpleToast(msg, type === 'error' || type === 'warning');
    else console.log(`[Measure ${type}]`, msg);
  }

  function loadLocalJSON(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveLocalJSON(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  function getDocPageKey(s) {
    if (!s?.activeDoc?.docId) return '';
    return `${s.activeDoc.docId}::${Number(s.activePage) || 1}`;
  }

  function getUserPageKey(s) {
    const docKey = getDocPageKey(s);
    if (!docKey) return '';
    return `${getCurrentUserId()}::${docKey}`;
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // =========================================================================
  // 2. MEASUREMENT MATH & FORMATTING
  // =========================================================================
  function distFeet(p1, p2, scale) {
    if (!scale) return 0;
    const dx = (p2.x - p1.x) * scale.width_ft;
    const dy = (p2.y - p1.y) * scale.height_ft;
    return Math.hypot(dx, dy);
  }

  function formatFeetInches(totalFeet) {
    if (!isFinite(totalFeet) || totalFeet < 0) return `0'-0"`;
    const totalEighths = Math.round(totalFeet * 12 * 8);
    const feet = Math.floor(totalEighths / 96);
    const remEighths = totalEighths % 96;
    const inches = Math.floor(remEighths / 8);
    const frac = remEighths % 8;
    const fracMap = { 0: '', 1: ' 1/8', 2: ' 1/4', 3: ' 3/8', 4: ' 1/2', 5: ' 5/8', 6: ' 3/4', 7: ' 7/8' };
    return `${feet}'-${inches}${fracMap[frac]}"`;
  }

  function formatDecimalFeet(ft) {
    if (!isFinite(ft) || ft < 0) return '0.00\'';
    return `${ft.toFixed(2)}'`;
  }

  function formatSqFt(sqFt) {
    if (!isFinite(sqFt) || sqFt < 0) return '0.0 sq ft';
    return `${sqFt.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} sq ft`;
  }

  function formatShortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function computeDistanceMetrics(points, scale, closed = false) {
    if (!scale || points.length < 2) return { totalFt: 0, segments: [] };
    const segments = [];
    let totalFt = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const len = distFeet(points[i], points[i + 1], scale);
      segments.push({ a: points[i], b: points[i + 1], len });
      totalFt += len;
    }
    if (closed && points.length >= 3) {
      const len = distFeet(points[points.length - 1], points[0], scale);
      segments.push({ a: points[points.length - 1], b: points[0], len });
      totalFt += len;
    }
    return { totalFt, segments };
  }

  function computeAreaMetrics(points, scale) {
    if (!scale || points.length < 2) return { areaSqFt: 0, perimeterFt: 0, edges: [], centroid: null };
    const edges = [];
    let perimeterFt = 0;
    const edgeCount = points.length >= 3 ? points.length : points.length - 1;
    for (let i = 0; i < edgeCount; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const len = distFeet(a, b, scale);
      edges.push({ a, b, len, isClosing: points.length >= 3 && i === points.length - 1 });
      perimeterFt += len;
    }

    let areaSqFt = 0;
    let centroid = null;
    if (points.length >= 3) {
      let sum = 0;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < points.length; i++) {
        const p1 = points[i];
        const p2 = points[(i + 1) % points.length];
        sum += (p1.x * scale.width_ft) * (p2.y * scale.height_ft) - (p2.x * scale.width_ft) * (p1.y * scale.height_ft);
        cx += p1.x;
        cy += p1.y;
      }
      areaSqFt = Math.abs(sum) * 0.5;
      centroid = { x: cx / points.length, y: cy / points.length };
    }
    return { areaSqFt, perimeterFt, edges, centroid };
  }

  function isMeasurableShape(shape) {
    if (!shape || !Array.isArray(shape.points)) return false;
    return shape.type === 'area' ? shape.points.length >= 3 : shape.points.length >= 2;
  }

  function getShapeSummary(shape, index, scale) {
    if (shape.type === 'distance') {
      const { totalFt, segments } = computeDistanceMetrics(shape.points, scale, shape.closed);
      const defaultTitle = shape.closed
        ? `Perimeter #${index + 1} (${segments.length} sides)`
        : segments.length > 1
        ? `Multi-Line #${index + 1} (${segments.length} lines)`
        : `Line #${index + 1}`;
      return {
        title: shape.name?.trim() || defaultTitle,
        primaryTotal: scale ? formatFeetInches(totalFt) : '--',
        secondaryTotal: scale ? formatDecimalFeet(totalFt) : '',
        segmentLabels: segments.map((seg, i) => `L${i + 1}: ${formatFeetInches(seg.len)}`)
      };
    }

    const { areaSqFt, perimeterFt, edges } = computeAreaMetrics(shape.points, scale);
    const defaultTitle = `Area #${index + 1} (${shape.points.length} corners)`;
    return {
      title: shape.name?.trim() || defaultTitle,
      primaryTotal: scale ? formatSqFt(areaSqFt) : '--',
      secondaryTotal: scale ? `Perim ${formatFeetInches(perimeterFt)}` : '',
      segmentLabels: edges.map((ed, i) => `S${i + 1}: ${formatFeetInches(ed.len)}`)
    };
  }

  function applyOrthoIfEnabled(pt, prevPt, stageW, stageH) {
    if (!mState.orthoSnap || !prevPt) return pt;
    const dx = (pt.x - prevPt.x) * (stageW || 1);
    const dy = (pt.y - prevPt.y) * (stageH || 1);
    if (Math.abs(dx) >= Math.abs(dy)) {
      return { x: pt.x, y: prevPt.y };
    }
    return { x: prevPt.x, y: pt.y };
  }

  function clientToNorm(clientX, clientY) {
    const s = getViewerState();
    const viewport = document.getElementById('bpCanvasViewport');
    if (!s || !viewport) return null;
    const rect = viewport.getBoundingClientRect();
    const stageX = (clientX - rect.left - s.panX) / (s.zoom || 1);
    const stageY = (clientY - rect.top - s.panY) / (s.zoom || 1);
    return {
      x: Math.max(0, Math.min(1, stageX / (s.stageW || 1))),
      y: Math.max(0, Math.min(1, stageY / (s.stageH || 1)))
    };
  }

  // =========================================================================
  // 3. SUPABASE SCALE SYNC & PER-USER MEASUREMENT SYNC
  // =========================================================================
  async function loadScaleForActivePage() {
    const s = getViewerState();
    const key = getDocPageKey(s);
    mState.currentDocKey = key;
    if (!key) {
      mState.pageScale = null;
      renderMeasureUI();
      return;
    }

    mState.pageScale = mState.scaleCache[key] || null;
    renderMeasureUI();

    if (!s.supabase || !s.isOnline) return;

    try {
      const { data, error } = await s.supabase
        .from(SCALES_TABLE)
        .select('doc_id, page_number, scale_label, calibration_mode, width_ft, height_ft, calibrated_by, updated_at')
        .eq('doc_id', s.activeDoc.docId)
        .eq('page_number', Number(s.activePage) || 1)
        .maybeSingle();

      if (error) return;
      if (getDocPageKey(getViewerState()) !== key) return;

      if (data && Number(data.width_ft) > 0 && Number(data.height_ft) > 0) {
        mState.pageScale = {
          scale_label: data.scale_label,
          calibration_mode: data.calibration_mode,
          width_ft: Number(data.width_ft),
          height_ft: Number(data.height_ft),
          calibrated_by: data.calibrated_by || '',
          updated_at: data.updated_at || ''
        };
        mState.scaleCache[key] = mState.pageScale;
        saveLocalJSON(LOCAL_SCALE_CACHE_KEY, mState.scaleCache);
      } else {
        mState.pageScale = null;
        delete mState.scaleCache[key];
        saveLocalJSON(LOCAL_SCALE_CACHE_KEY, mState.scaleCache);
      }
      renderMeasureUI();
    } catch {}
  }

  async function saveScaleForActivePage({ scaleLabel, mode, widthFt, heightFt }) {
    const s = getViewerState();
    if (!s?.activeDoc) return false;
    if (!s.canCalibrate) {
      toast('Only Supervisors, PMs, and Admins can calibrate sheets.', 'warning');
      return false;
    }
    if (!isFinite(widthFt) || !isFinite(heightFt) || widthFt <= 0 || heightFt <= 0) {
      toast('Invalid scale calculation. Pick two points farther apart.', 'error');
      return false;
    }

    if (mState.pageScale) {
      const prevBy = mState.pageScale.calibrated_by || 'another user';
      const prevDate = formatShortDate(mState.pageScale.updated_at);
      const ok = confirm(
        `Overwrite existing sheet scale?\n\nCurrent: ${mState.pageScale.scale_label} (set by ${prevBy}${prevDate ? ` on ${prevDate}` : ''})\nNew: ${scaleLabel}\n\nThis updates the shared scale for all users on this sheet.`
      );
      if (!ok) return false;
    }

    const nowIso = new Date().toISOString();
    const record = {
      doc_id: s.activeDoc.docId,
      page_number: Number(s.activePage) || 1,
      source_path: s.activeDoc.dropboxPath || null,
      scale_label: scaleLabel,
      calibration_mode: mode,
      width_ft: widthFt,
      height_ft: heightFt,
      calibrated_by: s.userName || 'Supervisor',
      updated_at: nowIso
    };

    const key = getDocPageKey(s);
    mState.pageScale = {
      scale_label: record.scale_label,
      calibration_mode: record.calibration_mode,
      width_ft: record.width_ft,
      height_ft: record.height_ft,
      calibrated_by: record.calibrated_by,
      updated_at: record.updated_at
    };
    mState.scaleCache[key] = mState.pageScale;
    saveLocalJSON(LOCAL_SCALE_CACHE_KEY, mState.scaleCache);

    let synced = false;
    if (s.supabase && s.isOnline) {
      try {
        const { error } = await s.supabase
          .from(SCALES_TABLE)
          .upsert(record, { onConflict: 'doc_id,page_number' });
        if (error) throw error;
        synced = true;
      } catch (err) {
        toast(`Scale saved locally (cloud sync warning: ${err.message})`, 'warning');
      }
    }

    mState.calPoints = [];
    mState.tool = 'distance';
    renderMeasureUI();

    if (synced) {
      toast(`Sheet scale saved (${scaleLabel}) & synced for all users.`, 'success');
    } else if (!s.isOnline) {
      toast(`Sheet scale saved locally (${scaleLabel}) while offline.`, 'info');
    }
    return true;
  }

  function sanitizeShapeRow(row) {
    const pts = Array.isArray(row.points)
      ? row.points
          .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
          .filter((p) => isFinite(p.x) && isFinite(p.y))
      : [];
    return {
      id: String(row.id),
      type: row.shape_type === 'area' ? 'area' : 'distance',
      points: pts,
      closed: Boolean(row.closed),
      name: String(row.name || ''),
      saved: true,
      updatedAt: row.updated_at || ''
    };
  }

  function updateLocalSavedCacheForCurrentPage() {
    const s = getViewerState();
    const userPageKey = getUserPageKey(s);
    if (!userPageKey) return;
    const savedList = mState.shapes
      .filter((sh) => sh.saved)
      .map((sh) => ({
        id: sh.id,
        shape_type: sh.type,
        points: sh.points,
        closed: sh.closed,
        name: sh.name || '',
        updated_at: sh.updatedAt || new Date().toISOString()
      }));
    if (savedList.length > 0) {
      mState.savedCache[userPageKey] = savedList;
    } else {
      delete mState.savedCache[userPageKey];
    }
    saveLocalJSON(LOCAL_MEASURES_CACHE_KEY, mState.savedCache);
  }

  function mergeSavedShapesIntoState(savedShapes) {
    const unsaved = mState.shapes.filter((sh) => !sh.saved);
    const savedIds = new Set(savedShapes.map((sh) => sh.id));
    const keptUnsaved = unsaved.filter((sh) => !savedIds.has(sh.id));
    mState.shapes = [...savedShapes, ...keptUnsaved];
    if (mState.selectedShapeId && !mState.shapes.some((sh) => sh.id === mState.selectedShapeId)) {
      mState.selectedShapeId = null;
    }
  }

  async function loadUserMeasurementsForActivePage() {
    const s = getViewerState();
    const userPageKey = getUserPageKey(s);
    const isSamePage = userPageKey === mState.currentUserPageKey;
    mState.currentUserPageKey = userPageKey;

    if (!userPageKey) {
      mState.shapes = [];
      mState.activeShapeId = null;
      mState.selectedShapeId = null;
      renderMeasureUI();
      return;
    }

    if (!isSamePage) {
      mState.shapes = [];
      mState.activeShapeId = null;
      mState.selectedShapeId = null;
      mState.totalsDropdownOpen = false;
    }

    const cachedRows = mState.savedCache[userPageKey];
    if (Array.isArray(cachedRows) && cachedRows.length > 0) {
      mergeSavedShapesIntoState(cachedRows.map(sanitizeShapeRow));
      renderMeasureUI();
    }

    if (!s.supabase || !s.isOnline) return;

    try {
      const userId = getCurrentUserId();
      const { data, error } = await s.supabase
        .from(USER_MEASURES_TABLE)
        .select('id, shape_type, points, closed, name, updated_at')
        .eq('user_id', userId)
        .eq('doc_id', s.activeDoc.docId)
        .eq('page_number', Number(s.activePage) || 1)
        .order('updated_at', { ascending: true });

      if (error) return;
      if (getUserPageKey(getViewerState()) !== userPageKey) return;

      const remoteShapes = (data || []).map(sanitizeShapeRow);
      mergeSavedShapesIntoState(remoteShapes);
      updateLocalSavedCacheForCurrentPage();
      renderMeasureUI();
    } catch {}
  }

  async function saveShapesToSupabase(shapesToSave, { silent = false } = {}) {
    const s = getViewerState();
    if (!s?.activeDoc) return false;
    const valid = shapesToSave.filter(isMeasurableShape);
    if (valid.length === 0) {
      if (!silent) toast('Finish placing at least one measurement before saving.', 'warning');
      return false;
    }

    const userId = getCurrentUserId();
    const nowIso = new Date().toISOString();
    const rows = valid.map((sh) => ({
      id: sh.id,
      user_id: userId,
      user_name: s.userName || 'User',
      doc_id: s.activeDoc.docId,
      page_number: Number(s.activePage) || 1,
      source_path: s.activeDoc.dropboxPath || null,
      name: String(sh.name || '').trim(),
      shape_type: sh.type,
      points: sh.points,
      closed: Boolean(sh.closed),
      updated_at: nowIso
    }));

    valid.forEach((sh) => {
      sh.saved = true;
      sh.updatedAt = nowIso;
      if (mState.activeShapeId === sh.id) {
        mState.activeShapeId = null;
      }
    });
    updateLocalSavedCacheForCurrentPage();
    renderMeasureUI();

    if (!s.supabase || !s.isOnline) {
      if (!silent) toast('Saved locally while offline.', 'info');
      return true;
    }

    try {
      mState.isSaving = true;
      const { error } = await s.supabase
        .from(USER_MEASURES_TABLE)
        .upsert(rows, { onConflict: 'id' });
      if (error) throw error;
      if (!silent) {
        toast(
          valid.length === 1
            ? 'Measurement saved to your account.'
            : `Saved ${valid.length} measurements to your account.`,
          'success'
        );
      }
      return true;
    } catch (err) {
      if (!silent) toast(`Saved locally (sync warning: ${err.message})`, 'warning');
      return false;
    } finally {
      mState.isSaving = false;
      renderTopTotalsDropdown();
    }
  }

  async function deleteShapeById(shapeId, { skipConfirm = false } = {}) {
    const shape = mState.shapes.find((sh) => sh.id === shapeId);
    if (!shape) return;

    if (!skipConfirm) {
      const idx = mState.shapes.indexOf(shape);
      const summary = getShapeSummary(shape, idx, mState.pageScale);
      const msg = shape.saved
        ? `Delete saved measurement "${summary.title}" (${summary.primaryTotal}) from your account across all devices?`
        : `Delete measurement "${summary.title}" (${summary.primaryTotal})?`;
      if (!confirm(msg)) return;
    }

    const wasSaved = Boolean(shape.saved);
    mState.shapes = mState.shapes.filter((sh) => sh.id !== shapeId);
    if (mState.activeShapeId === shapeId) mState.activeShapeId = null;
    if (mState.selectedShapeId === shapeId) mState.selectedShapeId = null;
    updateLocalSavedCacheForCurrentPage();
    renderMeasureUI();

    if (wasSaved) {
      const s = getViewerState();
      if (s?.supabase && s.isOnline) {
        try {
          const { error } = await s.supabase
            .from(USER_MEASURES_TABLE)
            .delete()
            .eq('id', shapeId)
            .eq('user_id', getCurrentUserId());
          if (error) throw error;
          toast('Saved measurement deleted.', 'info');
        } catch (err) {
          toast(`Removed locally (cloud delete warning: ${err.message})`, 'warning');
        }
      }
    }
  }

  // =========================================================================
  // 4. CLEAN TOOLBAR OVERFLOW (⋯ POPOVER), EMPTY-STATE HIDE & FULLSCREEN
  // =========================================================================
  function tagBlueprintTopChrome() {
    const view = document.getElementById('viewBlueprints');
    const viewport = document.getElementById('bpCanvasViewport');
    if (!view || !viewport) return;

    let el = viewport;
    while (el && el !== view) {
      let prev = el.previousElementSibling;
      while (prev) {
        prev.classList.add('bp-fs-chrome');
        prev = prev.previousElementSibling;
      }
      el = el.parentElement;
    }
  }

  function findActionToolbarRow() {
    const measureBtn = document.getElementById('bpToggleMeasureBtn');
    if (measureBtn?.parentElement) return measureBtn.parentElement;

    const anchor =
      document.getElementById('bpToggleAddLinkBtn') ||
      document.getElementById('bpSaveOfflineBtn');
    if (anchor?.parentElement && anchor.parentElement.id !== 'bpToolsPopoverMenu') {
      return anchor.parentElement;
    }

    const fitBtn = document.getElementById('bpZoomFitBtn');
    if (!fitBtn) return null;
    const p = fitBtn.parentElement;
    if (p && p.parentElement && p.parentElement.querySelector('#bpToggleAddLinkBtn, #bpSaveOfflineBtn')) {
      return p.parentElement;
    }
    return p;
  }

  function ensureToolsPopover() {
    let pop = document.getElementById('bpToolsPopoverMenu');
    if (pop) return pop;

    pop = document.createElement('div');
    pop.id = 'bpToolsPopoverMenu';
    pop.setAttribute('data-bp-measure-ui', '1');
    pop.className = 'hidden';

    // Auto-close popover right after a secondary tool inside it is clicked
    pop.addEventListener('click', (e) => {
      if (e.target.closest('button')) {
        setTimeout(() => {
          closeToolsPopover();
          updateToolsButtonIndicator();
        }, 60);
      }
    });

    document.body.appendChild(pop);
    return pop;
  }

  function openToolsPopover() {
    const pop = ensureToolsPopover();
    const btn = document.getElementById('bpToolsMenuBtn');
    if (!btn) return;

    const rect = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(rect.bottom + 6)}px`;
    pop.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
    pop.classList.remove('hidden');
    mState.toolsPopoverOpen = true;
    btn.setAttribute('aria-expanded', 'true');
  }

  function closeToolsPopover() {
    const pop = document.getElementById('bpToolsPopoverMenu');
    if (pop) pop.classList.add('hidden');
    mState.toolsPopoverOpen = false;
    document.getElementById('bpToolsMenuBtn')?.setAttribute('aria-expanded', 'false');
  }

  function updateToolsButtonIndicator() {
    const dot = document.getElementById('bpToolsActiveDot');
    const pop = document.getElementById('bpToolsPopoverMenu');
    const menuBtn = document.getElementById('bpToolsMenuBtn');
    if (!pop || !menuBtn) return;

    // Hide ⋯ button if all moved tools are hidden for this role
    const hasVisibleTool = Array.from(pop.children).some((el) => !el.classList.contains('hidden'));
    menuBtn.classList.toggle('hidden', !hasVisibleTool);

    if (!dot) return;
    const addLinkBtn = document.getElementById('bpToggleAddLinkBtn');
    const addLinkActive = Boolean(
      addLinkBtn &&
        !addLinkBtn.classList.contains('hidden') &&
        /(bg-amber-500|bg-amber-400|bg-sky-500|bg-emerald-500|bg-indigo-500)(?!\/)/.test(addLinkBtn.className || '')
    );
    dot.classList.toggle('hidden', !addLinkActive);
  }

  function organizeToolbarOverflow() {
    const actionRow = findActionToolbarRow();
    if (!actionRow) return;
    actionRow.classList.add('bp-action-row');

    const pop = ensureToolsPopover();

    let toolsBtn = document.getElementById('bpToolsMenuBtn');
    if (!toolsBtn) {
      toolsBtn = document.createElement('button');
      toolsBtn.id = 'bpToolsMenuBtn';
      toolsBtn.type = 'button';
      toolsBtn.title = 'More Blueprint Tools';
      toolsBtn.setAttribute('aria-haspopup', 'true');
      toolsBtn.setAttribute('aria-expanded', 'false');
      toolsBtn.className =
        'relative h-8 px-2.5 rounded-lg text-xs font-extrabold bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-600/80 flex items-center justify-center gap-1 transition shrink-0';
      toolsBtn.innerHTML = `
        <span class="tracking-widest leading-none">⋯</span>
        <span id="bpToolsActiveDot" class="hidden w-2 h-2 rounded-full bg-amber-400"></span>
      `;
      toolsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (mState.toolsPopoverOpen) closeToolsPopover();
        else openToolsPopover();
      });
      actionRow.appendChild(toolsBtn);
    }

    const fitBtn = document.getElementById('bpZoomFitBtn');
    let zoomChild = null;
    if (fitBtn) {
      let cur = fitBtn;
      while (cur && cur.parentElement !== actionRow) cur = cur.parentElement;
      if (cur && cur.parentElement === actionRow) zoomChild = cur;
    }

    const coreIds = new Set(['bpToggleMeasureBtn', 'bpToggleFullscreenBtn', 'bpToolsMenuBtn']);

    // Move secondary controls (Re-Scan Links, Add/Edit Callout Link, Available Offline, Dropbox Browser) into popover
    Array.from(actionRow.children).forEach((child) => {
      if (child === zoomChild) return;
      if (coreIds.has(child.id)) return;
      if (!zoomChild && /zoom|fit/i.test(child.id || '')) return;
      pop.appendChild(child);
    });

    // Keep clean consistent order: Zoom | Measure | Full | ⋯
    const measureBtn = document.getElementById('bpToggleMeasureBtn');
    const fsBtn = document.getElementById('bpToggleFullscreenBtn');
    if (measureBtn) actionRow.appendChild(measureBtn);
    if (fsBtn) actionRow.appendChild(fsBtn);
    actionRow.appendChild(toolsBtn);

    updateToolsButtonIndicator();
  }

  function syncToolbarEmptyState() {
    const actionRow = findActionToolbarRow();
    if (!actionRow) return;

    const s = getViewerState();
    const hasDoc = Boolean(s?.activeDoc);
    actionRow.classList.toggle('bp-action-row-empty', !hasDoc);

    if (!hasDoc) {
      closeToolsPopover();
      if (mState.fullscreen) setFullscreen(false);
    } else {
      organizeToolbarOverflow();
    }
  }

  function setFullscreen(enabled) {
    const next = Boolean(enabled);
    if (next) {
      closeToolsPopover();
      tagBlueprintTopChrome();
    }
    mState.fullscreen = next;
    document.body.classList.toggle('bp-focus-fullscreen', next);
    renderFullscreenControls();
    setTimeout(() => window.dispatchEvent(new Event('resize')), 40);
  }

  function renderFullscreenControls() {
    const fsToolbarBtn = document.getElementById('bpToggleFullscreenBtn');
    if (fsToolbarBtn) {
      fsToolbarBtn.className = mState.fullscreen
        ? 'h-8 px-2.5 rounded-lg text-xs font-extrabold bg-sky-500 text-slate-950 border border-sky-400 flex items-center gap-1 transition shrink-0'
        : 'h-8 px-2.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-600/80 flex items-center gap-1 transition shrink-0';
    }

    const floatBar = document.getElementById('bpFullscreenFloatBar');
    if (!floatBar) return;

    if (!mState.fullscreen) {
      floatBar.classList.add('hidden');
      return;
    }

    floatBar.classList.remove('hidden');
    floatBar.innerHTML = `
      <button id="bpFsQuickMeasureBtn" type="button" title="Toggle Measure Mode"
        class="h-8 px-2.5 rounded-lg text-xs font-extrabold border shadow-lg flex items-center gap-1 transition ${
          mState.active
            ? 'bg-emerald-500 text-slate-950 border-emerald-400'
            : 'bg-slate-900/95 hover:bg-slate-800 text-slate-100 border-slate-700'
        }">
        <span>📐</span><span>Measure</span>
      </button>
      <button id="bpFsExitBtn" type="button" title="Exit Fullscreen"
        class="h-8 px-2.5 rounded-lg bg-slate-900/95 hover:bg-slate-800 border border-slate-700 text-xs font-bold text-slate-100 shadow-lg flex items-center gap-1">
        <span>⤡</span><span>Exit</span>
      </button>
    `;

    document.getElementById('bpFsQuickMeasureBtn').onclick = () => setMeasureActive(!mState.active);
    document.getElementById('bpFsExitBtn').onclick = () => setFullscreen(false);
  }

  // =========================================================================
  // 5. DOM INJECTION & RESPONSIVE STYLING
  // =========================================================================
  function injectStyles() {
    let style = document.getElementById('bpMeasureStyles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'bpMeasureStyles';
      document.head.appendChild(style);
    }
    style.textContent = `
      #viewBlueprints.bp-measure-active #bpCalloutOverlayLayer {
        pointer-events: none !important;
      }
      #viewBlueprints.bp-measure-active #bpCanvasViewport,
      #viewBlueprints.bp-measure-active #bpCanvasViewport.cursor-grab,
      #viewBlueprints.bp-measure-active #bpCanvasViewport.cursor-grabbing,
      #viewBlueprints.bp-measure-active #bpDrawingStage {
        cursor: crosshair !important;
      }
      #viewBlueprints.bp-measure-active [data-bp-measure-ui] {
        cursor: default !important;
      }
      #viewBlueprints.bp-measure-active [data-bp-measure-ui] button {
        cursor: pointer !important;
      }
      #viewBlueprints.bp-measure-active [data-bp-measure-ui] input {
        cursor: text !important;
      }

      /* Clean Blueprints Action Bar (No horizontal overflow + Hidden when empty) */
      .bp-action-row {
        display: flex !important;
        flex-wrap: nowrap !important;
        align-items: center !important;
        gap: 6px !important;
        overflow: visible !important;
      }
      .bp-action-row #bpToggleMeasureBtn {
        margin-left: auto !important;
      }
      .bp-action-row.bp-action-row-empty {
        display: none !important;
      }

      /* Secondary Tools Popover */
      #bpToolsPopoverMenu {
        position: fixed;
        z-index: 88;
        width: 244px;
        max-width: calc(100vw - 16px);
        padding: 6px;
        border-radius: 10px;
        background-color: #0f172a;
        border: 1px solid #334155;
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.6);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      #bpToolsPopoverMenu.hidden {
        display: none !important;
      }
      #bpToolsPopoverMenu > *:not(.hidden) {
        width: 100% !important;
        display: flex !important;
        align-items: center !important;
        justify-content: flex-start !important;
        gap: 8px !important;
        padding: 8px 10px !important;
        border-radius: 6px !important;
        font-size: 12px !important;
        text-align: left !important;
        margin: 0 !important;
      }
      html.act-light #bpToolsPopoverMenu {
        background-color: #ffffff !important;
        border-color: #94a3b8 !important;
        box-shadow: 0 12px 28px rgba(15, 23, 42, 0.18) !important;
      }

      #bpMeasureStageLayer {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 30;
        --bp-inv-zoom: 1;
      }
      #bpMeasureSvg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: visible;
        pointer-events: none;
      }
      .bp-m-handle {
        position: absolute;
        width: 30px;
        height: 30px;
        transform: translate(-50%, -50%) scale(var(--bp-inv-zoom, 1));
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: move;
        pointer-events: auto;
        touch-action: none;
        z-index: 35;
      }
      .bp-m-handle.is-dimmed {
        opacity: 0.25;
      }
      .bp-m-handle.is-close-target {
        cursor: pointer !important;
        z-index: 38;
      }
      .bp-m-handle.is-dragging {
        cursor: crosshair !important;
      }
      .bp-m-handle-dot {
        width: 11px;
        height: 11px;
        border-radius: 9999px;
        border: 2px solid #ffffff;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.75);
        transition: transform 120ms ease;
      }
      .bp-m-handle.is-highlighted .bp-m-handle-dot {
        width: 13px;
        height: 13px;
        box-shadow: 0 0 0 4px rgba(251, 191, 36, 0.45), 0 1px 6px rgba(0, 0, 0, 0.85);
      }
      .bp-m-handle.is-close-target .bp-m-handle-dot {
        width: 14px;
        height: 14px;
        box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.45), 0 1px 6px rgba(0, 0, 0, 0.85);
      }
      .bp-m-handle.is-close-target:hover .bp-m-handle-dot {
        transform: scale(1.2);
      }
      .bp-m-handle.is-dragging .bp-m-handle-dot {
        width: 15px;
        height: 15px;
        box-shadow: 0 0 0 6px rgba(16, 185, 129, 0.35), 0 1px 6px rgba(0,0,0,0.8);
      }
      .bp-m-label {
        position: absolute;
        transform: translate(-50%, -50%) scale(var(--bp-inv-zoom, 1));
        padding: 2px 7px;
        border-radius: 9999px;
        font-size: 11px;
        font-weight: 800;
        line-height: 1.25;
        white-space: nowrap;
        pointer-events: none;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.55);
        z-index: 32;
      }
      .bp-m-label.is-highlighted {
        z-index: 36;
        padding: 3px 9px;
        font-size: 12px;
        box-shadow: 0 0 0 3px rgba(251, 191, 36, 0.45), 0 3px 10px rgba(0, 0, 0, 0.75);
      }

      /* Fullscreen Focus Mode */
      body.bp-focus-fullscreen > header {
        display: none !important;
      }
      body.bp-focus-fullscreen #viewBlueprints {
        top: 0 !important;
        height: 100dvh !important;
        max-height: 100dvh !important;
      }
      body.bp-focus-fullscreen .bp-fs-chrome {
        display: none !important;
      }

      /* Collapsed Measure Dock Pill (Portrait & Landscape) */
      #bpMeasureDock.is-collapsed {
        left: auto !important;
        right: 10px !important;
        bottom: 10px !important;
        transform: none !important;
        width: auto !important;
        max-width: calc(100% - 20px) !important;
        padding: 6px 10px !important;
        border-radius: 10px !important;
      }

      /* Phone Landscape Single-Row Measure Bar */
      @media (orientation: landscape) and (max-height: 540px) {
        #bpMeasureDock:not(.is-collapsed) {
          left: 8px !important;
          right: 8px !important;
          bottom: 6px !important;
          transform: none !important;
          width: auto !important;
          max-width: none !important;
          padding: 5px 8px !important;
          border-radius: 10px !important;
          display: flex !important;
          flex-direction: row !important;
          align-items: center !important;
          gap: 6px !important;
          overflow-x: auto !important;
          scrollbar-width: none;
        }
        #bpMeasureDock:not(.is-collapsed)::-webkit-scrollbar {
          display: none;
        }
        #bpMeasureDock:not(.is-collapsed) > * {
          margin-top: 0 !important;
        }
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-header,
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-tools {
          display: contents !important;
        }
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-scale-info,
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-note,
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-eyebrow,
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-tool-lbl,
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-clear-extra,
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-land-full {
          display: none !important;
        }
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-land-short {
          display: inline !important;
        }
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-tools-left {
          order: 1;
          flex-shrink: 0;
          gap: 4px !important;
        }
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-readout {
          order: 2;
          flex: 1 1 auto;
          min-width: 140px;
          padding: 4px 8px !important;
          border-radius: 6px !important;
        }
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-readout-val {
          font-size: 13px !important;
          line-height: 1.2 !important;
          white-space: nowrap;
        }
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-tools-right {
          order: 3;
          flex-shrink: 0;
          gap: 4px !important;
        }
        #bpMeasureDock:not(.is-collapsed) .bp-mdock-header-actions {
          order: 4;
          flex-shrink: 0;
          gap: 4px !important;
        }
        #bpMeasureDock:not(.is-collapsed) button {
          padding-top: 5px !important;
          padding-bottom: 5px !important;
          padding-left: 8px !important;
          padding-right: 8px !important;
          border-radius: 6px !important;
          font-size: 11px !important;
        }
        #bpMeasureTotalsWrap {
          top: 6px !important;
          left: 8px !important;
          transform: none !important;
          width: auto !important;
          max-width: min(360px, calc(100% - 175px)) !important;
          align-items: flex-start !important;
        }
        #bpMeasureTotalsWrap #bpTotalsToggleBtn {
          padding: 5px 10px !important;
          font-size: 11px !important;
          border-radius: 6px !important;
        }
        #bpMeasureTotalsWrap .bp-totals-scroll {
          max-height: 46dvh !important;
        }
        #bpMeasureTopBanner {
          top: 6px !important;
          padding: 5px 10px !important;
          font-size: 11px !important;
        }
      }
    `;
  }

  function ensureToolbarButtons() {
    const actionRow = findActionToolbarRow();
    if (!actionRow) return;

    if (!document.getElementById('bpToggleMeasureBtn')) {
      const btn = document.createElement('button');
      btn.id = 'bpToggleMeasureBtn';
      btn.type = 'button';
      btn.className =
        'h-8 px-2.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-600/80 flex items-center gap-1 transition shrink-0';
      btn.title = 'Measure Distance & Area';
      btn.innerHTML = `<span>📐</span><span>Measure</span>`;
      btn.addEventListener('click', () => {
        const s = getViewerState();
        if (!s?.activeDoc) {
          toast('Open a blueprint first to measure.', 'info');
          return;
        }
        closeToolsPopover();
        setMeasureActive(!mState.active);
      });
      actionRow.appendChild(btn);
    }

    if (!document.getElementById('bpToggleFullscreenBtn')) {
      const fsBtn = document.createElement('button');
      fsBtn.id = 'bpToggleFullscreenBtn';
      fsBtn.type = 'button';
      fsBtn.className =
        'h-8 px-2.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-600/80 flex items-center gap-1 transition shrink-0';
      fsBtn.title = 'Fullscreen Drawing View';
      fsBtn.innerHTML = `<span>⛶</span><span>Full</span>`;
      fsBtn.addEventListener('click', () => {
        const s = getViewerState();
        if (!s?.activeDoc) {
          toast('Open a blueprint first.', 'info');
          return;
        }
        setFullscreen(!mState.fullscreen);
      });
      actionRow.appendChild(fsBtn);
    }

    organizeToolbarOverflow();
  }

  function ensureStageLayer() {
    const stage = document.getElementById('bpDrawingStage');
    if (!stage) return null;

    let layer = document.getElementById('bpMeasureStageLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'bpMeasureStageLayer';
      layer.innerHTML = `<svg id="bpMeasureSvg"></svg><div id="bpMeasureHtmlLayer"></div>`;
      stage.appendChild(layer);
    }
    return layer;
  }

  function ensureFloatingDock() {
    const viewport = document.getElementById('bpCanvasViewport');
    if (!viewport) return;

    if (!document.getElementById('bpFullscreenFloatBar')) {
      const fsFloat = document.createElement('div');
      fsFloat.id = 'bpFullscreenFloatBar';
      fsFloat.setAttribute('data-bp-measure-ui', '1');
      fsFloat.className = 'hidden absolute top-2 right-2 z-50 flex items-center gap-1.5';
      viewport.appendChild(fsFloat);
    }

    if (!document.getElementById('bpMeasureTopBanner')) {
      const topBanner = document.createElement('div');
      topBanner.id = 'bpMeasureTopBanner';
      topBanner.setAttribute('data-bp-measure-ui', '1');
      topBanner.className =
        'hidden absolute top-3 left-1/2 -translate-x-1/2 z-40 max-w-[94%] px-3.5 py-2 rounded-xl bg-amber-500 text-slate-950 font-bold text-xs shadow-xl flex items-center gap-2.5';
      viewport.appendChild(topBanner);
    }

    if (!document.getElementById('bpMeasureTotalsWrap')) {
      const totalsWrap = document.createElement('div');
      totalsWrap.id = 'bpMeasureTotalsWrap';
      totalsWrap.setAttribute('data-bp-measure-ui', '1');
      totalsWrap.className =
        'hidden absolute top-3 left-1/2 -translate-x-1/2 z-40 w-[94%] max-w-md flex flex-col items-center';
      totalsWrap.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
      viewport.appendChild(totalsWrap);
    }

    if (!document.getElementById('bpMeasureDock')) {
      const dock = document.createElement('div');
      dock.id = 'bpMeasureDock';
      dock.setAttribute('data-bp-measure-ui', '1');
      dock.className =
        'hidden absolute bottom-3 left-1/2 -translate-x-1/2 z-40 w-[95%] max-w-xl rounded-2xl bg-slate-900/95 border border-slate-700/90 shadow-2xl backdrop-blur p-3 text-slate-100 space-y-2.5';
      viewport.appendChild(dock);
    }
  }

  function ensureScaleModal() {
    if (document.getElementById('bpScaleModal')) return;

    const modal = document.createElement('div');
    modal.id = 'bpScaleModal';
    modal.setAttribute('data-bp-measure-ui', '1');
    modal.className =
      'hidden fixed inset-0 z-[90] bg-slate-950/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4';
    modal.innerHTML = `
      <div class="w-full max-w-md rounded-t-3xl sm:rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden text-slate-100">
        <div class="flex items-center justify-between px-4 py-3.5 border-b border-slate-800">
          <div>
            <h3 id="bpScaleModalTitle" class="text-base font-extrabold text-white">Set Sheet Scale</h3>
            <p id="bpScaleModalSub" class="text-[11px] text-slate-400">Applies to this page for all users</p>
          </div>
          <button id="bpScaleModalCloseBtn" type="button"
            class="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-xl leading-none text-slate-300">&times;</button>
        </div>
        <div id="bpScaleModalBody" class="p-4 space-y-3.5 max-h-[80vh] overflow-y-auto"></div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeScaleModal();
    });
    document.getElementById('bpScaleModalCloseBtn').onclick = closeScaleModal;
  }

  function ensureCalibrationLengthModal() {
    if (document.getElementById('bpCalLengthModal')) return;

    const modal = document.createElement('div');
    modal.id = 'bpCalLengthModal';
    modal.setAttribute('data-bp-measure-ui', '1');
    modal.className =
      'hidden fixed inset-0 z-[92] bg-slate-950/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4';
    modal.innerHTML = `
      <div class="w-full max-w-sm rounded-t-3xl sm:rounded-2xl bg-slate-900 border border-amber-500/40 shadow-2xl overflow-hidden text-slate-100">
        <div class="flex items-center justify-between px-4 py-3.5 border-b border-slate-800">
          <h3 class="text-base font-extrabold text-amber-300">Enter Known Length</h3>
          <button id="bpCalLenCancelX" type="button"
            class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-lg leading-none text-slate-300">&times;</button>
        </div>
        <div class="p-4 space-y-3.5">
          <p class="text-xs text-slate-300">Enter the printed dimension between the two points you just placed on the drawing.</p>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-[11px] font-bold text-slate-400 mb-1">Feet</label>
              <input id="bpCalFeetInput" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 20"
                class="w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-base font-bold text-white focus:outline-none focus:border-emerald-500" />
            </div>
            <div>
              <label class="block text-[11px] font-bold text-slate-400 mb-1">Inches (optional)</label>
              <input id="bpCalInchesInput" type="number" inputmode="decimal" min="0" step="any" placeholder="0"
                class="w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-base font-bold text-white focus:outline-none focus:border-emerald-500" />
            </div>
          </div>
          <div class="flex gap-2 pt-1">
            <button id="bpCalLenRepickBtn" type="button"
              class="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 border border-slate-700">
              Re-Pick Points
            </button>
            <button id="bpCalLenSaveBtn" type="button"
              class="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-xs font-extrabold text-slate-950">
              Save Scale
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const cancel = () => {
      modal.classList.add('hidden');
      mState.calPoints = [];
      mState.tool = 'distance';
      renderMeasureUI();
    };
    document.getElementById('bpCalLenCancelX').onclick = cancel;
    document.getElementById('bpCalLenRepickBtn').onclick = () => {
      modal.classList.add('hidden');
      mState.calPoints = [];
      mState.tool = 'calibrate';
      renderMeasureUI();
    };
    document.getElementById('bpCalLenSaveBtn').onclick = async () => {
      const s = getViewerState();
      if (!s || mState.calPoints.length < 2) return;

      const feetVal = parseFloat(document.getElementById('bpCalFeetInput').value || '0');
      const inchesVal = parseFloat(document.getElementById('bpCalInchesInput').value || '0');
      const totalFeet = (isNaN(feetVal) ? 0 : feetVal) + (isNaN(inchesVal) ? 0 : inchesVal) / 12;
      if (totalFeet <= 0) {
        toast('Enter a length greater than 0.', 'warning');
        return;
      }

      const [p1, p2] = mState.calPoints;
      const dxPx = (p2.x - p1.x) * (s.stageW || 1);
      const dyPx = (p2.y - p1.y) * (s.stageH || 1);
      const distPx = Math.hypot(dxPx, dyPx);
      if (distPx < 4) {
        toast('Those two points are too close together. Pick across a longer dimension.', 'warning');
        return;
      }

      const ftPerPx = totalFeet / distPx;
      const widthFt = (s.stageW || 1) * ftPerPx;
      const heightFt = (s.stageH || 1) * ftPerPx;
      const label = `Calibrated (${formatFeetInches(totalFeet)} ref)`;

      modal.classList.add('hidden');
      await saveScaleForActivePage({
        scaleLabel: label,
        mode: 'calibrated',
        widthFt,
        heightFt
      });
    };
  }

  // =========================================================================
  // 6. SCALE MODAL (SUPERVISOR / PM / ADMIN ONLY)
  // =========================================================================
  function openScaleModal() {
    const s = getViewerState();
    if (!s?.activeDoc) return;
    if (!s.canCalibrate) {
      toast('Only Supervisors, PMs, and Admins can calibrate sheets.', 'warning');
      return;
    }

    ensureScaleModal();
    const modal = document.getElementById('bpScaleModal');
    const titleEl = document.getElementById('bpScaleModalTitle');
    const subEl = document.getElementById('bpScaleModalSub');
    if (titleEl) titleEl.textContent = mState.pageScale ? 'Recalibrate Sheet Scale' : 'Set Sheet Scale';
    if (subEl) subEl.textContent = `${s.activeDoc.name} • Page ${s.activePage}`;

    renderScaleModalBody();
    modal.classList.remove('hidden');
  }

  function closeScaleModal() {
    document.getElementById('bpScaleModal')?.classList.add('hidden');
  }

  function renderScaleModalBody() {
    const body = document.getElementById('bpScaleModalBody');
    const s = getViewerState();
    if (!body || !s) return;

    const existingHtml = mState.pageScale
      ? `
        <div class="rounded-xl bg-amber-500/15 border border-amber-400/40 p-3 text-xs text-amber-100">
          <div class="font-bold text-amber-300">Current Shared Scale: ${esc(mState.pageScale.scale_label)}</div>
          <div class="text-[11px] text-amber-200/80 mt-0.5">
            Last set by ${esc(mState.pageScale.calibrated_by || 'Supervisor')}${mState.pageScale.updated_at ? ` on ${esc(formatShortDate(mState.pageScale.updated_at))}` : ''}. Recalibrating updates this page for everyone.
          </div>
        </div>
      `
      : '';

    const tabsHtml = `
      <div class="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-950 border border-slate-800">
        <button data-scale-tab="two_point" type="button"
          class="py-2 rounded-lg text-xs font-bold transition ${mState.modalTab === 'two_point' ? 'bg-emerald-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800'}">
          2-Point Calibrate
        </button>
        <button data-scale-tab="preset" type="button"
          class="py-2 rounded-lg text-xs font-bold transition ${mState.modalTab === 'preset' ? 'bg-emerald-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800'}">
          Standard Presets
        </button>
      </div>
    `;

    let contentHtml = '';
    if (mState.modalTab === 'two_point') {
      contentHtml = `
        <div class="rounded-xl bg-slate-800/70 border border-slate-700 p-3.5 space-y-2.5 text-xs text-slate-300">
          <div class="font-bold text-sm text-white">Most Accurate Method</div>
          <ol class="list-decimal list-inside space-y-1 text-slate-300">
            <li>Zoom into a long printed dimension (like a 20'–40' grid bay or wall).</li>
            <li>Tap both ends of that dimension line.</li>
            <li>Enter the printed length to lock in the scale for the whole crew.</li>
          </ol>
          <button id="bpStartTwoPointCalBtn" type="button"
            class="w-full mt-2 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-sm shadow-lg transition">
            Start 2-Point Calibration
          </button>
        </div>
      `;
    } else {
      const paperWIn = (s.stageW / 72).toFixed(1);
      const paperHIn = (s.stageH / 72).toFixed(1);
      const renderButtons = (list) =>
        list
          .map(
            (p) => `
              <button type="button" data-preset-label="${esc(p.label)}" data-preset-ftperin="${p.ftPerIn}"
                class="py-2.5 px-2 rounded-xl bg-slate-800 hover:bg-emerald-500/20 hover:border-emerald-400/50 border border-slate-700 text-xs font-bold text-slate-100 transition">
                ${esc(p.label)}
              </button>
            `
          )
          .join('');

      contentHtml = `
        <div class="space-y-3">
          <div class="text-[11px] text-slate-400">
            Detected PDF sheet size: <strong class="text-slate-200">${paperWIn}" × ${paperHIn}"</strong>. Best for native CAD PDFs (use 2-Point Calibrate for scanned or fit-to-page sheets).
          </div>
          <div>
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Architectural</div>
            <div class="grid grid-cols-3 gap-1.5">${renderButtons(ARCHITECTURAL_PRESETS)}</div>
          </div>
          <div>
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Civil / Engineering</div>
            <div class="grid grid-cols-3 gap-1.5">${renderButtons(ENGINEERING_PRESETS)}</div>
          </div>
        </div>
      `;
    }

    body.innerHTML = `${existingHtml}${tabsHtml}${contentHtml}`;

    body.querySelectorAll('[data-scale-tab]').forEach((btn) => {
      btn.onclick = () => {
        mState.modalTab = btn.getAttribute('data-scale-tab');
        renderScaleModalBody();
      };
    });

    const startCalBtn = document.getElementById('bpStartTwoPointCalBtn');
    if (startCalBtn) {
      startCalBtn.onclick = () => {
        closeScaleModal();
        mState.calPoints = [];
        mState.tool = 'calibrate';
        mState.totalsDropdownOpen = false;
        mState.dockCollapsed = false;
        renderMeasureUI();
      };
    }

    body.querySelectorAll('[data-preset-ftperin]').forEach((btn) => {
      btn.onclick = async () => {
        const label = btn.getAttribute('data-preset-label');
        const ftPerIn = parseFloat(btn.getAttribute('data-preset-ftperin'));
        const cur = getViewerState();
        if (!cur || !isFinite(ftPerIn)) return;
        const widthFt = (cur.stageW / 72) * ftPerIn;
        const heightFt = (cur.stageH / 72) * ftPerIn;
        const saved = await saveScaleForActivePage({
          scaleLabel: label,
          mode: 'preset',
          widthFt,
          heightFt
        });
        if (saved) closeScaleModal();
      };
    });
  }

  // =========================================================================
  // 7. OVERLAY RENDERING (SVG LINES/POLYGONS + HIGHLIGHTING + HANDLES/LABELS)
  // =========================================================================
  function updateZoomScaleVar(zoom) {
    const layer = document.getElementById('bpMeasureStageLayer');
    if (!layer) return;
    const inv = 1 / Math.max(Number(zoom) || 1, 0.15);
    layer.style.setProperty('--bp-inv-zoom', inv.toFixed(4));
  }

  function getActiveShape() {
    if (!mState.activeShapeId) return null;
    return mState.shapes.find((sh) => sh.id === mState.activeShapeId) || null;
  }

  function renderOverlayGraphics() {
    const s = getViewerState();
    const layer = ensureStageLayer();
    const svg = document.getElementById('bpMeasureSvg');
    const htmlLayer = document.getElementById('bpMeasureHtmlLayer');
    if (!layer || !svg || !htmlLayer) return;

    if (!mState.active || !s?.activeDoc) {
      svg.innerHTML = '';
      htmlLayer.innerHTML = '';
      return;
    }

    updateZoomScaleVar(s.zoom);
    const W = s.stageW || 1000;
    const H = s.stageH || 1000;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';
    htmlLayer.innerHTML = '';

    const hasSelection = Boolean(
      mState.selectedShapeId && mState.shapes.some((sh) => sh.id === mState.selectedShapeId)
    );

    const addSvgEl = (tag, attrs) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      svg.appendChild(el);
      return el;
    };

    const addLabel = (nx, ny, text, bgClass, isHighlighted = false) => {
      const div = document.createElement('div');
      div.className = `bp-m-label ${bgClass}${isHighlighted ? ' is-highlighted' : ''}`;
      div.style.left = `${(nx * 100).toFixed(4)}%`;
      div.style.top = `${(ny * 100).toFixed(4)}%`;
      div.textContent = text;
      htmlLayer.appendChild(div);
    };

    const addHandle = (nx, ny, dotBg, meta) => {
      const h = document.createElement('div');
      const classes = ['bp-m-handle'];
      if (meta.isCloseTarget) classes.push('is-close-target');
      if (meta.isDimmed) classes.push('is-dimmed');
      if (meta.isHighlighted) classes.push('is-highlighted');
      h.className = classes.join(' ');
      h.style.left = `${(nx * 100).toFixed(4)}%`;
      h.style.top = `${(ny * 100).toFixed(4)}%`;
      if (meta.isCloseTarget) {
        h.title = 'Click to close & finish measurement';
      }
      h.innerHTML = `<div class="bp-m-handle-dot" style="background:${dotBg};"></div>`;

      if (meta.isCloseTarget) {
        h.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const shape = mState.shapes.find((sh) => sh.id === meta.shapeId);
          if (shape && !shape.closed && shape.points.length >= 3) {
            shape.closed = true;
            mState.activeShapeId = null;
            renderMeasureUI();
          }
        });
        htmlLayer.appendChild(h);
        return;
      }

      h.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        const cur = getViewerState();
        mState.draggingHandle = {
          pointerId: e.pointerId,
          el: h,
          meta,
          startClientX: e.clientX,
          startClientY: e.clientY,
          origX: nx,
          origY: ny,
          zoom: cur?.zoom || 1,
          stageW: cur?.stageW || 1,
          stageH: cur?.stageH || 1,
          moved: false
        };
      });

      h.addEventListener('pointermove', (e) => {
        const d = mState.draggingHandle;
        if (!d || d.pointerId !== e.pointerId) return;
        e.stopPropagation();
        const dxScreen = e.clientX - d.startClientX;
        const dyScreen = e.clientY - d.startClientY;

        if (!d.moved) {
          if (Math.hypot(dxScreen, dyScreen) <= 6) return;
          d.moved = true;
          d.el.classList.add('is-dragging');
        }

        const nextX = Math.max(0, Math.min(1, d.origX + dxScreen / (d.zoom * d.stageW)));
        const nextY = Math.max(0, Math.min(1, d.origY + dyScreen / (d.zoom * d.stageH)));

        if (d.meta.kind === 'cal') {
          if (mState.calPoints[d.meta.idx]) {
            mState.calPoints[d.meta.idx] = { x: nextX, y: nextY };
          }
        } else {
          const shape = mState.shapes.find((sh) => sh.id === d.meta.shapeId);
          if (shape && shape.points[d.meta.idx]) {
            shape.points[d.meta.idx] = { x: nextX, y: nextY };
          }
        }
        renderOverlayGraphics();
        renderTopTotalsDropdown();
        renderDock();
      });

      const finishDrag = (e) => {
        const d = mState.draggingHandle;
        if (!d || d.pointerId !== e.pointerId) return;
        e.stopPropagation();
        d.el.classList.remove('is-dragging');

        if (d.moved && d.meta.kind === 'shape') {
          const shape = mState.shapes.find((sh) => sh.id === d.meta.shapeId);
          if (shape && shape.saved) {
            saveShapesToSupabase([shape], { silent: true });
          }
        }
        mState.draggingHandle = null;
      };

      h.addEventListener('pointerup', finishDrag);
      h.addEventListener('pointercancel', finishDrag);
      htmlLayer.appendChild(h);
    };

    if (mState.tool === 'calibrate' && mState.calPoints.length > 0) {
      if (mState.calPoints.length === 2) {
        const [p1, p2] = mState.calPoints;
        addSvgEl('line', {
          x1: p1.x * W,
          y1: p1.y * H,
          x2: p2.x * W,
          y2: p2.y * H,
          stroke: '#f59e0b',
          'stroke-width': 3,
          'stroke-dasharray': '7 5',
          'vector-effect': 'non-scaling-stroke'
        });
      }
      mState.calPoints.forEach((pt, idx) => {
        addHandle(pt.x, pt.y, '#f59e0b', { kind: 'cal', idx });
      });
    }

    const scale = mState.pageScale;
    const orderedShapes = [...mState.shapes].sort((a, b) => {
      if (a.id === mState.selectedShapeId) return 1;
      if (b.id === mState.selectedShapeId) return -1;
      return 0;
    });

    for (const shape of orderedShapes) {
      const pts = shape.points;
      if (!pts.length) continue;

      const isSelected = hasSelection && shape.id === mState.selectedShapeId;
      const isDimmed = hasSelection && !isSelected;
      const strokeOpacity = isDimmed ? '0.2' : '1';

      if (shape.type === 'distance') {
        const { segments } = computeDistanceMetrics(pts, scale, shape.closed);
        for (const seg of segments) {
          if (isSelected) {
            addSvgEl('line', {
              x1: seg.a.x * W,
              y1: seg.a.y * H,
              x2: seg.b.x * W,
              y2: seg.b.y * H,
              stroke: '#fbbf24',
              'stroke-width': 9,
              'stroke-opacity': '0.45',
              'stroke-linecap': 'round',
              'vector-effect': 'non-scaling-stroke'
            });
          }
          addSvgEl('line', {
            x1: seg.a.x * W,
            y1: seg.a.y * H,
            x2: seg.b.x * W,
            y2: seg.b.y * H,
            stroke: isSelected ? '#fbbf24' : '#38bdf8',
            'stroke-width': isSelected ? 4 : 3,
            'stroke-opacity': strokeOpacity,
            'stroke-linecap': 'round',
            'vector-effect': 'non-scaling-stroke'
          });
          if (scale && !isDimmed) {
            addLabel(
              (seg.a.x + seg.b.x) / 2,
              (seg.a.y + seg.b.y) / 2,
              formatFeetInches(seg.len),
              isSelected
                ? 'bg-amber-400 text-slate-950 border-2 border-white'
                : 'bg-sky-500 text-slate-950 border border-white/60',
              isSelected
            );
          }
        }
        pts.forEach((pt, idx) => {
          const isStartCloseable =
            idx === 0 && !shape.closed && shape.id === mState.activeShapeId && pts.length >= 3;
          addHandle(pt.x, pt.y, isStartCloseable || isSelected ? '#f59e0b' : '#0284c7', {
            kind: 'shape',
            shapeId: shape.id,
            idx,
            isCloseTarget: isStartCloseable,
            isDimmed,
            isHighlighted: isSelected
          });
        });
      } else if (shape.type === 'area') {
        const { areaSqFt, edges, centroid } = computeAreaMetrics(pts, scale);
        if (pts.length >= 3) {
          addSvgEl('polygon', {
            points: pts.map((p) => `${(p.x * W).toFixed(2)},${(p.y * H).toFixed(2)}`).join(' '),
            fill: isSelected ? 'rgba(16, 185, 129, 0.34)' : 'rgba(16, 185, 129, 0.22)',
            'fill-opacity': isDimmed ? '0.2' : '1',
            stroke: 'none'
          });
        }
        for (const edge of edges) {
          if (isSelected) {
            addSvgEl('line', {
              x1: edge.a.x * W,
              y1: edge.a.y * H,
              x2: edge.b.x * W,
              y2: edge.b.y * H,
              stroke: '#fbbf24',
              'stroke-width': 8,
              'stroke-opacity': '0.45',
              'stroke-linecap': 'round',
              'vector-effect': 'non-scaling-stroke'
            });
          }
          addSvgEl('line', {
            x1: edge.a.x * W,
            y1: edge.a.y * H,
            x2: edge.b.x * W,
            y2: edge.b.y * H,
            stroke: isSelected ? '#34d399' : '#10b981',
            'stroke-width': isSelected ? 3.75 : 2.75,
            'stroke-opacity': strokeOpacity,
            'stroke-dasharray': edge.isClosing && !shape.closed ? '6 5' : '',
            'vector-effect': 'non-scaling-stroke'
          });
          if (scale && edge.len > 0 && !isDimmed) {
            addLabel(
              (edge.a.x + edge.b.x) / 2,
              (edge.a.y + edge.b.y) / 2,
              formatFeetInches(edge.len),
              isSelected
                ? 'bg-amber-400 text-slate-950 border-2 border-white'
                : 'bg-slate-900/90 text-emerald-300 border border-emerald-500/60',
              isSelected
            );
          }
        }
        if (scale && centroid && pts.length >= 3 && !isDimmed) {
          addLabel(
            centroid.x,
            centroid.y,
            formatSqFt(areaSqFt),
            isSelected
              ? 'bg-emerald-400 text-slate-950 border-2 border-white'
              : 'bg-emerald-500 text-slate-950 border border-white/70',
            isSelected
          );
        }
        pts.forEach((pt, idx) => {
          const isStartCloseable =
            idx === 0 && !shape.closed && shape.id === mState.activeShapeId && pts.length >= 3;
          addHandle(pt.x, pt.y, isStartCloseable || isSelected ? '#f59e0b' : '#10b981', {
            kind: 'shape',
            shapeId: shape.id,
            idx,
            isCloseTarget: isStartCloseable,
            isDimmed,
            isHighlighted: isSelected
          });
        });
      }
    }
  }

  // =========================================================================
  // 8. TOP MEASURED TOTALS DROPDOWN, CALIBRATION BANNER & FLOATING DOCK
  // =========================================================================
  function renderTopBanner() {
    const banner = document.getElementById('bpMeasureTopBanner');
    if (!banner) return;

    if (!mState.active || mState.tool !== 'calibrate') {
      banner.classList.add('hidden');
      return;
    }

    const stepText =
      mState.calPoints.length === 0
        ? 'Calibrate: Tap the START of a known dimension (pan & zoom freely)'
        : 'Calibrate: Tap the END of that dimension';

    banner.innerHTML = `
      <span>📏 ${esc(stepText)}</span>
      <button id="bpCalCancelBannerBtn" type="button"
        class="px-2 py-0.5 rounded-lg bg-slate-950/20 hover:bg-slate-950/35 text-slate-950 text-[11px] font-extrabold">
        Cancel
      </button>
    `;
    banner.classList.remove('hidden');

    document.getElementById('bpCalCancelBannerBtn').onclick = () => {
      mState.calPoints = [];
      mState.tool = 'distance';
      renderMeasureUI();
    };
  }

  function renderTopTotalsDropdown() {
    const wrap = document.getElementById('bpMeasureTotalsWrap');
    const s = getViewerState();
    if (!wrap) return;

    const measurable = mState.shapes.filter(isMeasurableShape);
    if (!mState.active || !s?.activeDoc || !mState.pageScale || mState.tool === 'calibrate' || measurable.length === 0) {
      wrap.classList.add('hidden');
      return;
    }

    wrap.classList.remove('hidden');
    const scale = mState.pageScale;
    const selectedIdx = mState.selectedShapeId
      ? measurable.findIndex((sh) => sh.id === mState.selectedShapeId)
      : -1;
    const selectedShape = selectedIdx >= 0 ? measurable[selectedIdx] : null;
    const selectedSummary = selectedShape ? getShapeSummary(selectedShape, selectedIdx, scale) : null;

    const unsavedShapes = measurable.filter((sh) => !sh.saved);
    const savedCount = measurable.length - unsavedShapes.length;

    const triggerLabel = selectedSummary
      ? `<span class="w-2 h-2 rounded-full bg-amber-400 shrink-0"></span>
         <span class="truncate">${esc(selectedSummary.title)}: <strong class="text-amber-300">${esc(selectedSummary.primaryTotal)}</strong></span>`
      : `<span class="w-2 h-2 rounded-full ${savedCount === measurable.length ? 'bg-emerald-400' : 'bg-sky-400'} shrink-0"></span>
         <span class="truncate">Measured Totals (${measurable.length})</span>`;

    let menuHtml = '';
    if (mState.totalsDropdownOpen) {
      const itemsHtml = measurable
        .map((sh, idx) => {
          const sum = getShapeSummary(sh, idx, scale);
          const isSel = sh.id === mState.selectedShapeId;
          const dotColor = sh.saved ? 'bg-emerald-400' : 'bg-slate-500';
          const typeIcon = sh.type === 'area' ? '⬠' : '📏';

          return `
            <div class="rounded-xl border transition ${
              isSel
                ? 'bg-amber-500/15 border-amber-400/60'
                : 'bg-slate-950/75 border-slate-800 hover:border-slate-700'
            }">
              <div class="flex items-center gap-2 p-2.5">
                <button type="button" data-select-shape="${esc(sh.id)}"
                  class="flex-1 min-w-0 text-left flex items-start gap-2.5">
                  <span class="mt-1.5 w-2 h-2 rounded-full ${dotColor} shrink-0" title="${sh.saved ? 'Saved to your account' : 'Unsaved'}"></span>
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-bold ${isSel ? 'text-amber-200' : 'text-slate-200'} truncate">
                      ${typeIcon} ${esc(sum.title)}
                    </div>
                    <div class="text-sm font-extrabold text-white leading-tight mt-0.5">
                      ${esc(sum.primaryTotal)}
                      ${sum.secondaryTotal ? `<span class="text-[11px] font-semibold text-slate-400 ml-1">${esc(sum.secondaryTotal)}</span>` : ''}
                    </div>
                  </div>
                </button>

                <div class="flex items-center gap-1 shrink-0">
                  ${
                    !sh.saved
                      ? `<button type="button" data-save-shape="${esc(sh.id)}"
                          class="px-2.5 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-500/40 text-emerald-300 text-[11px] font-bold">
                          Save
                        </button>`
                      : `<button type="button" data-rename-shape="${esc(sh.id)}" title="Rename saved measurement"
                          class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold flex items-center justify-center">
                          ✎
                        </button>`
                  }
                  <button type="button" data-delete-shape="${esc(sh.id)}" title="Delete measurement"
                    class="w-8 h-8 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 border border-rose-500/30 text-rose-300 text-xs font-bold flex items-center justify-center">
                    ✕
                  </button>
                </div>
              </div>

              ${
                isSel && sum.segmentLabels.length > 0
                  ? `
                    <div class="px-3 pb-2.5 pt-1.5 border-t border-amber-400/25 flex flex-wrap gap-1.5">
                      ${sum.segmentLabels
                        .map(
                          (lbl) =>
                            `<span class="px-2 py-0.5 rounded-md bg-slate-900/90 border border-amber-400/40 text-[11px] font-bold text-amber-200">${esc(lbl)}</span>`
                        )
                        .join('')}
                    </div>
                  `
                  : ''
              }
            </div>
          `;
        })
        .join('');

      menuHtml = `
        <div class="mt-1.5 w-full rounded-2xl bg-slate-900/95 border border-slate-700/90 shadow-2xl backdrop-blur p-2.5 text-slate-100 space-y-2">
          <div class="flex items-center justify-between gap-2 px-1">
            <div class="text-[11px] text-slate-400 font-semibold">
              Tap to highlight • <span class="text-emerald-400">●</span> Saved (${savedCount})
            </div>
            <div class="flex items-center gap-1.5">
              ${
                selectedShape
                  ? `<button id="bpTotalsShowAllBtn" type="button"
                      class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-bold text-slate-200">
                      Show All
                    </button>`
                  : ''
              }
              ${
                unsavedShapes.length > 0
                  ? `<button id="bpTotalsSaveAllBtn" type="button" ${mState.isSaving ? 'disabled' : ''}
                      class="px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 text-[11px] font-extrabold">
                      ${mState.isSaving ? 'Saving...' : `Save All (${unsavedShapes.length})`}
                    </button>`
                  : ''
              }
            </div>
          </div>

          <div class="bp-totals-scroll max-h-[45vh] overflow-y-auto space-y-1.5 pr-0.5">
            ${itemsHtml}
          </div>
        </div>
      `;
    }

    wrap.innerHTML = `
      <div class="flex items-center gap-1.5 max-w-full">
        <button id="bpTotalsToggleBtn" type="button"
          class="px-3.5 py-2 rounded-xl bg-slate-900/95 hover:bg-slate-800 border ${
            selectedShape ? 'border-amber-400/70' : 'border-slate-700'
          } shadow-xl backdrop-blur text-xs font-bold text-slate-100 flex items-center gap-2 max-w-full">
          ${triggerLabel}
          <span class="text-slate-400 text-[10px] shrink-0">${mState.totalsDropdownOpen ? '▲' : '▼'}</span>
        </button>
        ${
          selectedShape
            ? `<button id="bpTotalsQuickClearSelBtn" type="button" title="Clear highlight"
                class="px-2.5 py-2 rounded-xl bg-slate-900/95 hover:bg-slate-800 border border-slate-700 shadow-xl text-xs font-bold text-slate-300 shrink-0">
                All
              </button>`
            : ''
        }
      </div>
      ${menuHtml}
    `;

    document.getElementById('bpTotalsToggleBtn').onclick = () => {
      mState.totalsDropdownOpen = !mState.totalsDropdownOpen;
      renderTopTotalsDropdown();
    };

    const quickAllBtn = document.getElementById('bpTotalsQuickClearSelBtn');
    if (quickAllBtn) {
      quickAllBtn.onclick = () => {
        mState.selectedShapeId = null;
        renderMeasureUI();
      };
    }

    const showAllBtn = document.getElementById('bpTotalsShowAllBtn');
    if (showAllBtn) {
      showAllBtn.onclick = () => {
        mState.selectedShapeId = null;
        renderMeasureUI();
      };
    }

    const saveAllBtn = document.getElementById('bpTotalsSaveAllBtn');
    if (saveAllBtn) {
      saveAllBtn.onclick = async () => {
        await saveShapesToSupabase(unsavedShapes);
      };
    }

    wrap.querySelectorAll('[data-select-shape]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-select-shape');
        mState.selectedShapeId = mState.selectedShapeId === id ? null : id;
        renderMeasureUI();
      };
    });

    wrap.querySelectorAll('[data-save-shape]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-save-shape');
        const sh = mState.shapes.find((item) => item.id === id);
        if (sh) await saveShapesToSupabase([sh]);
      };
    });

    wrap.querySelectorAll('[data-rename-shape]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-rename-shape');
        const sh = mState.shapes.find((item) => item.id === id);
        if (!sh) return;
        const nextName = prompt('Label for this measurement (e.g. "North Wall", "Main Slab"):', sh.name || '');
        if (nextName === null) return;
        sh.name = nextName.trim();
        await saveShapesToSupabase([sh], { silent: false });
      };
    });

    wrap.querySelectorAll('[data-delete-shape]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-delete-shape');
        await deleteShapeById(id);
      };
    });
  }

  function renderDock() {
    const dock = document.getElementById('bpMeasureDock');
    const s = getViewerState();
    if (!dock) return;

    if (!mState.active || !s?.activeDoc) {
      dock.classList.add('hidden');
      dock.classList.remove('is-collapsed');
      return;
    }

    dock.classList.remove('hidden');
    const scale = mState.pageScale;
    const canCal = Boolean(s.canCalibrate);

    const selectedShape = mState.selectedShapeId
      ? mState.shapes.find((sh) => sh.id === mState.selectedShapeId)
      : null;
    const displayShape =
      getActiveShape() || selectedShape || (mState.shapes.length > 0 ? mState.shapes[mState.shapes.length - 1] : null);

    if (mState.dockCollapsed && mState.tool !== 'calibrate') {
      dock.classList.add('is-collapsed');
      let compactLabel = mState.tool === 'area' ? 'Area' : 'Distance';
      if (displayShape && scale) {
        if (displayShape.type === 'distance' && displayShape.points.length >= 2) {
          compactLabel = formatFeetInches(computeDistanceMetrics(displayShape.points, scale, displayShape.closed).totalFt);
        } else if (displayShape.type === 'area' && displayShape.points.length >= 3) {
          compactLabel = formatSqFt(computeAreaMetrics(displayShape.points, scale).areaSqFt);
        }
      }
      const canSaveCompact = displayShape && isMeasurableShape(displayShape) && !displayShape.saved;

      dock.innerHTML = `
        <div class="flex items-center gap-2">
          <button id="bpDockExpandBtn" type="button"
            class="flex items-center gap-1.5 text-xs font-extrabold text-white">
            <span>📐</span>
            <span>${esc(compactLabel)}</span>
            <span class="text-slate-400 text-[10px]">▴</span>
          </button>
          ${
            canSaveCompact
              ? `<button id="bpDockSaveCurrentBtn" type="button"
                  class="px-2 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-extrabold">
                  Save
                </button>`
              : ''
          }
          <button id="bpDockCloseBtn" type="button"
            class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-rose-500/20 text-slate-300 text-[11px] font-bold">
            Done
          </button>
        </div>
      `;

      document.getElementById('bpDockExpandBtn').onclick = () => {
        mState.dockCollapsed = false;
        renderDock();
      };
      document.getElementById('bpDockCloseBtn').onclick = () => setMeasureActive(false);
      const saveCompactBtn = document.getElementById('bpDockSaveCurrentBtn');
      if (saveCompactBtn && displayShape) {
        saveCompactBtn.onclick = async () => {
          if (displayShape.type === 'area' && displayShape.points.length >= 3) {
            displayShape.closed = true;
          }
          await saveShapesToSupabase([displayShape]);
        };
      }
      return;
    }

    dock.classList.remove('is-collapsed');

    let readoutHtml = '';
    if (!scale) {
      readoutHtml = canCal
        ? `
          <div class="bp-mdock-readout rounded-xl bg-amber-500/15 border border-amber-400/40 px-3 py-2 flex items-center justify-between gap-2">
            <div class="bp-mdock-readout-val text-xs text-amber-200 font-semibold truncate">Sheet not calibrated yet.</div>
            <button id="bpDockSetScaleNowBtn" type="button"
              class="shrink-0 px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-extrabold text-xs">
              Set Scale
            </button>
          </div>
        `
        : `
          <div class="bp-mdock-readout rounded-xl bg-amber-500/15 border border-amber-400/40 px-3 py-2 text-xs text-amber-200 font-semibold truncate">
            Not calibrated — ask a Supervisor, PM, or Admin.
          </div>
        `;
    } else if (mState.tool === 'calibrate') {
      readoutHtml = `
        <div class="bp-mdock-readout rounded-xl bg-amber-500/15 border border-amber-400/40 px-3 py-2 text-xs text-amber-200 font-semibold">
          Placing calibration points (${mState.calPoints.length}/2)...
        </div>
      `;
    } else if (!displayShape) {
      readoutHtml = `
        <div class="bp-mdock-readout rounded-xl bg-slate-950/80 border border-slate-800 px-3 py-2 text-xs text-slate-300 truncate">
          ${
            mState.tool === 'distance'
              ? 'Tap points to measure distance (tap start dot to close).'
              : 'Tap 3+ corners around an area to measure sq ft.'
          }
        </div>
      `;
    } else if (displayShape.type === 'distance') {
      const { totalFt, segments } = computeDistanceMetrics(displayShape.points, scale, displayShape.closed);
      const headingLabel = displayShape.name
        ? displayShape.name
        : displayShape.closed
        ? `Perimeter (${segments.length} sides)`
        : `Distance ${segments.length > 1 ? `(${segments.length} segments)` : ''}`;
      const canSaveThis = displayShape.points.length >= 2 && !displayShape.saved;

      readoutHtml = `
        <div class="bp-mdock-readout rounded-xl bg-slate-950/90 border border-sky-500/40 px-3.5 py-2 flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="bp-mdock-eyebrow text-[10px] uppercase tracking-wider text-sky-400 font-bold truncate">
              ${esc(headingLabel)}
            </div>
            <div class="bp-mdock-readout-val text-lg font-extrabold text-white leading-tight truncate">
              ${displayShape.points.length >= 2 ? `${esc(formatFeetInches(totalFt))} <span class="text-xs font-semibold text-slate-400">(${esc(formatDecimalFeet(totalFt))})</span>` : 'Tap 2nd point...'}
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            ${
              canSaveThis
                ? `<button id="bpDockSaveCurrentBtn" type="button" class="px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-extrabold">Save</button>`
                : ''
            }
            ${
              displayShape.points.length >= 2 && mState.activeShapeId === displayShape.id && !displayShape.closed
                ? `<button id="bpDockNewShapeBtn" type="button" class="px-2.5 py-1.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 text-sky-200 text-xs font-bold">New</button>`
                : ''
            }
          </div>
        </div>
      `;
    } else {
      const { areaSqFt, perimeterFt } = computeAreaMetrics(displayShape.points, scale);
      const canSaveThis = displayShape.points.length >= 3 && !displayShape.saved;
      readoutHtml = `
        <div class="bp-mdock-readout rounded-xl bg-slate-950/90 border border-emerald-500/40 px-3.5 py-2 flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="bp-mdock-eyebrow text-[10px] uppercase tracking-wider text-emerald-400 font-bold truncate">
              ${esc(displayShape.name || 'Surface Area')}
            </div>
            <div class="bp-mdock-readout-val text-lg font-extrabold text-white leading-tight truncate">
              ${
                displayShape.points.length >= 3
                  ? `${esc(formatSqFt(areaSqFt))} <span class="text-xs font-semibold text-slate-400">• ${esc(formatFeetInches(perimeterFt))}</span>`
                  : `Tap ${3 - displayShape.points.length} more corner${displayShape.points.length === 2 ? '' : 's'}...`
              }
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            ${
              canSaveThis
                ? `<button id="bpDockSaveCurrentBtn" type="button" class="px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-extrabold">Save</button>`
                : ''
            }
            ${
              displayShape.points.length >= 3 && !displayShape.closed
                ? `<button id="bpDockFinishAreaBtn" type="button" class="px-2.5 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/40 text-emerald-200 text-xs font-bold">Finish</button>`
                : ''
            }
          </div>
        </div>
      `;
    }

    const scaleStatusHtml = scale
      ? `
        <div class="bp-mdock-scale-info flex items-center gap-2 min-w-0">
          <span class="w-2 h-2 rounded-full bg-emerald-400 shrink-0"></span>
          <span class="text-xs font-bold text-emerald-300 truncate">${esc(scale.scale_label)}</span>
          ${scale.calibrated_by ? `<span class="hidden sm:inline text-[11px] text-slate-400 truncate">• ${esc(scale.calibrated_by)}</span>` : ''}
        </div>
      `
      : `
        <div class="bp-mdock-scale-info flex items-center gap-2 min-w-0">
          <span class="w-2 h-2 rounded-full bg-amber-400 shrink-0"></span>
          <span class="text-xs font-bold text-amber-300 truncate">Not Calibrated</span>
        </div>
      `;

    const unsavedCount = mState.shapes.filter((sh) => !sh.saved && sh.points.length > 0).length;
    const hasAnyPoints = mState.shapes.some((sh) => sh.points.length > 0);
    const activeTargetForUndo = getActiveShape() || mState.shapes.slice().reverse().find((sh) => !sh.saved);
    const showUnsavedSuffix = unsavedCount > 0 && unsavedCount < mState.shapes.length;

    dock.innerHTML = `
      <div class="bp-mdock-header flex items-center justify-between gap-2">
        ${scaleStatusHtml}
        <div class="bp-mdock-header-actions flex items-center gap-1.5 shrink-0">
          ${
            canCal
              ? `<button id="bpDockCalibrateBtn" type="button" title="${scale ? 'Recalibrate sheet scale' : 'Calibrate sheet scale'}"
                  class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-[11px] font-bold text-slate-100">
                  <span class="bp-mdock-land-full">${scale ? 'Recalibrate' : 'Calibrate'}</span>
                  <span class="bp-mdock-land-short hidden">Cal</span>
                </button>`
              : ''
          }
          <button id="bpDockCollapseBtn" type="button" title="Minimize measure bar"
            class="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-bold text-slate-300">
            ▾
          </button>
          <button id="bpDockCloseBtn" type="button"
            class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/20 hover:text-rose-200 border border-slate-700 text-[11px] font-bold text-slate-300">
            Done
          </button>
        </div>
      </div>

      ${readoutHtml}

      <div class="bp-mdock-tools flex flex-wrap items-center justify-between gap-2">
        <div class="bp-mdock-tools-left flex items-center gap-1.5">
          <button id="bpToolDistanceBtn" type="button" title="Distance" ${!scale ? 'disabled' : ''}
            class="px-3 py-2 rounded-xl text-xs font-bold transition ${
              mState.tool === 'distance' && scale
                ? 'bg-sky-500 text-slate-950'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40'
            }">
            <span>📏</span><span class="bp-mdock-tool-lbl"> Distance</span>
          </button>
          <button id="bpToolAreaBtn" type="button" title="Surface Area" ${!scale ? 'disabled' : ''}
            class="px-3 py-2 rounded-xl text-xs font-bold transition ${
              mState.tool === 'area' && scale
                ? 'bg-emerald-500 text-slate-950'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40'
            }">
            <span>⬠</span><span class="bp-mdock-tool-lbl"> Area</span>
          </button>
          <button id="bpToolOrthoBtn" type="button" ${!scale ? 'disabled' : ''}
            title="Lock segments to 90° horizontal/vertical"
            class="px-2.5 py-2 rounded-xl text-xs font-bold border transition ${
              mState.orthoSnap
                ? 'bg-amber-500/25 text-amber-200 border-amber-400/60'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700 disabled:opacity-40'
            }">
            90°
          </button>
        </div>

        <div class="bp-mdock-tools-right flex items-center gap-1.5">
          <button id="bpToolUndoBtn" type="button" ${!activeTargetForUndo ? 'disabled' : ''}
            class="px-2.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-bold text-slate-200">
            Undo
          </button>
          <button id="bpToolClearBtn" type="button" ${!hasAnyPoints ? 'disabled' : ''}
            class="px-2.5 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 disabled:opacity-40 border border-rose-500/30 text-xs font-bold text-rose-300">
            Clear${showUnsavedSuffix ? '<span class="bp-mdock-clear-extra"> Unsaved</span>' : ''}
          </button>
        </div>
      </div>

      <div class="bp-mdock-note text-[10px] text-slate-500 text-center">
        Reference only — verify critical dimensions against printed callouts. Tap amber start dot to close loop, or drag dots to fine-tune.
      </div>
    `;

    document.getElementById('bpDockCloseBtn').onclick = () => setMeasureActive(false);
    document.getElementById('bpDockCollapseBtn').onclick = () => {
      mState.dockCollapsed = true;
      renderDock();
    };

    const calBtn = document.getElementById('bpDockCalibrateBtn');
    if (calBtn) calBtn.onclick = openScaleModal;
    const setNowBtn = document.getElementById('bpDockSetScaleNowBtn');
    if (setNowBtn) setNowBtn.onclick = openScaleModal;

    document.getElementById('bpToolDistanceBtn').onclick = () => {
      if (!mState.pageScale) return;
      mState.tool = 'distance';
      mState.activeShapeId = null;
      renderMeasureUI();
    };
    document.getElementById('bpToolAreaBtn').onclick = () => {
      if (!mState.pageScale) return;
      mState.tool = 'area';
      mState.activeShapeId = null;
      renderMeasureUI();
    };
    document.getElementById('bpToolOrthoBtn').onclick = () => {
      mState.orthoSnap = !mState.orthoSnap;
      renderDock();
    };

    const saveCurrentBtn = document.getElementById('bpDockSaveCurrentBtn');
    if (saveCurrentBtn && displayShape) {
      saveCurrentBtn.onclick = async () => {
        if (displayShape.type === 'area' && displayShape.points.length >= 3) {
          displayShape.closed = true;
        }
        await saveShapesToSupabase([displayShape]);
      };
    }

    const newShapeBtn = document.getElementById('bpDockNewShapeBtn');
    if (newShapeBtn) {
      newShapeBtn.onclick = () => {
        mState.activeShapeId = null;
        renderMeasureUI();
      };
    }
    const finishAreaBtn = document.getElementById('bpDockFinishAreaBtn');
    if (finishAreaBtn) {
      finishAreaBtn.onclick = () => {
        const sh = getActiveShape();
        if (sh) sh.closed = true;
        mState.activeShapeId = null;
        renderMeasureUI();
      };
    }

    document.getElementById('bpToolUndoBtn').onclick = () => {
      const target = getActiveShape() || mState.shapes.slice().reverse().find((sh) => !sh.saved);
      if (!target) return;
      if (target.closed) {
        target.closed = false;
        mState.activeShapeId = target.id;
        renderMeasureUI();
        return;
      }
      target.points.pop();
      if (target.points.length === 0) {
        mState.shapes = mState.shapes.filter((sh) => sh.id !== target.id);
        if (mState.activeShapeId === target.id) mState.activeShapeId = null;
        if (mState.selectedShapeId === target.id) mState.selectedShapeId = null;
      } else {
        target.closed = false;
        mState.activeShapeId = target.id;
      }
      renderMeasureUI();
    };

    document.getElementById('bpToolClearBtn').onclick = async () => {
      const unsaved = mState.shapes.filter((sh) => !sh.saved);
      const saved = mState.shapes.filter((sh) => sh.saved);

      if (unsaved.length > 0) {
        if (!confirm(`Clear ${unsaved.length} unsaved measurement${unsaved.length === 1 ? '' : 's'} from this page?`)) {
          return;
        }
        mState.shapes = saved;
        mState.activeShapeId = null;
        if (mState.selectedShapeId && !saved.some((sh) => sh.id === mState.selectedShapeId)) {
          mState.selectedShapeId = null;
        }
        renderMeasureUI();
        if (saved.length > 0) {
          toast('Cleared unsaved measurements. Your saved measurements were kept.', 'info');
        }
        return;
      }

      if (saved.length > 0) {
        if (
          !confirm(
            `Delete all ${saved.length} of your saved measurement${saved.length === 1 ? '' : 's'} on this page across all devices?`
          )
        ) {
          return;
        }
        const idsToDelete = saved.map((sh) => sh.id);
        mState.shapes = [];
        mState.activeShapeId = null;
        mState.selectedShapeId = null;
        mState.totalsDropdownOpen = false;
        updateLocalSavedCacheForCurrentPage();
        renderMeasureUI();

        const cur = getViewerState();
        if (cur?.supabase && cur.isOnline) {
          try {
            const { error } = await cur.supabase
              .from(USER_MEASURES_TABLE)
              .delete()
              .in('id', idsToDelete)
              .eq('user_id', getCurrentUserId());
            if (error) throw error;
            toast('Deleted all saved measurements on this page.', 'info');
          } catch (err) {
            toast(`Removed locally (cloud delete warning: ${err.message})`, 'warning');
          }
        }
      }
    };
  }

  function renderMeasureUI() {
    const view = document.getElementById('viewBlueprints');
    const toggleBtn = document.getElementById('bpToggleMeasureBtn');

    if (view) view.classList.toggle('bp-measure-active', mState.active);
    if (toggleBtn) {
      toggleBtn.className = mState.active
        ? 'h-8 px-2.5 rounded-lg text-xs font-extrabold bg-emerald-500 text-slate-950 border border-emerald-400 flex items-center gap-1 transition shrink-0'
        : 'h-8 px-2.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-600/80 flex items-center gap-1 transition shrink-0';
    }

    syncToolbarEmptyState();
    renderFullscreenControls();
    renderTopBanner();
    renderTopTotalsDropdown();
    renderDock();
    renderOverlayGraphics();
  }

  // =========================================================================
  // 9. TAP-TO-MEASURE VIEWPORT LISTENER (PRESERVES PAN & PINCH-ZOOM)
  // =========================================================================
  function bindViewportTapHandler() {
    const viewport = document.getElementById('bpCanvasViewport');
    if (!viewport || viewport.dataset.bpMeasureBound === '1') return;
    viewport.dataset.bpMeasureBound = '1';

    viewport.addEventListener('pointerdown', (e) => {
      if (!mState.active || e.button === 2) return;
      if (e.target.closest('[data-bp-measure-ui]') || e.target.closest('.bp-m-handle') || e.target.closest('button')) {
        return;
      }

      mState.activePointerIds.add(e.pointerId);
      if (mState.activePointerIds.size > 1) {
        mState.multiTouchSeen = true;
        mState.tapCandidate = null;
        return;
      }

      mState.multiTouchSeen = false;
      mState.tapCandidate = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        time: Date.now(),
        moved: false
      };
    });

    viewport.addEventListener('pointermove', (e) => {
      const tc = mState.tapCandidate;
      if (!tc || tc.pointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - tc.x, e.clientY - tc.y) > 8) {
        tc.moved = true;
      }
    });

    const handleEnd = (e, cancelled) => {
      mState.activePointerIds.delete(e.pointerId);
      const tc = mState.tapCandidate;

      if (
        !cancelled &&
        mState.active &&
        tc &&
        tc.pointerId === e.pointerId &&
        !tc.moved &&
        !mState.multiTouchSeen &&
        Date.now() - tc.time < 450
      ) {
        onCanvasTap(e.clientX, e.clientY);
      }

      if (mState.activePointerIds.size === 0) {
        mState.tapCandidate = null;
        mState.multiTouchSeen = false;
      }
    };

    viewport.addEventListener('pointerup', (e) => handleEnd(e, false));
    viewport.addEventListener('pointercancel', (e) => handleEnd(e, true));
  }

  function onCanvasTap(clientX, clientY) {
    const s = getViewerState();
    if (!s?.activeDoc) return;
    const rawPt = clientToNorm(clientX, clientY);
    if (!rawPt) return;

    if (mState.totalsDropdownOpen) {
      mState.totalsDropdownOpen = false;
    }

    if (mState.tool === 'calibrate') {
      if (!s.canCalibrate) return;
      const pt =
        mState.calPoints.length === 1
          ? applyOrthoIfEnabled(rawPt, mState.calPoints[0], s.stageW, s.stageH)
          : rawPt;
      mState.calPoints.push(pt);
      renderMeasureUI();

      if (mState.calPoints.length === 2) {
        ensureCalibrationLengthModal();
        const fInp = document.getElementById('bpCalFeetInput');
        const iInp = document.getElementById('bpCalInchesInput');
        if (fInp) fInp.value = '';
        if (iInp) iInp.value = '';
        document.getElementById('bpCalLengthModal').classList.remove('hidden');
        setTimeout(() => fInp?.focus(), 60);
      }
      return;
    }

    if (!mState.pageScale) {
      if (s.canCalibrate) openScaleModal();
      else toast('This sheet is not calibrated yet. Ask a Supervisor, PM, or Admin to set the scale.', 'warning');
      return;
    }

    mState.selectedShapeId = null;

    let shape = getActiveShape();
    if (!shape || shape.type !== mState.tool || shape.closed || shape.saved) {
      shape = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: mState.tool,
        points: [],
        closed: false,
        saved: false,
        name: ''
      };
      mState.shapes.push(shape);
      mState.activeShapeId = shape.id;
    }

    const prevPt = shape.points.length > 0 ? shape.points[shape.points.length - 1] : null;
    const pt = applyOrthoIfEnabled(rawPt, prevPt, s.stageW, s.stageH);
    shape.points.push(pt);
    renderMeasureUI();
  }

  // =========================================================================
  // 10. LIFECYCLE & PUBLIC HOOKS FOR blueprints.js
  // =========================================================================
  function mountIfReady() {
    if (!document.getElementById('bpCanvasViewport')) return;
    injectStyles();
    ensureToolbarButtons();
    ensureStageLayer();
    ensureFloatingDock();
    tagBlueprintTopChrome();
    bindViewportTapHandler();
    syncToolbarEmptyState();

    if (!mState.mounted) {
      mState.mounted = true;

      document.addEventListener('click', (e) => {
        if (!mState.toolsPopoverOpen) return;
        const pop = document.getElementById('bpToolsPopoverMenu');
        const btn = document.getElementById('bpToolsMenuBtn');
        if (pop?.contains(e.target) || btn?.contains(e.target)) return;
        closeToolsPopover();
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (mState.toolsPopoverOpen) closeToolsPopover();
          else if (mState.fullscreen) setFullscreen(false);
        }
      });

      window.addEventListener('resize', () => {
        if (mState.toolsPopoverOpen) closeToolsPopover();
      });

      const viewEl = document.getElementById('viewBlueprints');
      if (viewEl && !mState.viewObserver) {
        mState.viewObserver = new MutationObserver(() => {
          if (!viewEl.classList.contains('hidden')) {
            syncToolbarEmptyState();
          } else {
            closeToolsPopover();
          }
        });
        mState.viewObserver.observe(viewEl, { attributes: true, attributeFilter: ['class'] });
      }
    }
  }

  function setMeasureActive(enabled) {
    mountIfReady();
    const next = Boolean(enabled);
    if (next) {
      closeToolsPopover();
      getBridge()?.disableAddLinkMode?.();
    }
    mState.active = next;
    if (!next) {
      mState.calPoints = [];
      mState.selectedShapeId = null;
      mState.totalsDropdownOpen = false;
      mState.dockCollapsed = false;
      if (mState.tool === 'calibrate') mState.tool = 'distance';
      closeScaleModal();
      document.getElementById('bpCalLengthModal')?.classList.add('hidden');
    } else {
      Promise.all([loadScaleForActivePage(), loadUserMeasurementsForActivePage()]);
    }
    renderMeasureUI();
  }

  window.ACTBlueprintMeasure = {
    setActive: setMeasureActive,
    setFullscreen,
    onPageRendered() {
      mountIfReady();
      syncToolbarEmptyState();
      const s = getViewerState();
      const nextDocKey = getDocPageKey(s);
      const nextUserKey = getUserPageKey(s);
      if (nextDocKey !== mState.currentDocKey || nextUserKey !== mState.currentUserPageKey) {
        mState.shapes = [];
        mState.activeShapeId = null;
        mState.selectedShapeId = null;
        mState.totalsDropdownOpen = false;
        mState.calPoints = [];
        if (mState.tool === 'calibrate') mState.tool = 'distance';
        loadScaleForActivePage();
        if (mState.active) {
          loadUserMeasurementsForActivePage();
        } else {
          mState.currentUserPageKey = '';
        }
      } else {
        renderOverlayGraphics();
      }
    },
    onTransformChanged(zoom) {
      if (mState.active) updateZoomScaleVar(zoom);
    },
    onHeaderUpdated() {
      mountIfReady();
      syncToolbarEmptyState();
      updateToolsButtonIndicator();
      renderFullscreenControls();
      if (mState.active) {
        renderTopTotalsDropdown();
        renderDock();
      }
    },
    onViewerClosed() {
      closeToolsPopover();
      mState.currentUserPageKey = '';
      mState.shapes = [];
      mState.activeShapeId = null;
      mState.selectedShapeId = null;
      if (mState.fullscreen) setFullscreen(false);
      setMeasureActive(false);
      syncToolbarEmptyState();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountIfReady);
  } else {
    mountIfReady();
  }
})();
