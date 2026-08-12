/*
 * Recurring: the commitments the app worked out for itself.
 *
 * Nobody keeps a list of their subscriptions, and the ones people do keep are out of date,
 * because everything renews dearer and nothing announces it. What a household does have is
 * a year of transactions, and a debit that lands every month from the same shop for about
 * the same amount is a subscription whether or not anybody wrote it down.
 *
 * So this screen has three jobs. Offer what it found, which the user files or dismisses.
 * Report the plans already on file whose recorded price no longer matches what is being
 * debited, which is the price rise nobody noticed. And add up what all of it comes to over
 * the next year with every step-up applied, which is the number that changes behaviour.
 *
 * Nothing here writes on its own. A suggestion is a suggestion until it is tapped.
 */

import { Bridge } from '../bridge.js';
import {
  h, icon, sheet, toast, chooser, emptyState, errorBlock, confirmDialog,
  selectField, bindSelectFields,
} from '../ui.js';
import {
  formatCurrency, formatDate, formatDelta, formatMonthKey, formatPercent, formatRelativeDate,
  todayISO,
} from '../formatters.js';
import { barSeriesChart, legend, sparkline } from '../charts.js';

const SCAN_WINDOWS = [6, 12, 15, 24, 36];

const CADENCE_CYCLES = ['Monthly', 'Quarterly', 'Half-yearly', 'Annual'];

const STEP_MONTHS = [
  { value: '0', label: 'On the anniversary' },
  { value: '4', label: 'Every April' },
  { value: '1', label: 'Every January' },
  { value: '7', label: 'Every July' },
  { value: '10', label: 'Every October' },
];

/** Kept between visits, so a scan window somebody chose is still chosen next time. */
const view = { months: 15 };

const money = (app, value) => formatCurrency(value, app.currency, app.locale);

export async function renderRecurring(container, app) {
  const [found, projection] = await Promise.all([
    Bridge.db('find_recurring', { months: view.months, member_id: app.memberFilter }),
    Bridge.db('project_commitments', { months: 12, member_id: app.memberFilter }),
  ]);

  if (found.status !== 'success') {
    container.innerHTML = errorBlock(found);
    return;
  }

  const candidates = found.candidates || [];
  const tracked = found.tracked || [];
  const dismissed = found.dismissed || [];
  const stale = tracked.filter((entry) => entry.needs_update);

  container.innerHTML = `
    <div class="banner">
      ${icon('autorenew')}
      <span class="banner-main">
        <span class="banner-title">Recurring payments</span>
        <span class="banner-body">
          Detected from recurring transaction patterns.
        </span>
      </span>
    </div>

    ${projection.status === 'success' && projection.series.length ? `
      <div class="card">
        <div class="card-title">
          <span>12-month commitment projection</span>
          <span class="caption">${h(money(app, projection.year_total))}</span>
        </div>
        ${barSeriesChart(
    projection.buckets.map((key) => formatMonthKey(key).slice(0, 3)),
    projection.series,
    { stacked: true, format: (value) => money(app, value), height: 150 },
  )}
        <div style="margin-top:12px">${legend(projection.series)}</div>
        <div class="fact-grid" style="margin-top:14px">
          <div class="fact">
            <span class="fact-label">This month</span>
            <span class="fact-value">${h(money(app, projection.first_month))}</span>
          </div>
          <div class="fact">
            <span class="fact-label">In 12 months</span>
            <span class="fact-value ${projection.last_month > projection.first_month ? 'expense' : ''}">
              ${h(money(app, projection.last_month))}
            </span>
          </div>
        </div>
      </div>` : ''}

    ${stale.length ? `
      <div class="section">
        <div class="section-header">
          <span class="title">Price changes</span>
          <span class="caption">${stale.length}</span>
        </div>
        <div class="list">
          ${stale.map((entry) => `
            <button class="list-row" data-stale="${h(entry.merchant_key)}">
              <span class="avatar avatar-sm" style="background:var(--expense-container);color:var(--expense)">
                ${icon(entry.drift > 0 ? 'trending_up' : 'trending_down')}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">${h(entry.tracked.name)}</span>
                <span class="list-row-sub">
                  Saved at ${h(money(app, entry.recorded_amount))} · Debited ${h(money(app, entry.amount))} (${h(formatDelta(entry.drift, 1))})
                </span>
              </span>
              ${icon('chevron_right', 'icon-sm')}
            </button>`).join('')}
        </div>
      </div>` : ''}

    <div class="section">
      <div class="section-header">
        <span class="title">Detected payments</span>
        <span class="caption">${candidates.length ? `${h(money(app, found.yearly_untracked))}/yr` : ''}</span>
      </div>

      ${candidates.length ? `
        <div class="commitment-list">
          ${candidates.map((entry, index) => candidateCard(app, entry, index)).join('')}
        </div>`
    : `<div class="card">${emptyState('query_stats', 'No repeating payments found',
      'Repeating payments appear here automatically after 3 occurrences.')}</div>`}
    </div>

    ${tracked.length ? `
      <div class="section">
        <div class="section-header">
          <span class="title">Tracked</span>
          <span class="caption">${tracked.length}</span>
        </div>
        <div class="list">
          ${tracked.map((entry) => `
            <div class="list-row">
              <span class="avatar avatar-sm" style="background:var(--accent-container);color:var(--on-accent-container)">
                ${icon(entry.tracked.kind === 'sip' ? 'trending_up' : 'subscriptions')}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">${h(entry.tracked.name)}</span>
                <span class="list-row-sub">
                  ${h(entry.cadence_label)} · ${entry.times} payments
                  ${entry.needs_update ? ' · price changed' : ''}
                </span>
              </span>
              <span class="list-row-amount">${h(money(app, entry.amount))}</span>
            </div>`).join('')}
        </div>
      </div>` : ''}

    ${dismissed.length ? `
      <div class="section">
        <div class="section-header"><span class="title">Dismissed</span></div>
        <div class="list">
          ${dismissed.map((entry) => `
            <button class="list-row" data-restore="${h(entry.merchant_key)}">
              <span class="list-row-main">
                <span class="list-row-title">${h(entry.name)}</span>
                <span class="list-row-sub">${h(entry.cadence_label)} · ${h(money(app, entry.amount))}</span>
              </span>
              <span class="caption">Restore</span>
            </button>`).join('')}
        </div>
      </div>` : ''}

    <div class="card">
      <div data-window></div>
      <p class="caption" style="margin-top:10px">
        Scanned ${found.scanned} entries since ${h(formatDate(found.from))}.
      </p>
    </div>`;

  /* ------------------------------------------------------------- wiring */

  container.querySelector('[data-window]').innerHTML = selectField({
    key: 'months',
    label: 'How far back to look',
    id: 'scanWindow',
    value: String(view.months),
    options: SCAN_WINDOWS.map((count) => ({ value: String(count), label: `${count} months` })),
  });
  bindSelectFields(container.querySelector('[data-window]'));
  container.querySelector('#scanWindow').addEventListener('change', (event) => {
    view.months = Number(event.target.value) || 15;
    app.refresh();
  });

  container.querySelectorAll('[data-track]').forEach((button) => {
    button.addEventListener('click', async () => {
      const entry = candidates[Number(button.dataset.track)];
      if (entry) await openTrackSheet(app, entry);
    });
  });

  container.querySelectorAll('[data-dismiss]').forEach((button) => {
    button.addEventListener('click', async () => {
      const entry = candidates[Number(button.dataset.dismiss)];
      if (!entry) return;
      const res = await app.db('dismiss_recurring', {
        merchant_key: entry.merchant_key, kind: entry.kind,
      });
      if (res) {
        toast(`${entry.name} set aside.`, 'success');
        app.refresh();
      }
    });
  });

  container.querySelectorAll('[data-restore]').forEach((button) => {
    button.addEventListener('click', async () => {
      const res = await app.db('dismiss_recurring', {
        merchant_key: button.dataset.restore, restore: true,
      });
      if (res) app.refresh();
    });
  });

  container.querySelectorAll('[data-stale]').forEach((row) => {
    row.addEventListener('click', async () => {
      const entry = tracked.find((item) => item.merchant_key === row.dataset.stale);
      if (entry) await openPriceSheet(app, entry);
    });
  });
}

/**
 * One candidate.
 *
 * A card rather than a list row because there are four facts worth stating and two things
 * to do with it, and squeezing that into a row would mean abbreviating the one thing the
 * user has to judge: whether this really is the plan they think it is.
 */
function candidateCard(app, entry, index) {
  const rise = entry.changes.length
    ? entry.changes[entry.changes.length - 1]
    : null;

  return `
    <div class="commitment-card">
      <div class="row-between">
        <span class="row" style="gap:10px;min-width:0">
          <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface-variant)">
            ${icon(entry.kind === 'sip' ? 'trending_up' : 'subscriptions')}
          </span>
          <span class="list-row-main">
            <span class="list-row-title">${h(entry.name)}</span>
            <span class="list-row-sub">
              ${h(entry.cadence_label)} · ${entry.times} times · ${h(entry.category || 'no category')}
            </span>
          </span>
        </span>
        <span class="list-row-amount">${h(money(app, entry.amount))}</span>
      </div>

      <div class="commitment-facts">
        <span class="caption">${h(money(app, entry.yearly))} a year</span>
        <span class="caption">next ${h(formatRelativeDate(entry.next_due))}</span>
        <span class="caption">${entry.regularity}% regular</span>
        ${entry.levels.length > 1 ? sparkline(entry.levels.map((level) => level.amount)) : ''}
      </div>

      ${rise ? `
        <div class="badge ${rise.to > rise.from ? 'badge-warning' : 'badge-income'}">
          ${rise.to > rise.from ? 'Rose' : 'Fell'} from ${h(money(app, rise.from))}
          to ${h(money(app, rise.to))} in ${h(formatDate(rise.date))}
          ${entry.annual_change_percent ? ` · ${h(formatDelta(entry.annual_change_percent, 1))} a year` : ''}
        </div>` : ''}

      <div class="row" style="gap:8px;margin-top:12px">
        <button class="btn btn-filled" data-track="${index}" style="flex:1">
          ${icon('add')}Track
        </button>
        <button class="btn btn-text" data-dismiss="${index}">Not a plan</button>
      </div>
    </div>`;
}

/**
 * Filing a candidate, with everything already filled in.
 *
 * The kind is offered rather than assumed: an investment mandate and a subscription are the
 * same debit as far as a bank alert is concerned, and only the person paying it knows which
 * it is. The step-up is offered here too, because the moment somebody is looking at a plan
 * that has already risen twice is the moment they know what it does.
 */
async function openTrackSheet(app, entry) {
  const isSip = entry.kind === 'sip';
  const suggestedStep = Math.round(entry.annual_change_percent * 10) / 10;

  const body = `
    <div class="card-flat">
      <div class="row-between">
        <span class="caption">Being debited</span>
        <span class="title">${h(money(app, entry.amount))}</span>
      </div>
      <div class="row-between" style="margin-top:6px">
        <span class="caption">Read from</span>
        <span class="caption">${entry.times} payments since ${h(formatDate(entry.first_seen))}</span>
      </div>
      ${entry.changes.length ? `
        <div class="caption" style="margin-top:10px">
          ${entry.changes.map((change) => `
            ${h(formatDate(change.date))}: ${h(money(app, change.from))} to ${h(money(app, change.to))}
            (${h(formatDelta(change.percent, 1))})`).join('<br>')}
        </div>` : ''}
    </div>

    <div class="field">
      <span class="field-label">Track it as</span>
      <div class="segmented" data-kinds>
        <button type="button" data-kind="subscription" aria-selected="${!isSip}">Subscription</button>
        <button type="button" data-kind="sip" aria-selected="${isSip}">Investment SIP</button>
      </div>
    </div>

    <div class="field">
      <label class="field-label" for="recName">Name</label>
      <input class="input" id="recName" data-name type="text" value="${h(entry.name)}">
    </div>

    <div class="row" style="gap:12px;align-items:flex-end">
      <div class="field" style="flex:1">
        <label class="field-label" for="recAmount">Amount</label>
        <input class="input numeric" id="recAmount" data-amount type="number" inputmode="decimal"
               step="any" value="${entry.amount}">
      </div>
      <div data-cycle style="flex:1"></div>
    </div>

    <div class="row" style="gap:12px;align-items:flex-end">
      <div class="field" style="flex:1">
        <label class="field-label" for="recStep">Yearly change %</label>
        <input class="input numeric" id="recStep" data-step type="number" inputmode="decimal"
               step="0.1" value="${suggestedStep || ''}" placeholder="0">
      </div>
      <div data-step-month style="flex:1"></div>
    </div>

    <p class="caption">
      A positive figure steps the amount up every year, a negative one steps it down. It is
      what the projections use, so a plan that rises is not counted as a plan that does not.
      ${suggestedStep ? `Your history works out at ${h(formatPercent(suggestedStep, 1))} a year.` : ''}
    </p>`;

  const saved = await sheet('Track this payment', body, {
    autofocus: false,
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>Track it</button>`,
    onMount(node, close) {
      let kind = entry.kind;

      const paintKindFields = () => {
        node.querySelector('[data-cycle]').innerHTML = kind === 'sip'
          ? selectField({
            key: 'day',
            label: 'Debits on',
            id: 'recDay',
            value: String(entry.day_of_month),
            options: Array.from({ length: 28 }, (_, i) => String(i + 1)),
          })
          : selectField({
            key: 'cycle',
            label: 'Billed',
            id: 'recCycle',
            value: CADENCE_CYCLES.includes(entry.billing_cycle) ? entry.billing_cycle : 'Monthly',
            options: CADENCE_CYCLES,
          });

        node.querySelector('[data-step-month]').innerHTML = kind === 'sip'
          ? selectField({
            key: 'step_month',
            label: 'Applied',
            id: 'recStepMonth',
            value: '0',
            options: STEP_MONTHS,
          })
          : '';

        bindSelectFields(node);
      };

      paintKindFields();

      node.querySelectorAll('[data-kind]').forEach((button) => {
        button.addEventListener('click', () => {
          kind = button.dataset.kind;
          node.querySelectorAll('[data-kind]').forEach((other) => {
            other.setAttribute('aria-selected', String(other.dataset.kind === kind));
          });
          paintKindFields();
        });
      });

      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));

      node.querySelector('[data-save]').addEventListener('click', async () => {
        const name = node.querySelector('[data-name]').value.trim();
        const amount = Number(node.querySelector('[data-amount]').value);
        if (!name) {
          toast('Give it a name.', 'error');
          return;
        }
        if (!(amount > 0)) {
          toast('An amount above zero is needed.', 'error');
          return;
        }

        const step = Number(node.querySelector('[data-step]').value) || 0;
        const payload = {
          kind,
          merchant_key: entry.merchant_key,
          name,
          amount,
          category: entry.category,
          member_id: entry.member_id ?? app.memberFilter,
          first_seen: entry.first_seen,
          last_seen: entry.last_seen,
          next_due: entry.next_due,
          changes: entry.changes,
        };

        if (kind === 'sip') {
          payload.day_of_month = Number(node.querySelector('#recDay').value) || entry.day_of_month;
          payload.step_up_percent = step;
          payload.step_up_month = Number(node.querySelector('#recStepMonth').value) || 0;
          payload.start_date = entry.first_seen;
        } else {
          payload.billing_cycle = node.querySelector('#recCycle').value;
          payload.annual_change_percent = step;
          payload.price_since = entry.levels[entry.levels.length - 1].from;
        }

        const res = await app.db('track_recurring', payload);
        if (res) {
          toast(kind === 'sip' ? 'SIP tracked.' : 'Subscription tracked.', 'success');
          close(true);
        }
      });
    },
  });

  if (saved) app.refresh();
}

/**
 * Bringing a recorded price into line with what is actually being debited.
 *
 * The old figure is not thrown away: it becomes a row in the price history, which is what
 * lets the app tell somebody in two years what this plan cost when they took it out. The
 * yearly rate the history implies is offered at the same time, because a plan that has
 * risen twice will rise again and a projection that assumes otherwise is wrong.
 */
async function openPriceSheet(app, entry) {
  const history = await Bridge.db('get_price_history', {
    kind: entry.tracked.kind, record_id: entry.tracked.id,
  });
  const changes = history.status === 'success' ? history.changes : [];

  const body = `
    <div class="card-flat">
      <div class="row-between">
        <span class="caption">On file</span>
        <span class="title">${h(money(app, entry.recorded_amount))}</span>
      </div>
      <div class="row-between" style="margin-top:6px">
        <span class="caption">Actually debited</span>
        <span class="title ${entry.drift > 0 ? 'expense' : 'income'}">${h(money(app, entry.amount))}</span>
      </div>
      <div class="caption" style="margin-top:10px">
        Read from ${entry.times} payments, the most recent on ${h(formatDate(entry.last_seen))}.
      </div>
    </div>

    ${changes.length ? `
      <div class="section-header"><span class="title">What it has cost</span></div>
      <div class="list">
        ${changes.map((change) => `
          <div class="list-row">
            <span class="list-row-main">
              <span class="list-row-title">
                ${h(money(app, change.from_amount))} to ${h(money(app, change.to_amount))}
              </span>
              <span class="list-row-sub">${h(formatDate(change.date))} · ${h(change.source)}</span>
            </span>
            <span class="list-row-amount ${change.to_amount > change.from_amount ? 'expense' : 'income'}">
              ${h(formatDelta(change.from_amount > 0
    ? ((change.to_amount - change.from_amount) / change.from_amount) * 100
    : 0, 1))}
            </span>
          </div>`).join('')}
      </div>` : ''}

    <div class="field" style="margin-top:14px">
      <label class="field-label" for="newPrice">New amount</label>
      <input class="input numeric" id="newPrice" data-price type="number" inputmode="decimal"
             step="any" value="${entry.amount}">
    </div>

    <div class="field">
      <label class="field-label" for="priceDate">In effect from</label>
      <input class="input" id="priceDate" data-date type="date"
             value="${h(entry.levels[entry.levels.length - 1].from || todayISO())}">
    </div>

    ${entry.annual_change_percent ? `
      <label class="switch-row">
        <span class="list-row-main">
          <span class="list-row-title">Expect ${h(formatPercent(entry.annual_change_percent, 1))} a year</span>
          <span class="list-row-sub">
            What the history implies. Used by the projections rather than assuming it stays flat.
          </span>
        </span>
        <input type="checkbox" class="switch" data-expect checked>
      </label>` : ''}`;

  const saved = await sheet(entry.tracked.name, body, {
    autofocus: false,
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>Update the price</button>`,
    onMount(node, close) {
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      node.querySelector('[data-save]').addEventListener('click', async () => {
        const amount = Number(node.querySelector('[data-price]').value);
        if (!(amount > 0)) {
          toast('An amount above zero is needed.', 'error');
          return;
        }

        const res = await app.db('apply_price_change', {
          kind: entry.tracked.kind,
          record_id: entry.tracked.id,
          amount,
          date: node.querySelector('[data-date]').value || todayISO(),
          source: 'detected',
          note: 'Matched to the transactions already recorded.',
        });
        if (!res) return;

        const expect = node.querySelector('[data-expect]');
        if (expect && expect.checked) {
          // The rate goes on the record so every projection from here on carries it.
          const field = entry.tracked.kind === 'sip' ? 'step_up_percent' : 'annual_change_percent';
          await app.db('save_record', {
            record_type: entry.tracked.kind,
            record: { id: entry.tracked.id, [field]: entry.annual_change_percent },
          });
        }

        toast('Price updated.', 'success');
        close(true);
      });
    },
  });

  if (saved) app.refresh();
}

/**
 * Offered from the SIP and subscription screens: change the amount, keeping the history.
 *
 * Exported because the same operation belongs on the record itself, not only here. A plan
 * whose price changed is usually noticed while looking at the plan.
 */
export async function openManualPriceChange(app, kind, record) {
  const current = Number(kind === 'sip' ? record.monthly_amount : record.cost) || 0;
  const label = kind === 'sip' ? record.scheme_name : record.name;

  const history = await Bridge.db('get_price_history', { kind, record_id: record.id });
  const changes = history.status === 'success' ? history.changes : [];

  const body = `
    <div class="card-flat">
      <div class="row-between">
        <span class="caption">Now</span>
        <span class="title">${h(money(app, current))}</span>
      </div>
      ${changes.length ? `
        <div class="caption" style="margin-top:10px">
          ${changes.length} recorded ${changes.length === 1 ? 'change' : 'changes'}, the first from
          ${h(money(app, changes[0].from_amount))}.
        </div>` : ''}
    </div>

    <div class="field">
      <label class="field-label" for="manualPrice">New amount</label>
      <input class="input numeric" id="manualPrice" data-price type="number" inputmode="decimal"
             step="any" value="${current}">
    </div>

    <div class="field">
      <label class="field-label" for="manualDate">In effect from</label>
      <input class="input" id="manualDate" data-date type="date" value="${h(todayISO())}">
    </div>

    <div class="field">
      <label class="field-label" for="manualNote">Note</label>
      <input class="input" id="manualNote" data-note type="text"
             placeholder="${kind === 'sip' ? 'Stepped up' : 'Price rise'}">
    </div>`;

  const saved = await sheet(`Change what ${label} costs`, body, {
    autofocus: false,
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>Save</button>`,
    onMount(node, close) {
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      node.querySelector('[data-save]').addEventListener('click', async () => {
        const amount = Number(node.querySelector('[data-price]').value);
        if (!(amount > 0)) {
          toast('An amount above zero is needed.', 'error');
          return;
        }
        const res = await app.db('apply_price_change', {
          kind,
          record_id: record.id,
          amount,
          date: node.querySelector('[data-date]').value || todayISO(),
          note: node.querySelector('[data-note]').value.trim(),
        });
        if (res) {
          toast(res.unchanged ? 'That is what it already costs.' : 'Saved.', 'success');
          close(true);
        }
      });
    },
  });

  return Boolean(saved);
}

/**
 * The price history of one commitment, for the record's own screen.
 *
 * Exported so the SIP and subscription pages can offer it without importing the whole of
 * this screen's logic.
 */
export async function openPriceHistory(app, kind, record) {
  const label = kind === 'sip' ? record.scheme_name : record.name;
  const res = await Bridge.db('get_price_history', { kind, record_id: record.id });
  const changes = res.status === 'success' ? res.changes : [];

  if (!changes.length) {
    const change = await confirmDialog('No price changes recorded',
      `Nothing has been recorded about what ${label} used to cost. Record one now?`,
      { confirmLabel: 'Record a change' });
    if (change) return openManualPriceChange(app, kind, record);
    return false;
  }

  await sheet(`What ${label} has cost`, `
    <div class="card-flat">
      ${sparkline([changes[0].from_amount, ...changes.map((row) => row.to_amount)],
    { width: 240, height: 44 })}
      <div class="row-between" style="margin-top:10px">
        <span class="caption">${h(money(app, changes[0].from_amount))} at the start</span>
        <span class="caption">${h(money(app, changes[changes.length - 1].to_amount))} now</span>
      </div>
    </div>

    <div class="list">
      ${changes.map((row) => `
        <div class="list-row">
          <span class="list-row-main">
            <span class="list-row-title">
              ${h(money(app, row.from_amount))} to ${h(money(app, row.to_amount))}
            </span>
            <span class="list-row-sub">
              ${h(formatDate(row.date))}${row.note ? ` · ${h(row.note)}` : ''}
            </span>
          </span>
          <span class="list-row-amount ${row.to_amount > row.from_amount ? 'expense' : 'income'}">
            ${h(formatDelta(row.from_amount > 0
    ? ((row.to_amount - row.from_amount) / row.from_amount) * 100 : 0, 1))}
          </span>
        </div>`).join('')}
    </div>`, { autofocus: false });

  return false;
}

/**
 * What tapping a SIP or a subscription offers.
 *
 * Editing used to be the only thing a row did, and it is still what most taps want. The
 * other two are here because a price change is not an edit: it is a new fact about the same
 * plan, and overwriting the amount in the edit sheet would lose the old one.
 *
 * Returns 'edit' when the caller should open its own edit sheet, 'saved' when something was
 * written, and an empty string when nothing happened.
 */
export async function openCommitmentMenu(app, kind, record) {
  const chosen = await chooser(kind === 'sip' ? record.scheme_name : record.name, [
    { value: 'price', label: kind === 'sip' ? 'Change the instalment' : 'Change what it costs', icon: 'price_check' },
    { value: 'history', label: 'What it has cost', icon: 'history' },
    { value: 'edit', label: 'Edit everything', icon: 'edit' },
  ]);

  if (chosen === 'price') {
    return (await openManualPriceChange(app, kind, record)) ? 'saved' : '';
  }
  if (chosen === 'history') {
    return (await openPriceHistory(app, kind, record)) ? 'saved' : '';
  }
  return chosen === 'edit' ? 'edit' : '';
}
