/* Wealth hub: allocation at a glance, then a way into each kind of holding. */

import { Bridge } from '../bridge.js';
import { h } from '../ui.js';
import { formatCurrency } from '../formatters.js';
import { donutChart } from '../charts.js';
import { navRow, bindNavRows, memberChips, bindMemberChips } from './shared.js';

const ALLOCATION_GROUPS = [
  { label: 'Cash and bank', keys: ['Cash', 'Bank'], color: '#3B82F6' },
  { label: 'Deposits', keys: ['FD', 'RD'], color: '#F59E0B' },
  { label: 'Mutual funds', keys: ['MF'], color: '#10B981' },
  { label: 'Equities', keys: ['Stock', 'Demat'], color: '#8B5CF6' },
  { label: 'Retirement', keys: ['NPS', 'EPF', 'PPF'], color: '#06B6D4' },
  { label: 'Other', keys: ['Gold', 'Property', 'Other'], color: '#64748B' },
];

export async function renderWealth(container, app) {
  const [summaryRes, counts] = await Promise.all([
    Bridge.db('get_summary', { member_id: app.memberFilter }),
    countRecords(app),
  ]);

  const totals = summaryRes.asset_totals || {};
  const money = (v) => formatCurrency(v, app.currency, app.locale);

  const slices = ALLOCATION_GROUPS
    .map((group) => ({
      label: group.label,
      color: group.color,
      value: group.keys.reduce((sum, key) => sum + Number(totals[key] || 0), 0),
    }))
    .filter((slice) => slice.value > 0);

  const assets = Number(summaryRes.total_assets || 0);
  const liabilities = Number(summaryRes.total_liabilities || 0);

  const memberHtml = memberChips(app, summaryRes.family_members || []);

  container.innerHTML = `
    ${memberHtml ? `<div class="sticky-header">${memberHtml}</div>` : ''}

    <div class="grid-2">
      <div class="stat">
        <span class="caption">Assets</span>
        <span class="stat-value">${h(money(assets))}</span>
      </div>
      <div class="stat">
        <span class="caption">Liabilities</span>
        <span class="stat-value expense">${h(money(liabilities))}</span>
      </div>
    </div>

    ${slices.length ? `
      <div class="card">
        <div class="card-title">Allocation</div>
        ${donutChart(slices, { centerLabel: 'Assets', centerValue: money(assets) })}
      </div>` : ''}

    <div class="section">
      <div class="section-header"><span class="title">Holdings</span></div>
      <div class="list">
        ${navRow('investments', 'stacked_bar_chart', 'Investments', 'Portfolio, profit & loss')}
        ${navRow('accounts', 'account_balance', 'Accounts', 'Bank balances & deposits', counts.account)}
        ${navRow('sips', 'trending_up', 'SIPs', 'Recurring investments', counts.sip)}
        ${navRow('cas', 'picture_as_pdf', 'Account statement', 'Import CAS statement')}
      </div>
    </div>

    <div class="section">
      <div class="section-header"><span class="title">Commitments</span></div>
      <div class="list">
        ${navRow('loans', 'account_balance_wallet', 'Loans', 'Outstanding & EMIs', counts.loan)}
        ${navRow('cards', 'credit_card', 'Credit cards', 'Limits & balances', counts.card)}
        ${navRow('subscriptions', 'subscriptions', 'Subscriptions', 'Recurring services', counts.subscription)}
        ${navRow('recurring', 'autorenew', 'Recurring payments',
          'Tracked recurring payments')}
      </div>
    </div>

    <div class="section">
      <div class="section-header"><span class="title">Planning</span></div>
      <div class="list">
        ${navRow('goals', 'flag', 'Goals', 'Savings targets', counts.goal)}
        ${navRow('fire', 'rocket_launch', 'Retirement', 'FIRE & retirement calculator')}
      </div>
    </div>`;

  bindMemberChips(container, app);
  bindNavRows(container, app);
}

async function countRecords(app) {
  const types = ['account', 'sip', 'loan', 'card', 'subscription', 'goal'];
  const results = await Promise.all(types.map((type) =>
    Bridge.db('list_records', { record_type: type, member_id: app.memberFilter })));

  const counts = {};
  types.forEach((type, i) => {
    const n = results[i].records?.length || 0;
    counts[type] = n ? String(n) : '';
  });
  return counts;
}
