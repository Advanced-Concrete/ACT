// =========================================================================
    // FIELD FORMS: ZOOMABLE DRAG-MAPPER, AI SCANNER, SIGNER & SUPABASE CLEANUP
    // =========================================================================
    let formTemplates = [];
    let formSubmissions = [];
    let activeFillerTemplate = null;
    let signaturePads = {};

    // Builder state for Admin uploading/editing a PDF template
    let editingTemplateId = null;
    let builderPdfDoc = null;
    let builderPdfBytes = null;
    let builderPdfDataUrl = null;
    let builderCurrentPage = 1;
    let builderTotalPages = 1;
    let builderFields = [];
    let builderZoom = 1.0;
    let draggingFieldId = null;
    let justFinishedPinDrag = false;

    function selectMenuFeature(featureKey) {
      if (currentRole !== 'admin' && featureKey !== 'receipts' && featureKey !== 'forms') {
        closeSideMenu();
        return;
      }
      const otherView = document.getElementById('viewOtherModule');
      const crewView = document.getElementById('viewCrew');
      const adminView = document.getElementById('viewAdmin');
      const placeholderCard = document.getElementById('otherModulePlaceholderCard');
      const formsWorkspace = document.getElementById('fieldFormsWorkspace');

      if (featureKey === 'receipts') {
        otherView.classList.add('hidden');
        if (currentRole === 'admin') {
          openAdminPage(currentAdminPage || 'reconcile');
          return;
        }
        crewView.classList.remove('hidden');
        adminView.classList.add('hidden');
      } else if (featureKey === 'forms') {
        document.getElementById('topBarPageTitle').textContent = 'Field Forms (PDF)';
        crewView.classList.add('hidden');
        adminView.classList.add('hidden');
        otherView.classList.remove('hidden');
        if (placeholderCard) placeholderCard.classList.add('hidden');
        if (formsWorkspace) formsWorkspace.classList.remove('hidden');
        const adminTabBtn = document.getElementById('btnFormsAdminTab');
        if (adminTabBtn) adminTabBtn.classList.toggle('hidden', currentRole !== 'admin');
        showFormsSubView('list');
        loadFormTemplatesFromSupabase();
      } else {
        const titles = { timecards: 'Time Cards', payroll: 'Payroll' };
        document.getElementById('otherModuleTitle').textContent = titles[featureKey] || 'Module';
        document.getElementById('topBarPageTitle').textContent = titles[featureKey] || 'Module';
        crewView.classList.add('hidden');
        adminView.classList.add('hidden');
        otherView.classList.remove('hidden');
        if (formsWorkspace) formsWorkspace.classList.add('hidden');
        if (placeholderCard) placeholderCard.classList.remove('hidden');
      }
      closeSideMenu();
      renderAll();
    }

    function showFormsSubView(subView) {
      ['list', 'filler', 'admin_builder'].forEach(k => {
        const el = document.getElementById(`formsSubView_${k}`);
        if (el) el.classList.toggle('hidden', k !== subView);
      });
    }

    // Helper to extract storage bucket file path from a public Supabase URL
    function extractFormsStoragePath(publicUrl) {
      if (!publicUrl || typeof publicUrl !== 'string') return null;
      const marker = '/storage/v1/object/public/forms/';
      const idx = publicUrl.indexOf(marker);
      if (idx === -1) return null;
      return decodeURIComponent(publicUrl.slice(idx + marker.length).split('?')[0]);
    }

    async function loadFormTemplatesFromSupabase() {
      try {
        const cachedTpl = localStorage.getItem('fieldops_form_templates');
        if (cachedTpl) formTemplates = JSON.parse(cachedTpl);
        const cachedSub = localStorage.getItem('fieldops_form_submissions');
        if (cachedSub) formSubmissions = JSON.parse(cachedSub);
      } catch (e) {}

      if (supabaseClient && isOnline) {
        try {
          const [tplRes, subRes] = await Promise.all([
            supabaseClient.from('form_templates').select('*').order('created_at', { ascending: false }),
            supabaseClient.from('form_submissions').select('*').order('created_at', { ascending: false }).limit(50)
          ]);
          if (!tplRes.error && tplRes.data) {
            formTemplates = tplRes.data;
            try { localStorage.setItem('fieldops_form_templates', JSON.stringify(formTemplates)); } catch (e) {}
          }
          if (!subRes.error && subRes.data) {
            formSubmissions = subRes.data;
            try { localStorage.setItem('fieldops_form_submissions', JSON.stringify(formSubmissions)); } catch (e) {}
          }
        } catch (err) {
          console.warn('Forms load warning:', err);
        }
      }
      renderAvailableFormsList();
    }

    function renderAvailableFormsList() {
      const listEl = document.getElementById('availableFormsList');
      const subEl = document.getElementById('completedFormsList');
      if (!listEl || !subEl) return;

      listEl.innerHTML = formTemplates.map(t => {
        const fieldCount = Array.isArray(t.fields) ? t.fields.length : 0;
        return `
          <div class="p-3 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="text-xs font-bold text-white truncate">${t.title}</div>
              <div class="text-[11px] text-slate-400">${fieldCount} input field(s) ${t.default_email ? `• Sends to ${t.default_email}` : ''}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button onclick="openFormFiller('${t.id}')" class="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow">
                Fill & Sign
              </button>
              ${currentRole === 'admin' ? `
                <button onclick="openEditFormTemplate('${t.id}')" title="Edit Pin Locations" class="px-2.5 py-2 rounded-xl bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 font-bold text-xs">
                  Edit
                </button>
                <button onclick="promptDeleteFormItem('template', '${t.id}')" title="Delete Template" class="px-2.5 py-2 rounded-xl bg-red-950/60 hover:bg-red-900 text-red-300 border border-red-500/30 font-bold text-xs">
                  ✕
                </button>
              ` : ''}
            </div>
          </div>
        `;
      }).join('') || `<p class="text-xs text-slate-500 py-3">No PDF form templates uploaded yet. ${currentRole === 'admin' ? 'Click "+ Upload / Map PDF Template" above to add one.' : ''}</p>`;

      subEl.innerHTML = formSubmissions.map(s => {
        const dateStr = s.created_at ? new Date(s.created_at).toLocaleDateString() : '';
        return `
          <div class="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-2 text-xs">
            <div class="min-w-0">
              <div class="font-bold text-white truncate">${s.template_title || 'Completed Form'}</div>
              <div class="text-[11px] text-slate-400 truncate">${s.submitted_by || 'Crew'} • ${dateStr} ${s.job_name ? `• ${s.job_name}` : ''}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${s.filled_pdf_url ? `<a href="${s.filled_pdf_url}" target="_blank" rel="noopener" class="px-2.5 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 font-bold text-[11px]">View PDF</a>` : ''}
              <button onclick="promptDeleteFormItem('submission', '${s.id}')" title="Delete Completed Form" class="px-2.5 py-1.5 rounded-lg bg-red-950/60 hover:bg-red-900 text-red-300 border border-red-500/30 font-bold text-[11px]">
                ✕
              </button>
            </div>
          </div>
        `;
      }).join('') || `<p class="text-xs text-slate-500 py-3">No completed forms submitted yet.</p>`;
    }

    // Confirmation Modal & Cloud Storage Deletion for Templates and Completed Forms
    function promptDeleteFormItem(mode, id) {
      const isTemplate = mode === 'template';
      const item = isTemplate
        ? formTemplates.find(t => t.id === id)
        : formSubmissions.find(s => s.id === id);
      if (!item) return;

      const label = isTemplate ? item.title : `${item.template_title || 'Form'} (${item.submitted_by || 'Crew'})`;
      document.getElementById('modalTitle').textContent = isTemplate ? 'Confirm Delete PDF Template' : 'Confirm Delete Completed Form';
      document.getElementById('modalBody').innerHTML = `
        <div class="space-y-4">
          <div class="p-3.5 rounded-xl bg-red-950/80 border border-red-500/60 text-red-100 space-y-1.5">
            <p class="text-xs font-bold">Are you sure you want to permanently delete "${label}"?</p>
            <p class="text-[11px] text-red-200/90">
              ${isTemplate
                ? 'This will remove the mapped PDF template and delete its file from Supabase cloud storage.'
                : 'This will remove this completed form record and delete its generated PDF file from Supabase cloud storage to free up space.'}
            </p>
          </div>
          <div class="flex gap-2.5">
            <button onclick="executeDeleteFormItem('${mode}', '${id}')" class="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow">
              Yes, Delete Permanently
            </button>
            <button onclick="closeModal()" class="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs border border-slate-700">
              Cancel
            </button>
          </div>
        </div>
      `;
      document.getElementById('appModal').classList.remove('hidden');
    }

    async function executeDeleteFormItem(mode, id) {
      if (mode === 'template') {
        const target = formTemplates.find(t => t.id === id);
        formTemplates = formTemplates.filter(t => t.id !== id);
        try { localStorage.setItem('fieldops_form_templates', JSON.stringify(formTemplates)); } catch (e) {}

        if (supabaseClient && isOnline) {
          try {
            const storagePath = target ? extractFormsStoragePath(target.pdf_url) : `templates/${id}.pdf`;
            if (storagePath) await supabaseClient.storage.from('forms').remove([storagePath]);
          } catch (e) {}
          try { await supabaseClient.from('form_templates').delete().eq('id', id); } catch (e) {}
        }
        closeModal();
        renderAvailableFormsList();
        showSimpleToast('Template Deleted from App & Supabase', true);
      } else {
        const target = formSubmissions.find(s => s.id === id);
        formSubmissions = formSubmissions.filter(s => s.id !== id);
        try { localStorage.setItem('fieldops_form_submissions', JSON.stringify(formSubmissions)); } catch (e) {}

        if (supabaseClient && isOnline) {
          try {
            const storagePath = target ? extractFormsStoragePath(target.filled_pdf_url) : null;
            if (storagePath) await supabaseClient.storage.from('forms').remove([storagePath]);
          } catch (e) {}
          try { await supabaseClient.from('form_submissions').delete().eq('id', id); } catch (e) {}
        }
        closeModal();
        renderAvailableFormsList();
        showSimpleToast('Completed Form Deleted from Supabase', true);
      }
    }

    // =========================================================================
    // ADMIN TEMPLATE BUILDER: ZOOM, DRAG PINS, EDIT EXISTING & AI AUTO-SCAN
    // =========================================================================
    function resetTemplateBuilder() {
      editingTemplateId = null;
      builderPdfDoc = null;
      builderPdfBytes = null;
      builderPdfDataUrl = null;
      builderCurrentPage = 1;
      builderTotalPages = 1;
      builderFields = [];
      builderZoom = 1.0;
      document.getElementById('adminPdfTemplateFile').value = '';
      document.getElementById('adminTemplateTitle').value = '';
      document.getElementById('adminTemplateEmail').value = '';
      const saveBtn = document.getElementById('btnSaveFormTemplate');
      if (saveBtn) saveBtn.textContent = '💾 Save & Publish PDF Template';
      const canvas = document.getElementById('pdfBuilderCanvas');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      applyBuilderZoomStyle();
      renderBuilderPinsAndList();
    }

    // Load an already-saved template back into the mapper to adjust pin positions
    async function openEditFormTemplate(templateId) {
      const tpl = formTemplates.find(t => t.id === templateId);
      if (!tpl) return;

      editingTemplateId = tpl.id;
      builderPdfDataUrl = tpl.pdf_url;
      builderFields = JSON.parse(JSON.stringify(tpl.fields || []));
      builderZoom = 1.0;

      document.getElementById('adminTemplateTitle').value = tpl.title || '';
      document.getElementById('adminTemplateEmail').value = tpl.default_email || '';
      const saveBtn = document.getElementById('btnSaveFormTemplate');
      if (saveBtn) saveBtn.textContent = '💾 Save Updated Pin Locations';

      showFormsSubView('admin_builder');
      showSimpleToast('Loading PDF for Pin Editing...', false);

      try {
        builderPdfBytes = await fetch(tpl.pdf_url).then(r => r.arrayBuffer());
        if (window.pdfjsLib) {
          builderPdfDoc = await window.pdfjsLib.getDocument({ data: builderPdfBytes.slice(0) }).promise;
          builderTotalPages = builderPdfDoc.numPages;
          builderCurrentPage = 1;
          await renderBuilderPdfPage(1);
        }
      } catch (err) {
        showSimpleToast(`Failed to load PDF: ${err.message}`, true);
      }
    }

    async function handleAdminTemplatePdfUpload(event) {
      const file = event.target.files?.[0];
      if (!file) return;

      editingTemplateId = null;
      const saveBtn = document.getElementById('btnSaveFormTemplate');
      if (saveBtn) saveBtn.textContent = '💾 Save & Publish PDF Template';

      const titleInp = document.getElementById('adminTemplateTitle');
      if (titleInp && !titleInp.value) {
        titleInp.value = file.name.replace(/\.pdf$/i, '');
      }

      builderPdfBytes = await file.arrayBuffer();
      builderPdfDataUrl = await new Promise(res => {
        const r = new FileReader();
        r.onload = e => res(e.target.result);
        r.readAsDataURL(file);
      });

      if (window.pdfjsLib) {
        builderPdfDoc = await window.pdfjsLib.getDocument({ data: builderPdfBytes.slice(0) }).promise;
        builderTotalPages = builderPdfDoc.numPages;
        builderCurrentPage = 1;
        builderFields = [];
        builderZoom = 1.0;
        await renderBuilderPdfPage(1);
      }
    }

    async function renderBuilderPdfPage(pageNum) {
      if (!builderPdfDoc) return;
      builderCurrentPage = pageNum;
      document.getElementById('builderPageIndicator').textContent = `P. ${pageNum}/${builderTotalPages}`;

      const page = await builderPdfDoc.getPage(pageNum);
      // Render at high base resolution so zooming in stays sharp
      const viewport = page.getViewport({ scale: 1.8 });
      const canvas = document.getElementById('pdfBuilderCanvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      applyBuilderZoomStyle();
      renderBuilderPinsAndList();
    }

    function adjustBuilderZoom(delta) {
      builderZoom = Math.min(Math.max(0.5, +(builderZoom + delta).toFixed(2)), 3.0);
      applyBuilderZoomStyle();
    }

    function resetBuilderZoom() {
      builderZoom = 1.0;
      applyBuilderZoomStyle();
    }

    function applyBuilderZoomStyle() {
      const canvas = document.getElementById('pdfBuilderCanvas');
      const ind = document.getElementById('builderZoomIndicator');
      if (ind) ind.textContent = `${Math.round(builderZoom * 100)}%`;
      if (!canvas || !canvas.width) return;
      // At 100% zoom, base width is 680px; scaling width scales the overlay pins identically
      const displayWidth = Math.round(680 * builderZoom);
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = 'auto';
    }

    function changeBuilderPdfPage(delta) {
      if (!builderPdfDoc) return;
      const next = builderCurrentPage + delta;
      if (next >= 1 && next <= builderTotalPages) {
        renderBuilderPdfPage(next);
      }
    }

    function handlePdfCanvasTap(event) {
      if (justFinishedPinDrag) {
        justFinishedPinDrag = false;
        return;
      }
      if (!builderPdfDoc) return showSimpleToast('Upload a Blank PDF First', true);
      const canvas = document.getElementById('pdfBuilderCanvas');
      const rect = canvas.getBoundingClientRect();
      const normX = Math.round(((event.clientX - rect.left) / rect.width) * 1000);
      const normY = Math.round(((event.clientY - rect.top) / rect.height) * 1000);

      builderFields.push({
        id: 'fld_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        page: builderCurrentPage,
        label: `Field ${builderFields.length + 1}`,
        type: 'text',
        required: true,
        x: Math.min(Math.max(5, normX), 960),
        y: Math.min(Math.max(10, normY), 990)
      });
      renderBuilderPinsAndList();
    }

    // Drag any pin on the PDF canvas with mouse or finger
    function startPinDrag(event, fieldId) {
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
      draggingFieldId = fieldId;

      const canvas = document.getElementById('pdfBuilderCanvas');
      if (!canvas) return;

      const moveHandler = moveEvt => {
        if (!draggingFieldId) return;
        if (moveEvt.cancelable) moveEvt.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const clientX = moveEvt.touches ? moveEvt.touches[0].clientX : moveEvt.clientX;
        const clientY = moveEvt.touches ? moveEvt.touches[0].clientY : moveEvt.clientY;

        const normX = Math.min(Math.max(5, Math.round(((clientX - rect.left) / rect.width) * 1000)), 975);
        const normY = Math.min(Math.max(10, Math.round(((clientY - rect.top) / rect.height) * 1000)), 990);

        const target = builderFields.find(f => f.id === draggingFieldId);
        if (target) {
          target.x = normX;
          target.y = normY;
          renderBuilderPinsOnly();
          const xInp = document.getElementById(`fldX_${target.id}`);
          const yInp = document.getElementById(`fldY_${target.id}`);
          if (xInp) xInp.value = normX;
          if (yInp) yInp.value = normY;
        }
      };

      const upHandler = () => {
        draggingFieldId = null;
        justFinishedPinDrag = true;
        setTimeout(() => { justFinishedPinDrag = false; }, 120);
        window.removeEventListener('mousemove', moveHandler);
        window.removeEventListener('mouseup', upHandler);
        window.removeEventListener('touchmove', moveHandler);
        window.removeEventListener('touchend', upHandler);
      };

      window.addEventListener('mousemove', moveHandler, { passive: false });
      window.addEventListener('mouseup', upHandler);
      window.addEventListener('touchmove', moveHandler, { passive: false });
      window.addEventListener('touchend', upHandler);
    }

    async function aiAutoDetectPdfFormFields() {
      if (!builderPdfDoc) return showSimpleToast('Upload a Blank PDF First', true);
      const btn = document.getElementById('btnAiScanFormFields');
      btn.disabled = true;
      btn.textContent = 'Scanning Blank Spaces with Gemini AI...';

      const canvas = document.getElementById('pdfBuilderCanvas');
      const base64Img = scaleCanvasMax(canvas, 1600).toDataURL('image/jpeg', 0.88).split(',')[1];

      const prompt = `You are a precision PDF form coordinate mapper. Examine this form page and detect every writable blank line, cell, or signature line.
CRITICAL PLACEMENT RULES SO TEXT NEVER OVERLAPS PRINTED LABELS:
1. NEVER place "x" on top of printed label words (such as "JOB NAME", "CITY", "STATE", "Labor hrs:", "Carpenter hrs:", "Gravel:", "Concrete:", "Date:").
2. For "Label: _________" lines, place "x" in the BLANK WHITE SPACE strictly to the RIGHT of the label/colon (at least 15 to 25 units after the colon or last letter of the printed label), and place "y" directly on the horizontal line baseline.
3. For split lines like "_________ W/operator hrs: _________", create TWO separate fields: one in the blank space to the LEFT of "W/operator hrs:" (e.g. "Equipment Used 1", x at left blank area) and one in the blank space to the RIGHT of "W/operator hrs:" (e.g. "Equipment 1 Operator Hrs", x after the colon).
4. For boxed cells where a small caption sits at the bottom-left (like "CONTRACTOR" at the bottom of a box), place "y" in the open white space above that small caption so the stamped text does not touch the caption.
Scale "x" (0=left edge, 1000=right edge) and "y" (0=top edge, 1000=bottom edge).
Choose "type" from: ["text", "date", "job", "employee", "checkbox", "signature", "textarea"].
Return ONLY valid JSON:
{
  "fields": [
    { "label": "Job Name", "type": "job", "x": 185, "y": 388, "required": true }
  ]
}`;

      const res = await callGeminiWithFallback({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: 'image/jpeg', data: base64Img } }
          ]
        }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      });

      btn.disabled = false;
      btn.textContent = '✨ AI Auto-Detect Inputs on This Page';

      if (!res.ok) return showSimpleToast(`AI Scan Error: ${res.errorReason}`, true);

      try {
        const rawText = (res.data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text).map(p => p.text).join('\n');
        const cleaned = rawText.replace(/```json|```/gi, '').trim();
        const parsed = JSON.parse(cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned);
        if (Array.isArray(parsed.fields) && parsed.fields.length) {
          builderFields = builderFields.filter(f => f.page !== builderCurrentPage);
          parsed.fields.forEach((f, idx) => {
            builderFields.push({
              id: 'fld_' + Date.now() + '_' + idx,
              page: builderCurrentPage,
              label: f.label || `Field ${idx + 1}`,
              type: ['text', 'date', 'job', 'employee', 'checkbox', 'signature', 'textarea'].includes(f.type) ? f.type : 'text',
              required: f.required !== false,
              x: Math.min(Math.max(10, Math.round(Number(f.x) || 150)), 960),
              y: Math.min(Math.max(10, Math.round(Number(f.y) || 150)), 985)
            });
          });
          renderBuilderPinsAndList();
          showSimpleToast(`Mapped ${parsed.fields.length} Fields — Drag any pin to fine-tune!`, false);
        } else {
          showSimpleToast('No fields detected — tap on the PDF to add manually', true);
        }
      } catch (e) {
        showSimpleToast('Could not parse AI fields — tap PDF to add manually', true);
      }
    }

    function renderBuilderPinsOnly() {
      const overlay = document.getElementById('pdfOverlayPinsContainer');
      if (!overlay) return;
      const pageFields = builderFields.filter(f => f.page === builderCurrentPage);
      const fontPx = Math.max(9, Math.round(10.5 * (builderZoom || 1)));

      overlay.innerHTML = pageFields.map(f => {
        const globalIdx = builderFields.indexOf(f) + 1;
        const safeLabel = (f.label || `Field ${globalIdx}`).replace(/"/g, '&quot;');

        // 1. Signature Pad Preview: Proportional box matching exported signature size
        if (f.type === 'signature') {
          return `
            <div
              onmousedown="startPinDrag(event, '${f.id}')"
              ontouchstart="startPinDrag(event, '${f.id}')"
              style="position:absolute; left:${f.x / 10}%; top:${f.y / 10}%; width:18%; height:4.2%; transform:translateY(-70%); font-size:${fontPx}px;"
              title="Drag to move #${globalIdx} ${safeLabel}"
              class="pointer-events-auto cursor-move select-none flex items-center justify-center rounded border-2 border-dashed border-indigo-500 bg-indigo-500/15 hover:bg-indigo-500/30 text-indigo-950 font-bold shadow-sm overflow-hidden whitespace-nowrap px-1"
            >
              <span class="px-1 py-0.2 rounded bg-indigo-600 text-white text-[9px] mr-1 shrink-0">#${globalIdx}</span>
              <span class="truncate italic">✍ ${safeLabel}</span>
            </div>`;
        }

        // 2. Checkbox Preview: Compact square sitting directly on the checkbox target
        if (f.type === 'checkbox') {
          return `
            <div
              onmousedown="startPinDrag(event, '${f.id}')"
              ontouchstart="startPinDrag(event, '${f.id}')"
              style="position:absolute; left:${f.x / 10}%; top:${f.y / 10}%; transform:translateY(-85%); font-size:${fontPx}px;"
              title="Drag to move #${globalIdx} ${safeLabel}"
              class="pointer-events-auto cursor-move select-none inline-flex items-center gap-1 px-1 py-0.5 rounded border-2 border-emerald-600 bg-emerald-500/20 hover:bg-emerald-500/35 text-slate-900 font-extrabold shadow-sm whitespace-nowrap"
            >
              <span>✓</span>
              <span class="px-1 rounded bg-emerald-700 text-white text-[9px]">#${globalIdx}</span>
            </div>`;
        }

        // 3. Text / Date / Job / Employee Preview: See-through baseline box where bottom-left = exact PDF text start
        return `
          <div
            onmousedown="startPinDrag(event, '${f.id}')"
            ontouchstart="startPinDrag(event, '${f.id}')"
            style="position:absolute; left:${f.x / 10}%; top:${f.y / 10}%; transform:translateY(-100%); font-size:${fontPx}px; line-height:1.15;"
            title="Drag to move #${globalIdx} ${safeLabel} (Bottom-left corner = exact text start)"
            class="pointer-events-auto cursor-move select-none inline-flex items-baseline gap-1 px-1 pt-0.5 pb-0 rounded-t border-b-2 border-l-2 border-emerald-600 bg-emerald-400/20 hover:bg-emerald-400/35 text-slate-900 font-bold whitespace-nowrap"
          >
            <span class="px-1 rounded bg-emerald-700 text-white text-[9px] font-mono leading-tight shrink-0">#${globalIdx}</span>
            <span class="tracking-tight">${safeLabel}</span>
          </div>`;
      }).join('');
    }

    function renderBuilderPinsAndList() {
      const listEl = document.getElementById('adminMappedFieldsList');
      const badgeEl = document.getElementById('builderFieldCountBadge');
      if (!listEl) return;

      if (badgeEl) badgeEl.textContent = `${builderFields.length} field(s)`;
      renderBuilderPinsOnly();

      listEl.innerHTML = builderFields.map((f, idx) => `
        <div class="p-2.5 rounded-xl bg-slate-900 border border-slate-700 space-y-2 text-xs">
          <div class="flex items-center justify-between gap-2">
            <span class="font-mono font-bold text-emerald-400">#${idx + 1} (Page ${f.page})</span>
            <div class="flex items-center gap-2">
              <label class="flex items-center gap-1 text-[11px] text-slate-300">
                <input type="checkbox" ${f.required ? 'checked' : ''} onchange="updateBuilderField('${f.id}', 'required', this.checked)" /> Req
              </label>
              <button type="button" onclick="removeBuilderField('${f.id}')" class="text-red-400 hover:text-red-300 font-bold px-1.5">✕</button>
            </div>
          </div>

          <div class="grid grid-cols-5 gap-1.5">
            <input type="text" value="${f.label}" oninput="updateBuilderField('${f.id}', 'label', this.value)" class="col-span-3 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white font-semibold" placeholder="Field Label" />
            <select onchange="updateBuilderField('${f.id}', 'type', this.value)" class="col-span-2 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-indigo-300 font-semibold">
              <option value="text" ${f.type === 'text' ? 'selected' : ''}>Text Input</option>
              <option value="date" ${f.type === 'date' ? 'selected' : ''}>Date</option>
              <option value="job" ${f.type === 'job' ? 'selected' : ''}>Sage Job List</option>
              <option value="employee" ${f.type === 'employee' ? 'selected' : ''}>Employee Name</option>
              <option value="checkbox" ${f.type === 'checkbox' ? 'selected' : ''}>Checkbox (✓)</option>
              <option value="signature" ${f.type === 'signature' ? 'selected' : ''}>Signature Pad</option>
              <option value="textarea" ${f.type === 'textarea' ? 'selected' : ''}>Multi-line Note</option>
            </select>
          </div>

          <!-- Fine-Tune X / Y Coordinates -->
          <div class="grid grid-cols-2 gap-2 pt-1">
            <div class="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1">
              <span class="text-[10px] font-mono text-slate-400">X (Left→Right):</span>
              <input type="number" id="fldX_${f.id}" min="0" max="1000" value="${f.x}" oninput="updateBuilderField('${f.id}', 'x', Number(this.value))" class="w-full bg-transparent text-right font-mono font-bold text-emerald-400 focus:outline-none" />
            </div>
            <div class="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1">
              <span class="text-[10px] font-mono text-slate-400">Y (Top→Down):</span>
              <input type="number" id="fldY_${f.id}" min="0" max="1000" value="${f.y}" oninput="updateBuilderField('${f.id}', 'y', Number(this.value))" class="w-full bg-transparent text-right font-mono font-bold text-emerald-400 focus:outline-none" />
            </div>
          </div>
        </div>
      `).join('') || `<p class="text-xs text-slate-500 py-2">Tap on the PDF preview or click AI Auto-Detect to add inputs.</p>`;
    }

    function updateBuilderField(id, key, val) {
      const target = builderFields.find(f => f.id === id);
      if (!target) return;
      target[key] = val;
      if (key === 'label' || key === 'x' || key === 'y') {
        renderBuilderPinsOnly();
      } else {
        renderBuilderPinsAndList();
      }
    }

    function removeBuilderField(id) {
      builderFields = builderFields.filter(f => f.id !== id);
      renderBuilderPinsAndList();
    }

    async function saveAdminPdfTemplate() {
      const title = document.getElementById('adminTemplateTitle').value.trim();
      const defaultEmail = document.getElementById('adminTemplateEmail').value.trim();
      if (!builderPdfDataUrl || !title) {
        return showSimpleToast('Upload a PDF and enter a Form Title', true);
      }
      if (!builderFields.length) {
        return showSimpleToast('Add at least 1 input field to the PDF', true);
      }

      const btn = document.getElementById('btnSaveFormTemplate');
      btn.disabled = true;
      btn.textContent = 'Saving Template to Cloud...';

      const tplId = editingTemplateId || ('tpl_' + Date.now());
      let storedPdfUrl = builderPdfDataUrl;

      // Only upload PDF bytes if it's a new local data URL (not already a cloud URL)
      if (supabaseClient && isOnline && builderPdfDataUrl.startsWith('data:')) {
        try {
          const res = await fetch(builderPdfDataUrl);
          const blob = await res.blob();
          const path = `templates/${tplId}.pdf`;
          const { error } = await supabaseClient.storage.from('forms').upload(path, blob, { contentType: 'application/pdf', upsert: true });
          if (!error) {
            const { data: pub } = supabaseClient.storage.from('forms').getPublicUrl(path);
            if (pub?.publicUrl) storedPdfUrl = pub.publicUrl;
          }
        } catch (e) {}
      }

      const updatedTemplate = {
        id: tplId,
        title,
        default_email: defaultEmail || null,
        pdf_url: storedPdfUrl,
        fields: builderFields,
        created_at: new Date().toISOString()
      };

      const existingIdx = formTemplates.findIndex(t => t.id === tplId);
      if (existingIdx >= 0) {
        formTemplates[existingIdx] = updatedTemplate;
      } else {
        formTemplates.unshift(updatedTemplate);
      }
      try { localStorage.setItem('fieldops_form_templates', JSON.stringify(formTemplates)); } catch (e) {}

      if (supabaseClient && isOnline) {
        try { await supabaseClient.from('form_templates').upsert(updatedTemplate); } catch (e) {}
      }

      btn.disabled = false;
      btn.textContent = '💾 Save & Publish PDF Template';
      resetTemplateBuilder();
      showFormsSubView('list');
      renderAvailableFormsList();
      showSimpleToast('Form Template Saved!', false);
    }

    // =========================================================================
    // CREW FORM FILLER, TOUCH SIGNATURE PAD & PDF-LIB GENERATOR + EMAILER
    // =========================================================================
    function openFormFiller(templateId) {
      const tpl = formTemplates.find(t => t.id === templateId);
      if (!tpl) return;
      activeFillerTemplate = tpl;
      signaturePads = {};

      document.getElementById('fillerFormTitle').textContent = tpl.title;
      document.getElementById('fillerRecipientEmail').value = tpl.default_email || '';

      const emp = state.employees.find(e => e.id === activeCrewEmployeeId);
      const currentEmpName = currentRole === 'admin' ? 'Administrator' : (emp ? emp.full_name : '');
      const todayIso = new Date().toISOString().slice(0, 10);

      const jobOptions = `<option value="">-- Select Job --</option>` +
        state.jobs.map(j => `<option value="${j.name}">${j.name}</option>`).join('');

      const container = document.getElementById('fillerDynamicInputs');
      container.innerHTML = (tpl.fields || []).map(f => {
        const reqBadge = f.required ? `<span class="text-emerald-400">*</span>` : '';
        if (f.type === 'date') {
          return `
            <div>
              <label class="block text-xs font-bold text-slate-300 mb-1">${f.label} ${reqBadge}</label>
              <input type="date" id="fill_${f.id}" value="${todayIso}" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white" />
            </div>`;
        }
        if (f.type === 'employee') {
          return `
            <div>
              <label class="block text-xs font-bold text-slate-300 mb-1">${f.label} ${reqBadge}</label>
              <input type="text" id="fill_${f.id}" value="${currentEmpName}" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white font-semibold" />
            </div>`;
        }
        if (f.type === 'job') {
          return `
            <div>
              <label class="block text-xs font-bold text-slate-300 mb-1">${f.label} ${reqBadge}</label>
              <select id="fill_${f.id}" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white">
                ${jobOptions}
              </select>
            </div>`;
        }
        if (f.type === 'checkbox') {
          return `
            <label class="flex items-center justify-between p-3 rounded-xl bg-slate-900 border border-slate-700 cursor-pointer">
              <span class="text-xs font-bold text-white">${f.label}</span>
              <input type="checkbox" id="fill_${f.id}" class="w-5 h-5 accent-emerald-500 rounded" />
            </label>`;
        }
        if (f.type === 'textarea') {
          return `
            <div>
              <label class="block text-xs font-bold text-slate-300 mb-1">${f.label} ${reqBadge}</label>
              <textarea id="fill_${f.id}" rows="3" class="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-xs text-white"></textarea>
            </div>`;
        }
        if (f.type === 'signature') {
          return `
            <div class="space-y-1.5">
              <div class="flex items-center justify-between">
                <label class="text-xs font-bold text-emerald-300">${f.label} (Sign in box below) ${reqBadge}</label>
                <button type="button" onclick="clearSignaturePad('${f.id}')" class="text-[11px] text-slate-400 hover:text-white underline">Clear Signature</button>
              </div>
              <div class="bg-white rounded-xl overflow-hidden border-2 border-slate-600">
                <canvas id="sigCanvas_${f.id}" width="500" height="150" class="w-full h-32 touch-none cursor-crosshair"></canvas>
              </div>
            </div>`;
        }
        return `
          <div>
            <label class="block text-xs font-bold text-slate-300 mb-1">${f.label} ${reqBadge}</label>
            <input type="text" id="fill_${f.id}" placeholder="Enter ${f.label}" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white" />
          </div>`;
      }).join('');

      showFormsSubView('filler');

      setTimeout(() => {
        (tpl.fields || []).filter(f => f.type === 'signature').forEach(f => initSignaturePad(f.id));
      }, 60);
    }

    function initSignaturePad(fieldId) {
      const canvas = document.getElementById(`sigCanvas_${fieldId}`);
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      let drawing = false;
      let hasInk = false;
      signaturePads[fieldId] = { canvas, hasInk: () => hasInk, clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false; } };

      const getPos = e => {
        const r = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return {
          x: ((clientX - r.left) / r.width) * canvas.width,
          y: ((clientY - r.top) / r.height) * canvas.height
        };
      };

      const start = e => {
        e.preventDefault();
        drawing = true;
        hasInk = true;
        const p = getPos(e);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
      };
      const move = e => {
        if (!drawing) return;
        e.preventDefault();
        const p = getPos(e);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      };
      const end = () => { drawing = false; };

      canvas.addEventListener('mousedown', start);
      canvas.addEventListener('mousemove', move);
      window.addEventListener('mouseup', end);
      canvas.addEventListener('touchstart', start, { passive: false });
      canvas.addEventListener('touchmove', move, { passive: false });
      canvas.addEventListener('touchend', end);
    }

    function clearSignaturePad(fieldId) {
      if (signaturePads[fieldId]) signaturePads[fieldId].clear();
    }

    async function generateAndSendFilledPdf(mode) {
      if (!activeFillerTemplate || !window.PDFLib) return;

      const fields = activeFillerTemplate.fields || [];
      const answers = {};
      let detectedJobName = '';

      for (const f of fields) {
        if (f.type === 'signature') {
          const pad = signaturePads[f.id];
          if (f.required && (!pad || !pad.hasInk())) {
            return showSimpleToast(`Signature Required: ${f.label}`, true);
          }
          answers[f.label] = '[Signed]';
        } else if (f.type === 'checkbox') {
          const el = document.getElementById(`fill_${f.id}`);
          answers[f.label] = el && el.checked ? 'Yes' : 'No';
        } else {
          const el = document.getElementById(`fill_${f.id}`);
          const val = el ? el.value.trim() : '';
          if (f.required && !val) {
            return showSimpleToast(`Required Field: ${f.label}`, true);
          }
          answers[f.label] = val;
          if (f.type === 'job' && val) detectedJobName = val;
        }
      }

      const recipientEmail = document.getElementById('fillerRecipientEmail').value.trim();
      if (mode === 'share_or_email' && !recipientEmail) {
        return showSimpleToast('Enter a Recipient Email Address', true);
      }

      const btn = document.getElementById('btnGenerateAndEmailPdf');
      btn.disabled = true;
      btn.textContent = 'Stamping PDF & Uploading...';

      try {
        const existingPdfBytes = await fetch(activeFillerTemplate.pdf_url).then(r => r.arrayBuffer());
        const pdfDoc = await window.PDFLib.PDFDocument.load(existingPdfBytes);
        const font = await pdfDoc.embedFont(window.PDFLib.StandardFonts.HelveticaBold);
        const pages = pdfDoc.getPages();

        for (const f of fields) {
          const pageIdx = Math.max(0, Math.min((f.page || 1) - 1, pages.length - 1));
          const page = pages[pageIdx];
          const { width, height } = page.getSize();

          const pdfX = (f.x / 1000) * width;
          const pdfY = height - ((f.y / 1000) * height);

          if (f.type === 'signature') {
            const pad = signaturePads[f.id];
            if (pad && pad.hasInk()) {
              const pngDataUrl = pad.canvas.toDataURL('image/png');
              const pngImage = await pdfDoc.embedPng(pngDataUrl);
              page.drawImage(pngImage, {
                x: pdfX,
                y: Math.max(10, pdfY - 22),
                width: 115,
                height: 32
              });
            }
          } else if (f.type === 'checkbox') {
            const el = document.getElementById(`fill_${f.id}`);
            if (el && el.checked) {
              page.drawText('X', { x: pdfX, y: pdfY - 2, size: 11, font });
            }
          } else {
            const el = document.getElementById(`fill_${f.id}`);
            const textVal = el ? el.value.trim() : '';
            if (textVal) {
              page.drawText(textVal, {
                x: pdfX,
                y: pdfY - 1,
                size: 9.5,
                font,
                maxWidth: width - pdfX - 18,
                lineHeight: 11.5
              });
            }
          }
        }

        const pdfBytes = await pdfDoc.save();
        const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
        const safeFileName = `${activeFillerTemplate.title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
        const pdfFile = new File([pdfBlob], safeFileName, { type: 'application/pdf' });

        const subId = 'sub_' + Date.now();
        let publicPdfUrl = null;
        if (supabaseClient && isOnline) {
          try {
            const storagePath = `completed/${subId}_${safeFileName}`;
            const { error } = await supabaseClient.storage.from('forms').upload(storagePath, pdfBlob, { contentType: 'application/pdf', upsert: true });
            if (!error) {
              const { data: pub } = supabaseClient.storage.from('forms').getPublicUrl(storagePath);
              publicPdfUrl = pub?.publicUrl || null;
            }
          } catch (e) {}
        }

        const emp = state.employees.find(e => e.id === activeCrewEmployeeId);
        const submitterName = currentRole === 'admin' ? 'Administrator' : (emp ? emp.full_name : 'Crew Member');

        const submissionRecord = {
          id: subId,
          template_id: activeFillerTemplate.id,
          template_title: activeFillerTemplate.title,
          submitted_by: submitterName,
          recipient_email: recipientEmail || null,
          job_name: detectedJobName || null,
          filled_pdf_url: publicPdfUrl,
          answers,
          created_at: new Date().toISOString()
        };

        formSubmissions.unshift(submissionRecord);
        try { localStorage.setItem('fieldops_form_submissions', JSON.stringify(formSubmissions)); } catch (e) {}
        if (supabaseClient && isOnline) {
          try { await supabaseClient.from('form_submissions').insert(submissionRecord); } catch (e) {}
        }

        if (mode === 'download_only') {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(pdfBlob);
          a.download = safeFileName;
          a.click();
          showSimpleToast('Completed PDF Downloaded!', false);
        } else {
          if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
            await navigator.share({
              title: `${activeFillerTemplate.title} — ${submitterName}`,
              text: `Completed form "${activeFillerTemplate.title}" submitted by ${submitterName}.${publicPdfUrl ? '\nCloud PDF Copy: ' + publicPdfUrl : ''}`,
              files: [pdfFile]
            });
          } else {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(pdfBlob);
            a.download = safeFileName;
            a.click();

            const subject = encodeURIComponent(`${activeFillerTemplate.title} - ${submitterName} (${new Date().toLocaleDateString()})`);
            const summaryLines = Object.entries(answers).map(([k, v]) => `${k}: ${v}`).join('\n');
            const body = encodeURIComponent(
              `Completed PDF Form: ${activeFillerTemplate.title}\nSubmitted By: ${submitterName}\n\n` +
              (publicPdfUrl ? `View / Download Signed PDF:\n${publicPdfUrl}\n\n` : `(Signed PDF downloaded to your computer — attach ${safeFileName})\n\n`) +
              `--- Form Summary ---\n${summaryLines}`
            );
            window.location.href = `mailto:${encodeURIComponent(recipientEmail)}?subject=${subject}&body=${body}`;
          }
          showSimpleToast('PDF Generated & Ready to Send!', false);
        }

        showFormsSubView('list');
        renderAvailableFormsList();
      } catch (err) {
        showSimpleToast(`PDF Error: ${err.message}`, true);
      } finally {
        btn.disabled = false;
        btn.textContent = '✉ Complete & Email PDF';
      }
    }
