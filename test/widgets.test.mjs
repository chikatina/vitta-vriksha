/*
 * The dashboard panels, rendered against a real database.
 *
 *     ./scripts/dev test
 *
 * A widget is a function from a reply to a string, which means it can be run here without a
 * browser: the backend is JavaScript in this process, and the panels build markup rather
 * than touching the document. So every panel is rendered twice, once against an empty
 * install and once against a seeded one, which is what catches a panel reading a field off a
 * reply that does not have it. That failure is a blank Home screen on the device and a line
 * in the console nobody sees.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { monthsAgo, freshBackend, ok } from './_harness.mjs';

const widgets = await import('../app/src/main/assets/www/js/views/widgets.js');

const {
  WIDGETS, availableWidgets, defaultOptions, loadWidgetData, readLayout, saveLayout,
  DEFAULT_LAYOUT,
} = widgets;

/** The parts of the app object a widget is allowed to read. */
function fakeApp(settings = {}) {
  return {
    currency: 'INR',
    locale: 'en-IN',
    memberFilter: 'all',
    familyEnabled: settings.family_features_enabled === '1',
    settings,
    db: async () => ({ status: 'success' }),
  };
}

beforeEach(async () => {
  await freshBackend();
});

async function seed(t) {
  for (let back = 0; back < 4; back += 1) {
    const date = monthsAgo(back);
    await ok(t, 'save_transaction', {
      transaction: {
        date, amount: 2000 + back * 50, category: 'Groceries', type: 'Expense', merchant: 'A supermarket',
      },
    });
    await ok(t, 'save_transaction', {
      transaction: {
        date, amount: 199, category: 'Entertainment', type: 'Expense', merchant: 'A streaming service',
      },
    });
    await ok(t, 'save_transaction', {
      transaction: {
        date, amount: 70000, category: 'Salary', type: 'Income', merchant: 'Work',
      },
    });
    // Monthly, the same amount every time, and deliberately not tracked as a subscription,
    // so the panel that reports what it found has something to report.
    await ok(t, 'save_transaction', {
      transaction: {
        date, amount: 1200, category: 'Health', type: 'Expense', merchant: 'A gym',
      },
    });
    await ok(t, 'save_transaction', {
      transaction: {
        date, amount: 5000, category: 'Investment Outflow', type: 'Expense', merchant: 'An index fund',
        is_investment_outflow: true,
      },
    });
  }

  await ok(t, 'save_record', {
    record_type: 'sip',
    record: {
      scheme_name: 'An index fund',
      monthly_amount: 5000,
      debit_day: 5,
      step_up_percent: 10,
      start_date: monthsAgo(24),
      is_active: 1,
    },
  });
  await ok(t, 'save_record', {
    record_type: 'subscription',
    record: {
      name: 'A streaming service', cost: 199, billing_cycle: 'Monthly', next_billing_date: monthsAgo(0),
    },
  });
  await ok(t, 'update_setting', { key: 'monthly_budget', value: '60000' });
}

/** Renders one instance of every widget and returns what came back. */
async function renderAll(app) {
  const layout = availableWidgets(app).map((widget, index) => ({
    id: widget.id,
    uid: `${widget.id}-${index}`,
    options: defaultOptions(widget.id),
  }));

  const data = await loadWidgetData(app, layout);
  return layout.map((entry) => {
    const html = WIDGETS[entry.id].render(data, app, entry.options);
    assert.equal(typeof html, 'string', `${entry.id} did not return markup`);
    return { id: entry.id, html };
  });
}

describe('the dashboard panels', () => {
  it('renders every panel on an empty install without throwing', async () => {
    const rendered = await renderAll(fakeApp());
    // Nothing to show is an empty string, not a card full of zeroes. Net worth and Recent
    // are the two that always draw something, because they explain what to do next.
    const drawn = rendered.filter((entry) => entry.html.length > 0).map((entry) => entry.id);
    assert.deepEqual(drawn.sort(), ['net_worth', 'recent']);
  });

  it('renders every panel against a seeded install', async (t) => {
    await seed(t);
    const rendered = await renderAll(fakeApp());

    for (const entry of rendered) {
      // A panel that has data and still draws nothing is a panel that has gone wrong.
      // Panels that require specialised data the basic seed does not provide are skipped:
      // spend_by_member needs family, accounts_summary needs asset_accounts,
      // investments_summary needs holdings, debt_summary needs credit cards/loans,
      // financial_runway needs asset_accounts/holdings.
      if (['spend_by_member', 'accounts_summary', 'investments_summary', 'debt_summary', 'financial_runway'].includes(entry.id)) continue;
      assert.ok(entry.html.length > 0, `${entry.id} drew nothing`);
      assert.ok(!entry.html.includes('undefined'), `${entry.id} rendered "undefined"`);
      assert.ok(!entry.html.includes('NaN'), `${entry.id} rendered "NaN"`);
    }
  });

  it('renders every option of every panel', async (t) => {
    await seed(t);
    const app = fakeApp();

    for (const widget of availableWidgets(app)) {
      for (const option of widget.options || []) {
        for (const choice of option.choices) {
          const options = { ...defaultOptions(widget.id), [option.key]: choice.value };
          const layout = [{ id: widget.id, uid: 'x', options }];
          const data = await loadWidgetData(app, layout);
          const html = WIDGETS[widget.id].render(data, app, options);
          assert.equal(typeof html, 'string', `${widget.id} with ${option.key}=${choice.value}`);
          assert.ok(!html.includes('undefined'),
            `${widget.id} with ${option.key}=${choice.value} rendered "undefined"`);
        }
      }
    }
  });

  it('asks for one fetch when two panels want the same thing', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = defaultOptions('spend_by_category');
    const layout = [
      { id: 'spend_by_category', uid: 'a', options },
      { id: 'spend_by_category', uid: 'b', options },
    ];
    const data = await loadWidgetData(app, layout);
    assert.equal(Object.keys(data).length, 1);
  });

  it('fetches twice when the same panel is asked two different questions', async (t) => {
    await seed(t);
    const app = fakeApp();
    const layout = [
      { id: 'spend_by_category', uid: 'a', options: { span: 'month:6' } },
      { id: 'spend_by_category', uid: 'b', options: { span: 'day:30' } },
    ];
    const data = await loadWidgetData(app, layout);
    assert.equal(Object.keys(data).length, 2);
  });
});

describe('the saved layout', () => {
  it('reads a layout written as plain names, which is what older builds wrote', () => {
    const app = fakeApp({ home_widgets: JSON.stringify(['net_worth', 'recent']) });
    const layout = readLayout(app);
    assert.deepEqual(layout.map((entry) => entry.id), ['net_worth', 'recent']);
    // Every instance comes back fully specified, so nothing downstream has to guess.
    assert.deepEqual(layout[0].options, defaultOptions('net_worth'));
  });

  it('reads a layout of instances, options and all', () => {
    const app = fakeApp({
      home_widgets: JSON.stringify([
        { id: 'custom_chart', uid: 'c1', options: { metric: 'net_flow', span: 'week:8', style: 'line' } },
      ]),
    });
    const [entry] = readLayout(app);
    assert.equal(entry.uid, 'c1');
    assert.equal(entry.options.metric, 'net_flow');
    assert.equal(entry.options.span, 'week:8');
  });

  it('fills in an option a saved layout does not mention', () => {
    const app = fakeApp({
      home_widgets: JSON.stringify([{ id: 'custom_chart', uid: 'c1', options: { metric: 'net_flow' } }]),
    });
    const [entry] = readLayout(app);
    assert.equal(entry.options.span, 'month:6');
    assert.equal(entry.options.style, 'bars');
  });

  it('drops a panel that no longer exists rather than blanking the screen', () => {
    const app = fakeApp({ home_widgets: JSON.stringify(['net_worth', 'a_panel_we_removed']) });
    assert.deepEqual(readLayout(app).map((entry) => entry.id), ['net_worth']);
  });

  it('falls back to the default layout when the setting is nonsense', () => {
    const app = fakeApp({ home_widgets: '{not json' });
    assert.deepEqual(readLayout(app).map((entry) => entry.id), DEFAULT_LAYOUT);
  });

  it('leaves the household panel out when the family features are off', () => {
    const app = fakeApp({ home_widgets: JSON.stringify(['net_worth', 'spend_by_member']) });
    assert.deepEqual(readLayout(app).map((entry) => entry.id), ['net_worth']);
  });

  it('keeps two instances of the same panel apart', async () => {
    const app = fakeApp();
    const layout = [
      { id: 'custom_chart', uid: 'c1', options: { metric: 'spend_total', span: 'day:30', style: 'bars' } },
      { id: 'custom_chart', uid: 'c2', options: { metric: 'net_flow', span: 'month:12', style: 'line' } },
    ];
    await saveLayout(app, layout);

    const read = readLayout(app);
    assert.equal(read.length, 2);
    assert.equal(read[0].options.metric, 'spend_total');
    assert.equal(read[1].options.metric, 'net_flow');
  });

  it('offers every metric a panel can be pointed at', async (t) => {
    await seed(t);
    const app = fakeApp();
    const metricOption = WIDGETS.custom_chart.options.find((option) => option.key === 'metric');

    for (const choice of metricOption.choices) {
      const options = { ...defaultOptions('custom_chart'), metric: choice.value };
      const data = await loadWidgetData(app, [{ id: 'custom_chart', uid: 'x', options }]);
      const reply = Object.values(data)[0];
      assert.equal(reply.status, 'success', `${choice.value}: ${reply.code || ''}`);
    }
  });

  it('renders month_summary with 3 cards when exclude_investments is on and 2 cards when off', async (t) => {
    await seed(t);
    const appOn = fakeApp({ exclude_investments_from_expenses: '1' });
    const appOff = fakeApp({ exclude_investments_from_expenses: '0' });

    const layout = [{ id: 'month_summary', uid: 'm1', options: { window: 'month' } }];
    const data = await loadWidgetData(appOn, layout);

    const htmlOn = WIDGETS.month_summary.render(data, appOn, { window: 'month' });
    assert.ok(htmlOn.includes('grid-3'), 'should render 3-column grid');
    assert.ok(htmlOn.includes('data-flow="invest"'), 'should have invested card');

    const htmlOff = WIDGETS.month_summary.render(data, appOff, { window: 'month' });
    assert.ok(htmlOff.includes('grid-2'), 'should render 2-column grid');
    assert.ok(!htmlOff.includes('data-flow="invest"'), 'should not have invested card');
  });
});

describe('net_worth breakdown options', () => {
  it('renders the default assets_liabilities breakdown', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = { ...defaultOptions('net_worth'), breakdown: 'assets_liabilities' };
    const layout = [{ id: 'net_worth', uid: 'nw', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.net_worth.render(data, app, options);
    assert.ok(html.includes('balance-split'), 'should use balance-split layout');
    assert.ok(html.includes('Assets'), 'should label assets');
    assert.ok(html.includes('Owed'), 'should label liabilities');
  });

  it('renders the detailed_grid breakdown with 4 boxes', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = { ...defaultOptions('net_worth'), breakdown: 'detailed_grid' };
    const layout = [{ id: 'net_worth', uid: 'nw', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.net_worth.render(data, app, options);
    assert.ok(html.includes('balance-grid-4'), 'should use 4-box grid');
    assert.ok(html.includes('Cash'), 'should show cash');
    assert.ok(html.includes('Invested'), 'should show invested');
    assert.ok(html.includes('Debts'), 'should show debts');
    assert.ok(html.includes('Net this month'), 'should show net this month');
  });

  it('renders compact mode with no breakdown', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = { ...defaultOptions('net_worth'), breakdown: 'compact' };
    const layout = [{ id: 'net_worth', uid: 'nw', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.net_worth.render(data, app, options);
    assert.ok(!html.includes('balance-split'), 'should not have split');
    assert.ok(!html.includes('balance-grid-4'), 'should not have grid');
    assert.ok(html.includes('balance-amount'), 'should still show the headline number');
  });

  it('renders asset_classes breakdown showing top holdings', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = { ...defaultOptions('net_worth'), breakdown: 'asset_classes' };
    const layout = [{ id: 'net_worth', uid: 'nw', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.net_worth.render(data, app, options);
    // On a seeded install with no asset accounts, this may show an empty or minimal split.
    assert.equal(typeof html, 'string');
    assert.ok(!html.includes('undefined'), 'should not include undefined');
  });

  it('shows the monthly delta badge when show_delta is yes', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = { ...defaultOptions('net_worth'), show_delta: 'yes' };
    const layout = [{ id: 'net_worth', uid: 'nw', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.net_worth.render(data, app, options);
    assert.ok(html.includes('balance-delta'), 'should show delta badge');
  });

  it('hides the monthly delta badge when show_delta is no', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = { ...defaultOptions('net_worth'), show_delta: 'no' };
    const layout = [{ id: 'net_worth', uid: 'nw', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.net_worth.render(data, app, options);
    assert.ok(!html.includes('balance-delta'), 'should not show delta badge');
  });
});

describe('month_summary savings rate toggle', () => {
  it('shows savings rate bar when show_savings_rate is yes', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = { ...defaultOptions('month_summary'), show_savings_rate: 'yes' };
    const layout = [{ id: 'month_summary', uid: 'ms', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.month_summary.render(data, app, options);
    assert.ok(html.includes('Savings rate'), 'should mention savings rate');
    assert.ok(html.includes('progress-bar'), 'should have a progress bar');
  });

  it('hides savings rate when show_savings_rate is no', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = { ...defaultOptions('month_summary'), show_savings_rate: 'no' };
    const layout = [{ id: 'month_summary', uid: 'ms', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.month_summary.render(data, app, options);
    assert.ok(!html.includes('Savings rate'), 'should not mention savings rate');
  });
});

describe('monthly_breakdown widget', () => {
  it('renders with income, spending, kept, and savings rate', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = defaultOptions('monthly_breakdown');
    const layout = [{ id: 'monthly_breakdown', uid: 'mb', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.monthly_breakdown.render(data, app, options);
    assert.ok(html.length > 0, 'should draw something');
    assert.ok(html.includes('Income'), 'should mention income');
    assert.ok(html.includes('Spent'), 'should mention spending');
    assert.ok(html.includes('Kept'), 'should mention kept');
    assert.ok(html.includes('Savings rate'), 'should show savings rate');
  });

  it('shows budget progress when a monthly budget is set', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = defaultOptions('monthly_breakdown');
    const layout = [{ id: 'monthly_breakdown', uid: 'mb', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.monthly_breakdown.render(data, app, options);
    assert.ok(html.includes('Budget used'), 'should show budget progress');
  });

  it('returns empty on an empty install', async () => {
    const app = fakeApp();
    const options = defaultOptions('monthly_breakdown');
    const layout = [{ id: 'monthly_breakdown', uid: 'mb', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.monthly_breakdown.render(data, app, options);
    assert.equal(html, '', 'should draw nothing on empty install');
  });
});

describe('accounts_summary widget', () => {
  it('returns empty when there are no assets or liabilities', async () => {
    const app = fakeApp();
    const layout = [{ id: 'accounts_summary', uid: 'as', options: {} }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.accounts_summary.render(data, app, {});
    assert.equal(html, '', 'should draw nothing without data');
  });
});

describe('category_card (Category spotlight) widget', () => {
  it('renders spotlight for Groceries with spending, sparkline, and average', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = { category: 'Groceries', span: 'month:6' };
    const layout = [{ id: 'category_card', uid: 'cat-1', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.category_card.render(data, app, options);

    assert.ok(html.length > 0, 'should draw category spotlight');
    assert.ok(html.includes('Groceries'), 'should have category title');
    assert.ok(html.includes('svg') || html.includes('sparkline'), 'should contain sparkline');
    assert.ok(html.includes('avg over 6 months'), 'should show period average');
  });

  it('renders spotlight for lower-ranked categories like Health and Entertainment', async (t) => {
    await seed(t);
    const app = fakeApp();
    const options = { category: 'Health', span: 'month:4' };
    const layout = [{ id: 'category_card', uid: 'cat-2', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.category_card.render(data, app, options);

    assert.ok(html.length > 0, 'should render category spotlight for Health');
    assert.ok(html.includes('Health'), 'should have Health title');
    assert.ok(html.includes('1,200'), 'should reflect the 1,200 spend amount');
  });

  it('renders clean fallback card for categories with no transactions recorded', async () => {
    const app = fakeApp();
    const options = { category: 'Education', span: 'month:6' };
    const layout = [{ id: 'category_card', uid: 'cat-3', options }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.category_card.render(data, app, options);

    assert.ok(html.length > 0, 'should render empty spotlight card');
    assert.ok(html.includes('Education'), 'should display Education category');
    assert.ok(html.includes('No spending recorded'), 'should explain no spending recorded');
  });

  it('binds click handler to navigate to ledger with category search', async () => {
    const mockApp = {
      ...fakeApp(),
      ledgerFilter: '',
      ledgerSearch: '',
      go(page) { this.page = page; },
    };
    const drillElement = {
      addEventListener(evt, fn) { this.handler = fn; },
      click() { if (this.handler) this.handler(); },
    };
    const node = {
      querySelector(sel) {
        if (sel === '[data-drill]') return drillElement;
        return null;
      },
    };
    const drillBtn = node.querySelector('[data-drill]');
    WIDGETS.category_card.bind(node, {}, mockApp, { category: 'Shopping' });
    drillBtn.click();

    assert.equal(mockApp.ledgerSearch, 'Shopping');
    assert.equal(mockApp.page, 'ledger');
  });
});

describe('financial_runway widget', () => {
  it('renders runway duration and liquid/investment tiers when accounts exist', async (t) => {
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'Savings Bank', category: 'Bank', balance: 150000 },
    });
    await ok(t, 'save_transaction', {
      transaction: { date: '2026-08-01', amount: 3000, category: 'Dining', type: 'Expense', merchant: 'Dinner' },
    });

    const app = fakeApp();
    const layout = [{ id: 'financial_runway', uid: 'runway-1', options: {} }];
    const data = await loadWidgetData(app, layout);
    const html = WIDGETS.financial_runway.render(data, app, {});

    assert.ok(html.length > 0, 'should render financial runway card');
    assert.ok(html.includes('Financial Runway'), 'should contain title');
    assert.ok(html.includes('Liquid Cash Runway'), 'should contain liquid cash runway tier');
  });

  it('returns empty string when no assets exist', async () => {
    const app = fakeApp();
    const html = WIDGETS.financial_runway.render({ custom_runway: { status: 'success', net_runway_funds: 0, selected_assets_total: 0 } }, app, {});
    assert.equal(html, '');
  });
});

describe('safe_to_spend widget', () => {
  it('renders daily, weekly, and monthly cadence options', async (t) => {
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'Main Savings', category: 'Bank', balance: 50000 },
    });
    await ok(t, 'save_record', {
      table: 'sips',
      record: { fund_name: 'Large Cap Index', monthly_amount: 5000, debit_day: 10, is_active: 1 },
    });

    const app = fakeApp();
    const layout = [{ id: 'safe_to_spend', uid: 'safe-1', options: { cadence: 'daily' } }];
    const data = await loadWidgetData(app, layout);

    const runwayHtml = WIDGETS.safe_to_spend.render(data, app, { cadence: 'runway' });
    assert.ok(runwayHtml.includes('Days') || runwayHtml.includes('Weeks') || runwayHtml.includes('Months'));

    const dailyHtml = WIDGETS.safe_to_spend.render(data, app, { cadence: 'daily' });
    assert.ok(dailyHtml.includes('/ day'));
    assert.ok(dailyHtml.includes('Safe-to-Spend Allowance'));
    assert.ok(dailyHtml.includes('Liquid Bank Cash'));
    assert.ok(dailyHtml.includes('SIPs:'));

    const weeklyHtml = WIDGETS.safe_to_spend.render(data, app, { cadence: 'weekly' });
    assert.ok(weeklyHtml.includes('/ week'));

    const monthlyHtml = WIDGETS.safe_to_spend.render(data, app, { cadence: 'monthly' });
    assert.ok(monthlyHtml.includes('safe'));

    const compactHtml = WIDGETS.safe_to_spend.render(data, app, { show_breakdown: 'no' });
    assert.ok(!compactHtml.includes('Liquid Bank Cash'));
  });

  it('renders deficit state with short by amount when commitments exceed liquid cash', async (t) => {
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'Low Balance Bank', category: 'Bank', balance: 2000 },
    });
    await ok(t, 'save_record', {
      table: 'loans',
      record: { name: 'Personal Loan', principal: 100000, current_outstanding: 50000, monthly_emi: 8000, direction: 'borrowed' },
    });

    const app = fakeApp();
    const layout = [{ id: 'safe_to_spend', uid: 'safe-1', options: {} }];
    const data = await loadWidgetData(app, layout);

    const html = WIDGETS.safe_to_spend.render(data, app, {});
    assert.ok(html.includes('Deficit'));
    assert.ok(html.includes('Short by'));
  });
});


