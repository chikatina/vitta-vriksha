/*
 * App shell: theme, lock, routing and shared state.
 *
 * The navigation is five destinations plus a floating add button, in the shape Android
 * users expect. Everything that used to be a thirteenth scrolling tab now lives as a page
 * inside Wealth or More, reached through a list and a back button.
 */

import { Bridge } from './bridge.js';
import { toast, icon, h, autoScrollChipScrollers } from './ui.js';
import { setAmountsMasked } from './formatters.js';
import { openTransactionSheet } from './views/transaction-sheet.js';
import { renderLock, renderSetup, renderStartupFailure } from './views/lock.js';

import { renderHome } from './views/home.js';
import { renderLedger } from './views/ledger.js';
import { renderBudgets } from './views/budgets.js';
import { renderWealth } from './views/wealth.js';
import { renderInvestments } from './views/investments.js';
import { renderMore } from './views/more.js';
import { renderRecordPage } from './views/records.js';
import { renderInsights } from './views/insights.js';
import { renderRecurring } from './views/recurring.js';
import { renderFire } from './views/fire.js';
import { renderCas } from './views/cas.js';
import { renderFamily } from './views/family.js';
import { renderRules } from './views/rules.js';
import { renderBackup } from './views/backup.js';
import { renderDeleteData } from './views/delete-data.js';
import { renderSettings } from './views/settings.js';
import { renderSecurity } from './views/security.js';
import { renderAbout } from './views/about.js';
import { renderGuide } from './views/guide.js';
import { renderSupport } from './views/support.js';
import { renderSmsIngest } from './views/sms-ingest.js';
import { seedDemoData } from './demo-seed.js';

const TABS = [
  { id: 'home', label: 'Home', icon: 'dashboard', title: 'Home' },
  { id: 'ledger', label: 'Ledger', icon: 'receipt_long', title: 'Transactions' },
  { id: 'budgets', label: 'Budgets', icon: 'donut_small', title: 'Budgets' },
  { id: 'wealth', label: 'Wealth', icon: 'savings', title: 'Wealth' },
  { id: 'more', label: 'More', icon: 'more_horiz', title: 'More' },
];

const TAB_VIEWS = {
  home: renderHome,
  ledger: renderLedger,
  budgets: renderBudgets,
  wealth: renderWealth,
  more: renderMore,
};

// Sub-pages reached from the Wealth and More hubs. Each declares its parent tab so the
// back button and the highlighted destination stay consistent.
const PAGES = {
  // Reached from Home, from the Ledger and from More, because "what made this up" is a
  // question asked from wherever the figure was seen.
  insights: { parent: 'home', title: 'Insights', render: renderInsights },
  sms_ingest: { parent: 'home', title: 'Bank SMS Ingestion', render: renderSmsIngest },
  recurring: { parent: 'wealth', title: 'Recurring payments', render: renderRecurring },
  investments: { parent: 'wealth', title: 'Investments', render: renderInvestments },
  accounts: { parent: 'wealth', title: 'Accounts', render: (c, a) => renderRecordPage(c, a, 'account') },
  sips: { parent: 'wealth', title: 'SIPs', render: (c, a) => renderRecordPage(c, a, 'sip') },
  loans: { parent: 'wealth', title: 'Loans', render: (c, a) => renderRecordPage(c, a, 'loan') },
  cards: { parent: 'wealth', title: 'Credit cards', render: (c, a) => renderRecordPage(c, a, 'card') },
  subscriptions: { parent: 'wealth', title: 'Subscriptions', render: (c, a) => renderRecordPage(c, a, 'subscription') },
  goals: { parent: 'wealth', title: 'Goals', render: (c, a) => renderRecordPage(c, a, 'goal') },
  fire: { parent: 'wealth', title: 'Retirement', render: renderFire },
  cas: { parent: 'wealth', title: 'Account statement', render: renderCas },
  family: { parent: 'more', title: 'Household', render: renderFamily },
  rules: { parent: 'more', title: 'SMS rules', render: renderRules },
  backup: { parent: 'more', title: 'Backup', render: renderBackup },
  'delete-data': { parent: 'more', title: 'Delete data', render: renderDeleteData },
  settings: { parent: 'more', title: 'Settings', render: renderSettings },
  security: { parent: 'more', title: 'Security', render: renderSecurity },
  guide: { parent: 'more', title: 'Guide', render: renderGuide },
  support: { parent: 'more', title: 'Help & Support', render: renderSupport },
  about: { parent: 'more', title: 'About', render: renderAbout },
};

// Destinations where the add button would have nothing to add to.
const FAB_HIDDEN_TABS = new Set(['more']);

// Pages that read Android permission state and so go stale when it changes elsewhere.
const PERMISSION_SENSITIVE_PAGES = new Set(['security', 'rules']);

class App {
  constructor() {
    this.tab = 'home';
    this.page = null;
    this.tabStack = [];
    this._lastBackPressTime = 0;
    this.settings = {};
    this.currency = 'INR';
    this.locale = 'en-IN';
    this.memberFilter = 'all';
    this.locked = true;

    this.view = document.getElementById('view');
    this.appBar = document.getElementById('appBar');
    this.appBarTitle = document.getElementById('appBarTitle');
    this.backButton = document.getElementById('backButton');
    this.lockButton = document.getElementById('lockButton');
    this.fab = document.getElementById('fab');
    this.navBar = document.getElementById('navBar');

    window.app = this;
    if (Bridge.isDebug()) {
      window.seedDemoData = () => seedDemoData(this);
    }
    window.onSystemBackPressed = () => this.handleSystemBack();
    window.onNotificationClicked = (reminderId) => {
      if (this.locked) {
        this._pendingNotificationId = reminderId;
        return;
      }
      this.handleNotificationClick(reminderId);
    };
    this.init();
  }

  /*
   * Starting up, which now has to happen in two halves.
   *
   * Nothing recorded can be read before the PIN is in, so settings cannot be read either:
   * the theme, the currency and whether setup was ever finished all live in a database that
   * is ciphertext until the vault opens. So boot asks the one question that can be answered
   * while locked, shows the right screen for the answer, and stops. The rest of the app is
   * built by `resume` once the key is in memory.
   *
   * The theme is the exception, mirrored into storage precisely so the lock screen is not
   * the one screen in the app drawn in the wrong colours.
   */
  async init() {
    this.applyAppearance(localStorage.getItem('vv.appearance') || 'system',
      localStorage.getItem('vv.accent') || 'jade');
    this.bindChrome();

    const vault = await Bridge.db('vault_status');
    if (vault.status !== 'success') {
      // No answer to the only question that works while locked. Carrying on would open a
      // database the app cannot decrypt, so say so and stop.
      renderStartupFailure(this, vault);
      return;
    }

    if (!vault.exists) {
      // Nothing has ever been recorded here. Setup chooses the PIN, which is what makes
      // the vault, and calls `resume` when it has.
      this.buildNav();
      renderSetup(this);
      return;
    }

    if (vault.unlocked) {
      await this.resume();
      return;
    }

    this.buildNav();
    renderLock(this);
  }

  /**
   * The second half of starting up, once the database can be read.
   *
   * Called by the lock screen after a right PIN and by setup after it has made the vault.
   * Everything here needs a database that decrypts, which is why none of it is in `init`.
   */
  async resume() {
    try {
      const res = await Bridge.db('get_settings');
      if (res && res.status === 'success') this.settings = res.settings;

      this.currency = this.settings.currency || 'INR';
      this.locale = this.settings.locale || 'en-IN';
      setAmountsMasked(this.settings.mask_amounts === '1');
      this.applyAppearance(this.settings.appearance || 'system', this.settings.accent || 'jade');
      // Kept outside the database so the next lock screen is drawn in the user's theme
      // rather than the default one.
      localStorage.setItem('vv.appearance', this.appearance);
      localStorage.setItem('vv.accent', this.accent);

      this.buildNav();

      if (this.settings.setup_complete !== '1') {
        renderSetup(this);
      } else {
        this.unlock();
      }
    } catch (err) {
      console.error('Error during app.resume():', err);
      this.unlock();
    }
  }

  /**
   * Back to the very first screen, as if the app had just been installed.
   *
   * A reset that only navigates home leaves the household, the PIN and the setup flag as
   * this session last read them, so the app carries on looking like it still has data it
   * has just deleted. Everything in memory has to be read again from a database that is
   * now empty.
   */
  async restart() {
    this.settings = {};
    this.locked = true;
    this.tab = 'home';
    this.page = null;
    this.memberFilter = 'all';
    this.ledgerFilter = 'all';
    this.ledgerSearch = '';
    this.ledgerScope = 'month';
    this.ledgerMonthValue = '';
    this.ledgerWeekValue = '';
    this.ledgerDayValue = '';

    // The same two halves as a cold start, and for the same reason: a reset that deleted
    // the vault leaves a database that cannot be read until a new PIN has made a new one.
    await this.init();
  }

  /* ------------------------------------------------------------- appearance */

  applyAppearance(appearance, accent) {
    this.appearance = appearance;
    this.accent = accent;

    const resolved = appearance === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : appearance;

    document.documentElement.setAttribute('data-appearance', resolved);
    document.documentElement.setAttribute('data-accent', accent);
    localStorage.setItem('vv.appearance', appearance);
    localStorage.setItem('vv.accent', accent);

    if (!this.appearanceWatcher) {
      this.appearanceWatcher = window.matchMedia('(prefers-color-scheme: dark)');
      this.appearanceWatcher.addEventListener('change', () => {
        if (this.appearance === 'system') this.applyAppearance('system', this.accent);
      });
    }
  }

  async saveAppearance(appearance, accent) {
    this.applyAppearance(appearance, accent);
    await Bridge.db('update_setting', { key: 'appearance', value: appearance });
    await Bridge.db('update_setting', { key: 'accent', value: accent });
    this.settings.appearance = appearance;
    this.settings.accent = accent;
  }

  /* ------------------------------------------------------------------ chrome */

  buildNav() {
    this.navBar.innerHTML = TABS.map((tab) => `
      <button class="nav-item" data-tab="${tab.id}" aria-selected="false">
        <span class="nav-indicator">${icon(tab.icon)}</span>
        <span class="nav-label">${h(tab.label)}</span>
      </button>`).join('');

    this.navBar.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => this.go(btn.dataset.tab));
    });
  }

  /*
   * Wires the app bar, the button and the scroll shadow. Once, ever.
   *
   * A factory reset restarts the app by running `init` again, and `init` builds the chrome.
   * Without the guard that would add a second listener to every control and a second plus
   * glyph to the button, so one tap after a reset would open two sheets.
   */
  bindChrome() {
    if (this.chromeBound) return;
    this.chromeBound = true;

    // Glyphs are injected rather than written into index.html, so every icon in the app
    // goes through the same name lookup.
    this.backButton.innerHTML = icon('arrow_back');
    this.lockButton.innerHTML = icon('lock');
    this.fab.insertAdjacentHTML('afterbegin', icon('add'));

    this.backButton.addEventListener('click', () => this.back());
    this.lockButton.addEventListener('click', () => this.lock());
    this.fab.addEventListener('click', () => this.addTransaction());

    // The app bar gains a surface once the content scrolls under it.
    this.view.addEventListener('scroll', () => {
      this.appBar.classList.toggle('scrolled', this.view.scrollTop > 4);
    }, { passive: true });

    // Android's back gesture / popstate handling
    window.addEventListener('popstate', () => {
      this.handleSystemBack();
    });

    // Permissions can be changed from system settings while the app is in the background.
    // Setup installs its own handler, so only take over once the app proper is running.
    window.onAppResumed = async () => {
      const lockTimeoutStr = localStorage.getItem('app_lock_timeout_ms') || this.settings?.app_lock_timeout_ms || '120000';
      const lockTimeoutMs = Number(lockTimeoutStr);

      if (lockTimeoutMs > 0 && this.backgroundedAt) {
        const elapsed = Date.now() - this.backgroundedAt;
        if (elapsed > lockTimeoutMs) {
          await this.lock();
        }
      }
      this.backgroundedAt = null;

      if (!this.locked && PERMISSION_SENSITIVE_PAGES.has(this.page)) this.render();
    };

    /*
     * When the phone screen is turned off or device is locked, lock immediately ignoring grace period.
     */
    window.onDeviceLocked = () => {
      this.lock();
    };

    /*
     * When backgrounded, if the phone itself was locked (screen off), lock immediately.
     * Otherwise (app switch with phone still awake), apply the graceful timeout.
     */
    window.onAppBackgrounded = (isPhoneLocked = false) => {
      if (isPhoneLocked) {
        this.lock();
        return;
      }
      this.backgroundedAt = Date.now();
      const lockTimeoutStr = localStorage.getItem('app_lock_timeout_ms') || this.settings?.app_lock_timeout_ms || '120000';
      if (Number(lockTimeoutStr) === 0) {
        this.lock();
      }
    };
  }

  /* ------------------------------------------------------------------ routing */

  go(tab, page = null, { fromBack = false } = {}) {
    if (!fromBack && this.tab && tab !== this.tab) {
      this.tabStack.push(this.tab);
      if (this.tabStack.length > 20) this.tabStack.shift();
    }
    this.tab = tab;
    this.page = page;
    if (page && typeof history !== 'undefined' && history?.pushState) {
      history.pushState({ page }, '');
    }
    return this.render();
  }

  open(destination) {
    if (TAB_VIEWS[destination]) {
      return this.go(destination);
    }
    const config = PAGES[destination];
    if (config) return this.go(config.parent, destination);
  }

  openPage(page) {
    return this.open(page);
  }

  back() {
    if (!this.page) return;
    this.page = null;
    this.render();
  }

  handleSystemBack() {
    // 1. Close any open dropdown menus
    const menu = document.querySelector('.menu, .menu-scrim');
    if (menu) {
      document.querySelectorAll('.menu, .menu-scrim').forEach((node) => node.remove());
      return true;
    }

    // 2. Close any open dialog or prompt
    const dialog = document.querySelector('.dialog-scrim');
    if (dialog) {
      const cancel = dialog.querySelector('[data-cancel], [data-close], button');
      if (cancel) cancel.click();
      else dialog.remove();
      return true;
    }

    // 3. Close any open bottom sheet
    const sheet = document.querySelector('.sheet-scrim');
    if (sheet) {
      const cancel = sheet.querySelector('[data-cancel], [data-close]');
      if (cancel) cancel.click();
      else sheet.remove();
      return true;
    }

    // 4. Close subpage/panel if currently inside one
    if (this.page) {
      this.back();
      return true;
    }

    // 5. Navigate to previous tab in tab stack, or go to Home tab if on another tab
    while (this.tabStack.length > 0) {
      const prevTab = this.tabStack.pop();
      if (prevTab && prevTab !== this.tab) {
        this.go(prevTab, null, { fromBack: true });
        return true;
      }
    }

    if (this.tab !== 'home') {
      this.go('home', null, { fromBack: true });
      return true;
    }

    // 6. On Home root with nothing open: double back to exit
    const now = Date.now();
    if (!this._lastBackPressTime || now - this._lastBackPressTime > 2000) {
      this._lastBackPressTime = now;
      toast('Press back again to exit');
      return true;
    }

    return false; // Allow app exit
  }

  async render({ preserveScroll = false } = {}) {
    const sRes = await Bridge.db('get_settings');
    if (sRes?.status === 'success' && sRes.settings) {
      this.settings = sRes.settings;
    }
    const scrollPos = preserveScroll && this.view ? this.view.scrollTop : 0;
    const config = this.page ? PAGES[this.page] : null;
    const tab = TABS.find((t) => t.id === this.tab) || TABS[0];

    this.appBarTitle.textContent = config ? config.title : tab.title;
    this.backButton.classList.toggle('hidden', !config);
    this.lockButton.classList.toggle('hidden', Boolean(config));

    this.navBar.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === this.tab));
    });

    const showFab = !config && !FAB_HIDDEN_TABS.has(this.tab);
    this.fab.classList.toggle('hidden-fab', !showFab);

    if (!preserveScroll) {
      this.view.scrollTop = 0;
      this.appBar.classList.remove('scrolled');
    }
    this.view.innerHTML = '';

    const render = config ? config.render : TAB_VIEWS[this.tab];
    try {
      await render(this.view, this);
      autoScrollChipScrollers(this.view);
      if (preserveScroll && scrollPos > 0) {
        this.view.scrollTop = scrollPos;
        this.appBar.classList.toggle('scrolled', scrollPos > 4);
      }
    } catch (error) {
      console.error('Failed to render', this.page || this.tab, error);
      this.view.innerHTML = `
        <div class="empty">
          ${icon('error')}
          <div class="empty-title">This screen could not load</div>
          <div class="empty-body">${h(error.message || 'Something went wrong.')}</div>
        </div>`;
    }
  }

  /** Re-renders whatever is currently on screen, after a write. */
  refresh({ preserveScroll = true } = {}) {
    return this.render({ preserveScroll });
  }

  /* -------------------------------------------------------------------- data */

  /** Runs a database action and surfaces any error as a toast. Returns null on failure. */
  async db(action, args = {}, { silent = false } = {}) {
    const res = await Bridge.db(action, args);
    if (res.status !== 'success') {
      // The code reaches the log even when the toast shows only the message, so a report
      // of "it said that did not work" is still traceable.
      console.error(`Action "${action}" failed [${res.code || 'no code'}]`, res);
      this.lastError = res;
      if (!silent) toast(res.message || 'That did not work.', 'error');
      return null;
    }
    return res;
  }

  async addTransaction(existing = null) {
    const saved = await openTransactionSheet(this, existing);
    if (saved) await this.refresh();
  }

  /* -------------------------------------------------------------------- lock */

  /**
   * Locks the app, which now means locking the data and not just the screen.
   *
   * The lock screen is drawn first and the key dropped after, so there is no moment where
   * the records are still readable behind a screen that says they are not. Everything the
   * app had in memory goes with the key, so unlocking reads the file again from the start.
   *
   * Two things it refuses to do. Locking twice, because the second call would draw a lock
   * screen over a lock screen and then drop a key that has already gone. And locking during
   * setup, because there is no PIN yet to unlock with: somebody who steps out of setup to
   * read the SMS with their bank balance in it would come back to a screen asking for a PIN
   * they have not chosen.
   */
  async lock() {
    if (this.locked) return;
    if (this.settings.setup_complete !== '1') return;

    document.querySelectorAll('.scrim, .dialog, .sheet, .menu, .menu-scrim, .app-tour-scrim, .app-tour-container, .app-tour-spotlight').forEach((node) => node.remove());
    document.body?.classList?.remove('tour-active');
    this.locked = true;
    this.settings = {};
    renderLock(this);
    await Bridge.db('lock_vault');
  }

  unlock() {
    this.locked = false;
    document.querySelectorAll('.overlay-screen, .scrim, .dialog, .sheet, .menu, .menu-scrim').forEach((node) => node.remove());
    this.render();
    this.catchUp();
    if (this._pendingNotificationId) {
      const id = this._pendingNotificationId;
      this._pendingNotificationId = null;
      this.handleNotificationClick(id);
    }
  }

  handleNotificationClick(reminderId) {
    if (!reminderId) return;
    if (reminderId === 'pending-alerts') {
      this.go('home');
    } else if (reminderId === 'daily-spend-review') {
      this.go('home');
      this.addTransaction();
    } else if (reminderId === 'cas-refresh') {
      this.open('cas');
    } else if (reminderId.startsWith('sip-')) {
      this.open('sips');
    }
  }

  /**
   * What happened while the app was closed.
   *
   * Two things: bank alerts the shell caught and wrote down, which are classified now
   * against the rules as they currently stand, and the reminder alarms, which are
   * rescheduled because a due date that has passed should not still be set.
   */
  async catchUp() {
    if (!Bridge.isAndroid()) return;

    Bridge.call('reminders', { action: 'sync' }).catch(() => {});

    const res = await Bridge.call('sms', { action: 'pending_alerts' });
    if (res.status !== 'success' || !res.alerts.length) return;

    this.pendingAlerts = res.alerts;
    if (this.tab === 'home' && !this.page) this.render();
  }

  /** Opens the next queued bank alert as a draft, for the user to check and file. */
  async reviewNextAlert() {
    const alert = (this.pendingAlerts || []).shift();
    if (!alert) return;

    await this.addTransaction({
      date: alert.date,
      amount: alert.amount,
      type: alert.type,
      category: alert.category,
      merchant: alert.merchant,
      raw_sms: alert.raw_sms,
    });
    this.render();
  }

  get familyEnabled() {
    return this.settings.family_features_enabled === '1';
  }

  get excludeInvestments() {
    return this.settings.exclude_investments_from_expenses !== '0';
  }
}

export { App };
export default App;

new App();
