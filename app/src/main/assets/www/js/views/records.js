/*
 * One page implementation for every simple record list: accounts, SIPs, loans, cards,
 * subscriptions and goals.
 *
 * Each type declares its fields and how a row reads. The list, the empty state, the
 * add and edit sheet, validation and deletion are shared. Adding a new kind of record
 * means adding a config entry, not another screen.
 */

import { Bridge } from '../bridge.js';
import {
  icon, h, sheet, toast, confirmDialog, emptyState, errorBlock, selectField, bindSelectFields,
} from '../ui.js';
import {
  formatCurrency, formatDate, formatDelta, formatMonthKey, formatRelativeDate, todayISO,
} from '../formatters.js';
import { barSeriesChart } from '../charts.js';
import { openCommitmentMenu } from './recurring.js';

const ACCOUNT_CATEGORIES = ['Cash', 'Bank', 'FD', 'RD', 'Stock', 'MF', 'NPS', 'EPF', 'PPF', 'Gold', 'Property', 'Other'];
const LOAN_TYPES = ['Home', 'Car', 'Personal', 'Education', 'Gold', 'Business', 'Other'];
const BILLING_CYCLES = ['Monthly', 'Quarterly', 'Half-yearly', 'Annual'];

/**
 * When a yearly step-up lands.
 *
 * The anniversary of the start is the default because that is what a mandate set up through
 * a fund house does. A calendar month is offered because an increase timed to a pay rise is
 * the other common arrangement, and April is when most of them happen here.
 */
const STEP_UP_MONTHS = [
  { value: '0', label: 'On the anniversary' },
  { value: '1', label: 'Every January' },
  { value: '4', label: 'Every April' },
  { value: '7', label: 'Every July' },
  { value: '10', label: 'Every October' },
];

/** The record types that cost money on a schedule, and so can be stepped up. */
const COMMITMENT_KINDS = { sip: 'sip', subscription: 'subscription' };

/**
 * A loan is the same arithmetic whichever way the money went. What changes is which side
 * of the balance it lands on, and whether the instalment is one you pay or one you are
 * paid.
 */
const LOAN_DIRECTIONS = [
  { value: 'borrowed', label: 'I borrowed', sub: 'Money you owe' },
  { value: 'lent', label: 'I lent', sub: 'Money owed to you' },
];

const isLent = (loan) => loan.direction === 'lent';

const DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => String(i + 1));

export const RECORD_CONFIG = {
  account: {
    heading: 'Accounts',
    addLabel: 'Add account',
    empty: ['account_balance', 'No accounts yet',
      'Add bank balances, deposits and manual holdings.'],
    totalLabel: 'Total value',
    total: (rows) => rows.reduce((s, r) => s + Number(r.balance || 0), 0),
    /*
     * What is asked for depends on the kind.
     *
     * A fixed deposit has a rate and a maturity date; a cash box has neither, and being
     * asked for them suggests the app has not understood what it is being told about.
     * A field with no `showFor` is asked of everything.
     */
    fields: [
      { key: 'category', label: 'Kind', type: 'select', options: ACCOUNT_CATEGORIES, half: true },
      { key: 'name', label: 'Name', type: 'text', required: true, half: true, placeholder: 'HDFC savings' },
      { key: 'balance', label: 'Balance', type: 'number', required: true },
      {
        key: 'institution',
        label: 'Institution',
        type: 'text',
        placeholder: 'HDFC Bank',
        showFor: ['Bank', 'FD', 'RD', 'Stock', 'MF', 'NPS', 'EPF', 'PPF', 'Other'],
      },
      {
        key: 'account_number',
        label: 'Account or folio number',
        type: 'text',
        placeholder: 'Optional',
        showFor: ['Bank', 'FD', 'RD', 'Stock', 'MF', 'NPS', 'EPF', 'PPF'],
      },
      {
        key: 'interest_rate',
        label: 'Interest rate %',
        type: 'number',
        half: true,
        showFor: ['FD', 'RD', 'PPF', 'EPF', 'NPS', 'Bank'],
      },
      {
        key: 'maturity_date',
        label: 'Matures on',
        type: 'date',
        half: true,
        showFor: ['FD', 'RD', 'PPF'],
      },
      { key: 'notes', label: 'Note', type: 'textarea' },
    ],
    row: (r) => ({
      glyph: 'account_balance',
      title: r.name,
      sub: [r.category, r.institution].filter(Boolean).join(' · '),
      amount: r.balance,
    }),
  },

  sip: {
    heading: 'SIPs',
    addLabel: 'Add SIP',
    empty: ['trending_up', 'No SIPs tracked',
      'Add recurring investments to track monthly outflows.'],
    totalLabel: 'Every month',
    total: (rows) => rows.filter((r) => r.is_active !== 0)
      .reduce((s, r) => s + Number(r.monthly_amount || 0), 0),
    fields: [
      { key: 'scheme_name', label: 'Scheme', type: 'text', required: true, placeholder: 'Nifty 50 Index Fund' },
      { key: 'monthly_amount', label: 'Amount', type: 'number', required: true, half: true },
      { key: 'debit_day', label: 'Debits on', type: 'select', options: DAY_OPTIONS, half: true, default: '5' },
      {
        key: 'step_up_percent',
        label: 'Yearly step-up %',
        type: 'number',
        half: true,
        hint: 'A negative figure steps the instalment down instead.',
      },
      { key: 'step_up_month', label: 'Step-up applies', type: 'select', options: STEP_UP_MONTHS, half: true, default: '0' },
      { key: 'start_date', label: 'Started', type: 'date', half: true, default: todayISO },
      { key: 'is_active', label: 'Active', type: 'switch', half: true, default: 1 },
    ],
    row: (r) => ({
      glyph: 'trending_up',
      title: r.scheme_name,
      sub: [
        `Day ${r.debit_day} of each month`,
        Number(r.step_up_percent) ? `${Number(r.step_up_percent) > 0 ? 'step-up' : 'step-down'} ${Math.abs(Number(r.step_up_percent))}%` : '',
        r.is_active === 0 ? 'paused' : '',
      ].filter(Boolean).join(' · '),
      amount: r.monthly_amount,
      dim: r.is_active === 0,
    }),
    afterList: (host, app, records) => renderCommitmentOutlook(host, app, records, 'sip'),
  },

  loan: {
    heading: 'Loans',
    addLabel: 'Add loan',
    empty: ['account_balance', 'No loans tracked',
      'Add borrowed or lent amounts to track liabilities.'],
    // Two totals, because one net figure would hide the thing worth knowing: whether
    // what you owe and what you are owed are the same size or nothing like it.
    totals: (rows) => [
      {
        label: 'You owe',
        value: rows.filter((r) => !isLent(r))
          .reduce((sum, r) => sum + Number(r.current_outstanding || 0), 0),
        negative: true,
      },
      {
        label: 'Owed to you',
        value: rows.filter(isLent)
          .reduce((sum, r) => sum + Number(r.current_outstanding || 0), 0),
      },
    ].filter((total) => total.value > 0),
    negative: true,
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Home loan' },
      { key: 'direction', label: 'Direction', type: 'select', options: LOAN_DIRECTIONS, half: true, default: 'borrowed' },
      { key: 'loan_type', label: 'Kind', type: 'select', options: LOAN_TYPES, half: true },
      { key: 'principal_amount', label: 'Principal', type: 'number', required: true, half: true },
      { key: 'current_outstanding', label: 'Outstanding', type: 'number', required: true, half: true },
      { key: 'interest_rate', label: 'Rate %', type: 'number', required: true, half: true, default: 8.5 },
      { key: 'monthly_emi', label: 'Instalment', type: 'number', required: true, half: true },
      { key: 'tenure_months', label: 'Tenure in months', type: 'number', required: true, half: true, default: 240 },
      { key: 'start_date', label: 'Started', type: 'date', default: todayISO },
      { key: 'notes', label: 'Note', type: 'textarea' },
    ],
    row: (r) => {
      const bal = Number(r.current_outstanding) || 0;
      const emi = Number(r.monthly_emi) || 0;
      const rate = Number(r.interest_rate) || 0;
      let emiLeftStr = '';
      if (bal > 0 && emi > 0) {
        let emisLeft = 0;
        if (rate <= 0) {
          emisLeft = Math.ceil(bal / emi);
        } else {
          const monthlyRate = rate / 12 / 100;
          const monthlyInt = bal * monthlyRate;
          if (emi > monthlyInt) {
            const n = -Math.log(1 - (monthlyInt / emi)) / Math.log(1 + monthlyRate);
            emisLeft = Math.max(1, Math.ceil(n));
          } else {
            emisLeft = Number(r.tenure_months) || 0;
          }
        }
        if (emisLeft > 0) {
          const yrs = Math.floor(emisLeft / 12);
          const mos = emisLeft % 12;
          const timeStr = yrs > 0 ? (mos > 0 ? `${yrs}y ${mos}m` : `${yrs} yrs`) : `${mos} mos`;
          emiLeftStr = `${emisLeft} EMIs left (${timeStr})`;
        }
      }

      return {
        glyph: isLent(r) ? 'volunteer_activism' : 'account_balance',
        title: r.name,
        sub: [
          isLent(r) ? 'Lent' : 'Borrowed',
          r.loan_type,
          `${r.interest_rate}%`,
          `${Math.round(r.monthly_emi)}/mo`,
          emiLeftStr,
        ].filter(Boolean).join(' · '),
        amount: r.current_outstanding,
        positive: isLent(r),
      };
    },
    afterList: renderPrepaymentCalculator,
  },

  card: {
    heading: 'Credit cards',
    addLabel: 'Add card',
    empty: ['credit_card', 'No cards tracked',
      'Add credit cards to track limits and utilisation.'],
    totalLabel: 'Total owed',
    total: (rows) => rows.reduce((s, r) => s + Number(r.current_balance || 0), 0),
    negative: true,
    fields: [
      { key: 'card_name', label: 'Card', type: 'text', required: true, placeholder: 'Regalia Gold' },
      { key: 'bank', label: 'Bank', type: 'text', required: true, half: true, placeholder: 'HDFC' },
      { key: 'last_4', label: 'Last 4 digits', type: 'text', half: true, maxlength: 4 },
      { key: 'total_limit', label: 'Limit', type: 'number', required: true, half: true },
      { key: 'current_balance', label: 'Current balance', type: 'number', half: true },
      { key: 'due_date', label: 'Statement due on', type: 'select', options: DAY_OPTIONS, default: '15' },
    ],
    row: (r) => {
      const used = Number(r.total_limit) ? (Number(r.current_balance) / Number(r.total_limit)) * 100 : 0;
      return {
        glyph: 'credit_card',
        title: r.card_name,
        sub: `${r.bank}${r.last_4 ? ` ···· ${r.last_4}` : ''} · ${used.toFixed(0)}% used`,
        amount: r.current_balance,
        progress: { value: used, warn: used > 30 },
      };
    },
  },

  subscription: {
    heading: 'Subscriptions',
    addLabel: 'Add subscription',
    empty: ['subscriptions', 'No subscriptions tracked',
      'Add repeating subscriptions and bills.'],
    totalLabel: 'Per month',
    total: (rows) => rows.reduce((s, r) => s + monthlyEquivalent(r), 0),
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Streaming plan' },
      { key: 'cost', label: 'Cost', type: 'number', required: true, half: true },
      { key: 'billing_cycle', label: 'Billed', type: 'select', options: BILLING_CYCLES, half: true },
      { key: 'next_billing_date', label: 'Next bill', type: 'date', required: true, default: todayISO },
      { key: 'category', label: 'Category', type: 'text', half: true, placeholder: 'Entertainment' },
      { key: 'auto_debit', label: 'Auto debit', type: 'switch', half: true, default: 1 },
      {
        key: 'annual_change_percent',
        label: 'Yearly price change %',
        type: 'number',
        half: true,
        hint: 'What this plan does every year. Used by the projections.',
      },
      { key: 'price_since', label: 'Price since', type: 'date', half: true, default: todayISO },
    ],
    row: (r) => ({
      glyph: 'subscriptions',
      title: r.name,
      sub: [
        r.billing_cycle,
        `next ${formatRelativeDate(r.next_billing_date)}`,
        Number(r.annual_change_percent) ? `${formatDelta(r.annual_change_percent, 1)} a year` : '',
      ].filter(Boolean).join(' · '),
      amount: r.cost,
    }),
    afterList: (host, app, records) => renderCommitmentOutlook(host, app, records, 'subscription'),
  },

  goal: {
    heading: 'Goals',
    addLabel: 'Add goal',
    empty: ['flag', 'No goals yet',
      'Add goals to track your savings progress.'],
    totalLabel: 'Saved towards goals',
    total: (rows) => rows.reduce((s, r) => s + Number(r.current_amount || 0), 0),
    fields: [
      { key: 'title', label: 'Goal', type: 'text', required: true, placeholder: 'House deposit' },
      { key: 'target_amount', label: 'Target', type: 'number', required: true, half: true },
      { key: 'current_amount', label: 'Saved so far', type: 'number', half: true },
      { key: 'target_date', label: 'Target date', type: 'date', required: true, default: todayISO },
      { key: 'category', label: 'Category', type: 'text', placeholder: 'General' },
      { key: 'notes', label: 'Note', type: 'textarea' },
    ],
    row: (r) => {
      const progress = Number(r.target_amount) ? (Number(r.current_amount) / Number(r.target_amount)) * 100 : 0;
      return {
        glyph: 'flag',
        title: r.title,
        sub: `${progress.toFixed(0)}% · by ${formatDate(r.target_date)}`,
        amount: r.target_amount,
        progress: { value: progress },
      };
    },
  },
};

function monthlyEquivalent(subscription) {
  const cost = Number(subscription.cost || 0);
  switch (subscription.billing_cycle) {
    case 'Annual': return cost / 12;
    case 'Half-yearly': return cost / 6;
    case 'Quarterly': return cost / 3;
    default: return cost;
  }
}

/* ------------------------------------------------------------------- page */

export async function renderRecordPage(container, app, type) {
  const config = RECORD_CONFIG[type];
  const res = await Bridge.db('list_records', { record_type: type, member_id: app.memberFilter });
  const records = res.records || [];
  const money = (v) => formatCurrency(v, app.currency, app.locale);

  // A record type states either one headline figure or several; loans have two, because
  // what you owe and what you are owed are different questions.
  const totals = config.totals
    ? config.totals(records)
    : (config.total ? [{ label: config.totalLabel, value: config.total(records) }] : []);

  container.innerHTML = `
    ${records.length && totals.length === 1 ? `
      <div class="card-accent">
        <span class="overline" style="color:inherit;opacity:0.7">${h(totals[0].label)}</span>
        <div class="balance-amount" style="font-size:30px">${h(money(totals[0].value))}</div>
      </div>` : ''}

    ${records.length && totals.length > 1 ? `
      <div class="grid-2">
        ${totals.map((entry) => `
          <div class="stat">
            <span class="caption">${h(entry.label)}</span>
            <span class="stat-value ${entry.negative ? 'expense' : 'income'}">${h(money(entry.value))}</span>
          </div>`).join('')}
      </div>` : ''}

    ${config.note && records.length ? `
      <div class="banner">${icon('info')}<span class="banner-main"><span class="banner-body">${h(config.note)}</span></span></div>` : ''}

    ${records.length ? `
      <div class="list">
        ${records.map((record) => {
          const row = config.row(record);
          return `
            <button class="list-row" data-record="${record.id}" ${row.dim ? 'style="opacity:0.55"' : ''}>
              <span class="avatar avatar-sm" style="background:var(--accent-container);color:var(--on-accent-container)">
                ${icon(row.glyph)}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">${h(row.title)}</span>
                <span class="list-row-sub">${h(row.sub)}</span>
                ${row.progress ? `
                  <span class="bar-track" style="margin-top:6px">
                    <span class="bar-fill" style="display:block;width:${Math.min(100, row.progress.value)}%;
                      background:${row.progress.warn ? 'var(--expense)' : 'var(--accent)'}"></span>
                  </span>` : ''}
              </span>
              <span class="list-row-amount ${row.positive ? 'income' : (config.negative ? 'expense' : '')}">${h(money(row.amount))}</span>
            </button>`;
        }).join('')}
      </div>`
    : `<div class="card">${emptyState(...config.empty)}</div>`}

    <button class="btn btn-tonal btn-block" data-add>${icon('add')}${h(config.addLabel)}</button>

    <div data-after></div>`;

  container.querySelector('[data-add]').addEventListener('click', () => openRecordSheet(app, type, null));

  container.querySelectorAll('[data-record]').forEach((row) => {
    row.addEventListener('click', async () => {
      const record = records.find((r) => String(r.id) === row.dataset.record);
      if (!record) return;

      /*
       * A commitment is asked what the tap meant.
       *
       * Editing the amount in place would overwrite what it used to cost, and what it used
       * to cost is the whole basis of a projection that knows this plan rises. So a price
       * change is a separate operation with its own history, and the edit sheet is still
       * one tap away for everything else.
       */
      if (COMMITMENT_KINDS[type]) {
        const outcome = await openCommitmentMenu(app, type, record);
        if (outcome === 'saved') {
          app.refresh();
          return;
        }
        if (outcome !== 'edit') return;
      }

      openRecordSheet(app, type, record);
    });
  });

  if (config.afterList) {
    await config.afterList(container.querySelector('[data-after]'), app, records);
  }
}

/* ------------------------------------------------------------------ sheet */

function fieldHtml(field, value) {
  const id = `field_${field.key}`;
  const common = `id="${id}" data-field="${field.key}"`;

  let control;
  if (field.type === 'select') {
    return selectField({
      key: field.key, label: field.label, value, options: field.options, half: field.half, id,
    });
  }
  if (field.type === 'textarea') {
    control = `<textarea class="textarea" ${common} rows="2" placeholder="${h(field.placeholder || '')}">${h(value ?? '')}</textarea>`;
  } else if (field.type === 'switch') {
    return `
      <label class="switch-row" style="${field.half ? 'flex:1;' : ''}">
        <span class="list-row-main"><span class="list-row-title">${h(field.label)}</span></span>
        <input type="checkbox" class="switch" ${common} ${Number(value) ? 'checked' : ''}>
      </label>`;
  } else {
    const numeric = field.type === 'number';
    control = `<input class="input ${numeric ? 'numeric' : ''}" type="${field.type}" ${common}
      value="${h(value ?? '')}" placeholder="${h(field.placeholder || '')}"
      ${numeric ? 'inputmode="decimal" step="any"' : ''}
      ${field.maxlength ? `maxlength="${field.maxlength}"` : ''}>`;
  }

  return `
    <div class="field" style="${field.half ? 'flex:1;min-width:0;' : ''}"
         ${field.showFor ? `data-show-for="${h(field.showFor.join(','))}"` : ''}>
      <label class="field-label" for="${id}">${h(field.label)}</label>
      ${control}
      ${field.hint ? `<span class="caption">${h(field.hint)}</span>` : ''}
    </div>`;
}

async function openRecordSheet(app, type, existing) {
  const config = RECORD_CONFIG[type];

  const initial = (field) => {
    if (existing) return existing[field.key];
    return typeof field.default === 'function' ? field.default() : field.default ?? '';
  };

  // Consecutive half-width fields share a row.
  const rows = [];
  config.fields.forEach((field) => {
    const last = rows[rows.length - 1];
    if (field.half && last && last.half && last.fields.length < 2) last.fields.push(field);
    else rows.push({ half: field.half, fields: [field] });
  });

  const body = rows.map((row) => (row.fields.length > 1 || row.half
    ? `<div class="row" style="gap:12px;align-items:flex-end">${row.fields.map((f) => fieldHtml(f, initial(f))).join('')}</div>`
    : fieldHtml(row.fields[0], initial(row.fields[0])))).join('')
    + (existing ? `<button class="btn btn-danger-text btn-block" data-delete>${icon('delete')}Delete</button>` : '');

  const saved = await sheet(existing ? `Edit ${config.heading.toLowerCase().replace(/s$/, '')}` : config.addLabel, body, {
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>Save</button>`,
    onMount(node, close) {
      bindSelectFields(node);
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));

      /*
       * Shows only the fields the chosen kind actually has. A hidden field is left out of
       * the save entirely rather than written as a blank, so switching a deposit to a cash
       * account does not leave a stale maturity date behind it.
       */
      const kindField = node.querySelector('[data-field="category"]');
      const applyKind = () => {
        const kind = kindField ? kindField.value : '';
        node.querySelectorAll('[data-show-for]').forEach((field) => {
          const shown = field.dataset.showFor.split(',').includes(kind);
          field.hidden = !shown;
        });
      };
      if (kindField) {
        kindField.addEventListener('change', applyKind);
        applyKind();
      }

      node.querySelector('[data-save]').addEventListener('click', async () => {
        const record = existing ? { id: existing.id } : {};

        for (const field of config.fields) {
          const input = node.querySelector(`[data-field="${field.key}"]`);
          // A field this kind does not have is not written, so a rate typed against a
          // deposit does not survive being changed to a savings account.
          const wrapper = input && input.closest('[data-show-for]');
          if (wrapper && wrapper.hidden) {
            record[field.key] = field.type === 'number' ? 0 : '';
            continue;
          }
          let value;

          if (field.type === 'switch') value = input.checked ? 1 : 0;
          else if (field.type === 'number') value = input.value === '' ? 0 : Number(input.value);
          else value = input.value.trim();

          if (field.required && (value === '' || value === null
            || (field.type === 'number' && !Number.isFinite(value)))) {
            toast(`${field.label} is required.`, 'error');
            input.focus();
            return;
          }
          record[field.key] = value;
        }

        if (app.memberFilter !== 'all') record.member_id = Number(app.memberFilter);

        const res = await app.db('save_record', { record_type: type, record });
        if (res) {
          toast('Saved.', 'success');
          close(true);
        }
      });

      const deleteButton = node.querySelector('[data-delete]');
      if (deleteButton) {
        deleteButton.addEventListener('click', async () => {
          const confirmed = await confirmDialog('Delete this record?',
            'This cannot be undone.', { confirmLabel: 'Delete', danger: true });
          if (!confirmed) return;
          const res = await app.db('delete_record', { record_type: type, record_id: existing.id });
          if (res) {
            toast('Deleted.', 'success');
            close(true);
          }
        });
      }
    },
  });

  if (saved) app.refresh();
}

/* ------------------------------------------------ what a commitment becomes */

/**
 * The next twelve months of one kind of commitment, with every step-up applied.
 *
 * A page that lists five SIPs and totals this month's instalments understates what has
 * actually been agreed to: three of them rise ten percent a year, and in five years that is
 * a different household budget. The projection is worked out in the backend, where the
 * anniversary arithmetic lives, so this only draws it.
 */
async function renderCommitmentOutlook(host, app, records, kind) {
  const money = (value) => formatCurrency(value, app.currency, app.locale);
  const seriesKey = kind === 'sip' ? 'sips' : 'subscriptions';

  const finder = `
    <button class="btn btn-text btn-block" data-find>
      ${icon('autorenew')}Find these in my transactions
    </button>`;

  if (!records.length) {
    host.innerHTML = finder;
    bindFinder(host, app);
    return;
  }

  const projection = await Bridge.db('project_commitments', {
    months: 12, member_id: app.memberFilter,
  });

  if (projection.status !== 'success') {
    host.innerHTML = `${errorBlock(projection, { compact: true })}${finder}`;
    bindFinder(host, app);
    return;
  }

  const series = projection.series.filter((entry) => entry.key === seriesKey);
  const items = projection.items.filter((entry) => entry.kind === kind);
  const rising = items.filter((entry) => entry.last_amount > entry.first_amount + 0.5);
  const values = series.length ? series[0].values : [];
  const first = values.length ? values[0] : 0;
  const last = values.length ? values[values.length - 1] : 0;
  const yearTotal = values.reduce((sum, value) => sum + value, 0);

  host.innerHTML = `
    <div class="card">
      <div class="card-title">
        <span>The next twelve months</span>
        <span class="caption">${h(money(yearTotal))}</span>
      </div>

      ${series.length ? barSeriesChart(
    projection.buckets.map((key) => formatMonthKey(key).slice(0, 3)),
    series,
    { format: money, height: 140 },
  ) : ''}

      <div class="grid-2" style="margin-top:14px">
        <div class="stat">
          <span class="caption">This month</span>
          <span class="stat-value">${h(money(first))}</span>
        </div>
        <div class="stat">
          <span class="caption">In a year</span>
          <span class="stat-value ${last > first ? 'expense' : ''}">${h(money(last))}</span>
        </div>
      </div>

      ${rising.length ? `
        <div class="section-header" style="margin-top:16px">
          <span class="title">What is rising</span>
        </div>
        <div class="list">
          ${rising.map((entry) => `
            <div class="list-row">
              <span class="list-row-main">
                <span class="list-row-title">${h(entry.name)}</span>
                <span class="list-row-sub">
                  ${h(money(entry.first_amount))} now, ${h(money(entry.last_amount))} in a year
                  ${entry.change_percent ? ` · ${h(formatDelta(entry.change_percent, 1))} a year` : ''}
                </span>
              </span>
              ${icon('trending_up', 'icon-sm')}
            </div>`).join('')}
        </div>`
    : `<p class="caption" style="margin-top:12px">
         Nothing here is set to change. Add a yearly step-up to a ${kind === 'sip' ? 'SIP' : 'plan'}
         and the projection follows it.
       </p>`}
    </div>

    ${finder}`;

  bindFinder(host, app);
}

function bindFinder(host, app) {
  const button = host.querySelector('[data-find]');
  if (button) button.addEventListener('click', () => app.open('recurring'));
}

/* --------------------------------------------------- loan prepayment extra */

async function renderPrepaymentCalculator(container, app, loans = []) {
  const first = loans[0];
  const money = (v) => formatCurrency(v, app.currency, app.locale);

  const loanOptions = loans.map((l, i) => ({
    value: String(i),
    label: `${l.name} (${money(l.current_outstanding)})`,
  }));

  container.innerHTML = `
    <div class="card">
      <div class="card-title">Prepay Loan vs Stay Invested</div>
      <p class="caption" style="margin-bottom:14px">
        Should you aggressively prepay your loan or invest the surplus money? Compare interest saved against compounding market wealth.
      </p>

      ${loans.length > 1 ? `
        <div style="margin-bottom:14px">
          ${selectField({
    id: 'preLoanSelect',
    name: 'selected_loan_index',
    label: 'Select loan to evaluate',
    value: '0',
    options: loanOptions.map((opt) => ({ value: String(opt.value), label: opt.label })),
  })}
        </div>` : ''}

      <div class="row" style="gap:12px;align-items:flex-end">
        <div class="field" style="flex:1">
          <label class="field-label" for="prePrincipal">Outstanding</label>
          <input class="input numeric" id="prePrincipal" type="number" inputmode="decimal"
                 value="${first?.current_outstanding || 5000000}">
        </div>
        <div class="field" style="flex:1">
          <label class="field-label" for="preRate">Loan Rate %</label>
          <input class="input numeric" id="preRate" type="number" step="0.1" value="${first?.interest_rate || 8.5}">
        </div>
      </div>

      <div class="row" style="gap:12px;align-items:flex-end;margin-top:12px">
        <div class="field" style="flex:1">
          <label class="field-label" for="preTenure">Months left</label>
          <input class="input numeric" id="preTenure" type="number" value="${first?.tenure_months || 240}">
        </div>
        <div class="field" style="flex:1">
          <label class="field-label" for="preExtra">Extra cash / mo</label>
          <input class="input numeric" id="preExtra" type="number" inputmode="decimal" value="10000">
        </div>
      </div>

      <div class="field" style="margin-top:12px">
        <div class="row-between" style="margin-bottom:4px">
          <label class="field-label" for="preInvestReturn" style="padding-left:0">Expected investment return %</label>
          <span class="caption" id="investPresetLabel">12% Balanced MF</span>
        </div>
        <div class="row" style="gap:8px;align-items:center">
          <input class="input numeric" id="preInvestReturn" type="number" step="0.5" value="12" style="max-width:110px">
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <button type="button" class="chip btn-sm" data-rate="7.5">7.5% FD/Debt</button>
            <button type="button" class="chip btn-sm" data-rate="12" aria-selected="true">12% MF/Index</button>
            <button type="button" class="chip btn-sm" data-rate="15">15% Equity</button>
          </div>
        </div>
      </div>

      <button class="btn btn-filled btn-block" data-calc style="margin-top:16px">${icon('calculate')}Run comparison</button>
      <div data-result style="margin-top:16px"></div>
    </div>`;

  bindSelectFields(container, (field, value) => {
    if (field.dataset.name === 'selected_loan_index') {
      const selected = loans[Number(value)];
      if (selected) {
        container.querySelector('#prePrincipal').value = selected.current_outstanding || 0;
        container.querySelector('#preRate').value = selected.interest_rate || 8.5;
        container.querySelector('#preTenure').value = selected.tenure_months || 240;
      }
    }
  });

  container.querySelectorAll('[data-rate]').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-rate]').forEach((b) => b.removeAttribute('aria-selected'));
      btn.setAttribute('aria-selected', 'true');
      container.querySelector('#preInvestReturn').value = btn.dataset.rate;
      const label = btn.dataset.rate === '7.5' ? '7.5% FD/Debt' : (btn.dataset.rate === '12' ? '12% MF/Index' : '15% Equity');
      const labelNode = container.querySelector('#investPresetLabel');
      if (labelNode) labelNode.textContent = label;
    });
  });

  const runCalculation = async () => {
    const read = (id) => Number(container.querySelector(`#${id}`)?.value) || 0;

    const res = await Bridge.call('loan', {
      action: 'compare',
      principal: read('prePrincipal'),
      rate: read('preRate'),
      tenure_months: read('preTenure'),
      extra_monthly: read('preExtra'),
      invest_return: read('preInvestReturn'),
    });

    const output = container.querySelector('[data-result]');
    if (!output) return;
    if (res.status !== 'success') {
      output.innerHTML = errorBlock(res, { compact: true });
      return;
    }

    const isInvestWinner = res.winner === 'invest';
    const isPrepayWinner = res.winner === 'prepay';

    output.innerHTML = `
      <div class="card-flat" style="border-left:4px solid ${isInvestWinner ? 'var(--income)' : (isPrepayWinner ? 'var(--accent)' : 'var(--outline)')};padding:14px;background:var(--surface-container-high);border-radius:var(--radius);margin-bottom:16px">
        <div class="row" style="gap:10px;align-items:flex-start">
          <span style="color:${isInvestWinner ? 'var(--income)' : (isPrepayWinner ? 'var(--accent)' : 'var(--on-surface)')};flex-shrink:0;margin-top:2px">
            ${icon(isInvestWinner ? 'trending_up' : (isPrepayWinner ? 'verified' : 'balance'), 'icon-md')}
          </span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:15px;color:var(--on-surface);margin-bottom:4px;word-break:break-word">
              ${isInvestWinner
    ? `Staying Invested wins by ${h(money(res.wealth_difference))}`
    : (isPrepayWinner
      ? `Prepaying Loan wins by ${h(money(res.wealth_difference))}`
      : 'Both strategies break even')}
            </div>
            <div class="caption" style="line-height:1.45;word-break:break-word">
              ${isInvestWinner
    ? `Your expected investment return (${res.invest_return_rate}%) beats the loan interest (${read('preRate')}%). Investing ${h(money(read('preExtra')))}/mo builds a <strong>${h(money(res.invest_final_wealth))}</strong> corpus vs ${h(money(res.prepay_final_wealth))} from prepayment.`
    : (isPrepayWinner
      ? `Guaranteed interest savings of ${h(money(res.interest_saved))} at ${read('preRate')}% beat the ${res.invest_return_rate}% market return, clearing debt ${res.years_saved} years early.`
      : `The ${res.invest_return_rate}% return matches your borrowing cost.`)}
            </div>
          </div>
        </div>
      </div>

      <div class="row" style="gap:10px;margin-bottom:14px;flex-direction:column">
        <div class="card" style="padding:14px;background:${isInvestWinner ? 'var(--surface-container-highest)' : 'var(--surface-container)'};border:${isInvestWinner ? '1.5px solid var(--income)' : '1px solid var(--outline)'}">
          <div class="row-between" style="align-items:center">
            <span class="row" style="gap:6px;align-items:center;font-weight:700">
              ${icon('trending_up', 'icon-sm')}Stay Invested
            </span>
            ${isInvestWinner ? `<span class="badge" style="background:var(--income-container);color:var(--income)">Recommended</span>` : ''}
          </div>
          <div class="display" style="font-size:22px;margin-top:6px;color:var(--income)">${h(money(res.invest_final_wealth))}</div>
          <div class="caption" style="margin-top:2px">Final wealth after full term</div>
          <div class="caption" style="margin-top:6px;font-size:11.5px;color:var(--on-surface-variant);line-height:1.4">
            Pay regular EMI · Invest ${h(money(read('preExtra')))}/mo at ${res.invest_return_rate}%
          </div>
        </div>

        <div class="card" style="padding:14px;background:${isPrepayWinner ? 'var(--surface-container-highest)' : 'var(--surface-container)'};border:${isPrepayWinner ? '1.5px solid var(--accent)' : '1px solid var(--outline)'}">
          <div class="row-between" style="align-items:center">
            <span class="row" style="gap:6px;align-items:center;font-weight:700">
              ${icon('shield', 'icon-sm')}Prepay Loan
            </span>
            ${isPrepayWinner ? `<span class="badge" style="background:var(--accent-container);color:var(--on-accent-container)">Recommended</span>` : ''}
          </div>
          <div class="display" style="font-size:22px;margin-top:6px;color:var(--on-surface)">${h(money(res.prepay_final_wealth))}</div>
          <div class="caption" style="margin-top:2px">Final wealth after full term</div>
          <div class="caption" style="margin-top:6px;font-size:11.5px;color:var(--on-surface-variant);line-height:1.4">
            Debt-free ${res.years_saved} yrs early · Saves ${h(money(res.interest_saved))} interest
          </div>
        </div>
      </div>

      <div class="grid-2">
        <div class="stat">
          <span class="caption">Current Base EMI</span>
          <span class="stat-value">${h(money(res.base_emi))}</span>
        </div>
        <div class="stat">
          <span class="caption">Interest as-is</span>
          <span class="stat-value expense">${h(money(res.total_base_interest))}</span>
        </div>
        <div class="stat">
          <span class="caption">Interest saved</span>
          <span class="stat-value income">${h(money(res.interest_saved))}</span>
        </div>
        <div class="stat">
          <span class="caption">Tenure reduced by</span>
          <span class="stat-value income">${res.months_saved} mos (${res.years_saved} yrs)</span>
        </div>
      </div>`;
  };

  container.querySelector('[data-calc]').addEventListener('click', runCalculation);
}
