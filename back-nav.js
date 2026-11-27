// =========================================================================
// ACT MASTER - NATIVE BACK BUTTON & HISTORY CONTROLLER (back-nav.js)
// Zero-conflict drop-in History API manager for Android, iOS & Desktop PWAs
// - Pushes real user-gesture history entries (beats Chrome's history intervention)
// - Steps back cleanly through: Modals -> Side Menu -> Blueprint Fullscreen ->
//   Measure Mode -> Calendar Day View -> Previous View -> Role Home / Native Exit
// - Role-safe Home restore: Admins always return to openAdminPage(), never raw #viewCrew
// - Clears cached navigation snapshots immediately on Switch User / Logout
// =========================================================================
(function initACTBackNav() {
  'use strict';

  const KNOWN_MODALS = [
    'bpCalLengthModal',
    'bpScaleModal',
    'actDocsUploadModal',
    'actDocsViewerModal',
    'actCalManageModal',
    'actCalEventModal'
  ];

  const PRIMARY_VIEW_IDS = [
    'viewBlueprints',
    'viewCompanyCalendar',
    'viewCompanyDocuments',
    'viewAdmin',
    'viewOtherModule',
    'viewPmPortal',
    'viewCrew'
  ];

  const nav = {
    depth: 0,
    isHandlingPop: false,
    suppressNextPop: false,
    lastUserGestureAt: 0,
    activeUserKey: '',
    viewStack: [],       // e.g. [{ kind: 'feature', key: 'blueprints' }]
    homeSnapshot: null,  // Safe base snapshot (never stores #viewCrew for Admins)
    lastSignature: '',
    observerTimer: null
  };

  // =========================================================================
  // 1. ROLE, USER IDENTITY & VISIBILITY INSPECTORS
  // =========================================================================
  function getEffectiveRole() {
    if (typeof getActiveUserEffectiveRole === 'function') {
      return String(getActiveUserEffectiveRole() || 'crew').toLowerCase();
    }
    return typeof currentRole !== 'undefined' ? String(currentRole || 'crew').toLowerCase() : 'crew';
  }

  function getActiveUserKey() {
    const role = getEffectiveRole();
    const empId =
      typeof activeCrewEmployeeId !== 'undefined' && activeCrewEmployeeId
        ? String(activeCrewEmployeeId)
        : '';
    return `${role}::${empId}`;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.classList.contains('hidden')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findSideMenuElement() {
    const anchor =
      document.getElementById('menuFeatBlueprints') ||
      document.getElementById('menuFeatCalendar') ||
      document.getElementById('menuFeatDocuments');
    if (!anchor) return null;
    return anchor.closest('aside, [id*="Menu"], [id*="Drawer"], [id*="Sidebar"], .fixed') || anchor.parentElement;
  }

  function isSideMenuOpen() {
    const el = findSideMenuElement();
    if (!el || el.classList.contains('hidden')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 40 && rect.right > 20 && rect.left < window.innerWidth - 20;
  }

  function findTopOpenModal() {
    for (const id of KNOWN_MODALS) {
      const el = document.getElementById(id);
      if (isVisible(el)) return el;
    }

    const sideMenuEl = findSideMenuElement();
    const candidates = Array.from(document.querySelectorAll('body > div, body > section')).filter((el) => {
      if (PRIMARY_VIEW_IDS.includes(el.id)) return false;
      if (el === sideMenuEl || (sideMenuEl && el.contains(sideMenuEl))) return false;
      if (/toast|snackbar|backdrop|overlay/i.test(el.id) && !/modal/i.test(el.id)) return false;
      if (!isVisible(el)) return false;

      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed') return false;
      const z = parseInt(style.zIndex, 10) || 0;
      const rect = el.getBoundingClientRect();
      const coversViewport = rect.width >= window.innerWidth * 0.85 && rect.height >= window.innerHeight * 0.7;
      return coversViewport && z >= 40;
    });

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (parseInt(getComputedStyle(b).zIndex, 10) || 0) - (parseInt(getComputedStyle(a).zIndex, 10) || 0));
    return candidates[0];
  }

  function closeModalElement(modalEl) {
    if (!modalEl) return false;
    if (modalEl.id === 'actDocsViewerModal') {
      document.getElementById('actDocsViewerCloseBtn')?.click();
      return true;
    }
    const closeBtn = modalEl.querySelector(
      'button[id*="Close"], button[id*="Cancel"], button[aria-label*="Close"], button[title*="Close"]'
    );
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
    modalEl.classList.add('hidden');
    return true;
  }

  function isBlueprintFullscreen() {
    return document.body.classList.contains('bp-focus-fullscreen');
  }

  function isBlueprintMeasureOpen() {
    const view = document.getElementById('viewBlueprints');
    return Boolean(view && isVisible(view) && view.classList.contains('bp-measure-active'));
  }

  function isMeasureTotalsDropdownOpen() {
    return Boolean(document.querySelector('#bpMeasureTotalsWrap .bp-totals-scroll'));
  }

  function isCalendarDayViewOpen() {
    const view = document.getElementById('viewCompanyCalendar');
    if (!view || !isVisible(view)) return false;
    const dayBtn = document.getElementById('actCalModeDayBtn');
    return Boolean(dayBtn && dayBtn.classList.contains('bg-sky-500'));
  }

  function getActiveTopModule() {
    if (isVisible(document.getElementById('viewBlueprints'))) return 'blueprints';
    if (isVisible(document.getElementById('viewCompanyCalendar'))) return 'calendar';
    if (isVisible(document.getElementById('viewCompanyDocuments'))) return 'documents';
    if (isVisible(document.getElementById('viewOtherModule'))) return 'other';

    const role = getEffectiveRole();
    if (isVisible(document.getElementById('viewAdmin'))) {
      return role === 'admin' ? 'home' : 'admin';
    }
    if (isVisible(document.getElementById('viewPmPortal'))) {
      return role === 'pm' ? 'home' : 'pm_portal';
    }
    return 'home';
  }

  // =========================================================================
  // 2. ROLE-SAFE HOME SNAPSHOT & RESTORE (NEVER EXPOSES STALE #viewCrew)
  // =========================================================================
  function captureHomeSnapshotIfAtBase() {
    const activeMod = getActiveTopModule();
    if (activeMod === 'blueprints' || activeMod === 'calendar' || activeMod === 'documents') return;

    const role = getEffectiveRole();
    const baseIds = ['viewAdmin', 'viewPmPortal', 'viewOtherModule', 'roleWorkspaceQuickBar'];
    // Never snapshot raw #viewCrew for Admins (prevents ever unhiding a default/wrong employee card)
    if (role !== 'admin') {
      baseIds.push('viewCrew');
    }

    const visibleIds = baseIds.filter((id) => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    });

    if (visibleIds.length > 0) {
      nav.homeSnapshot = {
        userKey: getActiveUserKey(),
        visibleIds,
        title: document.getElementById('topBarPageTitle')?.textContent || ''
      };
    }
  }

  function restoreHomeView() {
    window.ACTBlueprints?.close?.();
    window.ACTCalendar?.close?.();
    window.ACTDocuments?.close?.();

    const baseIds = ['viewCrew', 'viewAdmin', 'viewOtherModule', 'viewPmPortal', 'roleWorkspaceQuickBar'];
    baseIds.forEach((id) => document.getElementById(id)?.classList.add('hidden'));

    const role = getEffectiveRole();
    const curUserKey = getActiveUserKey();
    const validSnapshot =
      nav.homeSnapshot &&
      nav.homeSnapshot.userKey === curUserKey &&
      nav.homeSnapshot.visibleIds.length > 0
        ? nav.homeSnapshot
        : null;

    nav.isHandlingPop = true;
    try {
      if (role === 'admin') {
        // Admins always return via openAdminPage() so their proper workspace renders
        if (typeof window.openAdminPage === 'function') {
          window.openAdminPage();
        } else {
          document.getElementById('viewAdmin')?.classList.remove('hidden');
          document.getElementById('roleWorkspaceQuickBar')?.classList.remove('hidden');
        }
      } else if (validSnapshot && validSnapshot.visibleIds.includes('viewPmPortal')) {
        validSnapshot.visibleIds.forEach((id) => document.getElementById(id)?.classList.remove('hidden'));
        const titleEl = document.getElementById('topBarPageTitle');
        if (titleEl && validSnapshot.title) titleEl.textContent = validSnapshot.title;
      } else if (typeof window.openMyPersonalCardView === 'function') {
        // Non-admins re-render through openMyPersonalCardView() so the active employee's card is bound
        window.openMyPersonalCardView();
      } else if (validSnapshot) {
        validSnapshot.visibleIds.forEach((id) => document.getElementById(id)?.classList.remove('hidden'));
        const titleEl = document.getElementById('topBarPageTitle');
        if (titleEl && validSnapshot.title) titleEl.textContent = validSnapshot.title;
      } else {
        document.getElementById('viewCrew')?.classList.remove('hidden');
        document.getElementById('roleWorkspaceQuickBar')?.classList.remove('hidden');
      }
    } finally {
      nav.isHandlingPop = false;
    }

    if (typeof window.refreshRoleUiVisibility === 'function') {
      try { window.refreshRoleUiVisibility(); } catch {}
    }
  }

  // =========================================================================
  // 3. HISTORY STACK MANAGEMENT (USER-GESTURE SAFE)
  // =========================================================================
  function initRootHistoryState() {
    try {
      const existing = window.history.state;
      if (!existing || !existing.actBackNav) {
        window.history.replaceState({ actBackNav: true, actDepth: 0, actLayer: 'root' }, '');
        nav.depth = 0;
      } else {
        nav.depth = Number(existing.actDepth) || 0;
      }
    } catch {}
  }

  function pushLayer(layerName, replaceIfMenu = false) {
    if (nav.isHandlingPop) return;
    try {
      const curState = window.history.state;
      if (replaceIfMenu && curState?.actBackNav && curState.actLayer === 'menu' && curState.actDepth > 0) {
        window.history.replaceState({ actBackNav: true, actDepth: curState.actDepth, actLayer: layerName }, '');
        nav.depth = curState.actDepth;
        return;
      }
      const nextDepth = (Number(curState?.actDepth) || nav.depth || 0) + 1;
      window.history.pushState({ actBackNav: true, actDepth: nextDepth, actLayer: layerName }, '');
      nav.depth = nextDepth;
    } catch {}
  }

  function isCompletelyAtHome() {
    if (findTopOpenModal()) return false;
    if (isSideMenuOpen()) return false;
    if (isBlueprintFullscreen()) return false;
    if (isBlueprintMeasureOpen()) return false;
    if (nav.viewStack.length > 0) return false;
    return getActiveTopModule() === 'home';
  }

  function rewindStaleHistoryIfAtHome() {
    const curDepth = Number(window.history.state?.actDepth) || 0;
    if (curDepth > 0 && isCompletelyAtHome()) {
      nav.suppressNextPop = true;
      nav.depth = 0;
      try {
        window.history.go(-curDepth);
      } catch {
        nav.suppressNextPop = false;
      }
    }
  }

  // =========================================================================
  // 4. POPSTATE HANDLER (THE ACTUAL BACK BUTTON STEP-BACK)
  // =========================================================================
  function handleNativeBack(event) {
    if (nav.suppressNextPop) {
      nav.suppressNextPop = false;
      nav.depth = Number(event.state?.actDepth) || 0;
      return;
    }

    nav.depth = Number(event.state?.actDepth) || 0;
    nav.isHandlingPop = true;

    try {
      // 1. Close topmost open modal
      const openModal = findTopOpenModal();
      if (openModal) {
        closeModalElement(openModal);
        return;
      }

      // 2. Close Side Menu drawer
      if (isSideMenuOpen()) {
        if (typeof window.closeSideMenu === 'function') {
          window.closeSideMenu();
        } else {
          findSideMenuElement()?.classList.add('hidden');
        }
        return;
      }

      // 3. Exit Blueprint Fullscreen mode
      if (isBlueprintFullscreen()) {
        window.ACTBlueprintMeasure?.setFullscreen?.(false);
        return;
      }

      // 4. Close Measured Totals dropdown, or exit Blueprint Measure mode
      if (isBlueprintMeasureOpen()) {
        if (isMeasureTotalsDropdownOpen()) {
          document.getElementById('bpTotalsToggleBtn')?.click();
          return;
        }
        window.ACTBlueprintMeasure?.setActive?.(false);
        return;
      }

      // 5. Step from Calendar Day view back to Calendar Month view
      if (isCalendarDayViewOpen()) {
        document.getElementById('actCalModeMonthBtn')?.click();
        return;
      }

      // 6. Step back through view stack (or exit current secondary module back to Home)
      if (nav.viewStack.length > 0) {
        nav.viewStack.pop();
        const prev = nav.viewStack[nav.viewStack.length - 1];
        if (!prev) {
          restoreHomeView();
        } else if (prev.kind === 'feature' && typeof window.selectMenuFeature === 'function') {
          window.selectMenuFeature(prev.key);
        } else if (prev.kind === 'admin' && typeof window.openAdminPage === 'function') {
          window.openAdminPage();
        } else {
          restoreHomeView();
        }
        return;
      }

      const activeMod = getActiveTopModule();
      if (activeMod !== 'home') {
        restoreHomeView();
        return;
      }
    } finally {
      nav.isHandlingPop = false;
      nav.lastSignature = computeLayerSignature();
      setTimeout(rewindStaleHistoryIfAtHome, 0);
    }
  }

  // =========================================================================
  // 5. HOOK ACT NAVIGATION & OBSERVE MODALS / MENU / FULLSCREEN / DAY VIEW
  // =========================================================================
  function computeLayerSignature() {
    const modal = findTopOpenModal();
    return [
      modal ? `M:${modal.id || modal.className.slice(0, 24)}` : '',
      isSideMenuOpen() ? 'MENU' : '',
      isBlueprintFullscreen() ? 'BPFS' : '',
      isBlueprintMeasureOpen() ? 'BPMEAS' : '',
      isCalendarDayViewOpen() ? 'CALDAY' : ''
    ].join('|');
  }

  function onDomLayerMutation() {
    if (nav.isHandlingPop) return;
    const nextSig = computeLayerSignature();
    if (nextSig === nav.lastSignature) return;

    const prevParts = new Set(nav.lastSignature.split('|').filter(Boolean));
    const nextParts = nextSig.split('|').filter(Boolean);
    const added = nextParts.filter((p) => !prevParts.has(p));
    nav.lastSignature = nextSig;

    const recentGesture = Date.now() - nav.lastUserGestureAt < 2000;
    if (added.length > 0 && recentGesture) {
      const topAdded = added[added.length - 1];
      const layerTag = topAdded === 'MENU' ? 'menu' : topAdded.toLowerCase();
      pushLayer(layerTag, false);
    }
  }

  function syncUserChange() {
    const nextKey = getActiveUserKey();
    if (nextKey !== nav.activeUserKey) {
      nav.activeUserKey = nextKey;
      nav.viewStack = [];
      nav.homeSnapshot = null;
    }
  }

  function installObservers() {
    const markGesture = () => {
      nav.lastUserGestureAt = Date.now();
    };
    window.addEventListener('pointerdown', markGesture, { capture: true, passive: true });
    window.addEventListener('keydown', markGesture, { capture: true, passive: true });

    const observer = new MutationObserver(() => {
      if (nav.observerTimer) return;
      nav.observerTimer = requestAnimationFrame(() => {
        nav.observerTimer = null;
        onDomLayerMutation();
      });
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style'],
      childList: true,
      subtree: true
    });
  }

  function installNavigationWrappers() {
    const prevSelectMenu = window.selectMenuFeature;
    if (typeof prevSelectMenu === 'function') {
      window.selectMenuFeature = function (featureKey) {
        if (!nav.isHandlingPop) {
          syncUserChange();
          if (nav.viewStack.length === 0) captureHomeSnapshotIfAtBase();

          const isSubModule =
            featureKey === 'blueprints' ||
            featureKey === 'calendar' ||
            featureKey === 'documents';

          if (isSubModule) {
            const top = nav.viewStack[nav.viewStack.length - 1];
            if (!top || top.kind !== 'feature' || top.key !== featureKey) {
              nav.viewStack.push({ kind: 'feature', key: featureKey });
              pushLayer(`view:${featureKey}`, true);
            }
          } else {
            nav.viewStack = [];
          }
        }
        return prevSelectMenu.apply(this, arguments);
      };
    }

    const prevOpenAdmin = window.openAdminPage;
    if (typeof prevOpenAdmin === 'function') {
      window.openAdminPage = function () {
        if (!nav.isHandlingPop) {
          syncUserChange();
          if (getEffectiveRole() === 'admin') {
            nav.viewStack = [];
            nav.homeSnapshot = null;
          } else {
            if (nav.viewStack.length === 0) captureHomeSnapshotIfAtBase();
            const top = nav.viewStack[nav.viewStack.length - 1];
            if (!top || top.kind !== 'admin') {
              nav.viewStack.push({ kind: 'admin' });
              pushLayer('view:admin', true);
            }
          }
        }
        return prevOpenAdmin.apply(this, arguments);
      };
    }

    const prevPersonalCard = window.openMyPersonalCardView;
    if (typeof prevPersonalCard === 'function') {
      window.openMyPersonalCardView = function () {
        if (!nav.isHandlingPop) {
          syncUserChange();
          nav.viewStack = [];
        }
        return prevPersonalCard.apply(this, arguments);
      };
    }

    const prevLogout = window.logoutUser;
    if (typeof prevLogout === 'function') {
      window.logoutUser = function () {
        nav.activeUserKey = '';
        nav.viewStack = [];
        nav.homeSnapshot = null;
        return prevLogout.apply(this, arguments);
      };
    }

    const prevRefreshRole = window.refreshRoleUiVisibility;
    if (typeof prevRefreshRole === 'function') {
      window.refreshRoleUiVisibility = function () {
        const res = prevRefreshRole.apply(this, arguments);
        syncUserChange();
        return res;
      };
    }

    const prevUpdateTopBar = window.updateTopBarIndicators;
    if (typeof prevUpdateTopBar === 'function') {
      window.updateTopBarIndicators = function () {
        const res = prevUpdateTopBar.apply(this, arguments);
        syncUserChange();
        return res;
      };
    }
  }

  function boot() {
    initRootHistoryState();
    nav.activeUserKey = getActiveUserKey();
    installNavigationWrappers();
    installObservers();
    nav.lastSignature = computeLayerSignature();
    window.addEventListener('popstate', handleNativeBack);
  }

  window.ACTBackNav = {
    getStack: () => [...nav.viewStack],
    resetToHome: () => {
      nav.viewStack = [];
      restoreHomeView();
      rewindStaleHistoryIfAtHome();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
