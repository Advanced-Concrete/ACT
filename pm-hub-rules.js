// =========================================================================
    // 4-TIER USER HIERARCHY (ADMIN / PM / SUPERVISOR / CREW) & PM PROJECT HUB
    // =========================================================================
    let jobTimeEntries = [];
    let activePmPortalTab = 'docs';
    let adminViewingPersonalCard = false;
    let lastLoggedInUserSessionKey = null;

    const USER_ROLE_LABELS = {
      admin:      { label: 'Administrator',   short: 'Admin',      badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40', textClass: 'text-emerald-400' },
      pm:         { label: 'Project Manager', short: 'PM',         badgeClass: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',   textClass: 'text-indigo-400' },
      supervisor: { label: 'Supervisor',      short: 'Supervisor', badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',     textClass: 'text-amber-400' },
      crew:       { label: 'Crew Member',     short: 'Crew',       badgeClass: 'bg-slate-700/60 text-slate-300 border-slate-600',        textClass: 'text-slate-400' }
    };

    const APPOINTED_ROLE_DEFAULTS = {
      'jake textor':   { role: 'admin',      email: 'jake@advconcrete.com' },
      'eddie varner':  { role: 'pm',         email: '' },
      'gary salyers':  { role: 'supervisor', email: '' },
      'grant gilbert': { role: 'supervisor', email: '' }
    };

    function applyStoredRolesSync() {
      try {
        const raw = localStorage.getItem('fieldops_roles_pm_meta');
        let meta = raw ? JSON.parse(raw) : { empRoles: {}, jobPms: {} };

        // Auto-heal stale 'crew' entries from the SQL DEFAULT 'crew' column migration
        if (!meta.v3_fixed) {
          meta.empRoles = meta.empRoles || {};
          Object.entries(APPOINTED_ROLE_DEFAULTS).forEach(([lowerName, cfg]) => {
            (state?.employees || []).forEach(e => {
              if ((e.full_name || '').trim().toLowerCase() === lowerName) {
                meta.empRoles[e.id] = { role: cfg.role, email: e.email || cfg.email || '', explicitly_saved: true };
                meta.empRoles[e.full_name] = { role: cfg.role, email: e.email || cfg.email || '', explicitly_saved: true };
                e.role = cfg.role;
                if (cfg.email && !e.email) e.email = cfg.email;
              }
            });
          });
          meta.v3_fixed = true;
          try { localStorage.setItem('fieldops_roles_pm_meta', JSON.stringify(meta)); } catch (e) {}
        }

        if (meta.empRoles && Array.isArray(state?.employees)) {
          state.employees.forEach(e => {
            const lowerName = (e.full_name || '').trim().toLowerCase();
            const saved = meta.empRoles[e.id] || meta.empRoles[e.full_name];
            if (saved && saved.role && (saved.role !== 'crew' || saved.explicitly_saved)) {
              e.role = saved.role;
              if (saved.email) e.email = saved.email;
            } else if (APPOINTED_ROLE_DEFAULTS[lowerName]) {
              e.role = APPOINTED_ROLE_DEFAULTS[lowerName].role;
              if (APPOINTED_ROLE_DEFAULTS[lowerName].email && !e.email) {
                e.email = APPOINTED_ROLE_DEFAULTS[lowerName].email;
              }
            }
          });
        }

        if (meta.jobPms && Array.isArray(state?.jobs)) {
          state.jobs.forEach(j => {
            const saved = meta.jobPms[j.id] || meta.jobPms[j.name];
            if (saved) {
              if (saved.pm_name) j.pm_name = saved.pm_name;
              if (saved.pm_email) j.pm_email = saved.pm_email;
              if (saved.pm_employee_id) j.pm_employee_id = saved.pm_employee_id;
            }
          });
        }
      } catch (e) {}
    }

    function getEmployeeRole(emp) {
      applyStoredRolesSync();
      if (!emp) return 'crew';
      const lowerName = (emp.full_name || '').trim().toLowerCase();
      const r = (emp.role || '').toLowerCase().trim();
      if (r === 'admin' || r === 'pm' || r === 'supervisor') return r;
      if (APPOINTED_ROLE_DEFAULTS[lowerName]) return APPOINTED_ROLE_DEFAULTS[lowerName].role;
      return 'crew';
    }

    function getActiveUserEffectiveRole() {
      applyStoredRolesSync();
      if (typeof activeCrewEmployeeId !== 'undefined' && activeCrewEmployeeId) {
        const emp = (state.employees || []).find(e => e.id === activeCrewEmployeeId);
        if (emp) return getEmployeeRole(emp);
      }
      if (typeof currentRole !== 'undefined' && (currentRole === 'admin' || currentRole === 'pm' || currentRole === 'supervisor')) {
        return currentRole;
      }
      return 'crew';
    }

    function resolveRecordJobInfo(rec) {
      if (!rec) return { jobId: '', jobName: '' };
      const rawCandidates = [
        rec.job_name,
        rec.job,
        rec.jobName,
        rec.assigned_job,
        rec.ocr_job,
        rec.job_id,
        rec.jobId,
        rec.project_name
      ].filter(v => v !== undefined && v !== null && String(v).trim() !== '').map(v => String(v).trim());

      const jobs = state.jobs || [];
      for (const candidate of rawCandidates) {
        const lower = candidate.toLowerCase();
        const byId = jobs.find(j => String(j.id || '').toLowerCase() === lower);
        if (byId) return { jobId: byId.id, jobName: (byId.name || '').trim() };

        const byName = jobs.find(j => String(j.name || '').trim().toLowerCase() === lower);
        if (byName) return { jobId: byName.id, jobName: (byName.name || '').trim() };

        const bySageNum = jobs.find(j => j.sage_job_number && String(j.sage_job_number).trim().toLowerCase() === lower);
        if (bySageNum) return { jobId: bySageNum.id, jobName: (bySageNum.name || '').trim() };
      }

      return {
        jobId: String(rec.job_id || rec.jobId || '').trim(),
        jobName: rawCandidates[0] || ''
      };
    }

    async function loadPmPortalData() {
      applyStoredRolesSync();
      try {
        const cached = localStorage.getItem('fieldops_job_time_entries');
        if (cached) jobTimeEntries = JSON.parse(cached);
      } catch (e) {}

      if (supabaseClient && isOnline) {
        try {
          const [jobsRes, empRes, timeRes, metaRes] = await Promise.all([
            supabaseClient.from('jobs').select('*').eq('active', true).order('name'),
            supabaseClient.from('employees').select('*').order('full_name'),
            supabaseClient.from('job_time_entries').select('*').order('work_date', { ascending: false }),
            supabaseClient.from('app_settings').select('ocr_api_key').eq('id', 'roles_pm_meta').maybeSingle()
          ]);

          if (!metaRes.error && metaRes.data?.ocr_api_key) {
            try {
              localStorage.setItem('fieldops_roles_pm_meta', metaRes.data.ocr_api_key);
            } catch (e) {}
          }
          if (!jobsRes.error && jobsRes.data?.length) {
            state.jobs = jobsRes.data;
          }
          if (!empRes.error && empRes.data?.length) {
            state.employees = empRes.data;
          }
          if (!timeRes.error && timeRes.data) {
            jobTimeEntries = timeRes.data;
            try { localStorage.setItem('fieldops_job_time_entries', JSON.stringify(jobTimeEntries)); } catch (e) {}
          }
        } catch (e) {}
      }

      applyStoredRolesSync();
      refreshRoleUiVisibility();
    }

    async function persistRolesAndPmMeta() {
      const empRoles = {};
      (state.employees || []).forEach(e => {
        const r = (e.role || '').toLowerCase().trim() || getEmployeeRole(e);
        empRoles[e.id] = { role: r, email: e.email || '', explicitly_saved: true };
        empRoles[e.full_name] = { role: r, email: e.email || '', explicitly_saved: true };
      });
      const jobPms = {};
      (state.jobs || []).forEach(j => {
        if (j.pm_name || j.pm_email) {
          jobPms[j.id] = { pm_name: j.pm_name || '', pm_email: j.pm_email || '', pm_employee_id: j.pm_employee_id || '' };
          jobPms[j.name] = { pm_name: j.pm_name || '', pm_email: j.pm_email || '', pm_employee_id: j.pm_employee_id || '' };
        }
      });

      const payloadObj = { v3_fixed: true, empRoles, jobPms };
      try { localStorage.setItem('fieldops_roles_pm_meta', JSON.stringify(payloadObj)); } catch (e) {}

      if (supabaseClient && isOnline) {
        try {
          await supabaseClient.from('app_settings').upsert({
            id: 'roles_pm_meta',
            ocr_api_key: JSON.stringify(payloadObj),
            updated_at: new Date().toISOString()
          });
        } catch (e) {}
      }
    }

    // 2. Ensure Side Menu & Top Quick-Switch Bar Work for Admin, PM, Supervisor & Crew
    function ensureMenuButtonsExist() {
      const receiptsBtn = document.getElementById('menuFeatReceipts');
      if (!receiptsBtn || !receiptsBtn.parentNode) return;
      const mainFeaturesContainer = receiptsBtn.parentNode;

      // Move Field Forms, Time Cards & Payroll out of #drawerAdminFutureFeatures into the main FEATURES list
      ['menuFeatForms', 'menuFeatTimecards', 'menuFeatPayroll'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn && btn.parentNode !== mainFeaturesContainer) {
          mainFeaturesContainer.appendChild(btn);
        }
      });

      if (!document.getElementById('menuFeatMyPersonalCard')) {
        const myCardBtn = document.createElement('button');
        myCardBtn.id = 'menuFeatMyPersonalCard';
        myCardBtn.setAttribute('onclick', 'openMyPersonalCardView()');
        myCardBtn.className = 'hidden w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition';
        myCardBtn.innerHTML = `
          <span class="flex items-center gap-2.5">
            <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>
            <span id="menuMyCardLabel">My Personal Card</span>
          </span>
          <span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono">Card</span>
        `;
        mainFeaturesContainer.insertBefore(myCardBtn, receiptsBtn.nextSibling);
      }

      let pmBtn = document.getElementById('menuFeatPmPortal');
      if (!pmBtn) {
        pmBtn = document.createElement('button');
        pmBtn.id = 'menuFeatPmPortal';
        pmBtn.setAttribute('onclick', "selectMenuFeature('pm_portal')");
        pmBtn.className = 'w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition';
        pmBtn.innerHTML = `
          <span class="flex items-center gap-2.5">
            <svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
            PM Project Hub
          </span>
          <span id="pmMenuBadge" class="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[10px] font-mono">PM</span>
        `;
      }
      if (pmBtn.parentNode !== mainFeaturesContainer) {
        mainFeaturesContainer.appendChild(pmBtn);
      }

      let roleBtn = document.getElementById('menuFeatUserRoles');
      if (!roleBtn) {
        roleBtn = document.createElement('button');
        roleBtn.id = 'menuFeatUserRoles';
        roleBtn.setAttribute('onclick', 'closeSideMenu(); openUserRolesManagerModal();');
        roleBtn.className = 'w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition';
        roleBtn.innerHTML = `
          <span class="flex items-center gap-2.5">
            <svg class="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            User Levels & Roles
          </span>
          <span class="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-mono">Admin</span>
        `;
      }
      if (roleBtn.parentNode !== mainFeaturesContainer) {
        mainFeaturesContainer.appendChild(roleBtn);
      }

      // Inject a clean Role Workspace Switcher Bar at the top of <main> for Project Managers & Supervisors
      const mainEl = document.querySelector('main');
      if (mainEl && !document.getElementById('roleWorkspaceQuickBar')) {
        const bar = document.createElement('div');
        bar.id = 'roleWorkspaceQuickBar';
        bar.className = 'hidden mb-4 bg-slate-800/95 border border-indigo-500/40 rounded-2xl p-3 flex flex-wrap items-center justify-between gap-2 shadow-lg';
        mainEl.insertBefore(bar, mainEl.firstChild);
      }
    }

    window.openMyPersonalCardView = function() {
      adminViewingPersonalCard = true;
      document.getElementById('viewPmPortal')?.classList.add('hidden');
      document.getElementById('viewOtherModule')?.classList.add('hidden');
      document.getElementById('viewAdmin')?.classList.add('hidden');
      document.getElementById('viewCrew')?.classList.remove('hidden');
      const emp = (state.employees || []).find(e => e.id === activeCrewEmployeeId);
      document.getElementById('topBarPageTitle').textContent = emp ? `My Card — ${emp.full_name}` : 'My Card & Receipts';
      closeSideMenu();
      if (typeof renderCrewView === 'function') renderCrewView();
    };

    function refreshRoleUiVisibility() {
      ensureMenuButtonsExist();
      const effRole = getActiveUserEffectiveRole();
      const emp = (state.employees || []).find(e => e.id === activeCrewEmployeeId);
      const roleInfo = USER_ROLE_LABELS[effRole] || USER_ROLE_LABELS.crew;
      const isAdmin = (effRole === 'admin');
      const isAssignedPmOnAnyJob = emp && (state.jobs || []).some(
        j => (j.pm_name || '').trim().toLowerCase() === (emp.full_name || '').trim().toLowerCase()
      );
      const isPmOrSupv = (effRole === 'pm' || effRole === 'supervisor' || isAssignedPmOnAnyJob);

      if (isAdmin && typeof currentRole !== 'undefined' && currentRole === 'crew') {
        currentRole = 'admin';
      }

      // CRITICAL FIX: Ensure the Side Menu's upper scrollable container & FEATURES list are NEVER hidden!
      const drawer = document.getElementById('sideMenuDrawer');
      if (drawer) {
        Array.from(drawer.children).forEach(child => child.classList.remove('hidden'));
        const receiptsBtn = document.getElementById('menuFeatReceipts');
        if (receiptsBtn && receiptsBtn.parentElement) {
          receiptsBtn.parentElement.classList.remove('hidden');
          if (receiptsBtn.parentElement.parentElement) {
            receiptsBtn.parentElement.parentElement.classList.remove('hidden');
          }
        }

        // Update Side Drawer Role Subtitle ("Crew Member" -> "Project Manager" / "Supervisor" / "Administrator")
        drawer.querySelectorAll('p, div, span').forEach(el => {
          const txt = (el.textContent || '').trim();
          if (
            el.dataset.roleSubtitle === '1' ||
            txt === 'Crew Member' ||
            txt === 'Admin Portal' ||
            txt === 'Administrator' ||
            txt === 'Project Manager' ||
            txt === 'Supervisor'
          ) {
            if (el.children.length === 0) {
              el.dataset.roleSubtitle = '1';
              el.textContent = emp ? roleInfo.label : (isAdmin ? 'Admin Portal' : roleInfo.label);
              el.className = `text-[11px] font-semibold ${roleInfo.textClass}`;
            }
          }
        });

        const drawerTitleEl = document.getElementById('drawerUserName') || document.getElementById('sideMenuUserName');
        if (drawerTitleEl && emp) {
          drawerTitleEl.textContent = emp.full_name;
        }
      }

      // Update Top-Right Active User Pill (e.g. "PM: Eddie Varner", "Supervisor: Gary Salyers", "Admin: Jake Textor")
      const topUserBadge = document.getElementById('topBarUserName') || document.getElementById('activeUserBadgeText') || document.getElementById('topBarUserLabel');
      if (topUserBadge && emp) {
        topUserBadge.textContent = effRole === 'crew' ? emp.full_name : `${roleInfo.short}: ${emp.full_name}`;
      }

      // Only hide Admin-only sub-containers (#drawerAdminPages, #drawerAdminTools, #btnDrawerResetData) for non-admins
      ['drawerAdminSection', 'drawerOptionsSection', 'drawerResetDataBtn', 'drawerAdminPages', 'drawerAdminTools', 'btnDrawerResetData'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !isAdmin);
      });

      // Show "My Personal Card" shortcut for Appointed Admins who also hold a card
      const myCardBtn = document.getElementById('menuFeatMyPersonalCard');
      if (myCardBtn) {
        if (isAdmin && emp) {
          const empCards = (state.cards || []).filter(c => (c.assigned_employee_id || c.employee_id) === emp.id);
          const cNum = empCards.length ? (empCards[0].last_four || empCards[0].last4 || '') : '';
          const last4 = cNum ? ` (•••• ${cNum})` : '';
          const lbl = document.getElementById('menuMyCardLabel');
          if (lbl) lbl.textContent = `My Personal Card${last4}`;
          myCardBtn.classList.remove('hidden');
        } else {
          myCardBtn.classList.add('hidden');
        }
      }

      // Show/Hide Feature Buttons by Role (Crew Members NEVER see these tabs)
      const pmBtn = document.getElementById('menuFeatPmPortal');
      if (pmBtn) {
        pmBtn.classList.toggle('hidden', !(isAdmin || isPmOrSupv));
        const badge = document.getElementById('pmMenuBadge');
        if (badge) badge.textContent = effRole === 'supervisor' ? 'Supv' : 'PM';
      }

      const futureWrap = document.getElementById('drawerAdminFutureFeatures');
      if (futureWrap) futureWrap.classList.toggle('hidden', !(isAdmin || isPmOrSupv));

      const tcBtn = document.getElementById('menuFeatTimecards');
      if (tcBtn) tcBtn.classList.toggle('hidden', !(isAdmin || isPmOrSupv));

      const prBtn = document.getElementById('menuFeatPayroll');
      if (prBtn) prBtn.classList.toggle('hidden', !(isAdmin || effRole === 'pm' || isAssignedPmOnAnyJob));

      const roleMenuBtn = document.getElementById('menuFeatUserRoles');
      if (roleMenuBtn) roleMenuBtn.classList.toggle('hidden', !isAdmin);

      const allowCrewForms = localStorage.getItem('fieldops_allow_crew_forms') === 'true';
      const formsBtn = document.getElementById('menuFeatForms');
      if (formsBtn) {
        formsBtn.classList.toggle('hidden', !(isAdmin || isPmOrSupv || allowCrewForms));
      }

      // Render Top Role Quick-Switch Bar for Project Managers & Supervisors
      const quickBar = document.getElementById('roleWorkspaceQuickBar');
      const loginView = document.getElementById('loginScreen') || document.getElementById('viewLogin');
      const isLoggedOut = loginView && !loginView.classList.contains('hidden');

      if (quickBar) {
        if (!isLoggedOut && !isAdmin && isPmOrSupv && emp) {
          const empCards = (state.cards || []).filter(c => (c.assigned_employee_id || c.employee_id) === emp.id);
          const cNum = empCards.length ? (empCards[0].last_four || empCards[0].last4 || '') : '';
          const cardSuffix = cNum ? ` (•••• ${cNum})` : '';
          quickBar.classList.remove('hidden');
          quickBar.innerHTML = `
            <div class="flex items-center gap-2">
              <span class="px-2.5 py-1 rounded-lg border text-xs font-extrabold ${roleInfo.badgeClass}">${roleInfo.label}</span>
              <span class="text-xs font-bold text-white">${emp.full_name}</span>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <button type="button" onclick="selectMenuFeature('pm_portal')" class="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow">
                📂 PM Project Hub
              </button>
              <button type="button" onclick="openMyPersonalCardView()" class="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-700 text-emerald-300 border border-emerald-500/40 font-bold text-xs">
                💳 My Card${cardSuffix}
              </button>
              <button type="button" onclick="selectMenuFeature('forms')" class="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold text-xs">
                📄 Field Forms (PDF)
              </button>
            </div>
          `;
        } else {
          quickBar.classList.add('hidden');
        }
      }

      // Auto-route Project Managers to their PM Project Hub when they first log in
      const sessionKey = isLoggedOut ? null : `${effRole}_${activeCrewEmployeeId || 'root'}`;
      if (sessionKey && sessionKey !== lastLoggedInUserSessionKey) {
        lastLoggedInUserSessionKey = sessionKey;
        if (!isAdmin && (effRole === 'pm' || isAssignedPmOnAnyJob)) {
          setTimeout(() => selectMenuFeature('pm_portal'), 50);
        }
      } else if (!sessionKey) {
        lastLoggedInUserSessionKey = null;
      }
    }

    const _baseLoadStateFromDB = window.loadStateFromDB;
    if (typeof _baseLoadStateFromDB === 'function') {
      window.loadStateFromDB = async function() {
        const loaded = await _baseLoadStateFromDB.apply(this, arguments);
        setTimeout(() => {
          applyStoredRolesSync();
          refreshRoleUiVisibility();
        }, 30);
        return loaded;
      };
    }

    const _baseOpenSideMenu = window.openSideMenu;
    window.openSideMenu = function() {
      refreshRoleUiVisibility();
      if (_baseOpenSideMenu) _baseOpenSideMenu();
      refreshRoleUiVisibility();
    };

    const _baseRenderAll = window.renderAll;
    window.renderAll = function() {
      refreshRoleUiVisibility();
      if (_baseRenderAll) _baseRenderAll();
      refreshRoleUiVisibility();
      if (adminViewingPersonalCard && getActiveUserEffectiveRole() === 'admin' && activeCrewEmployeeId) {
        document.getElementById('viewAdmin')?.classList.add('hidden');
        document.getElementById('viewCrew')?.classList.remove('hidden');
      }
    };

    // 3. Extend selectMenuFeature so PM Hub, Time Cards, Payroll, and Field Forms work for all permitted roles
    const _baseSelectMenuFeature = window.selectMenuFeature;
    window.selectMenuFeature = function(featureKey) {
      adminViewingPersonalCard = false;
      refreshRoleUiVisibility();
      const pmSection = document.getElementById('viewPmPortal');
      if (pmSection) pmSection.classList.add('hidden');

      const effRole = getActiveUserEffectiveRole();
      const emp = (state.employees || []).find(e => e.id === activeCrewEmployeeId);
      const isAssignedPm = emp && (state.jobs || []).some(
        j => (j.pm_name || '').trim().toLowerCase() === (emp.full_name || '').trim().toLowerCase()
      );

      // Route 'pm_portal', 'timecards', and 'payroll' directly into their dedicated PM Project Hub views & tabs!
      if (featureKey === 'pm_portal' || featureKey === 'timecards' || featureKey === 'payroll') {
        if (effRole !== 'admin' && effRole !== 'pm' && effRole !== 'supervisor' && !isAssignedPm) {
          closeSideMenu();
          return showSimpleToast('PM Project Hub requires PM, Supervisor, or Admin level', true);
        }
        const hubLabel = effRole === 'supervisor' ? 'Supervisor Job Hub' : 'PM Project Hub';
        const viewMeta = {
          pm_portal: { top: hubLabel,     eye: 'Project Manager Workspace', h1: `${hubLabel} — Docs, Receipts, Hours & Payroll`, tab: 'docs' },
          timecards: { top: 'Time Cards', eye: 'Crew Timekeeping & Hours',  h1: 'Time Cards — Crew Hours Logged',                    tab: 'hours' },
          payroll:   { top: 'Payroll',    eye: 'Labor Cost & Payroll',      h1: 'Payroll — Project Labor Breakdown',                 tab: 'payroll' }
        };
        const cfg = viewMeta[featureKey] || viewMeta.pm_portal;
        activePmPortalTab = cfg.tab;

        document.getElementById('topBarPageTitle').textContent = cfg.top;
        const eyeEl = document.getElementById('pmHubEyebrow');
        const h1El = document.getElementById('pmHubMainHeading');
        if (eyeEl) eyeEl.textContent = cfg.eye;
        if (h1El) h1El.textContent = cfg.h1;

        document.getElementById('viewCrew')?.classList.add('hidden');
        document.getElementById('viewAdmin')?.classList.add('hidden');
        document.getElementById('viewOtherModule')?.classList.add('hidden');
        if (pmSection) pmSection.classList.remove('hidden');
        closeSideMenu();
        switchPmPortalTab(cfg.tab);
        initPmPortalView();
        return;
      }

      if (featureKey === 'forms') {
        document.getElementById('topBarPageTitle').textContent = 'Field Forms (PDF)';
        document.getElementById('viewCrew')?.classList.add('hidden');
        document.getElementById('viewAdmin')?.classList.add('hidden');
        document.getElementById('viewOtherModule')?.classList.remove('hidden');
        document.getElementById('otherModulePlaceholderCard')?.classList.add('hidden');
        document.getElementById('fieldFormsWorkspace')?.classList.remove('hidden');
        const adminTabBtn = document.getElementById('btnFormsAdminTab');
        if (adminTabBtn) adminTabBtn.classList.toggle('hidden', effRole !== 'admin');
        showFormsSubView('list');
        loadFormTemplatesFromSupabase();
        closeSideMenu();
        return;
      }

      if (_baseSelectMenuFeature) _baseSelectMenuFeature(featureKey);
      refreshRoleUiVisibility();
    };

    const _baseOpenAdminPage = window.openAdminPage;
    window.openAdminPage = function(pageKey) {
      adminViewingPersonalCard = false;
      if (getActiveUserEffectiveRole() === 'admin') {
        currentRole = 'admin';
      }
      document.getElementById('viewPmPortal')?.classList.add('hidden');
      if (_baseOpenAdminPage) _baseOpenAdminPage(pageKey);
      refreshRoleUiVisibility();
      if (pageKey === 'jobs') {
        setTimeout(checkUnassignedJobsForPmPrompt, 200);
      }
    };

    (function initRolesAndPmModuleImmediately() {
      applyStoredRolesSync();
      ensureMenuButtonsExist();
      refreshRoleUiVisibility();
      setTimeout(async () => {
        await loadPmPortalData();
        hookNewJobInputsForPmPrompt();
        injectRoleButtonIntoPmHeader();
        refreshRoleUiVisibility();
      }, 300);
    })();

    function injectRoleButtonIntoPmHeader() {
      const pmSection = document.getElementById('viewPmPortal');
      if (!pmSection || document.getElementById('btnOpenRolesModalInHub')) return;
      const btnRow = pmSection.querySelector('.flex.flex-wrap.items-center.gap-2');
      if (btnRow) {
        const btn = document.createElement('button');
        btn.id = 'btnOpenRolesModalInHub';
        btn.setAttribute('onclick', 'openUserRolesManagerModal()');
        btn.className = 'px-3 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 font-bold text-xs';
        btn.textContent = '👥 User Levels & Roles';
        btnRow.appendChild(btn);
      }
    }

    // =========================================================================
    // 4. ADMIN USER LEVELS & ROLES MANAGER MODAL (ADMIN / PM / SUPERVISOR / CREW)
    // =========================================================================
    window.openUserRolesManagerModal = function openUserRolesManagerModal() {
      if (typeof closeSideMenu === 'function') closeSideMenu();
      if (getActiveUserEffectiveRole() !== 'admin') {
        return showSimpleToast('Only Administrators can change user levels', true);
      }
      const emps = [...(state.employees || [])].sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

      document.getElementById('modalTitle').textContent = 'Manage User Levels & Roles (Admin / PM / Supervisor / Crew)';
      document.getElementById('modalBody').innerHTML = `
        <div class="space-y-3 text-xs">
          <p class="text-slate-400 leading-relaxed">
            Appoint users to <strong>Admin</strong>, <strong>Project Manager</strong>, <strong>Supervisor</strong>, or <strong>Crew / User</strong>. Logging in as that user automatically unlocks their role's workspace and menu options.
          </p>

          <div class="flex flex-wrap gap-1.5 pb-1">
            <span class="px-2 py-0.5 rounded border text-[10px] font-bold ${USER_ROLE_LABELS.admin.badgeClass}">Admin: Full Control + Own Card</span>
            <span class="px-2 py-0.5 rounded border text-[10px] font-bold ${USER_ROLE_LABELS.pm.badgeClass}">Project Manager: PM Hub & Job Docs/Spend</span>
            <span class="px-2 py-0.5 rounded border text-[10px] font-bold ${USER_ROLE_LABELS.supervisor.badgeClass}">Supervisor: Field Lead & Hours</span>
            <span class="px-2 py-0.5 rounded border text-[10px] font-bold ${USER_ROLE_LABELS.crew.badgeClass}">Crew / User: Card & Forms</span>
          </div>

          <div class="space-y-2 max-h-96 overflow-y-auto custom-scroll pr-1">
            ${emps.map(e => {
              const role = getEmployeeRole(e);
              return `
                <div class="p-2.5 rounded-xl bg-slate-900 border border-slate-700 grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                  <div class="sm:col-span-4 font-bold text-white truncate">
                    ${e.full_name}
                    ${e.active === false ? `<span class="text-[10px] text-red-400 ml-1">(Inactive)</span>` : ''}
                  </div>
                  <div class="sm:col-span-4">
                    <select id="roleSelect_${e.id}" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white font-semibold">
                      <option value="crew" ${role === 'crew' ? 'selected' : ''}>Crew / User</option>
                      <option value="supervisor" ${role === 'supervisor' ? 'selected' : ''}>Supervisor</option>
                      <option value="pm" ${role === 'pm' ? 'selected' : ''}>Project Manager</option>
                      <option value="admin" ${role === 'admin' ? 'selected' : ''}>Administrator</option>
                    </select>
                  </div>
                  <div class="sm:col-span-4">
                    <input type="email" id="roleEmail_${e.id}" value="${(e.email || '').replace(/"/g, '&quot;')}" placeholder="Email (for PM routing)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white font-mono text-[11px]" />
                  </div>
                </div>
              `;
            }).join('')}
          </div>

          <div class="flex gap-2 pt-2">
            <button onclick="saveAllUserRoles()" class="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow">
              💾 Save All User Levels
            </button>
            <button onclick="closeModal()" class="px-4 py-3 rounded-xl bg-slate-800 text-slate-300 font-bold border border-slate-700">
              Cancel
            </button>
          </div>
        </div>
      `;
      document.getElementById('appModal').classList.remove('hidden');
    };

    window.saveAllUserRoles = async function() {
      (state.employees || []).forEach(e => {
        const rSel = document.getElementById(`roleSelect_${e.id}`);
        const emInp = document.getElementById(`roleEmail_${e.id}`);
        if (rSel) e.role = rSel.value;
        if (emInp) e.email = emInp.value.trim() || null;

        if (e.email) {
          (state.jobs || []).forEach(j => {
            if ((j.pm_name || '').trim().toLowerCase() === (e.full_name || '').trim().toLowerCase() && !j.pm_email) {
              j.pm_email = e.email;
            }
          });
        }
      });

      await persistRolesAndPmMeta();
      if (supabaseClient && isOnline) {
        try { await supabaseClient.from('employees').upsert(state.employees); } catch (e) {}
      }
      await saveState();
      refreshRoleUiVisibility();
      closeModal();
      if (!document.getElementById('viewPmPortal')?.classList.contains('hidden')) {
        initPmPortalView();
      }
      showSimpleToast('User Levels & Roles Updated!', false);
    };

    // =========================================================================
    // 5. JOB CREATION & PM ASSIGNMENT
    // =========================================================================
    function getAppointedPmList() {
      const allEmps = state.employees || [];
      const pmsAndAdmins = allEmps.filter(e => {
        const r = getEmployeeRole(e);
        return r === 'pm' || r === 'admin';
      });
      return pmsAndAdmins.length ? pmsAndAdmins : allEmps;
    }

    function hookNewJobInputsForPmPrompt() {
      document.querySelectorAll('button').forEach(btn => {
        const oc = btn.getAttribute('onclick') || '';
        if (oc.includes('addJob') || oc.includes('createJob')) {
          btn.setAttribute('onclick', 'interceptAddJobWithPmPrompt()');
        }
      });
    }

    function interceptAddJobWithPmPrompt() {
      const nameInp = document.getElementById('newJobInput') || document.getElementById('jobNameInput');
      const prefilledJobName = nameInp ? nameInp.value.trim() : '';
      openNewJobWithPmModal(prefilledJobName);
    }

    window.autoFillModalPmEmail = function(selectedName) {
      const nameInp = document.getElementById('modalNewJobPmName');
      const emailInp = document.getElementById('modalNewJobPmEmail');
      if (nameInp && selectedName) nameInp.value = selectedName;

      const emp = (state.employees || []).find(e => (e.full_name || '').toLowerCase() === (selectedName || '').toLowerCase());
      if (emp && emp.email && emailInp) {
        emailInp.value = emp.email;
        return;
      }
      const existingJobWithPm = (state.jobs || []).find(
        j => (j.pm_name || '').toLowerCase() === (selectedName || '').toLowerCase() && j.pm_email
      );
      if (existingJobWithPm && emailInp) {
        emailInp.value = existingJobWithPm.pm_email;
      }
    };

    window.openNewJobWithPmModal = function openNewJobWithPmModal(prefilledJobName = '') {
      const pmCandidates = getAppointedPmList();
      const otherEmps = (state.employees || []).filter(e => !pmCandidates.includes(e));

      const empOptions =
        `<option value="">-- Select Project Manager --</option>` +
        `<optgroup label="Appointed Project Managers & Admins">` +
        pmCandidates.map(e => `<option value="${e.full_name.replace(/"/g, '&quot;')}">${e.full_name} (${USER_ROLE_LABELS[getEmployeeRole(e)].label})</option>`).join('') +
        `</optgroup>` +
        (otherEmps.length ? `<optgroup label="Other Roster Users">` + otherEmps.map(e => `<option value="${e.full_name.replace(/"/g, '&quot;')}">${e.full_name}</option>`).join('') + `</optgroup>` : '');

      document.getElementById('modalTitle').textContent = 'Add Job & Assign Project Manager';
      document.getElementById('modalBody').innerHTML = `
        <div class="space-y-3.5 text-xs">
          <div>
            <label class="block font-bold text-slate-300 mb-1">Job Number & Name <span class="text-emerald-400">*</span></label>
            <input type="text" id="modalNewJobName" value="${prefilledJobName.replace(/"/g, '&quot;')}" placeholder="e.g. 26-104 Bingham Elementary" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-white font-semibold" />
          </div>

          <div class="p-3 rounded-xl bg-slate-900/90 border border-indigo-500/40 space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-bold uppercase tracking-wider text-indigo-400">Designated Project Manager (Required)</span>
              ${getActiveUserEffectiveRole() === 'admin' ? `<button type="button" onclick="openUserRolesManagerModal()" class="text-[11px] text-amber-300 underline">Manage PM Roles</button>` : ''}
            </div>
            <div>
              <label class="block text-slate-400 mb-1">Select Project Manager</label>
              <select onchange="autoFillModalPmEmail(this.value)" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white">
                ${empOptions}
              </select>
            </div>
            <div>
              <label class="block font-bold text-slate-300 mb-1">Project Manager Name <span class="text-emerald-400">*</span></label>
              <input type="text" id="modalNewJobPmName" placeholder="e.g. Eddie Varner" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white font-semibold" />
            </div>
            <div>
              <label class="block font-bold text-slate-300 mb-1">Project Manager Email (Default for PDF Forms) <span class="text-emerald-400">*</span></label>
              <input type="email" id="modalNewJobPmEmail" placeholder="eddie@advconcrete.com" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono" />
            </div>
          </div>

          <div class="flex gap-2 pt-2">
            <button onclick="saveNewJobWithPm()" class="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow">
              Save Job & Assign PM
            </button>
            <button onclick="closeModal()" class="px-4 py-3 rounded-xl bg-slate-800 text-slate-300 font-bold border border-slate-700">
              Cancel
            </button>
          </div>
        </div>
      `;
      document.getElementById('appModal').classList.remove('hidden');
    }

    async function saveNewJobWithPm() {
      const name = document.getElementById('modalNewJobName')?.value.trim();
      const pmName = document.getElementById('modalNewJobPmName')?.value.trim();
      const pmEmail = document.getElementById('modalNewJobPmEmail')?.value.trim();

      if (!name) return showSimpleToast('Enter a Job Name', true);
      if (!pmName) return showSimpleToast('Enter a Project Manager Name', true);
      if (!pmEmail) return showSimpleToast('Enter the Project Manager Email', true);

      const matchedEmp = (state.employees || []).find(e => (e.full_name || '').toLowerCase() === pmName.toLowerCase());
      if (matchedEmp) {
        if (!matchedEmp.email) matchedEmp.email = pmEmail;
        if (getEmployeeRole(matchedEmp) === 'crew') matchedEmp.role = 'pm';
      }

      const newJob = {
        id: 'job_' + Date.now(),
        name,
        active: true,
        pm_employee_id: matchedEmp ? matchedEmp.id : null,
        pm_name: pmName,
        pm_email: pmEmail
      };

      state.jobs.push(newJob);
      state.jobs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      const oldInp = document.getElementById('newJobInput') || document.getElementById('jobNameInput');
      if (oldInp) oldInp.value = '';

      await persistRolesAndPmMeta();
      if (supabaseClient && isOnline) {
        try { await supabaseClient.from('jobs').upsert(newJob); } catch (e) {}
      }
      await saveState();
      closeModal();
      renderAll();
      if (!document.getElementById('viewPmPortal')?.classList.contains('hidden')) {
        initPmPortalView();
      }
      showSimpleToast(`Job "${name}" Saved (PM: ${pmName})`, false);
    }

    function checkUnassignedJobsForPmPrompt() {
      const unassigned = (state.jobs || []).filter(j => j.active !== false && (!j.pm_name || !j.pm_email));
      if (unassigned.length > 0 && getActiveUserEffectiveRole() === 'admin') {
        openAssignPmToExistingJobsModal(true);
      }
    }

    window.openAssignPmToExistingJobsModal = function openAssignPmToExistingJobsModal(onlyUnassignedNotice = false) {
      const jobs = (state.jobs || []).filter(j => j.active !== false);
      const pmCandidates = getAppointedPmList();
      const empDatalist = `<datalist id="pmRosterList">${pmCandidates.map(e => `<option value="${e.full_name}">`).join('')}</datalist>`;

      document.getElementById('modalTitle').textContent = 'Assign Project Managers & Default Form Emails';
      document.getElementById('modalBody').innerHTML = `
        <div class="space-y-3 text-xs">
          ${empDatalist}
          ${onlyUnassignedNotice ? `
            <div class="p-3 rounded-xl bg-amber-950/80 border border-amber-500/60 text-amber-200">
              <strong>New / Unassigned Jobs Detected:</strong> Please assign a Project Manager and Email below so completed PDF forms and job spend route automatically.
            </div>
          ` : `
            <p class="text-slate-400">Assign a Project Manager and Email to each job. When that job is selected on any receipt or PDF form, its spend and documents link directly to that Project Manager.</p>
          `}
          <div class="space-y-2.5 max-h-96 overflow-y-auto custom-scroll pr-1">
            ${jobs.map(j => `
              <div class="p-3 rounded-xl bg-slate-900 border ${(!j.pm_name || !j.pm_email) ? 'border-amber-500/60' : 'border-slate-700'} space-y-2">
                <div class="font-bold text-white flex items-center justify-between">
                  <span>${j.name}</span>
                  ${(!j.pm_name || !j.pm_email) ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">Needs PM</span>` : `<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">✓ Assigned</span>`}
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input type="text" list="pmRosterList" id="editJobPmName_${j.id}" value="${(j.pm_name || '').replace(/"/g, '&quot;')}" placeholder="PM Full Name" class="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white font-semibold" />
                  <input type="email" id="editJobPmEmail_${j.id}" value="${(j.pm_email || '').replace(/"/g, '&quot;')}" placeholder="PM Email Address" class="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white font-mono" />
                </div>
              </div>
            `).join('')}
          </div>
          <div class="flex gap-2 pt-2">
            <button onclick="saveAllJobPmAssignments()" class="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow">
              Save All PM Assignments
            </button>
            <button onclick="closeModal()" class="px-4 py-3 rounded-xl bg-slate-800 text-slate-300 font-bold border border-slate-700">
              Close
            </button>
          </div>
        </div>
      `;
      document.getElementById('appModal').classList.remove('hidden');
    }

    async function saveAllJobPmAssignments() {
      const updatedJobs = [];
      (state.jobs || []).forEach(j => {
        const nameEl = document.getElementById(`editJobPmName_${j.id}`);
        const emailEl = document.getElementById(`editJobPmEmail_${j.id}`);
        if (nameEl && emailEl) {
          const pmName = nameEl.value.trim();
          const pmEmail = emailEl.value.trim();
          const matchedEmp = (state.employees || []).find(e => (e.full_name || '').toLowerCase() === pmName.toLowerCase());
          if (matchedEmp) {
            if (pmEmail && !matchedEmp.email) matchedEmp.email = pmEmail;
            if (getEmployeeRole(matchedEmp) === 'crew') matchedEmp.role = 'pm';
          }
          j.pm_name = pmName || null;
          j.pm_email = pmEmail || null;
          j.pm_employee_id = matchedEmp ? matchedEmp.id : (j.pm_employee_id || null);
          updatedJobs.push(j);
        }
      });

      await persistRolesAndPmMeta();
      if (supabaseClient && isOnline && updatedJobs.length) {
        try { await supabaseClient.from('jobs').upsert(updatedJobs); } catch (e) {}
      }
      await saveState();
      closeModal();
      if (!document.getElementById('viewPmPortal')?.classList.contains('hidden')) {
        initPmPortalView();
      }
      showSimpleToast('Project Manager Assignments Saved!', false);
    }

    // =========================================================================
    // 6. AUTO-FILL PM EMAIL WHEN JOB IS SELECTED ON ANY PDF FORM
    // =========================================================================
    window.handleFillerJobSelect = function(selectedJobName) {
      const emailInp = document.getElementById('fillerRecipientEmail');
      let badgeEl = document.getElementById('fillerPmAutoRouteBadge');
      if (!badgeEl && emailInp) {
        badgeEl = document.createElement('div');
        badgeEl.id = 'fillerPmAutoRouteBadge';
        badgeEl.className = 'text-[11px] font-semibold mt-1';
        emailInp.parentNode.appendChild(badgeEl);
      }

      const matchedJob = (state.jobs || []).find(
        j => (j.name || '').trim().toLowerCase() === (selectedJobName || '').trim().toLowerCase()
      );

      if (matchedJob && matchedJob.pm_email) {
        if (emailInp) emailInp.value = matchedJob.pm_email;
        if (badgeEl) {
          badgeEl.className = 'text-[11px] font-semibold text-emerald-400 mt-1';
          badgeEl.textContent = `✓ Auto-routed to Project Manager: ${matchedJob.pm_name || 'PM'} (${matchedJob.pm_email})`;
        }
        showSimpleToast(`Email set to PM: ${matchedJob.pm_name}`, false);
      } else if (matchedJob && !matchedJob.pm_email) {
        if (badgeEl) {
          badgeEl.className = 'text-[11px] font-semibold text-amber-400 mt-1';
          badgeEl.innerHTML = `⚠ No PM email assigned to "${matchedJob.name}" yet. <button type="button" onclick="openAssignPmToExistingJobsModal()" class="underline ml-1">Assign PM</button>`;
        }
      } else if (badgeEl) {
        badgeEl.textContent = '';
      }
    };

    const _baseOpenFormFiller = window.openFormFiller;
    window.openFormFiller = function(templateId) {
      const tpl = formTemplates.find(t => t.id === templateId);
      if (tpl && Array.isArray(tpl.fields)) {
        tpl.fields.forEach(f => {
          if (f.type === 'text' && /\b(job\s*name|project\s*name|job\s*#?)\b/i.test(f.label || '')) {
            f.type = 'job';
          }
        });
      }

      if (_baseOpenFormFiller) _baseOpenFormFiller(templateId);

      if (tpl && Array.isArray(tpl.fields)) {
        tpl.fields.filter(f => f.type === 'job').forEach(f => {
          const sel = document.getElementById(`fill_${f.id}`);
          if (sel) {
            sel.addEventListener('change', e => handleFillerJobSelect(e.target.value));
          }
        });
      }
    };

    // =========================================================================
    // 7. PROJECT MANAGER PORTAL: DOCS, RECEIPTS/INVOICES, HOURS & PAYROLL
    // =========================================================================
    window.initPmPortalView = async function initPmPortalView() {
      await loadPmPortalData();
      await loadFormTemplatesFromSupabase();
      injectRoleButtonIntoPmHeader();

      const pmSelect = document.getElementById('pmPortalSelectedPm');
      if (!pmSelect) return;

      const effRole = getActiveUserEffectiveRole();
      const loggedInEmp = (state.employees || []).find(e => e.id === activeCrewEmployeeId);

      const roleHubBtn = document.getElementById('btnOpenRolesModalInHub');
      if (roleHubBtn) roleHubBtn.classList.toggle('hidden', effRole !== 'admin');

      const pmNamesSet = new Set();
      (state.jobs || []).forEach(j => {
        if (j.pm_name && j.pm_name.trim()) pmNamesSet.add(j.pm_name.trim());
      });
      (state.employees || []).forEach(e => {
        if (getEmployeeRole(e) === 'pm' && e.full_name) pmNamesSet.add(e.full_name.trim());
      });
      const pmNames = Array.from(pmNamesSet).sort();

      if (effRole === 'pm' && loggedInEmp) {
        const myName = loggedInEmp.full_name.trim();
        pmSelect.innerHTML = `<option value="${myName.replace(/"/g, '&quot;')}">${myName} (My Assigned Projects)</option>`;
        pmSelect.value = myName;
        pmSelect.disabled = true;
      } else {
        pmSelect.disabled = false;
        const previousVal = pmSelect.value;
        pmSelect.innerHTML =
          `<option value="ALL">All Project Managers (${(state.jobs || []).length} Jobs)</option>` +
          pmNames.map(name => `<option value="${name.replace(/"/g, '&quot;')}">${name}</option>`).join('');
        if (previousVal && (previousVal === 'ALL' || pmNames.includes(previousVal))) {
          pmSelect.value = previousVal;
        } else {
          pmSelect.value = 'ALL';
        }
      }

      handlePmPortalFilterChange();
    }

    function handlePmPortalFilterChange() {
      const selectedPm = document.getElementById('pmPortalSelectedPm')?.value || 'ALL';
      const jobSelect = document.getElementById('pmPortalSelectedJob');
      if (!jobSelect) return;

      const matchingJobs = (state.jobs || []).filter(j => {
        if (selectedPm === 'ALL') return true;
        return (j.pm_name || '').trim().toLowerCase() === selectedPm.trim().toLowerCase();
      });

      jobSelect.innerHTML =
        `<option value="ALL">All Assigned Jobs (${matchingJobs.length})</option>` +
        matchingJobs.map(j => `<option value="${j.name.replace(/"/g, '&quot;')}">${j.name} ${j.pm_name ? `(${j.pm_name})` : ''}</option>`).join('');

      switchPmPortalTab(activePmPortalTab || 'docs');
    }

    window.switchPmPortalTab = function switchPmPortalTab(tabKey) {
      activePmPortalTab = tabKey;
      ['docs', 'receipts', 'hours', 'payroll'].forEach(k => {
        const btn = document.getElementById(`pmTabBtn_${k}`);
        if (btn) {
          btn.className = k === tabKey
            ? 'px-3.5 py-2 rounded-xl text-xs font-bold bg-indigo-600 text-white shadow'
            : 'px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-900 text-slate-300 hover:text-white';
        }
      });
      renderPmPortalContent();
    }

    function renderPmPortalContent() {
      const selectedPm = document.getElementById('pmPortalSelectedPm')?.value || 'ALL';
      const selectedJob = document.getElementById('pmPortalSelectedJob')?.value || 'ALL';

      const pmJobs = (state.jobs || []).filter(j => {
        const nameMatch = selectedJob === 'ALL' || (j.name || '').trim().toLowerCase() === selectedJob.trim().toLowerCase();
        const pmMatch = selectedPm === 'ALL' || (j.pm_name || '').trim().toLowerCase() === selectedPm.trim().toLowerCase();
        return nameMatch && pmMatch;
      });

      const allowedJobNames = new Set(pmJobs.map(j => (j.name || '').trim().toLowerCase()).filter(Boolean));
      const allowedJobIds   = new Set(pmJobs.map(j => String(j.id || '').trim().toLowerCase()).filter(Boolean));

      if (selectedJob !== 'ALL') {
        allowedJobNames.add(selectedJob.trim().toLowerCase());
      }

      const recordBelongsToFilter = rec => {
        const info = resolveRecordJobInfo(rec);
        const rName = (info.jobName || '').trim().toLowerCase();
        const rId   = (info.jobId || '').trim().toLowerCase();

        if (selectedPm === 'ALL' && selectedJob === 'ALL') {
          return Boolean(rName || rId || (state.jobs || []).length > 0);
        }
        if (rId && allowedJobIds.has(rId)) return true;
        if (rName && allowedJobNames.has(rName)) return true;
        return false;
      };

      const docs = (formSubmissions || []).filter(s => {
        if (recordBelongsToFilter(s)) return true;
        if (s.answers && typeof s.answers === 'object') {
          return Object.values(s.answers).some(
            v => typeof v === 'string' && allowedJobNames.has(v.trim().toLowerCase())
          );
        }
        return false;
      });

      const receipts = (state.statementLines || []).filter(r => recordBelongsToFilter(r));
      const hoursList = (jobTimeEntries || []).filter(t => recordBelongsToFilter(t));

      const totalReceiptSpend = receipts.reduce((sum, r) => {
        const val = r.amount !== null && r.amount !== undefined && r.amount !== '' ? Number(r.amount) : Number(r.ocr_amount || 0);
        return sum + (isNaN(val) ? 0 : val);
      }, 0);
      const totalHours = hoursList.reduce((sum, t) => sum + (Number(t.hours) || 0), 0);
      const totalPayroll = hoursList.reduce((sum, t) => sum + ((Number(t.hours) || 0) * (Number(t.hourly_rate) || 0)), 0);

      document.getElementById('pmKpiDocs').textContent = docs.length;
      document.getElementById('pmKpiReceipts').textContent = `$${totalReceiptSpend.toFixed(2)}`;
      document.getElementById('pmKpiHours').textContent = `${totalHours.toFixed(1)} hrs`;
      document.getElementById('pmKpiPayroll').textContent = `$${totalPayroll.toFixed(2)}`;

      const body = document.getElementById('pmPortalTabBody');
      if (!body) return;

      if (activePmPortalTab === 'docs') {
        body.innerHTML = `
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <h2 class="text-xs font-bold uppercase tracking-wider text-indigo-400">Completed Project PDFs (${docs.length})</h2>
              <button onclick="selectMenuFeature('forms')" class="px-3 py-1.5 rounded-xl bg-emerald-600 text-white font-bold text-xs">+ Fill New PDF Form</button>
            </div>
            <div class="space-y-2">
              ${docs.map(d => {
                const jInfo = resolveRecordJobInfo(d);
                return `
                  <div class="p-3 rounded-xl bg-slate-900 border border-slate-700 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div>
                      <div class="font-bold text-white">${d.template_title || 'Completed PDF'}</div>
                      <div class="text-[11px] text-slate-400">
                        Job: <span class="text-emerald-300 font-semibold">${jInfo.jobName || d.job_name || 'Assigned'}</span> •
                        By: ${d.submitted_by || 'Crew'} •
                        ${d.created_at ? new Date(d.created_at).toLocaleDateString() : ''}
                        ${d.recipient_email ? ` • Sent to: ${d.recipient_email}` : ''}
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      ${d.filled_pdf_url ? `<a href="${d.filled_pdf_url}" target="_blank" rel="noopener" class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs">View Signed PDF</a>` : ''}
                    </div>
                  </div>
                `;
              }).join('') || `<p class="text-xs text-slate-500 py-4">No completed PDF documents found for the selected PM / Job filter.</p>`}
            </div>
          </div>
        `;
        return;
      }

      if (activePmPortalTab === 'receipts') {
        body.innerHTML = `
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <h2 class="text-xs font-bold uppercase tracking-wider text-emerald-400">Job Invoices, Receipts & Card Charges (${receipts.length})</h2>
              <span class="text-xs font-mono font-bold text-emerald-300">Job Spend Total: $${totalReceiptSpend.toFixed(2)}</span>
            </div>
            <div class="space-y-2">
              ${receipts.map(r => {
                const amt = r.amount !== null && r.amount !== undefined && r.amount !== '' ? Number(r.amount) : Number(r.ocr_amount || 0);
                const jInfo = resolveRecordJobInfo(r);
                const ccObj = (state.costCodes || []).find(c => String(c.id) === String(r.cost_code_id));
                const ccLabel = (ccObj ? ccObj.name : '') || r.cost_code || r.costCode || r.assigned_cost_code || 'Unassigned';
                const vendorLabel = r.ocr_vendor || r.vendor || r.merchant || r.ocr_merchant || 'Vendor Receipt / Invoice';
                const card4 = r.ocr_last_four || r.last_four || r.card_last4 || '----';
                const dateLabel = r.ocr_post_date || r.post_date || r.ocr_date || '';
                const jobObj = (state.jobs || []).find(j => (j.name || '').toLowerCase() === (jInfo.jobName || '').toLowerCase());
                const pmTag = jobObj && jobObj.pm_name ? ` • PM: ${jobObj.pm_name}` : '';
                return `
                  <div class="p-3 rounded-xl bg-slate-900 border border-slate-700 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div>
                      <div class="font-bold text-white">${vendorLabel} — <span class="text-emerald-400 font-mono">$${(isNaN(amt) ? 0 : amt).toFixed(2)}</span></div>
                      <div class="text-[11px] text-slate-400">
                        Job: <span class="text-indigo-300 font-semibold">${jInfo.jobName || '--'}</span> •
                        Cost Code: <span class="text-amber-300 font-mono">${ccLabel}</span> •
                        Card •••• ${card4} • ${dateLabel}${pmTag}
                      </div>
                    </div>
                    ${r.receipt_image ? `<button onclick="viewReceiptModal('${r.id}')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/40 font-bold text-xs">View Receipt / Invoice</button>` : `<span class="text-[11px] text-amber-400">No Photo Attached</span>`}
                  </div>
                `;
              }).join('') || `<p class="text-xs text-slate-500 py-4">No receipts or invoices linked to the selected PM / Job filter yet.</p>`}
            </div>
          </div>
        `;
        return;
      }

      if (activePmPortalTab === 'hours') {
        body.innerHTML = `
          <div class="space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h2 class="text-xs font-bold uppercase tracking-wider text-indigo-400">Crew Hours Logged (${totalHours.toFixed(1)} hrs)</h2>
              <button onclick="openLogJobHoursModal()" class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs">+ Log Crew Hours</button>
            </div>
            <div class="space-y-2">
              ${hoursList.map(t => `
                <div class="p-3 rounded-xl bg-slate-900 border border-slate-700 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div>
                    <div class="font-bold text-white">${t.employee_name} — <span class="text-indigo-400 font-mono">${Number(t.hours).toFixed(2)} hrs</span></div>
                    <div class="text-[11px] text-slate-400">
                      Job: <span class="text-emerald-300 font-semibold">${t.job_name}</span> •
                      Cost Code: <span class="font-mono text-amber-300">${t.cost_code || 'General'}</span> •
                      Date: ${t.work_date || ''} ${t.notes ? `• "${t.notes}"` : ''}
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <button onclick="toggleApproveTimeEntry('${t.id}')" class="px-2.5 py-1 rounded-lg font-bold text-[11px] ${t.approved_by_pm ? 'bg-emerald-600/30 text-emerald-200 border border-emerald-500/40' : 'bg-slate-800 text-slate-300 border border-slate-700'}">
                      ${t.approved_by_pm ? '✓ PM Approved' : 'Approve'}
                    </button>
                    <button onclick="deleteTimeEntry('${t.id}')" class="px-2 py-1 rounded-lg bg-red-950/60 text-red-300 font-bold text-[11px]">✕</button>
                  </div>
                </div>
              `).join('') || `<p class="text-xs text-slate-500 py-4">No hours logged for this project filter yet. Click "+ Log Crew Hours" to record job hours.</p>`}
            </div>
          </div>
        `;
        return;
      }

      if (activePmPortalTab === 'payroll') {
        const byEmp = {};
        hoursList.forEach(t => {
          const key = t.employee_name || 'Crew';
          if (!byEmp[key]) byEmp[key] = { hours: 0, cost: 0, approvedHours: 0 };
          const h = Number(t.hours) || 0;
          const r = Number(t.hourly_rate) || 0;
          byEmp[key].hours += h;
          byEmp[key].cost += h * r;
          if (t.approved_by_pm) byEmp[key].approvedHours += h;
        });

        const rows = Object.entries(byEmp);
        body.innerHTML = `
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <h2 class="text-xs font-bold uppercase tracking-wider text-amber-400">Project Payroll & Labor Cost Breakdown</h2>
              <span class="text-xs font-mono font-bold text-amber-300">Total Labor: $${totalPayroll.toFixed(2)}</span>
            </div>
            <div class="space-y-2">
              ${rows.map(([empName, stats]) => `
                <div class="p-3 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-between text-xs">
                  <div>
                    <div class="font-bold text-white">${empName}</div>
                    <div class="text-[11px] text-slate-400">
                      Total: <span class="text-white font-mono">${stats.hours.toFixed(2)} hrs</span> •
                      PM Approved: <span class="text-emerald-400 font-mono">${stats.approvedHours.toFixed(2)} hrs</span>
                    </div>
                  </div>
                  <div class="text-right font-mono font-bold text-amber-400 text-sm">
                    $${stats.cost.toFixed(2)}
                  </div>
                </div>
              `).join('') || `<p class="text-xs text-slate-500 py-4">No payroll entries recorded for the selected project filter yet.</p>`}
            </div>
          </div>
        `;
      }
    }

    function openLogJobHoursModal() {
      const selectedJob = document.getElementById('pmPortalSelectedJob')?.value;
      const jobOpts = (state.jobs || []).map(j => `<option value="${j.name.replace(/"/g, '&quot;')}" ${j.name === selectedJob ? 'selected' : ''}>${j.name}</option>`).join('');
      const empOpts = (state.employees || []).map(e => `<option value="${e.full_name.replace(/"/g, '&quot;')}">${e.full_name}</option>`).join('');
      const ccOpts = `<option value="">-- Cost Code --</option>` + (state.costCodes || []).map(c => `<option value="${c.name.replace(/"/g, '&quot;')}">${c.name}</option>`).join('');
      const today = new Date().toISOString().slice(0, 10);

      document.getElementById('modalTitle').textContent = 'Log Project Hours';
      document.getElementById('modalBody').innerHTML = `
        <div class="space-y-3 text-xs">
          <div>
            <label class="block font-bold text-slate-300 mb-1">Job Name</label>
            <select id="logHrJob" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white">${jobOpts}</select>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block font-bold text-slate-300 mb-1">Employee</label>
              <select id="logHrEmp" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white">${empOpts}</select>
            </div>
            <div>
              <label class="block font-bold text-slate-300 mb-1">Work Date</label>
              <input type="date" id="logHrDate" value="${today}" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white" />
            </div>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <div>
              <label class="block font-bold text-slate-300 mb-1">Hours</label>
              <input type="number" step="0.25" id="logHrHours" placeholder="8.0" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono" />
            </div>
            <div>
              <label class="block font-bold text-slate-300 mb-1">Hourly Rate ($)</label>
              <input type="number" step="0.50" id="logHrRate" value="35.00" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono" />
            </div>
            <div>
              <label class="block font-bold text-slate-300 mb-1">Cost Code</label>
              <select id="logHrCc" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-2 py-2 text-white">${ccOpts}</select>
            </div>
          </div>
          <div>
            <label class="block font-bold text-slate-300 mb-1">Work Notes (Optional)</label>
            <input type="text" id="logHrNotes" placeholder="e.g. Footing pour & finish" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white" />
          </div>
          <div class="flex gap-2 pt-2">
            <button onclick="saveLoggedJobHours()" class="flex-1 py-2.5 rounded-xl bg-emerald-600 text-white font-bold">Save Hours</button>
            <button onclick="closeModal()" class="px-4 py-2.5 rounded-xl bg-slate-800 text-slate-300 font-bold">Cancel</button>
          </div>
        </div>
      `;
      document.getElementById('appModal').classList.remove('hidden');
    }

    async function saveLoggedJobHours() {
      const job_name = document.getElementById('logHrJob')?.value || '';
      const employee_name = document.getElementById('logHrEmp')?.value || '';
      const work_date = document.getElementById('logHrDate')?.value || new Date().toISOString().slice(0, 10);
      const hours = Number(document.getElementById('logHrHours')?.value || 0);
      const hourly_rate = Number(document.getElementById('logHrRate')?.value || 0);
      const cost_code = document.getElementById('logHrCc')?.value || '';
      const notes = document.getElementById('logHrNotes')?.value.trim() || '';

      if (!job_name || hours <= 0) return showSimpleToast('Select a Job and enter valid Hours', true);

      const entry = {
        id: 'hr_' + Date.now(),
        job_name,
        employee_name,
        cost_code,
        work_date,
        hours,
        hourly_rate,
        notes,
        approved_by_pm: true,
        created_at: new Date().toISOString()
      };

      jobTimeEntries.unshift(entry);
      try { localStorage.setItem('fieldops_job_time_entries', JSON.stringify(jobTimeEntries)); } catch (e) {}
      if (supabaseClient && isOnline) {
        try { await supabaseClient.from('job_time_entries').insert(entry); } catch (e) {}
      }
      closeModal();
      renderPmPortalContent();
      showSimpleToast('Hours Logged to Project!', false);
    }

    async function toggleApproveTimeEntry(id) {
      const item = jobTimeEntries.find(t => t.id === id);
      if (!item) return;
      item.approved_by_pm = !item.approved_by_pm;
      try { localStorage.setItem('fieldops_job_time_entries', JSON.stringify(jobTimeEntries)); } catch (e) {}
      if (supabaseClient && isOnline) {
        try { await supabaseClient.from('job_time_entries').update({ approved_by_pm: item.approved_by_pm }).eq('id', id); } catch (e) {}
      }
      renderPmPortalContent();
    }

    async function deleteTimeEntry(id) {
      jobTimeEntries = jobTimeEntries.filter(t => t.id !== id);
      try { localStorage.setItem('fieldops_job_time_entries', JSON.stringify(jobTimeEntries)); } catch (e) {}
      if (supabaseClient && isOnline) {
        try { await supabaseClient.from('job_time_entries').delete().eq('id', id); } catch (e) {}
      }
      renderPmPortalContent();
      showSimpleToast('Time Entry Removed', true);
    }
