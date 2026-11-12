(function applyActBranding() {
      const LOGO_SRC = 'ACT%20Master%20App%20Icon.png';

      // Strip card numbers, roles, and suffixes from the Login dropdown & user list anywhere on the page
      function cleanLoginUsernames() {
        const emps = (typeof state !== 'undefined' && Array.isArray(state.employees)) ? state.employees : [];

        document.querySelectorAll('select').forEach(sel => {
          // Skip dropdowns inside the PM Hub or Modals that aren't the login user selector
          if (sel.id === 'pmPortalSelectedJob' || sel.id.startsWith('roleSelect_') || sel.id.startsWith('fill_')) return;

          sel.querySelectorAll('option').forEach(opt => {
            const val = (opt.value || '').trim();
            const rawText = (opt.textContent || '').trim();
            if (!val || rawText.startsWith('--')) return;

            // 1. Match by employee ID or exact name
            const matchedById = emps.find(e => String(e.id) === val || (e.full_name && e.full_name.trim() === val));
            if (matchedById && matchedById.full_name) {
              const clean = matchedById.full_name.trim();
              if (opt.textContent !== clean) opt.textContent = clean;
              return;
            }

            // 2. Match if the option text starts with a known employee's full name
            const matchedByPrefix = emps.find(
              e => e.full_name && rawText.toLowerCase().startsWith(e.full_name.trim().toLowerCase())
            );
            if (matchedByPrefix && matchedByPrefix.full_name) {
              const clean = matchedByPrefix.full_name.trim();
              if (opt.textContent !== clean) opt.textContent = clean;
              return;
            }

            // 3. Clean Administrator option if it has extra text
            if (val.toLowerCase() === 'admin' || /^administrator\b/i.test(rawText)) {
              if (opt.textContent !== 'Administrator') opt.textContent = 'Administrator';
              return;
            }

            // 4. Fallback regex: strip anything starting with (, [, •, *, —, –, or " - "
            const stripped = rawText
              .replace(/\s*(\(|\[|•|\*|—|–|-\s).*$/, '')
              .trim();
            if (stripped && opt.textContent !== stripped) {
              opt.textContent = stripped;
            }
          });
        });
      }

      function updateDomBranding() {
        document.title = 'ACT';

        // 1. Replace every "FO" badge with your transparent ACT Master App Icon PNG
        document.querySelectorAll('div, span').forEach(el => {
          if (el.children.length === 0 && (el.textContent || '').trim() === 'FO') {
            const isSideMenuLogo = Boolean(el.closest('#sideMenuDrawer'));

            el.innerHTML = `<img src="${LOGO_SRC}" alt="ACT" class="w-full h-full object-contain drop-shadow-lg" />`;
            el.classList.remove(
              'w-8', 'h-8', 'w-9', 'h-9', 'w-10', 'h-10', 'w-11', 'h-11',
              'w-12', 'h-12', 'w-14', 'h-14', 'w-16', 'h-16',
              'bg-emerald-500', 'bg-emerald-600', 'bg-slate-900',
              'border', 'border-slate-700', 'p-2'
            );
            el.classList.add('overflow-hidden', 'p-0', 'bg-transparent', 'border-0');

            if (!isSideMenuLogo) {
              // Larger logo on the Login Screen / Main Card
              el.classList.add('w-28', 'h-28', 'mx-auto', 'mb-2');
            } else {
              // Compact icon in the top-left Side Menu header
              el.classList.add('w-10', 'h-10', 'shrink-0');
            }
          }
        });

        // 2. Replace visible "FieldOps" headings and text with "ACT"
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          const parentTag = node.parentNode && node.parentNode.tagName;
          if (parentTag !== 'SCRIPT' && parentTag !== 'STYLE' && /FieldOps/i.test(node.nodeValue)) {
            node.nodeValue = node.nodeValue
              .replace(/FieldOps\s+Pro/gi, 'ACT')
              .replace(/FieldOps/gi, 'ACT');
          }
        }

        // 3. Clean login usernames
        cleanLoginUsernames();
      }

      function watchLoginDropdown() {
        if (typeof window.populateLoginUserDropdown === 'function') {
          const _origPopulate = window.populateLoginUserDropdown;
          window.populateLoginUserDropdown = function() {
            const res = _origPopulate.apply(this, arguments);
            cleanLoginUsernames();
            return res;
          };
        }

        if (window.MutationObserver) {
          const obs = new MutationObserver(() => cleanLoginUsernames());
          obs.observe(document.body, { childList: true, subtree: true });
        }
      }

      function injectActManifest() {
        if (document.getElementById('actPwaManifest')) return;
        const iconAbsUrl = new URL(LOGO_SRC, window.location.href).href;
        const manifest = {
          name: 'ACT',
          short_name: 'ACT',
          start_url: window.location.pathname || './',
          display: 'standalone',
          background_color: '#0f172a',
          theme_color: '#0f172a',
          icons: [
            { src: iconAbsUrl, sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: iconAbsUrl, sizes: '512x512', type: 'image/png', purpose: 'any' }
          ]
        };
        const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
        const link = document.createElement('link');
        link.id = 'actPwaManifest';
        link.rel = 'manifest';
        link.href = URL.createObjectURL(blob);
        document.head.appendChild(link);
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          updateDomBranding();
          watchLoginDropdown();
          injectActManifest();
        });
      } else {
        updateDomBranding();
        watchLoginDropdown();
        injectActManifest();
      }
    })();
