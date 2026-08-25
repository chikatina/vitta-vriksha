/* Interactive Driver.js-Style Onboarding Walkthrough Tour with live auto-navigation and glowing spotlights. */

import { icon, h } from '../ui.js';

export const TOUR_STEPS = [
  // ── 1. HOME: CASHFLOW & DASHBOARD ──
  {
    tab: 'home',
    title: 'Live Cashflow & Net Kept',
    subtitle: 'Step 1 of 8 • Home Dashboard',
    glyph: 'dashboard',
    badge: 'Home Tab',
    targetSelectors: ['[data-widget="month_summary"]', '[data-widget="income_expense"]', '[data-panel]', '.card', '.home-top-bar'],
    description: 'Your financial heartbeat. Tracks this month\'s Income vs Expenses, live runway, and Net Kept savings rate. Tap "Customise" to reorder cards or add category spotlights.',
    highlights: [
      { icon: 'show_chart', text: 'Real-time Net Kept savings rate' },
      { icon: 'tune', text: 'Reorder cards & customize layout' },
    ],
  },

  // ── 2. HOME: BANK SMS SCANNING & ALERTS ──
  {
    tab: 'home',
    title: 'Bank SMS Auto-Scanning',
    subtitle: 'Step 2 of 8 • SMS Tracking',
    glyph: 'sms',
    badge: 'SMS Scanner',
    targetSelectors: ['[data-interactive-alert]', '[data-alert-tooltip]', '[data-onboarding-sms]', '[data-action-sms]'],
    description: 'Scans incoming debit and credit alerts directly from your SMS inbox on-device. Automatically detects UPI, card, ATM, and salary transactions with 100% offline privacy.',
    highlights: [
      { icon: 'sms', text: 'Auto-detect debits, credits & UPI' },
      { icon: 'lock', text: '100% on-device private parsing' },
    ],
  },

  // ── 3. LEDGER: LIVE FILTER STREAMS & BATCH ACTIONS ──
  {
    tab: 'ledger',
    title: 'Live Ledger & Filter Streams',
    subtitle: 'Step 3 of 8 • Ledger Tab',
    glyph: 'receipt_long',
    badge: 'Ledger Tab',
    targetSelectors: ['[data-filters]', '[data-scope-bar]', '.ledger-search-box', '[data-results]'],
    description: 'Your complete financial ledger. Instantly isolate transactions by Spent, Received (Income), Invested, UPI payments, or high-value spends, and multi-select to bulk edit or split single charges.',
    highlights: [
      { icon: 'south_west', text: 'Income vs Spends vs Investments' },
      { icon: 'check_circle', text: 'Batch actions & transaction splits' },
    ],
  },

  // ── 4. BUDGETS: CEILING & SAFE RUN-RATE ──
  {
    tab: 'budgets',
    title: 'Monthly Budget & Safe Run-Rate',
    subtitle: 'Step 4 of 8 • Budgets Tab',
    glyph: 'donut_small',
    badge: 'Budgets Tab',
    targetSelectors: ['.card:first-child', '[data-set-budget]', '[data-donut]'],
    description: 'Set your overall monthly spending ceiling. The engine dynamically computes your daily Safe-to-Spend pacing allowance (₹X/day) and tracks category caps with visual meters.',
    highlights: [
      { icon: 'shield', text: 'Daily Safe-to-Spend pacing allowance' },
      { icon: 'schedule', text: 'Category spending caps & salary trends' },
    ],
  },

  // ── 5. WEALTH: NET WORTH MILESTONES & ASSET ALLOCATION ──
  {
    tab: 'wealth',
    title: 'Wealth & Net Worth Milestones',
    subtitle: 'Step 5 of 8 • Wealth Tab',
    glyph: 'savings',
    badge: 'Wealth Tab',
    targetSelectors: ['.card:first-child', '.milestone-track', '[data-page="investments"]', '[data-page="goals"]', '[data-page="fire"]'],
    description: 'Track net worth across mutual funds, demat equities, NPS, SGBs and FDs. Watch your progression across financial milestones from ₹1 Lakh to ₹10 Crore.',
    highlights: [
      { icon: 'savings', text: 'Total assets, liabilities & net worth' },
      { icon: 'trending_up', text: 'Progression to financial milestones' },
    ],
  },

  // ── 6. WEALTH: CAS UPLOAD & PORTFOLIO IMPORTS ──
  {
    tab: 'wealth',
    title: 'CAS Statements & Tradebook Imports',
    subtitle: 'Step 6 of 8 • Portfolio Imports',
    glyph: 'upload_file',
    badge: 'CAS & Tradebooks',
    targetSelectors: ['[data-page="cas"]', '[data-page="investments"]', '[data-nav="cas"]', '.list'],
    description: 'Import CAMS/CDSL Consolidated Account Statement (eCAS) PDFs and broker tradebook CSVs (Zerodha, Groww) to automatically sync mutual funds, stocks, and demat holdings in one unified view.',
    highlights: [
      { icon: 'upload_file', text: 'CAMS & KFintech eCAS PDF auto-sync' },
      { icon: 'bar_chart', text: 'Zerodha & Groww tradebook CSV import' },
    ],
  },

  // ── 7. MORE: RULES & AUTO-CATEGORIZATION ──
  {
    tab: 'more',
    title: 'Merchant Rules & Auto-Categorization',
    subtitle: 'Step 7 of 8 • Smart Rules',
    glyph: 'rule',
    badge: 'Rules Engine',
    targetSelectors: ['[data-page="rules"]', '[data-nav="rules"]', '.list'],
    description: 'Assigns categories and family members automatically using merchant matching rules (e.g. Swiggy, Uber, D-Mart) and regex patterns. You can customize or add your own rules anytime.',
    highlights: [
      { icon: 'label', text: 'Auto-categorization by merchant name' },
      { icon: 'rule', text: 'Custom regex SMS rule editor & simulator' },
    ],
  },

  // ── 8. MORE: OFFLINE VAULT & ENCRYPTED BACKUPS ──
  {
    tab: 'more',
    title: '100% Offline Vault & Encrypted Backup',
    subtitle: 'Step 8 of 8 • Security & Privacy',
    glyph: 'security',
    badge: 'More Tab',
    targetSelectors: ['.card-accent', '[data-page="backup"]', '[data-page="security"]', '[data-nav="backup"]'],
    description: 'Zero network permissions — your records never leave this device. Encrypted locally with AES-GCM and unlocked via PIN or fingerprint. Export password-encrypted backups anytime.',
    highlights: [
      { icon: 'lock', text: 'Zero-network on-device AES-GCM vault' },
      { icon: 'backup', text: 'Password-encrypted offline backups' },
    ],
  },
];

/**
 * Launches an interactive guided tour that live-navigates across tabs,
 * with Driver.js-style glowing spotlights and auto-scrolling to highlighted elements.
 */
export function openOnboardingTour(app, startStep = 0) {
  // Never allow tour to open if app is locked or on lock/setup screen
  if (!app || app.locked || (typeof document !== 'undefined' && document.querySelector('.overlay-screen'))) {
    return;
  }

  // Remove any existing tour overlay or spotlight if present
  if (typeof document !== 'undefined' && document.querySelectorAll) {
    document.querySelectorAll('.app-tour-scrim, .app-tour-container, .app-tour-spotlight').forEach((el) => el.remove());
    document.body?.classList?.remove?.('tour-active');
  }

  let currentStep = Math.max(0, Math.min(TOUR_STEPS.length - 1, startStep));
  let isMinimized = false;
  let currentTargetEl = null;

  // Create full-screen modal blocking scrim (prevents all click-through to underlying app elements)
  const scrim = typeof document !== 'undefined' && document.createElement ? document.createElement('div') : { style: {}, classList: { add: () => {}, remove: () => {} }, remove: () => {} };
  scrim.className = 'app-tour-scrim';
  if (typeof document !== 'undefined' && document.body?.appendChild) {
    document.body.appendChild(scrim);
    document.body?.classList?.add?.('tour-active');
  }

  // Create glowing spotlight overlay
  const spotlight = typeof document !== 'undefined' && document.createElement ? document.createElement('div') : { style: {}, classList: { add: () => {}, remove: () => {} }, remove: () => {} };
  spotlight.className = 'app-tour-spotlight';
  if (typeof document !== 'undefined' && document.body?.appendChild) {
    document.body.appendChild(spotlight);
  }

  // Create tour popover container
  const container = typeof document !== 'undefined' && document.createElement ? document.createElement('div') : { style: {}, classList: { add: () => {}, remove: () => {} }, remove: () => {}, querySelector: () => null, querySelectorAll: () => [] };
  container.className = 'app-tour-container';
  if (typeof document !== 'undefined' && document.body?.appendChild) {
    document.body.appendChild(container);
  }

  // Trigger smooth entrance
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 0);
  raf(() => {
    scrim.classList?.add('open');
    container.classList?.add('open');
  });

  const positionSpotlight = () => {
    // Check if app is locked, inside a subpage (e.g. Insights), or target element has vanished
    if (!currentTargetEl || !app || app.locked || app.page || app.tab !== TOUR_STEPS[currentStep]?.tab || (typeof document !== 'undefined' && document.body && !document.body.contains(currentTargetEl))) {
      if (spotlight.style) spotlight.style.opacity = '0';
      scrim.classList?.remove('has-spotlight');
      currentTargetEl?.classList?.remove('tour-highlight-target');
      return;
    }

    const rect = typeof currentTargetEl.getBoundingClientRect === 'function' ? currentTargetEl.getBoundingClientRect() : { top: 0, left: 0, width: 0, height: 0, bottom: 0 };
    if (rect.width === 0 && rect.height === 0) {
      if (spotlight.style) spotlight.style.opacity = '0';
      scrim.classList?.remove('has-spotlight');
      currentTargetEl?.classList?.remove('tour-highlight-target');
      return;
    }

    const winWidth = typeof window !== 'undefined' ? window.innerWidth : 360;
    const winHeight = typeof window !== 'undefined' ? window.innerHeight : 640;

    const padding = 6;
    const top = Math.max(2, rect.top - padding);
    const left = Math.max(4, rect.left - padding);
    const width = Math.min(winWidth - 8, rect.width + padding * 2);
    const height = rect.height + padding * 2;

    if (spotlight.style) {
      spotlight.style.top = `${top}px`;
      spotlight.style.left = `${left}px`;
      spotlight.style.width = `${width}px`;
      spotlight.style.height = `${height}px`;

      try {
        const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(currentTargetEl) : {};
        spotlight.style.borderRadius = style?.borderRadius && style?.borderRadius !== '0px' ? style.borderRadius : '12px';
      } catch {
        spotlight.style.borderRadius = '12px';
      }
      spotlight.style.opacity = '1';
      scrim.classList?.add('has-spotlight');
      currentTargetEl?.classList?.add('tour-highlight-target');
    }

    // Auto dock tour card at top if spotlight is in the lower half of screen
    const midPoint = winHeight * 0.55;
    if (rect.top > midPoint || rect.bottom > winHeight - 240) {
      container.classList?.add('dock-top');
    } else {
      container.classList?.remove('dock-top');
    }
  };

  const findTargetAndSpotlight = (step) => {
    if (currentTargetEl) {
      currentTargetEl.classList?.remove('tour-highlight-target');
    }
    currentTargetEl = null;
    if (spotlight.style) spotlight.style.opacity = '0';
    scrim.classList?.remove('has-spotlight');

    // Verify app is currently on the expected step tab and not on a subpage
    if (app && (app.locked || app.page || app.tab !== step.tab)) {
      return;
    }

    for (const selector of step.targetSelectors || []) {
      const found = typeof document !== 'undefined' && typeof document.querySelector === 'function' ? document.querySelector(selector) : null;
      if (found && (found.offsetParent !== null || found.getBoundingClientRect?.().width > 0)) {
        currentTargetEl = found;
        break;
      }
    }

    if (currentTargetEl) {
      if (typeof currentTargetEl.scrollIntoView === 'function') {
        currentTargetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      positionSpotlight();
      setTimeout(positionSpotlight, 180);
      setTimeout(positionSpotlight, 360);
    } else {
      if (spotlight.style) spotlight.style.opacity = '0';
      scrim.classList?.remove('has-spotlight');
    }
  };

  // Scroll & resize listeners to keep spotlight aligned
  const onScrollOrResize = () => positionSpotlight();
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true });
    window.addEventListener('resize', onScrollOrResize, { passive: true });
  }

  const updateNavTabHighlight = (stepTab) => {
    if (typeof document === 'undefined') return;
    document.querySelectorAll?.('#navBar [data-tab], .nav-bar [data-tab]')?.forEach?.((btn) => {
      const isTargetTab = btn.dataset.tab === stepTab;
      btn.classList.toggle('tour-tab-active', isTargetTab);
      btn.setAttribute('aria-selected', isTargetTab ? 'true' : 'false');
    });
  };

  const closeTour = (returnToHome = false) => {
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('scroll', onScrollOrResize, { capture: true });
      window.removeEventListener('resize', onScrollOrResize);
    }
    if (typeof document !== 'undefined') {
      document.body?.classList?.remove?.('tour-active');
      document.querySelectorAll?.('.tour-highlight-target')?.forEach?.((el) => el.classList.remove('tour-highlight-target'));
      document.querySelectorAll?.('.tour-tab-active')?.forEach?.((el) => el.classList.remove('tour-tab-active'));
      document.querySelectorAll?.('#navBar [data-tab], .nav-bar [data-tab]')?.forEach?.((btn) => {
        btn.setAttribute('aria-selected', btn.dataset.tab === (app?.tab || 'home') ? 'true' : 'false');
      });
    }
    scrim.classList?.remove('open');
    scrim.classList?.remove('has-spotlight');
    container.classList?.remove('open');
    if (spotlight.style) spotlight.style.opacity = '0';
    setTimeout(() => {
      scrim.remove?.();
      container.remove?.();
      spotlight.remove?.();
      if (returnToHome && app?.tab !== 'home' && app?.go) {
        app.go('home');
      }
    }, 240);
  };

  const renderStep = async () => {
    const step = TOUR_STEPS[currentStep];

    // Hide spotlight immediately while transitioning between steps
    if (currentTargetEl) {
      currentTargetEl.classList?.remove('tour-highlight-target');
    }
    currentTargetEl = null;
    if (spotlight.style) spotlight.style.opacity = '0';
    scrim.classList?.remove('has-spotlight');

    // 1. Dismiss any blocking modal sheets (e.g. Customize layout), dialogs, popovers & scrims
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      document.querySelectorAll('.sheet-scrim, .sheet, .dialog-scrim, .dialog, .scrim, .menu, .menu-scrim, .overlay-screen:not(.app-tour-container):not(.app-tour-spotlight):not(.app-tour-scrim)').forEach((node) => {
        node.remove();
      });
    }

    // 2. Clear any active subpage/subpanel so the main tab view is fully visible
    if (app) {
      app.page = null;
    }

    // 3. Automatically navigate to the active tab in background
    if (app?.go) {
      await app.go(step.tab, null);
    } else if (app?.render) {
      await app.render();
    }

    // 4. Update the bottom navigation bar active tab highlight
    updateNavTabHighlight(step.tab);

    // 5. Progressive ticks to spotlight the target as soon as DOM paint occurs
    findTargetAndSpotlight(step);
    setTimeout(() => findTargetAndSpotlight(step), 60);
    setTimeout(() => findTargetAndSpotlight(step), 160);
    setTimeout(() => findTargetAndSpotlight(step), 320);

    container.innerHTML = `
      <div class="app-tour-card ${isMinimized ? 'minimized' : ''}">
        <div class="app-tour-header">
          <div class="row" style="gap:6px;align-items:center">
            <span class="app-tour-tab-badge">
              ${icon(step.glyph, 'icon-sm')} ${h(step.badge)}
            </span>
            <span class="caption" style="font-weight:600;font-size:10.5px">
              ${currentStep + 1} of ${TOUR_STEPS.length}
            </span>
          </div>
          <div class="row" style="gap:4px;align-items:center">
            <button class="icon-button" data-tour-toggle title="${isMinimized ? 'Expand tour' : 'Minimize tour'}" style="width:26px;height:26px">
              ${icon(isMinimized ? 'expand_less' : 'expand_more', 'icon-sm')}
            </button>
            <button class="icon-button" data-tour-close title="Close tour" style="width:26px;height:26px">
              ${icon('close', 'icon-sm')}
            </button>
          </div>
        </div>

        <div class="app-tour-body">
          <div style="font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:0.04em;color:var(--accent);margin-bottom:1px">
            ${h(step.subtitle)}
          </div>
          <h3 style="font-size:13.5px;font-weight:700;margin:0 0 3px 0;color:var(--on-surface)">
            ${h(step.title)}
          </h3>
          <p style="font-size:11.5px;line-height:1.35;margin:0 0 5px 0;color:var(--on-surface-variant)">
            ${h(step.description)}
          </p>
        </div>

        ${step.highlights && step.highlights.length ? `
          <div class="app-tour-feature-list">
            ${step.highlights.map((hItem) => `
              <div class="app-tour-feature-item">
                <span class="app-tour-feature-icon">${icon(hItem.icon, 'icon-sm')}</span>
                <span style="font-size:11px;color:var(--on-surface);font-weight:550">${h(hItem.text)}</span>
              </div>`).join('')}
          </div>` : ''}

        <div class="row" style="width:100%;justify-content:space-between;align-items:center;margin-top:3px">
          <button class="btn btn-outlined btn-sm" data-tour-prev ${currentStep === 0 ? 'style="visibility:hidden"' : ''} style="padding:3px 8px;font-size:11.5px">
            ${icon('chevron_left', 'icon-sm')} Back
          </button>
          <div class="row" style="gap:3px" data-tour-dots>
            ${TOUR_STEPS.map((_, i) => `
              <span class="setup-step-dot ${i === currentStep ? 'active' : ''}" 
                    data-dot-idx="${i}" 
                    title="Go to step ${i + 1}"
                    style="cursor:pointer;width:${i === currentStep ? '16px' : '4px'};height:4px;transition:all 0.2s ease"></span>`).join('')}
          </div>
          <button class="btn btn-filled btn-sm" data-tour-next style="padding:3px 10px;font-size:11.5px">
            ${currentStep === TOUR_STEPS.length - 1 ? 'Finish' : `Next ${icon('chevron_right', 'icon-sm')}`}
          </button>
        </div>
      </div>`;

    // Event listeners
    container.querySelector('[data-tour-close]')?.addEventListener('click', () => closeTour(false));

    container.querySelector('[data-tour-toggle]')?.addEventListener('click', () => {
      isMinimized = !isMinimized;
      renderStep();
    });

    container.querySelector('[data-tour-prev]')?.addEventListener('click', () => {
      if (currentStep > 0) {
        currentStep -= 1;
        renderStep();
      }
    });

    container.querySelector('[data-tour-next]')?.addEventListener('click', () => {
      if (currentStep < TOUR_STEPS.length - 1) {
        currentStep += 1;
        renderStep();
      } else {
        closeTour(false);
      }
    });

    container.querySelectorAll('[data-dot-idx]').forEach((dot) => {
      dot.addEventListener('click', (e) => {
        const idx = Number.parseInt(e.currentTarget.dataset.dotIdx, 10);
        if (!Number.isNaN(idx) && idx >= 0 && idx < TOUR_STEPS.length) {
          currentStep = idx;
          renderStep();
        }
      });
    });
  };

  renderStep();
}


