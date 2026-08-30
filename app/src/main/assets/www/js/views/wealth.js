/* Wealth hub: allocation, milestones (₹1L to ₹10Cr), upcoming timeline, and holding gateways. */

import { Bridge } from '../bridge.js';
import { icon, h } from '../ui.js';
import { formatCurrency, formatRelativeDate } from '../formatters.js';
import { donutChart } from '../charts.js';
import { navRow, bindNavRows, memberChips, bindMemberChips } from './shared.js';
import { getNetWorthMilestones } from '../backend/wealth_intel.js';

const ALLOCATION_GROUPS = [
  { label: 'Cash and bank', keys: ['Cash', 'Bank'], color: '#3B82F6' },
  { label: 'Deposits', keys: ['FD', 'RD'], color: '#F59E0B' },
  { label: 'Mutual funds', keys: ['MF'], color: '#10B981' },
  { label: 'Equities', keys: ['Stock', 'Demat'], color: '#8B5CF6' },
  { label: 'Retirement', keys: ['NPS', 'EPF', 'PPF'], color: '#06B6D4' },
  { label: 'Other', keys: ['Gold', 'Property', 'Other'], color: '#64748B' },
];

export async function renderWealth(container, app) {
  const [summaryRes, commitmentsRes, counts] = await Promise.all([
    Bridge.db('get_summary', { member_id: app.memberFilter }),
    Bridge.db('project_commitments', { days: 30, member_id: app.memberFilter }),
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
  const netWorth = assets - liabilities;

  const milestoneData = getNetWorthMilestones(netWorth);
  const nextTarget = milestoneData.next_milestone;
  const upcomingEvents = (commitmentsRes.timeline || []).slice(0, 5);

  const memberHtml = memberChips(app, summaryRes.family_members || []);

  container.innerHTML = `
    ${memberHtml ? `<div class="sticky-header">${memberHtml}</div>` : ''}

    <div class="grid-2">
      <div class="stat">
        <span class="caption">Total Assets</span>
        <span class="stat-value">${h(money(assets))}</span>
      </div>
      <div class="stat">
        <span class="caption">Liabilities</span>
        <span class="stat-value expense">${h(money(liabilities))}</span>
      </div>
    </div>

    <!-- Net Worth Growth Milestones (₹1L to ₹10Cr) -->
    <div class="card" style="background:linear-gradient(180deg, var(--surface-container-low), var(--surface-container));border:1px solid var(--outline-variant)">
      <div class="row-between" style="margin-bottom:8px">
        <span class="overline" style="margin-bottom:0">Net Worth Milestones</span>
        <span class="badge badge-income">${milestoneData.progress_to_next}% to ${nextTarget.label}</span>
      </div>

      <div class="row-between" style="align-items:baseline;margin-bottom:10px">
        <div class="display" style="font-size:24px">${h(money(netWorth))}</div>
        <span class="caption">${milestoneData.distance_to_next > 0 ? `${h(money(milestoneData.distance_to_next))} to ${nextTarget.label}` : 'Top milestone reached'}</span>
      </div>

      <div class="progress" style="height:8px;margin-bottom:14px">
        <div class="progress-bar" style="width:${milestoneData.progress_to_next}%"></div>
      </div>

      <div class="milestone-track">
        ${milestoneData.milestones.map((m) => `
          <div class="milestone-chip ${m.achieved ? 'achieved' : (m.isNext ? 'next' : '')}">
            <span style="font-weight:700">${h(m.label)}</span>
            <span style="font-size:10px">${m.achieved ? icon('check', 'icon-sm') : `${m.pct}%`}</span>
          </div>`).join('')}
      </div>
    </div>

    <!-- Upcoming 30-Day Commitments Timeline -->
    ${upcomingEvents.length ? `
      <div class="card">
        <div class="row-between" style="margin-bottom:10px">
          <span class="title">Upcoming Commitments</span>
          <span class="caption">Next 30 days</span>
        </div>
        <div class="list">
          ${upcomingEvents.map((event) => `
            <div class="list-row">
              <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
                ${icon(event.kind === 'sip' ? 'trending_up' : (event.kind === 'emi' ? 'account_balance' : 'credit_card'), 'icon-sm')}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">${h(event.name)}</span>
                <span class="list-row-sub">${h(formatRelativeDate(event.date))} · ${h(event.kind.toUpperCase())}</span>
              </span>
              <span class="list-row-amount expense">-${h(money(event.amount))}</span>
            </div>`).join('')}
        </div>
      </div>` : ''}

    ${slices.length ? `
      <div class="card">
        <div class="card-title">Asset Allocation</div>
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
        ${navRow('recurring', 'autorenew', 'Recurring payments', 'Tracked recurring payments')}
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
