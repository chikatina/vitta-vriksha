/*
 * Exhaustive UI Views & Functions Coverage Test Suite.
 *
 * Tests every UI view renderer, helper, dialog, bottom sheet, bridge function,
 * and error utility to maximize function coverage across the codebase.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { freshBackend, ok } from './_harness.mjs';

function mockElement(tag = 'div', id = '') {
  const listeners = new Map();
  const classes = new Set();
  const children = [];
  const attributes = new Map();

  const elem = {
    tagName: tag.toUpperCase(),
    tag,
    id,
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    type: '',
    checked: false,
    scrollTop: 0,
    style: {},
    dataset: {},
    offsetParent: {},
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); elem.className = [...classes].join(' '); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); elem.className = [...classes].join(' '); },
      toggle(c, force) {
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c); else classes.add(c);
        } else if (force) classes.add(c); else classes.delete(c);
        elem.className = [...classes].join(' ');
      },
      contains(c) { return classes.has(c); },
    },
    setAttribute(k, v) { attributes.set(k, String(v)); },
    getAttribute(k) { return attributes.get(k) || null; },
    hasAttribute(k) { return attributes.has(k); },
    removeAttribute(k) { attributes.delete(k); },
    appendChild(child) {
      children.push(child);
      if (child.className && String(child.className).includes('scrim')) {
        setTimeout(() => {
          child.dispatchEvent('click');
        }, 10);
      }
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
    },
    remove() {},
    querySelectorAll(sel) {
      if (sel === '[data-tab]') {
        return [
          mockElement('button'), mockElement('button'), mockElement('button'),
          mockElement('button'), mockElement('button'),
        ];
      }
      return [mockElement('div')];
    },
    querySelector() { return mockElement('div'); },
    closest() { return elem; },
    addEventListener(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    removeEventListener(evt, fn) {
      if (!listeners.has(evt)) return;
      listeners.set(evt, listeners.get(evt).filter((f) => f !== fn));
    },
    dispatchEvent(evt) {
      const name = typeof evt === 'string' ? evt : evt.type;
      const list = listeners.get(name) || [];
      list.forEach((fn) => fn({ type: name, target: elem, currentTarget: elem, preventDefault: () => {} }));
    },
    click() { elem.dispatchEvent('click'); },
    getBoundingClientRect: () => ({ top: 10, left: 10, width: 100, height: 40, bottom: 50, right: 110 }),
    scrollIntoView: () => {},
    focus: () => {},
    blur: () => {},
    insertAdjacentHTML(pos, html) {
      elem.innerHTML += html;
    },
  };
  return elem;
}

const elements = new Map([
  ['view', mockElement('main', 'view')],
  ['appBar', mockElement('header', 'appBar')],
  ['appBarTitle', mockElement('h1', 'appBarTitle')],
  ['backButton', mockElement('button', 'backButton')],
  ['lockButton', mockElement('button', 'lockButton')],
  ['fab', mockElement('button', 'fab')],
  ['navBar', mockElement('nav', 'navBar')],
]);

if (!globalThis.document) {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };

  globalThis.document = {
    getElementById: (id) => elements.get(id) || mockElement('div', id),
    querySelector: () => mockElement('div'),
    querySelectorAll: () => [mockElement('div')],
    createElement: (tag) => mockElement(tag),
    body: mockElement('body'),
    documentElement: mockElement('html'),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  globalThis.window = {
    localStorage: globalThis.localStorage,
    document: globalThis.document,
    location: { reload: () => {} },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollTo: () => {},
    innerHeight: 800,
    innerWidth: 400,
    history: { pushState: () => {} },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    onPermissionResult: null,
    onBiometricAuthResult: null,
  };
  globalThis.history = globalThis.window.history;
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
}

// Dynamic module loader
let UI, Formatters, BrandMark, BridgeMod, ErrorsMod, IsinMod, NativeMod;
let Views = {};
let AppClass;

before(async () => {
  await freshBackend();

  UI = await import('../app/src/main/assets/www/js/ui.js');
  Formatters = await import('../app/src/main/assets/www/js/formatters.js');
  BrandMark = await import('../app/src/main/assets/www/js/brand-mark.js');
  BridgeMod = await import('../app/src/main/assets/www/js/bridge.js');
  ErrorsMod = await import('../app/src/main/assets/www/js/backend/errors.js');
  IsinMod = await import('../app/src/main/assets/www/js/backend/isin.js');
  NativeMod = await import('../app/src/main/assets/www/js/backend/native.js');

  Views.about = await import('../app/src/main/assets/www/js/views/about.js');
  Views.backup = await import('../app/src/main/assets/www/js/views/backup.js');
  Views.budgets = await import('../app/src/main/assets/www/js/views/budgets.js');
  Views.cas = await import('../app/src/main/assets/www/js/views/cas.js');
  Views.categoryField = await import('../app/src/main/assets/www/js/views/category-field.js');
  Views.deleteData = await import('../app/src/main/assets/www/js/views/delete-data.js');
  Views.drilldown = await import('../app/src/main/assets/www/js/views/drilldown.js');
  Views.family = await import('../app/src/main/assets/www/js/views/family.js');
  Views.fire = await import('../app/src/main/assets/www/js/views/fire.js');
  Views.guide = await import('../app/src/main/assets/www/js/views/guide.js');
  Views.home = await import('../app/src/main/assets/www/js/views/home.js');
  Views.insights = await import('../app/src/main/assets/www/js/views/insights.js');
  Views.investments = await import('../app/src/main/assets/www/js/views/investments.js');
  Views.ledger = await import('../app/src/main/assets/www/js/views/ledger.js');
  Views.lock = await import('../app/src/main/assets/www/js/views/lock.js');
  Views.more = await import('../app/src/main/assets/www/js/views/more.js');
  Views.tour = await import('../app/src/main/assets/www/js/views/onboarding-tour.js');
  Views.records = await import('../app/src/main/assets/www/js/views/records.js');
  Views.recurring = await import('../app/src/main/assets/www/js/views/recurring.js');
  Views.rules = await import('../app/src/main/assets/www/js/views/rules.js');
  Views.security = await import('../app/src/main/assets/www/js/views/security.js');
  Views.settings = await import('../app/src/main/assets/www/js/views/settings.js');
  Views.shared = await import('../app/src/main/assets/www/js/views/shared.js');
  Views.smsIngest = await import('../app/src/main/assets/www/js/views/sms-ingest.js');
  Views.support = await import('../app/src/main/assets/www/js/views/support.js');
  Views.transactionSheet = await import('../app/src/main/assets/www/js/views/transaction-sheet.js');
  Views.wealth = await import('../app/src/main/assets/www/js/views/wealth.js');
  Views.widgets = await import('../app/src/main/assets/www/js/views/widgets.js');

  const appModule = await import('../app/src/main/assets/www/js/app.js');
  AppClass = appModule.default || appModule.App;
});

describe('UI & Functions Coverage: 1. ui.js, formatters.js & errors.js', () => {
  it('covers all error checking and registry utilities', () => {
    assert.equal(ErrorsMod.isError({ status: 'error' }), true);
    assert.equal(ErrorsMod.isError({ status: 'success' }), false);
    assert.equal(ErrorsMod.isError(null), false);

    const f1 = ErrorsMod.fail('BAD_REQUEST', 'Invalid params', 'Check inputs');
    assert.equal(f1.status, 'error');
    assert.equal(f1.code, 'BAD_REQUEST');
    assert.equal(f1.hint, 'Check inputs');

    const f2 = ErrorsMod.fail('NON_EXISTENT_CODE', 'Custom error');
    assert.equal(f2.code, 'INTERNAL');
    assert.ok(f2.message.includes('unregistered'));

    assert.ok(ErrorsMod.ERROR_CODES.PIN_WRONG);
    assert.ok(ErrorsMod.ERROR_CODES.CAS_NOT_PDF);
  });

  it('covers UI formatting and masking toggles', () => {
    assert.equal(UI.h('<div>test & "quote"</div>'), '&lt;div&gt;test &amp; &quot;quote&quot;&lt;/div&gt;');
    assert.ok(BrandMark.brandMark());
    assert.ok(UI.errorBlock({ message: 'Failed', code: 'BAD_REQUEST', hint: 'Check input' }));
    assert.ok(UI.emptyState('inbox', 'No data', 'Nothing here'));

    Formatters.setAmountsMasked(true);
    assert.equal(Formatters.amountsAreMasked(), true);
    assert.ok(Formatters.formatCurrency(1500).includes('••'));
    assert.ok(Formatters.formatExact(1500).includes('••'));
    Formatters.setAmountsMasked(false);
    assert.equal(Formatters.amountsAreMasked(), false);
    assert.ok(Formatters.formatCurrency(1500).includes('1,500'));
    assert.ok(Formatters.formatExact(1500).includes('1,500'));
    assert.ok(Formatters.formatDate('2026-08-17'));
    assert.ok(Formatters.formatDayMonth('2026-08-17'));
    assert.ok(Formatters.formatMonthKey('2026-08'));
    assert.ok(Formatters.formatNumber(12345));
    assert.ok(Formatters.formatPercent(45.2));
    assert.ok(Formatters.formatBucketLabel('2026-08', 'months', 0));
    assert.ok(Formatters.formatBucketTitle('2026-08', 'months'));
    assert.ok(Formatters.describePeriod('2026-08', 'months'));
    assert.ok(Formatters.formatDelta(15.2));
    assert.ok(Formatters.formatRelativeDate('2026-08-17'));
    assert.equal(typeof Formatters.daysUntil('2026-08-20'), 'number');
    assert.ok(Formatters.todayISO());

    const selectHtml = UI.selectField({
      name: 'acc_id',
      options: [
        { value: '1', label: 'Primary Account' },
        { value: '2', label: 'Savings' },
      ],
      value: '1',
    });
    assert.ok(selectHtml.includes('Primary Account'));

    // Progress Modal
    const prog = UI.showProgressModal('Testing Progress', { message: 'Starting...', initialPercent: 10 });
    assert.ok(prog);
    prog.update({ percent: 50, message: 'Halfway...', detail: 'Step 2 of 4' });
    prog.complete('Done testing!', 50);
  });
});

describe('UI & Functions Coverage: 2. Bridge & Native Interfaces', () => {
  it('exercises Bridge dispatchers and AndroidBridge fallbacks', async () => {
    assert.equal(typeof BridgeMod.Bridge.isAndroid(), 'boolean');
    assert.equal(typeof NativeMod.isAndroid(), 'boolean');
    assert.equal(typeof NativeMod.isBiometricAvailable(), 'boolean');

    NativeMod.triggerBiometricAuth();
    const bioVerify = await NativeMod.verifyBiometric();
    assert.equal(typeof bioVerify, 'object');
    assert.equal(bioVerify.success, false);

    const bridgeBioVerify = await BridgeMod.Bridge.verifyBiometric();
    assert.equal(typeof bridgeBioVerify, 'object');
    assert.equal(bridgeBioVerify.success, false);

    assert.equal(NativeMod.checkPermission('SMS'), false);
    assert.equal(NativeMod.permissionIsBlocked('SMS'), false);
    NativeMod.openAppSettings();

    const reqRes = await NativeMod.requestPermission('SMS');
    assert.equal(reqRes, false);

    assert.equal(NativeMod.scheduleReminder('1', Date.now() + 10000, 'Test', 'Body'), false);
    assert.equal(NativeMod.cancelReminder('1'), false);
    assert.equal(NativeMod.canScheduleExactAlarms(), false);

    NativeMod.setSmsTrackingEnabled(true);
    assert.equal(NativeMod.isSmsTrackingEnabled(), true);
    NativeMod.setSmsTrackingEnabled(false);
    assert.equal(NativeMod.isSmsTrackingEnabled(), false);

    assert.deepEqual(NativeMod.takePendingAlerts(), []);
    assert.deepEqual(NativeMod.readSmsInbox(), []);

    NativeMod.writeConfigMirror('{"mirrored": true}');
    assert.equal(NativeMod.readConfigMirror(), '{"mirrored": true}');

    const dbRes = await BridgeMod.Bridge.db('vault_status');
    assert.equal(dbRes.status, 'success');

    const callRes = await BridgeMod.Bridge.call('database', { action: 'vault_status' });
    assert.equal(callRes.status, 'success');
  });

  it('exercises ISIN reference database lifecycle', async () => {
    assert.equal(IsinMod.nameForIsin(''), '');
    assert.equal(IsinMod.nameForIsin('INF123456789'), '');
    assert.equal(IsinMod.isinDatabaseVersion(), null);
    IsinMod.unloadIsinDatabase();
  });
});

describe('UI & Functions Coverage: 3. View Renderers Smoke & Event Binding', () => {
  const mockApp = {
    tab: 'home',
    page: null,
    settings: { currency: 'INR', appearance: 'system', accent: 'jade', family_enabled: '1' },
    currency: 'INR',
    locale: 'en-IN',
    locked: false,
    familyEnabled: true,
    memberFilter: 'all',
    go: () => {},
    open: () => {},
    openPage: () => {},
    render: () => {},
    refresh: () => {},
    db: (action, args) => BridgeMod.Bridge.db(action, args),
    applyAppearance: () => {},
    buildNav: () => {},
    lock: async () => {},
    unlock: () => {},
    resume: async () => {},
  };

  it('renders all views without runtime errors', async () => {
    const container = mockElement('div');

    // 1. About
    Views.about.renderAbout(container, mockApp);

    // 2. Backup
    Views.backup.renderBackup(container, mockApp);

    // 3. Budgets
    await Views.budgets.renderBudgets(container, mockApp);

    // 4. CAS
    Views.cas.renderCas(container, mockApp);

    // 5. Delete Data
    Views.deleteData.renderDeleteData(container, mockApp);

    // 6. Family
    await Views.family.renderFamily(container, mockApp);

    // 7. FIRE
    Views.fire.renderFire(container, mockApp);

    // 8. Guide
    Views.guide.renderGuide(container, mockApp);

    // 9. Home
    await Views.home.renderHome(container, mockApp);

    // 10. Insights
    await Views.insights.renderInsights(container, mockApp);

    // 11. Investments
    await Views.investments.renderInvestments(container, mockApp);

    // 12. Ledger
    await Views.ledger.renderLedger(container, mockApp);

    // 13. Lock, Setup & Startup Failure
    Views.lock.renderLock(mockApp);
    Views.lock.renderSetup(mockApp);
    Views.lock.renderStartupFailure(mockApp, { message: 'Database failed' });

    // 14. More
    Views.more.renderMore(container, mockApp);

    // 15. Onboarding Tour
    assert.equal(Views.tour.TOUR_STEPS.length, 8);
    Views.tour.openOnboardingTour(mockApp, 0);

    // 16. Records
    const recordTypes = ['account', 'sip', 'loan', 'card', 'subscription', 'goal'];
    for (const rt of recordTypes) {
      await Views.records.renderRecordPage(container, mockApp, rt);
    }
    assert.ok(Views.records.GOAL_PRESETS.length > 0);
    assert.ok(Views.records.getGoalGlyph({ kind: 'vehicle' }));
    assert.ok(Views.records.RECORD_CONFIG.account);
    assert.equal(typeof Views.records.getMonthsRemaining('2030-01-01'), 'number');

    // 17. Recurring
    await Views.recurring.renderRecurring(container, mockApp);

    // 18. Rules
    await Views.rules.renderRules(container, mockApp);

    // 19. Security
    Views.security.renderSecurity(container, mockApp);

    // 20. Settings
    Views.settings.renderSettings(container, mockApp);

    // 21. SMS Ingest
    Views.smsIngest.renderSmsIngest(container, mockApp);

    // 22. Support
    Views.support.renderSupport(container, mockApp);

    // 23. Transaction Sheet
    await Views.transactionSheet.openTransactionSheet(mockApp, null);

    // 24. Wealth
    await Views.wealth.renderWealth(container, mockApp);

    // 25. Lock & Startup Failure
    Views.lock.renderStartupFailure(mockApp, { code: 'DATABASE_CORRUPT', message: 'DB Error' });
    Views.insights.focusInsights({ metric: 'spend', range: '1y' });

    // 25. Shared Components
    const idx = Views.shared.categoryIndex([{ name: 'Food', color: '#ff0000', icon: 'lunch_dining' }]);
    assert.ok(idx);
    const look = Views.shared.categoryLook(idx, 'Food');
    assert.ok(look);
    const txRow = Views.shared.transactionRow({ amount: 500, type: 'Expense', merchant: 'Swiggy', date: '2026-08-17' }, mockApp, idx);
    assert.ok(txRow);
    const nr = Views.shared.navRow('about', 'info', 'About', 'Version');
    assert.ok(nr);
    const mc = Views.shared.memberChips(mockApp, [{ id: 1, name: 'Self' }, { id: 2, name: 'Spouse' }]);
    assert.ok(mc);
    const chipContainer = mockElement('div');
    chipContainer.innerHTML = mc;
    Views.shared.bindMemberChips(chipContainer, mockApp);

    // 26. Widgets Layout
    assert.ok(Views.widgets.availableWidgets(mockApp));
    assert.ok(Views.widgets.defaultOptions('month_summary'));
    const layout = Views.widgets.readLayout(mockApp);
    assert.ok(layout);
    await Views.widgets.saveLayout(mockApp, layout);
    await Views.widgets.loadWidgetData(mockApp, layout);

    // 27. Category Field
    const catOpts = Views.categoryField.categoryOptions([{ name: 'Dining', type: 'Expense' }]);
    assert.ok(catOpts.length > 0);
    const catFieldHost = mockElement('div');
    catFieldHost.closest = () => mockElement('div');
    Views.categoryField.bindCategoryField(catFieldHost, {
      id: 'category',
      categories: [{ name: 'Dining', type: 'Expense' }],
      type: 'Expense',
    });

    // 28. Dialogs and Modals
    UI.closeOpenMenus();
    UI.bindSelectFields(mockElement('div'));
    UI.alertDialog('Alert', 'Sample Message');
    UI.confirmDialog('Confirm', 'Are you sure?', { confirmLabel: 'Yes', danger: true });
    UI.promptDialog('Prompt', { label: 'Name' });
    UI.sheet('Sheet Title', '<div>Content</div>');
    UI.chooser('Choose Option', [{ value: 'a', label: 'Option A' }]);
    UI.saveFile('export.csv', 'col1,col2\n1,2', 'text/csv');

    // 29. Drilldowns and Detailed Sheets
    await Views.drilldown.openTransactionsSheet(mockApp, { title: 'Food', filter: {} });
    await Views.drilldown.openPeriodSheet(mockApp, { title: 'August', start: '2026-08-01', end: '2026-08-31' });
    await Views.drilldown.openSliceSheet(mockApp, { title: 'Dining', filter: {} });
    await Views.drilldown.openCategoryTrend(mockApp, { name: 'Dining', color: '#ff0000', icon: 'sell' });
    await Views.drilldown.openCashflowSheet(mockApp);

    // 30. Recurring Actions
    await Views.recurring.openManualPriceChange(mockApp, 'sip', { id: 1, name: 'SIP 1' });
    await Views.recurring.openPriceHistory(mockApp, 'sip', { id: 1, name: 'SIP 1' });
  });
});

describe('UI & Functions Coverage: 4. App Controller Lifecycle', () => {
  it('covers App controller lifecycle methods', () => {
    const app = new AppClass();
    assert.ok(app);
    assert.equal(app.tab, 'home');

    app.applyAppearance('dark', 'jade');
    assert.equal(app.appearance, 'dark');
    assert.equal(app.accent, 'jade');

    app.buildNav();
    app.go('ledger');
    assert.equal(app.tab, 'ledger');

    app.open('settings');
    assert.equal(app.page, 'settings');

    app.openPage('budgets');
    assert.equal(app.tab, 'budgets');

    app.unlock();
    assert.equal(app.locked, false);
  });
});
