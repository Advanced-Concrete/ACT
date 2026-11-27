// =========================================================================
// ACT MASTER - PERSISTENT LOCAL PDF FORM DRAFTS (form-drafts.js)
// Zero-conflict drop-in draft manager for the Field Forms (PDF) tab
// - Stores partially filled forms (inputs, dropdowns, checkboxes, recipient
//   email, and signature canvases) locally on the device until sent
// - Supports multiple in-progress drafts (including multiple of the same form)
// - Silent autosave on edit + explicit "Save Draft" bar inside the form filler
// - Auto-deletes the active draft once the completed form is sent
// =========================================================================
(function initACTFormDrafts() {
  'use strict';

  const STORAGE_KEY = 'act_field_form_drafts_v1';
  const MAX_DRAFTS = 40;

  const dState = {
    activeTemplateId: null,
    activeDraftId: null,
    pendingResumeDraftId: null,
    initialSnapshotJson: '',
    initialCanvasSnapshots: {},
    submissionsCountOnOpen: -1,
    currentSubView: 'list',
    autosaveTimer: null,
    isRestoring: false,
    isSavingOwnToast: false,
    mounted: false
  };

  // =========================================================================
  // 1. PERSISTENT DEVICE STORAGE HELPERS
  // =========================================================================
  function requestPersistentStorage() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        navigator.storage.persist().catch(() => {});
      }
    } catch {}
  }

  function loadDrafts() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveDrafts(list) {
    try {
      const trimmed = list.slice(0, MAX_DRAFTS);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      return true;
    } catch (err) {
      toast('Device storage is full — delete old drafts before saving more.', true);
      return false;
    }
  }

  function getDraftById(id) {
    if (!id) return null;
    return loadDrafts().find((d) => d.id === id) || null;
  }

  function upsertDraft(draft) {
    const list = loadDrafts().filter((d) => d.id !== draft.id);
    list.unshift(draft);
    return saveDrafts(list);
  }

  function removeDraftById(id) {
    if (!id) return false;
    const list = loadDrafts();
    const next = list.filter((d) => d.id !== id);
    if (next.length === list.length) return false;
    saveDrafts(next);
    return true;
  }

  function toast(msg, isError = false) {
    dState.isSavingOwnToast = true;
    try {
      if (typeof showSimpleToast === 'function') {
        showSimpleToast(msg, isError);
      } else {
        console.log(`[FormDrafts${isError ? ' Error' : ''}]`, msg);
      }
    } finally {
      dState.isSavingOwnToast = false;
    }
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatSavedStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function getActiveUserName() {
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
    try {
      const role =
        typeof getActiveUserEffectiveRole === 'function' ? getActiveUserEffectiveRole() : '';
      if (String(role).toLowerCase() === 'admin') return 'Administrator';
    } catch {}
    return '';
  }

  function getTemplateById(templateId) {
    try {
      if (typeof formTemplates !== 'undefined' && Array.isArray(formTemplates)) {
        return formTemplates.find((t) => String(t.id) === String(templateId)) || null;
      }
    } catch {}
    return null;
  }

  // =========================================================================
  // 2. DOM DISCOVERY INSIDE #fieldFormsWorkspace
  // =========================================================================
  function getWorkspaceEl() {
    return document.getElementById('fieldFormsWorkspace');
  }

  function getFillerContainer() {
    const ws = getWorkspaceEl();
    if (!ws) return null;

    const anchor =
      ws.querySelector('#fillerRecipientEmail') ||
      ws.querySelector('[id^="fill_"]');
    if (!anchor) return null;

    // Walk up to the sub-view container directly inside #fieldFormsWorkspace
    let cur = anchor;
    while (cur.parentElement && cur.parentElement !== ws) {
      cur = cur.parentElement;
    }
    return cur;
  }

  function isFillerVisible() {
    const filler = getFillerContainer();
    if (!filler || filler.classList.contains('hidden')) return false;
    const ws = getWorkspaceEl();
    if (!ws || ws.classList.contains('hidden')) return false;
    const style = window.getComputedStyle(filler);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  // =========================================================================
  // 3. CAPTURE & RESTORE FORM FIELDS + SIGNATURE CANVASES
  // =========================================================================
  function getTrackableControls(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll('input, select, textarea')).filter((el) => {
      if (el.closest('#actFormDraftBanner')) return false;
      const type = String(el.type || '').toLowerCase();
      if (type === 'file' || type === 'button' || type === 'submit' || type === 'reset') {
        return false;
      }
      return Boolean(el.id || el.name);
    });
  }

  function getControlKey(el, idx) {
    if (el.id) return `id::${el.id}`;
    if (el.name && (el.type === 'radio' || el.type === 'checkbox')) {
      return `name::${el.name}::${el.value || idx}`;
    }
    if (el.name) return `name::${el.name}`;
    return `idx::${idx}`;
  }

  function captureControlValues(container) {
    const controls = getTrackableControls(container);
    const values = {};
    let filledCount = 0;
    let totalCount = 0;

    controls.forEach((el, idx) => {
      const key = getControlKey(el, idx);
      const type = String(el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        values[key] = { kind: 'checked', checked: Boolean(el.checked) };
        totalCount += 1;
        if (el.checked) filledCount += 1;
      } else {
        const val = String(el.value ?? '');
        values[key] = { kind: 'value', value: val };
        if (type !== 'hidden') {
          totalCount += 1;
          if (val.trim() !== '') filledCount += 1;
        }
      }
    });

    return { values, filledCount, totalCount };
  }

  function snapshotCanvases(container) {
    const out = {};
    if (!container) return out;
    const canvases = Array.from(container.querySelectorAll('canvas')).filter(
      (c) => !c.closest('#actFormDraftBanner') && c.width > 0 && c.height > 0
    );
    canvases.forEach((canvas, idx) => {
      const key = canvas.id ? `id::${canvas.id}` : `idx::${idx}`;
      try {
        out[key] = canvas.toDataURL('image/png');
      } catch {}
    });
    return out;
  }

  function captureSignedCanvases(container) {
    const current = snapshotCanvases(container);
    const signed = {};
    Object.entries(current).forEach(([key, dataUrl]) => {
      const blank = dState.initialCanvasSnapshots[key];
      if (dataUrl && dataUrl !== blank) {
        signed[key] = dataUrl;
      }
    });
    return signed;
  }

  function extractJobName(container, template) {
    if (!container) return '';
    if (template && Array.isArray(template.fields)) {
      const jobField = template.fields.find(
        (f) => f.type === 'job' || /\b(job\s*name|project\s*name|job\s*#?)\b/i.test(f.label || '')
      );
      if (jobField) {
        const el = document.getElementById(`fill_${jobField.id}`);
        if (el && String(el.value || '').trim()) {
          return String(el.value).trim();
        }
      }
    }

    // Fallback: inspect any select whose options match known job names
    const selects = Array.from(container.querySelectorAll('select')).filter(
      (s) => !s.closest('#actFormDraftBanner')
    );
    for (const sel of selects) {
      const val = String(sel.value || '').trim();
      if (!val || /^--/.test(val)) continue;
      if (typeof state !== 'undefined' && Array.isArray(state.jobs)) {
        const hit = state.jobs.find(
          (j) => String(j.name || '').trim().toLowerCase() === val.toLowerCase()
        );
        if (hit) return hit.name;
      }
    }
    return '';
  }

  function buildDraftFromDom(forceCreate = false) {
    const container = getFillerContainer();
    if (!container || !dState.activeTemplateId) return null;

    const { values, filledCount, totalCount } = captureControlValues(container);
    const canvases = captureSignedCanvases(container);
    const signedCount = Object.keys(canvases).length;

    const currentSignature = JSON.stringify({ values, canvases });
    if (!forceCreate && currentSignature === dState.initialSnapshotJson) {
      return null;
    }
    if (!forceCreate && filledCount === 0 && signedCount === 0) {
      return null;
    }

    const template = getTemplateById(dState.activeTemplateId);
    const existing = getDraftById(dState.activeDraftId);
    const draftId =
      dState.activeDraftId ||
      `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    dState.activeDraftId = draftId;

    return {
      id: draftId,
      templateId: String(dState.activeTemplateId),
      templateTitle: template?.title || template?.name || existing?.templateTitle || 'Field PDF Form',
      jobName: extractJobName(container, template) || existing?.jobName || '',
      savedBy: getActiveUserName() || existing?.savedBy || '',
      filledCount: filledCount + signedCount,
      totalCount: Math.max(totalCount + signedCount, filledCount + signedCount),
      hasSignature: signedCount > 0,
      values,
      canvases,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  function restoreDraftIntoDom(draft) {
    const container = getFillerContainer();
    if (!container || !draft) return;

    dState.isRestoring = true;
    try {
      const controls = getTrackableControls(container);
      const savedValues = draft.values || {};
      let recipientEmailEntry = null;

      controls.forEach((el, idx) => {
        const key = getControlKey(el, idx);
        const entry = savedValues[key];
        if (!entry) return;

        if (el.id === 'fillerRecipientEmail') {
          recipientEmailEntry = { el, entry };
          return;
        }

        if (entry.kind === 'checked') {
          el.checked = Boolean(entry.checked);
        } else if (entry.kind === 'value') {
          el.value = entry.value ?? '';
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // Re-apply recipient email last so job auto-routing never clobbers a custom email
      if (recipientEmailEntry && recipientEmailEntry.entry.kind === 'value') {
        recipientEmailEntry.el.value = recipientEmailEntry.entry.value ?? '';
        recipientEmailEntry.el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Restore any drawn signature canvases
      const savedCanvases = draft.canvases || {};
      const canvases = Array.from(container.querySelectorAll('canvas')).filter(
        (c) => !c.closest('#actFormDraftBanner') && c.width > 0 && c.height > 0
      );
      canvases.forEach((canvas, idx) => {
        const key = canvas.id ? `id::${canvas.id}` : `idx::${idx}`;
        const dataUrl = savedCanvases[key];
        if (!dataUrl) return;

        const img = new Image();
        img.onload = () => {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.src = dataUrl;
      });
    } finally {
      setTimeout(() => {
        dState.isRestoring = false;
      }, 80);
    }
  }

  function persistCurrentDraft(forceCreate = false, notify = false) {
    if (dState.isRestoring || !dState.activeTemplateId || !isFillerVisible()) return null;
    const draft = buildDraftFromDom(forceCreate);
    if (!draft) {
      if (notify) toast('Fill in at least one field before saving a draft.', true);
      return null;
    }
    const ok = upsertDraft(draft);
    if (ok) {
      updateFillerDraftBanner(draft);
      renderDraftsPanel();
      if (notify) {
        toast('Draft saved to this device — resume anytime.', false);
      }
    }
    return ok ? draft : null;
  }

  function scheduleAutosave() {
    if (dState.isRestoring || !dState.activeTemplateId) return;
    if (dState.autosaveTimer) clearTimeout(dState.autosaveTimer);
    dState.autosaveTimer = setTimeout(() => {
      dState.autosaveTimer = null;
      persistCurrentDraft(false, false);
    }, 450);
  }

  function clearActiveDraftAfterSend() {
    if (!dState.activeDraftId) return;
    const removed = removeDraftById(dState.activeDraftId);
    dState.activeDraftId = null;
    dState.activeTemplateId = null;
    if (dState.autosaveTimer) {
      clearTimeout(dState.autosaveTimer);
      dState.autosaveTimer = null;
    }
    if (removed) {
      renderDraftsPanel();
    }
  }

  // =========================================================================
  // 4. UI: "SAVED DRAFTS" PANEL ON FIELD FORMS LIST + FILLER DRAFT BAR
  // =========================================================================
  function ensureDraftsPanel() {
    const ws = getWorkspaceEl();
    if (!ws) return null;

    let panel = document.getElementById('actFormDraftsPanel');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'actFormDraftsPanel';
    panel.className = 'hidden mb-3';

    // Insert right at the top of the list sub-view if identifiable, otherwise inside #fieldFormsWorkspace
    const listSubView =
      ws.querySelector('[id*="List"], [id*="list"]') ||
      ws.firstElementChild;

    if (listSubView && listSubView !== getFillerContainer() && listSubView.parentElement === ws) {
      listSubView.insertBefore(panel, listSubView.firstChild);
    } else {
      ws.insertBefore(panel, ws.firstChild);
    }
    return panel;
  }

  function renderDraftsPanel() {
    const panel = ensureDraftsPanel();
    if (!panel) return;

    const drafts = loadDrafts();
    const shouldShow = dState.currentSubView === 'list' && !isFillerVisible() && drafts.length > 0;
    panel.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;

    const rowsHtml = drafts
      .map((draft) => {
        const stamp = formatSavedStamp(draft.updatedAt);
        const progress =
          draft.totalCount > 0 ? `${draft.filledCount}/${draft.totalCount} filled` : 'In progress';
        return `
          <div class="flex items-center gap-2 px-3 py-2.5 border-b border-slate-800 last:border-b-0 hover:bg-slate-800/60 transition">
            <button type="button" data-resume-draft="${esc(draft.id)}"
              class="min-w-0 flex-1 text-left">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="w-2 h-2 rounded-full bg-amber-400 shrink-0"></span>
                <span class="text-sm font-bold text-white truncate">${esc(draft.templateTitle)}</span>
              </div>
              <div class="text-[11px] text-slate-400 truncate mt-0.5">
                ${
                  draft.jobName
                    ? `<span class="text-emerald-300 font-semibold">${esc(draft.jobName)}</span> • `
                    : ''
                }<span>${esc(progress)}</span>${
                  draft.hasSignature ? ' • Signed' : ' • Needs signature'
                }${stamp ? ` • ${esc(stamp)}` : ''}
              </div>
            </button>

            <div class="flex items-center gap-1.5 shrink-0">
              <button type="button" data-resume-draft="${esc(draft.id)}"
                class="h-8 px-3 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-extrabold">
                Resume
              </button>
              <button type="button" data-delete-draft="${esc(draft.id)}" title="Delete draft"
                class="w-8 h-8 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 border border-rose-500/30 text-rose-300 text-xs font-bold flex items-center justify-center">
                ✕
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    panel.innerHTML = `
      <div class="rounded-xl bg-slate-900 border border-amber-500/40 overflow-hidden">
        <div class="px-3 py-2 bg-amber-500/10 border-b border-slate-800 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-xs font-extrabold uppercase tracking-wider text-amber-300 truncate">
              In-Progress Drafts (${drafts.length})
            </span>
          </div>
          <span class="text-[10px] font-semibold text-slate-400 shrink-0">Saved on this device</span>
        </div>
        <div>${rowsHtml}</div>
      </div>
    `;

    panel.querySelectorAll('[data-resume-draft]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-resume-draft');
        resumeDraftById(id);
      };
    });

    panel.querySelectorAll('[data-delete-draft]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-delete-draft');
        const target = getDraftById(id);
        if (!target) return;
        const label = target.jobName
          ? `${target.templateTitle} (${target.jobName})`
          : target.templateTitle;
        if (!confirm(`Delete saved draft "${label}" from this device? This cannot be undone.`)) {
          return;
        }
        removeDraftById(id);
        if (dState.activeDraftId === id) dState.activeDraftId = null;
        renderDraftsPanel();
        toast('Draft deleted from this device.', false);
      };
    });
  }

  function ensureFillerDraftBanner() {
    const filler = getFillerContainer();
    if (!filler) return null;

    let bar = document.getElementById('actFormDraftBanner');
    if (bar && filler.contains(bar)) return bar;
    if (bar) bar.remove();

    bar = document.createElement('div');
    bar.id = 'actFormDraftBanner';
    bar.className =
      'mb-3 px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-between gap-2';

    filler.insertBefore(bar, filler.firstChild);
    return bar;
  }

  function updateFillerDraftBanner(draft) {
    const bar = ensureFillerDraftBanner();
    if (!bar) return;

    const statusHtml = draft
      ? `<span class="w-2 h-2 rounded-full bg-emerald-400 shrink-0"></span>
         <span class="text-xs font-semibold text-slate-200 truncate">Saved on device • ${esc(formatSavedStamp(draft.updatedAt))}</span>`
      : `<span class="w-2 h-2 rounded-full bg-amber-400 shrink-0"></span>
         <span class="text-xs font-semibold text-slate-300 truncate">Autosaves on this device until sent</span>`;

    bar.innerHTML = `
      <div class="flex items-center gap-2 min-w-0 flex-1">
        ${statusHtml}
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button id="actFormSaveDraftBtn" type="button"
          class="h-8 px-3 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-extrabold">
          Save Draft
        </button>
        ${
          draft
            ? `<button id="actFormDiscardDraftBtn" type="button" title="Delete this draft"
                class="w-8 h-8 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 border border-rose-500/30 text-rose-300 text-xs font-bold flex items-center justify-center">
                ✕
              </button>`
            : ''
        }
      </div>
    `;

    document.getElementById('actFormSaveDraftBtn').onclick = () => {
      const saved = persistCurrentDraft(true, true);
      if (saved && typeof window.showFormsSubView === 'function') {
        window.showFormsSubView('list');
      }
    };

    const discardBtn = document.getElementById('actFormDiscardDraftBtn');
    if (discardBtn && draft) {
      discardBtn.onclick = () => {
        if (!confirm(`Discard saved draft "${draft.templateTitle}" from this device?`)) return;
        removeDraftById(draft.id);
        dState.activeDraftId = null;
        dState.activeTemplateId = null;
        if (typeof window.showFormsSubView === 'function') {
          window.showFormsSubView('list');
        }
        renderDraftsPanel();
        toast('Draft discarded.', false);
      };
    }
  }

  function bindFillerAutosaveListeners() {
    const filler = getFillerContainer();
    if (!filler || filler.dataset.actDraftBound === '1') return;
    filler.dataset.actDraftBound = '1';

    filler.addEventListener('input', (e) => {
      if (e.target.closest('#actFormDraftBanner')) return;
      scheduleAutosave();
    });

    filler.addEventListener('change', (e) => {
      if (e.target.closest('#actFormDraftBanner')) return;
      scheduleAutosave();
    });

    // Catch signature canvas strokes finishing on mobile touch or mouse
    const onCanvasStrokeEnd = (e) => {
      if (e.target && e.target.tagName === 'CANVAS') {
        scheduleAutosave();
      }
    };
    filler.addEventListener('pointerup', onCanvasStrokeEnd, true);
    filler.addEventListener('touchend', onCanvasStrokeEnd, true);
  }

  function resumeDraftById(draftId) {
    const draft = getDraftById(draftId);
    if (!draft) {
      toast('That draft could not be found.', true);
      renderDraftsPanel();
      return;
    }

    const tpl = getTemplateById(draft.templateId);
    if (!tpl) {
      toast('That form template is no longer available.', true);
      return;
    }

    dState.pendingResumeDraftId = draft.id;
    if (typeof window.openFormFiller === 'function') {
      window.openFormFiller(draft.templateId);
    }
  }

  // =========================================================================
  // 5. HOOK INTO ACT FIELD FORMS LIFECYCLE
  // =========================================================================
  function installHooks() {
    // 1. Wrap openFormFiller to initialize autosave or hydrate a resumed draft
    const prevOpenFiller = window.openFormFiller;
    if (typeof prevOpenFiller === 'function') {
      window.openFormFiller = function (templateId) {
        const res = prevOpenFiller.apply(this, arguments);

        dState.activeTemplateId = String(templateId);
        dState.currentSubView = 'filler';
        dState.submissionsCountOnOpen =
          typeof formSubmissions !== 'undefined' && Array.isArray(formSubmissions)
            ? formSubmissions.length
            : -1;

        const resumeId = dState.pendingResumeDraftId;
        dState.pendingResumeDraftId = null;

        setTimeout(() => {
          const filler = getFillerContainer();
          if (!filler) return;

          bindFillerAutosaveListeners();
          dState.initialCanvasSnapshots = snapshotCanvases(filler);

          const initControls = captureControlValues(filler);
          dState.initialSnapshotJson = JSON.stringify({
            values: initControls.values,
            canvases: {}
          });

          if (resumeId) {
            const draft = getDraftById(resumeId);
            if (draft) {
              dState.activeDraftId = draft.id;
              restoreDraftIntoDom(draft);
              updateFillerDraftBanner(draft);
              toast(`Resumed draft: ${draft.templateTitle}`, false);
            } else {
              dState.activeDraftId = null;
              updateFillerDraftBanner(null);
            }
          } else {
            dState.activeDraftId = null;
            updateFillerDraftBanner(null);
          }

          renderDraftsPanel();
        }, 40);

        return res;
      };
    }

    // 2. Wrap showFormsSubView to show/hide drafts panel & auto-clear sent drafts
    const prevShowSubView = window.showFormsSubView;
    if (typeof prevShowSubView === 'function') {
      window.showFormsSubView = function (viewName) {
        const res = prevShowSubView.apply(this, arguments);
        dState.currentSubView = String(viewName || 'list').toLowerCase();

        if (dState.currentSubView === 'list') {
          const currentSubCount =
            typeof formSubmissions !== 'undefined' && Array.isArray(formSubmissions)
              ? formSubmissions.length
              : -1;

          if (
            dState.activeDraftId &&
            dState.submissionsCountOnOpen >= 0 &&
            currentSubCount > dState.submissionsCountOnOpen
          ) {
            clearActiveDraftAfterSend();
          }
          setTimeout(renderDraftsPanel, 20);
        } else {
          renderDraftsPanel();
        }
        return res;
      };
    }

    // 3. Wrap loadFormTemplatesFromSupabase so drafts show right after templates load
    const prevLoadTemplates = window.loadFormTemplatesFromSupabase;
    if (typeof prevLoadTemplates === 'function') {
      window.loadFormTemplatesFromSupabase = async function () {
        const res = await prevLoadTemplates.apply(this, arguments);
        setTimeout(renderDraftsPanel, 30);
        return res;
      };
    }

    // 4. Wrap showSimpleToast to detect successful form send/submission and clear draft
    const prevToast = window.showSimpleToast;
    if (typeof prevToast === 'function') {
      window.showSimpleToast = function (msg, isError) {
        if (
          !dState.isSavingOwnToast &&
          !isError &&
          dState.activeDraftId &&
          typeof msg === 'string' &&
          /\b(sent|emailed|submitted|dispatched|signed\s+pdf|pdf\s+saved)\b/i.test(msg)
        ) {
          clearActiveDraftAfterSend();
        }
        return prevToast.apply(this, arguments);
      };
    }

    // 5. Flush any pending edits if the user locks their phone or switches apps
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && isFillerVisible()) {
        persistCurrentDraft(false, false);
      }
    });

    window.addEventListener('pagehide', () => {
      if (isFillerVisible()) {
        persistCurrentDraft(false, false);
      }
    });
  }

  window.ACTFormDrafts = {
    list: loadDrafts,
    resume: resumeDraftById,
    saveNow: () => persistCurrentDraft(true, true),
    clearActive: clearActiveDraftAfterSend,
    refresh: renderDraftsPanel
  };

  function boot() {
    if (dState.mounted) return;
    dState.mounted = true;
    requestPersistentStorage();
    installHooks();
    setTimeout(renderDraftsPanel, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
