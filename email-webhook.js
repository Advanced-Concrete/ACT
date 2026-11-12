// =========================================================================
    // SILENT BACKGROUND PDF EMAILER (GOOGLE APPS SCRIPT + SUPABASE SYNC)
    // =========================================================================
    let actEmailWebhookUrl = '';

    async function loadEmailWebhookFromSupabase() {
      try {
        const cached = localStorage.getItem('fieldops_email_webhook_url');
        if (cached) actEmailWebhookUrl = cached.trim();
      } catch (e) {}

      if (typeof supabaseClient !== 'undefined' && supabaseClient && isOnline) {
        try {
          const { data, error } = await supabaseClient
            .from('app_settings')
            .select('ocr_api_key')
            .eq('id', 'email_webhook_url')
            .maybeSingle();
          if (!error && data?.ocr_api_key) {
            actEmailWebhookUrl = data.ocr_api_key.trim();
            try { localStorage.setItem('fieldops_email_webhook_url', actEmailWebhookUrl); } catch (e) {}
          }
        } catch (e) {}
      }
      injectEmailWebhookAdminButton();
    }

    function injectEmailWebhookAdminButton() {
      const adminTabBtn = document.getElementById('btnFormsAdminTab');
      if (!adminTabBtn || !adminTabBtn.parentNode) return;

      let hookBtn = document.getElementById('btnFormsEmailWebhookConfig');
      if (!hookBtn) {
        hookBtn = document.createElement('button');
        hookBtn.id = 'btnFormsEmailWebhookConfig';
        hookBtn.setAttribute('onclick', 'openEmailWebhookConfigModal()');
        hookBtn.className = 'px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-700 text-emerald-300 border border-emerald-500/40 font-bold text-xs';
        adminTabBtn.parentNode.appendChild(hookBtn);
      }

      const isAdmin = (typeof getActiveUserEffectiveRole === 'function')
        ? getActiveUserEffectiveRole() === 'admin'
        : (typeof currentRole !== 'undefined' && currentRole === 'admin');

      hookBtn.classList.toggle('hidden', !isAdmin);
      hookBtn.textContent = actEmailWebhookUrl ? '✉ Auto-Email: Active' : '⚙ Setup Auto-Email';
    }

    window.openEmailWebhookConfigModal = function() {
      document.getElementById('modalTitle').textContent = 'Silent Background PDF Email Setup';
      document.getElementById('modalBody').innerHTML = `
        <div class="space-y-3.5 text-xs">
          <p class="text-slate-300 leading-relaxed">
            Paste your <strong>Google Apps Script Web App URL</strong> below. Once saved, it syncs to Supabase so every user's phone automatically emails completed PDF forms in the background with one tap.
          </p>
          <div>
            <label class="block font-bold text-slate-300 mb-1">Google Apps Script Web App URL (<span class="font-mono text-emerald-400">.../exec</span>)</label>
            <input type="url" id="inpEmailWebhookUrl" value="${(actEmailWebhookUrl || '').replace(/"/g, '&quot;')}" placeholder="https://script.google.com/macros/s/.../exec" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-white font-mono text-[11px]" />
          </div>
          <div class="flex flex-wrap gap-2 pt-2">
            <button onclick="saveEmailWebhookUrl(false)" class="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow">
              💾 Save & Sync to All Devices
            </button>
            <button onclick="saveEmailWebhookUrl(true)" id="btnTestEmailWebhook" class="px-4 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow">
              ✉ Save & Send Test Email
            </button>
            <button onclick="closeModal()" class="px-4 py-3 rounded-xl bg-slate-800 text-slate-300 font-bold border border-slate-700">
              Cancel
            </button>
          </div>
        </div>
      `;
      document.getElementById('appModal').classList.remove('hidden');
    };

    window.saveEmailWebhookUrl = async function(sendTest) {
      const val = (document.getElementById('inpEmailWebhookUrl')?.value || '').trim();
      actEmailWebhookUrl = val;
      try { localStorage.setItem('fieldops_email_webhook_url', val); } catch (e) {}

      if (typeof supabaseClient !== 'undefined' && supabaseClient && isOnline) {
        try {
          await supabaseClient.from('app_settings').upsert({
            id: 'email_webhook_url',
            ocr_api_key: val,
            updated_at: new Date().toISOString()
          });
        } catch (e) {}
      }

      injectEmailWebhookAdminButton();

      if (!sendTest) {
        closeModal();
        return showSimpleToast(val ? 'Auto-Email Webhook Synced!' : 'Webhook Cleared', false);
      }

      if (!val) return showSimpleToast('Paste your Web App URL first', true);

      const testBtn = document.getElementById('btnTestEmailWebhook');
      if (testBtn) {
        testBtn.disabled = true;
        testBtn.textContent = 'Sending Test...';
      }

      try {
        const res = await fetch(val, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            recipientEmail: 'jake@advconcrete.com',
            subject: 'ACT App — Silent Background Email Test',
            body: 'Your ACT Silent Background Emailer is connected and working!',
            senderName: 'ACT Field Forms'
          })
        });
        const out = await res.json();
        if (out && out.ok) {
          closeModal();
          showSimpleToast('Test Email Sent Successfully!', false);
        } else {
          showSimpleToast(`Webhook Error: ${out?.error || 'Check permissions'}`, true);
        }
      } catch (err) {
        showSimpleToast(`Connection Error: ${err.message}`, true);
      } finally {
        if (testBtn) {
          testBtn.disabled = false;
          testBtn.textContent = '✉ Save & Send Test Email';
        }
      }
    };

    // Helper: Convert Uint8Array PDF bytes to Base64 without stack overflow on large PDFs
    function uint8ToBase64(uint8) {
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < uint8.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, uint8.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    }

    // Override generateAndSendFilledPdf to send silently via the Webhook when mode === 'share_or_email'
    window.generateAndSendFilledPdf = async function(mode) {
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
      btn.textContent = mode === 'share_or_email'
        ? 'Stamping PDF & Emailing in Background...'
        : 'Stamping & Saving PDF...';

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

        // Upload completed PDF to Supabase Storage ('forms' bucket)
        const subId = 'sub_' + Date.now();
        let publicPdfUrl = null;
        if (typeof supabaseClient !== 'undefined' && supabaseClient && isOnline) {
          try {
            const storagePath = `completed/${subId}_${safeFileName}`;
            const { error } = await supabaseClient.storage.from('forms').upload(storagePath, pdfBlob, { contentType: 'application/pdf', upsert: true });
            if (!error) {
              const { data: pub } = supabaseClient.storage.from('forms').getPublicUrl(storagePath);
              publicPdfUrl = pub?.publicUrl || null;
            }
          } catch (e) {}
        }

        const emp = (state.employees || []).find(e => e.id === activeCrewEmployeeId);
        const submitterName = emp ? emp.full_name : (currentRole === 'admin' ? 'Administrator' : 'Crew Member');

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
        if (typeof supabaseClient !== 'undefined' && supabaseClient && isOnline) {
          try { await supabaseClient.from('form_submissions').insert(submissionRecord); } catch (e) {}
        }

        if (mode === 'download_only') {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(pdfBlob);
          a.download = safeFileName;
          a.click();
          showSimpleToast('Completed PDF Downloaded!', false);
        } else if (actEmailWebhookUrl && isOnline) {
          // SILENT 1-CLICK BACKGROUND EMAIL WITH ATTACHED PDF
          const pdfBase64 = uint8ToBase64(pdfBytes);
          const summaryRows = Object.entries(answers)
            .map(([k, v]) => `<tr><td style="padding:4px 8px;border:1px solid #cbd5e1;font-weight:bold;">${k}</td><td style="padding:4px 8px;border:1px solid #cbd5e1;">${v}</td></tr>`)
            .join('');

          const emailSubject = `${activeFillerTemplate.title}${detectedJobName ? ' — ' + detectedJobName : ''} (${submitterName})`;
          const htmlBody = `
            <div style="font-family:Arial,sans-serif;font-size:13px;color:#0f172a;">
              <h3 style="margin:0 0 8px 0;color:#059669;">ACT Completed Field Form: ${activeFillerTemplate.title}</h3>
              <p style="margin:0 0 12px 0;">
                <strong>Submitted By:</strong> ${submitterName}<br>
                ${detectedJobName ? `<strong>Job:</strong> ${detectedJobName}<br>` : ''}
                <strong>Date:</strong> ${new Date().toLocaleString()}<br>
                ${publicPdfUrl ? `<strong>Cloud PDF Link:</strong> <a href="${publicPdfUrl}">View / Download PDF</a>` : ''}
              </p>
              <table style="border-collapse:collapse;width:100%;max-width:540px;font-size:12px;">
                ${summaryRows}
              </table>
              <p style="margin-top:12px;font-size:11px;color:#64748b;">The signed PDF copy (${safeFileName}) is attached to this email.</p>
            </div>
          `;

          const response = await fetch(actEmailWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              recipientEmail,
              subject: emailSubject,
              body: `Completed form "${activeFillerTemplate.title}" submitted by ${submitterName}. Signed PDF is attached.`,
              htmlBody,
              fileName: safeFileName,
              pdfBase64,
              senderName: 'ACT Field Forms'
            })
          });

          const resJson = await response.json();
          if (!resJson || !resJson.ok) {
            throw new Error(resJson?.error || 'Email webhook rejected request');
          }
          showSimpleToast(`✉ PDF Emailed to ${recipientEmail}!`, false);
        } else {
          // Offline / Unconfigured Fallback
          const pdfFile = new File([pdfBlob], safeFileName, { type: 'application/pdf' });
          if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
            await navigator.share({
              title: `${activeFillerTemplate.title} — ${submitterName}`,
              text: `Completed form "${activeFillerTemplate.title}" submitted by ${submitterName}.`,
              files: [pdfFile]
            });
          } else {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(pdfBlob);
            a.download = safeFileName;
            a.click();
          }
          showSimpleToast('Saved! (Configure Auto-Email Webhook for silent sending)', false);
        }

        showFormsSubView('list');
        renderAvailableFormsList();
      } catch (err) {
        showSimpleToast(`Email / PDF Error: ${err.message}`, true);
      } finally {
        btn.disabled = false;
        btn.textContent = '✉ Complete & Email PDF';
      }
    };

    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(loadEmailWebhookFromSupabase, 700);
    });

    const _prevSelectMenuForEmail = window.selectMenuFeature;
    window.selectMenuFeature = function(featureKey) {
      if (_prevSelectMenuForEmail) _prevSelectMenuForEmail(featureKey);
      if (featureKey === 'forms') {
        setTimeout(injectEmailWebhookAdminButton, 100);
      }
    };
