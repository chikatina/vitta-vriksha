/* SIP Tracker and Mandate Management View. */

import { Bridge } from '../bridge.js';
import {
  icon, h, sheet, toast, confirmDialog, emptyState, errorBlock, selectField, bindSelectFields, showProgressModal,
} from '../ui.js';
import { formatCurrency, formatDate, todayISO } from '../formatters.js';

const DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => String(i + 1));

const STEP_UP_MONTHS = [
  { value: '0', label: 'On anniversary' },
  { value: '1', label: 'Every January' },
  { value: '4', label: 'Every April' },
  { value: '7', label: 'Every July' },
  { value: '10', label: 'Every October' },
];

let activeFilter = 'all';

function formatCostBreakdown(line, moneyFn) {
  if (!line) return '';
  const parts = [];
  const stamp = Number(line.stamp_duty || 0);
  const stt = Number(line.stt || 0);
  const charges = Number(line.charges || 0);
  if (stamp > 0) parts.push(`Stamp duty ${moneyFn(stamp)}`);
  if (stt > 0) parts.push(`STT ${moneyFn(stt)}`);
  if (charges > 0) parts.push(`Exchange/Charges ${moneyFn(charges)}`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function formatCostBreakdownBadges(line, moneyFn) {
  if (!line) return '';
  const parts = [];
  const stamp = Number(line.stamp_duty || 0);
  const stt = Number(line.stt || 0);
  const charges = Number(line.charges || 0);
  if (stamp > 0) parts.push(`Stamp duty ${moneyFn(stamp)}`);
  if (stt > 0) parts.push(`STT ${moneyFn(stt)}`);
  if (charges > 0) parts.push(`Charges ${moneyFn(charges)}`);
  if (!parts.length) return '';
  return `
    <div class="row" style="gap:4px;flex-wrap:wrap;margin-top:2px">
      ${parts.map((p) => `<span class="badge" style="background:var(--surface-container-highest);color:var(--on-surface-variant);font-size:10px;padding:1px 5px;border-radius:var(--radius-full)">${h(p)}</span>`).join('')}
    </div>`;
}

/**
 * Main SIP Tracker view entry point.
 */
export async function renderSipTracker(container, app) {
  const [sipsRes, discoverRes] = await Promise.all([
    Bridge.db('list_sips', { member_id: app.memberFilter }),
    Bridge.db('discover_sips', { member_id: app.memberFilter }),
  ]);

  if (sipsRes.status !== 'success') {
    container.innerHTML = `<div class="card">${errorBlock(sipsRes)}</div>`;
    return;
  }

  const mandates = sipsRes.mandates || [];
  const sips = sipsRes.sips || [];
  const summary = sipsRes.summary || {
    total_monthly_amount: 0,
    active_sips_count: 0,
    mandates_count: 0,
    current_month_due_count: 0,
    current_month_debited_count: 0,
    current_month_allotted_count: 0,
  };
  const discoveredCount = discoverRes.total_candidates ?? ((discoverRes.discovered_mandates?.length || 0) + (discoverRes.discovered_sips?.length || 0));

  const mfSips = sips.filter((s) => s.investment_type !== 'stock');
  const stockSips = sips.filter((s) => s.investment_type === 'stock');
  const pausedSips = sips.filter((s) => s.is_active === 0);

  const shownSips = sips.filter((s) => {
    if (activeFilter === 'mf') return s.investment_type !== 'stock' && s.is_active !== 0;
    if (activeFilter === 'stock') return s.investment_type === 'stock' && s.is_active !== 0;
    if (activeFilter === 'paused') return s.is_active === 0;
    if (activeFilter === 'mandates') return false;
    return s.is_active !== 0;
  });

  const money = (val) => formatCurrency(val, app.currency, app.locale);

  container.innerHTML = `
    <!-- Top Summary Card -->
    <div class="sip-hero-card">
      <div class="row-between" style="align-items:baseline">
        <span class="caption">Monthly SIP Outflow</span>
        <span class="badge badge-investment">${icon('trending_up', 'icon-sm')} ${summary.active_sips_count} active</span>
      </div>
      <div class="display" style="margin-top:4px">${h(money(summary.total_monthly_amount))}</div>

      <div class="sip-status-row">
        <span class="badge badge-allotted" title="Allotted via CAMS">
          ${icon('check_circle', 'icon-sm')} ${summary.current_month_allotted_count} Allotted
        </span>
        <span class="badge badge-debited" title="Debited via bank">
          ${icon('payments', 'icon-sm')} ${summary.current_month_debited_count} Debited
        </span>
        <span class="badge badge-due" title="Due this month">
          ${icon('schedule', 'icon-sm')} ${summary.current_month_due_count} Due
        </span>
      </div>

      <div class="sip-action-bar">
        <button class="btn btn-sm btn-filled" data-add-sip>
          ${icon('add', 'icon-sm')} Add SIP
        </button>
        <button class="btn btn-sm btn-tonal" data-add-mandate>
          ${icon('umbrella', 'icon-sm')} Add Mandate
        </button>
        <button class="btn btn-sm btn-outlined" data-scan-sips>
          ${icon('refresh', 'icon-sm')} Scan SIPs
        </button>
      </div>
    </div>

    <!-- Discovery Alert Banner -->
    ${discoveredCount > 0 ? `
      <div class="convert-prompt-banner" data-open-discovery>
        <div class="row" style="gap:10px;align-items:center;min-width:0;flex:1">
          <span class="avatar avatar-sm" style="background:var(--investment-container);color:var(--investment)">
            ${icon('savings', 'icon-sm')}
          </span>
          <div style="min-width:0;flex:1">
            <div style="font-weight:600;font-size:13px;color:var(--on-surface)">
              ${discoveredCount} ${discoveredCount === 1 ? 'SIP candidate' : 'SIP candidates'} discovered
            </div>
            <div class="caption">From bank debits and statement records</div>
          </div>
        </div>
        <button class="btn btn-xs btn-tonal" style="flex-shrink:0">Review</button>
      </div>` : ''}

    <!-- Filter Chips -->
    <div class="chip-scroller review-filters" style="margin-bottom:var(--gap-3)">
      <button type="button" class="chip" data-filter="all" aria-selected="${activeFilter === 'all'}">
        All ${sips.length}
      </button>
      <button type="button" class="chip" data-filter="mf" aria-selected="${activeFilter === 'mf'}">
        Mutual Funds ${mfSips.length}
      </button>
      <button type="button" class="chip" data-filter="stock" aria-selected="${activeFilter === 'stock'}">
        Stocks &amp; ETFs ${stockSips.length}
      </button>
      <button type="button" class="chip" data-filter="mandates" aria-selected="${activeFilter === 'mandates'}">
        Mandates ${mandates.length}
      </button>
      ${pausedSips.length ? `
        <button type="button" class="chip" data-filter="paused" aria-selected="${activeFilter === 'paused'}">
          Paused ${pausedSips.length}
        </button>` : ''}
    </div>

    <!-- Umbrella Mandates Section -->
    ${(activeFilter === 'all' || activeFilter === 'mandates') && mandates.length ? `
      <div class="section" style="margin-bottom:var(--gap-4)">
        <div class="section-header">
          <span class="title">Umbrella Mandates</span>
          <span class="caption">${mandates.length}</span>
        </div>
        ${mandates.map((m) => `
          <div class="sip-mandate-card" data-mandate-card="${m.id}">
            <div class="sip-mandate-header">
              <div class="sip-mandate-title">
                ${icon('umbrella', 'icon-sm')}
                <span>${h(m.name)}</span>
              </div>
              <div class="row" style="gap:6px">
                <button class="icon-button" data-edit-mandate="${m.id}" aria-label="Edit mandate">
                  ${icon('edit', 'icon-sm')}
                </button>
                <button class="icon-button" data-delete-mandate="${m.id}" aria-label="Delete mandate">
                  ${icon('delete', 'icon-sm')}
                </button>
              </div>
            </div>

            <div class="row-between" style="font-size:12.5px;color:var(--on-surface-variant)">
              <span>Day ${m.debit_day || 5} · ${h(m.bank_name || 'Bank Debit')}</span>
              <span style="font-weight:600;color:var(--on-surface)">${h(money(m.monthly_amount))} / mo</span>
            </div>

            <!-- Child Splits -->
            ${m.splits && m.splits.length ? `
              <div class="sip-splits-container">
                <div class="caption" style="font-size:11px">Split Allocations (${m.splits.length})</div>
                ${m.splits.map((s) => `
                  <div class="sip-split-row" data-open-sip="${s.id}">
                    <div style="display:flex;flex-direction:column;min-width:0;flex:1">
                      <span style="font-weight:600;color:var(--on-surface);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                        ${h(s.scheme_name || s.name || 'Child SIP')}
                      </span>
                      <span class="caption" style="font-size:11px">
                        ${h(s.folio_number ? `Folio ${s.folio_number}` : (s.isin || 'Child SIP'))}
                      </span>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                      <span style="font-weight:600;font-size:12.5px">${h(money(s.monthly_amount || s.amount || 0))}</span>
                      <span class="badge ${s.status === 'allotted' ? 'badge-allotted' : (s.status === 'debited' ? 'badge-debited' : 'badge-due')}" style="font-size:10px;padding:1px 6px">
                        ${h(s.status || 'active')}
                      </span>
                      <button class="icon-button" data-delete-sip="${s.id}" aria-label="Delete SIP" style="color:var(--expense);padding:2px">
                        ${icon('delete', 'icon-sm')}
                      </button>
                    </div>
                  </div>`).join('')}
              </div>` : ''}
          </div>`).join('')}
      </div>` : ''}

    <!-- SIPs List Section -->
    ${activeFilter !== 'mandates' && shownSips.length ? `
      <div class="section">
        <div class="section-header">
          <span class="title">Systematic Plans</span>
          <span class="caption">${shownSips.length}</span>
        </div>
        ${shownSips.map((sip) => {
    const isPaused = sip.is_active === 0;
    const statusClass = isPaused
      ? 'badge-missed'
      : (sip.current_status === 'allotted' ? 'badge-allotted' : (sip.current_status === 'debited' ? 'badge-debited' : 'badge-due'));
    const statusLabel = isPaused ? 'Paused' : (sip.current_status === 'allotted' ? 'Allotted' : (sip.current_status === 'debited' ? 'Debited' : 'Due'));

    return `
            <div class="sip-card" data-open-sip="${sip.id}">
              <div class="sip-card-info">
                <span class="avatar avatar-sm ${sip.investment_type === 'stock' ? 'avatar-debit' : 'avatar-bank'}">
                  ${icon(sip.investment_type === 'stock' ? 'show_chart' : 'trending_up', 'icon-sm')}
                </span>
                <div class="sip-card-text">
                  <span class="sip-card-name">${h(sip.scheme_name || sip.name || 'Mutual Fund SIP')}</span>
                  <span class="sip-card-sub">
                    ${h([
    sip.mandate_name ? `Mandate: ${sip.mandate_name}` : null,
    sip.folio_number ? `Folio ${sip.folio_number}` : (sip.symbol || null),
    `Day ${sip.debit_day || 5}`,
    Number(sip.step_up_percent) ? `+${sip.step_up_percent}% step-up` : null,
  ].filter(Boolean).join(' · '))}
                  </span>
                </div>
              </div>
              <div class="row" style="gap:6px;align-items:center">
                <div class="sip-card-trailing">
                  <span class="sip-card-amount">${h(money(sip.monthly_amount || sip.amount || 0))}</span>
                  <span class="badge ${statusClass}">${h(statusLabel)}</span>
                </div>
                <button class="icon-button" data-delete-sip="${sip.id}" aria-label="Delete SIP" style="color:var(--expense)">
                  ${icon('delete', 'icon-sm')}
                </button>
              </div>
            </div>`;
  }).join('')}
      </div>` : ''}

    <!-- Empty State -->
    ${!mandates.length && !sips.length ? `
      <div class="card">
        ${emptyState('trending_up', 'No SIPs tracked',
    'Add recurring mutual fund or stock investments to track monthly debits and CAMS allotments.')}
        <div class="row" style="gap:8px;justify-content:center;margin-top:16px">
          <button class="btn btn-sm btn-filled" data-add-sip>${icon('add', 'icon-sm')} Add SIP</button>
          <button class="btn btn-sm btn-tonal" data-scan-sips>${icon('refresh', 'icon-sm')} Scan Statements</button>
        </div>
      </div>` : ''}
  `;

  // Bind Filter Chips
  container.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      renderSipTracker(container, app);
    });
  });

  // Action Buttons - wire ALL instances
  container.querySelectorAll('[data-add-sip]').forEach((btn) => {
    btn.addEventListener('click', () => openSipFormSheet(app, null, null, () => renderSipTracker(container, app)));
  });

  container.querySelectorAll('[data-add-mandate]').forEach((btn) => {
    btn.addEventListener('click', () => openMandateFormSheet(app, null, () => renderSipTracker(container, app)));
  });

  container.querySelectorAll('[data-scan-sips]').forEach((btn) => {
    btn.addEventListener('click', () => openDiscoverSipsWizard(app, () => renderSipTracker(container, app)));
  });

  const openDiscBanner = container.querySelector('[data-open-discovery]');
  if (openDiscBanner) {
    openDiscBanner.addEventListener('click', () => openDiscoverSipsWizard(app, () => renderSipTracker(container, app)));
  }

  // Open SIP Details
  container.querySelectorAll('[data-open-sip]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-sip]')) return;
      const sipId = Number(el.dataset.openSip);
      if (sipId) openSipDetailsSheet(app, sipId, () => renderSipTracker(container, app));
    });
  });

  // Direct Delete SIP
  container.querySelectorAll('[data-delete-sip]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sipId = Number(btn.dataset.deleteSip);
      if (!sipId) return;
      const targetSip = sips.find((s) => s.id === sipId);
      const title = targetSip?.scheme_name || targetSip?.name || 'this SIP';
      const confirmed = await confirmDialog(
        'Delete SIP',
        `Delete tracking for "${title}"? Existing statement transactions will remain intact.`,
        { confirmLabel: 'Delete', danger: true },
      );
      if (confirmed) {
        await Bridge.db('delete_sip', { sip_id: sipId, id: sipId });
        toast('SIP deleted', 'success');
        renderSipTracker(container, app);
      }
    });
  });

  // Edit / Delete Mandates
  container.querySelectorAll('[data-edit-mandate]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mandateId = Number(btn.dataset.editMandate);
      const target = mandates.find((m) => m.id === mandateId);
      if (target) openMandateFormSheet(app, target, () => renderSipTracker(container, app));
    });
  });

  container.querySelectorAll('[data-delete-mandate]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const mandateId = Number(btn.dataset.deleteMandate);
      const confirmed = await confirmDialog(
        'Delete Mandate',
        'Delete this umbrella mandate? Child SIPs will become standalone plans.',
        { confirmLabel: 'Delete', danger: true },
      );
      if (confirmed) {
        await Bridge.db('delete_sip_mandate', { id: mandateId });
        toast('Mandate deleted', 'success');
        renderSipTracker(container, app);
      }
    });
  });
}

/**
 * Detailed inspection sheet for a SIP with CAMS portfolio insight and monthly execution timeline.
 */
export async function openSipDetailsSheet(app, sipId, onRefresh) {
  const idNum = Number(sipId);
  if (!idNum) {
    toast('Invalid SIP selected', 'error');
    return;
  }
  const res = await Bridge.db('get_sip_details', { sip_id: idNum, id: idNum });
  if (res.status !== 'success') {
    toast(res.message || 'Failed to load SIP details', 'error');
    return;
  }

  const { sip, mandate, holding, executions } = res;
  const money = (val) => formatCurrency(val, app.currency, app.locale);

  const formHtml = `
    <!-- Top Meta -->
    <div style="margin-bottom:var(--gap-3)">
      <div class="row-between" style="align-items:flex-start">
        <div>
          <div style="font-weight:700;font-size:16px;color:var(--on-surface)">${h(sip.scheme_name)}</div>
          <div class="caption" style="margin-top:2px">
            ${h([
    sip.investment_type === 'stock' ? 'Stock / ETF' : 'Mutual Fund',
    sip.folio_number ? `Folio ${sip.folio_number}` : null,
    sip.isin || null,
  ].filter(Boolean).join(' · '))}
          </div>
        </div>
        <span class="badge ${sip.is_active === 0 ? 'badge-missed' : 'badge-allotted'}">
          ${sip.is_active === 0 ? 'Paused' : 'Active'}
        </span>
      </div>

      <div class="grid-2" style="margin-top:var(--gap-3)">
        <div class="stat">
          <span class="caption">Monthly Instalment</span>
          <span class="stat-value">${h(money(sip.monthly_amount))}</span>
        </div>
        <div class="stat">
          <span class="caption">Debit Schedule</span>
          <span class="stat-value">Day ${sip.debit_day || 5}</span>
        </div>
      </div>

      ${mandate ? `
        <div class="card-flat" style="background:var(--surface-container-high);padding:10px 12px;border-radius:var(--radius-sm);margin-top:var(--gap-2);font-size:12.5px">
          <div class="row-between">
            <span style="color:var(--on-surface-variant)">Umbrella Mandate</span>
            <span style="font-weight:600;color:var(--on-surface)">${h(mandate.name)}</span>
          </div>
        </div>` : ''}

      ${Number(sip.step_up_percent) ? `
        <div class="card-flat" style="background:var(--surface-container-high);padding:10px 12px;border-radius:var(--radius-sm);margin-top:var(--gap-2);font-size:12.5px">
          <div class="row-between">
            <span style="color:var(--on-surface-variant)">Yearly Step-Up</span>
            <span style="font-weight:600;color:var(--income)">+${sip.step_up_percent}%</span>
          </div>
        </div>` : ''}
    </div>

    <!-- Portfolio Insight Card (from CAMS statement) -->
    ${holding ? `
      <div class="card" style="background:var(--surface-container-low);border:1px solid var(--outline-variant);margin-bottom:var(--gap-3);padding:var(--gap-3)">
        <div class="row-between" style="margin-bottom:6px">
          <span class="caption">Linked Portfolio Holding</span>
          <span class="badge ${holding.pnl >= 0 ? 'badge-income' : 'badge-expense'}">
            ${holding.pnl >= 0 ? '+' : ''}${h(money(holding.pnl))} (${holding.pnl_percent >= 0 ? '+' : ''}${holding.pnl_percent.toFixed(1)}%)
          </span>
        </div>
        <div class="row-between" style="align-items:baseline">
          <span class="title" style="font-size:18px">${h(money(holding.value))}</span>
          <span class="caption">Invested ${h(money(holding.invested))}</span>
        </div>
        <div class="caption" style="margin-top:4px">
          ${Number(holding.units || 0).toFixed(3)} units · NAV ${h(money(holding.nav || 0))}
        </div>
      </div>` : ''}

    <!-- Paired Monthly Reconciliation Timeline -->
    <div class="section" style="margin-top:var(--gap-3)">
      <div class="row-between" style="margin-bottom:var(--gap-2)">
        <span class="title" style="font-size:14px">Execution Timeline</span>
        <span class="caption">Debits &amp; Allotments</span>
      </div>

      <div class="sip-timeline">
        ${executions.length ? executions.map((ex) => {
    const isAllotted = ex.status === 'allotted';
    const isDebited = ex.status === 'debited';
    const isMissed = ex.status === 'missed';
    const badgeClass = isAllotted ? 'badge-allotted' : (isDebited ? 'badge-debited' : (isMissed ? 'badge-missed' : 'badge-due'));

    return `
            <div class="sip-timeline-month">
              <div class="sip-timeline-month-header">
                <span style="font-weight:600;font-size:13px;color:var(--on-surface)">${h(ex.month)}</span>
                <span class="badge ${badgeClass}" style="text-transform:capitalize">
                  ${h(ex.status)}
                </span>
              </div>

              <div class="sip-timeline-pair">
                <!-- Bank Debit Side -->
                <div class="sip-timeline-side">
                  <div class="sip-timeline-side-title">
                    ${icon('payments', 'icon-sm')} Bank Debit
                  </div>
                  ${ex.debit_transaction ? `
                    <div style="font-weight:600">${h(money(ex.debit_transaction.amount))}</div>
                    <div class="caption">${h(formatDate(ex.debit_transaction.date))}</div>
                    <div class="caption" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(ex.debit_transaction.account_name || 'Bank')}</div>
                    <button class="btn btn-xs btn-text" data-unlink-debit="${ex.debit_transaction.id}" style="align-self:flex-start;padding:2px 0;color:var(--expense)">
                      Unlink
                    </button>` : `
                    <div class="caption" style="font-style:italic">No bank debit linked</div>
                    <button class="btn btn-xs btn-tonal" data-find-debit="${ex.month}" style="align-self:flex-start;margin-top:4px">
                      Link Debit
                    </button>`}
                </div>

                <!-- CAMS Allotment Side -->
                <div class="sip-timeline-side">
                  <div class="sip-timeline-side-title">
                    ${icon('receipt_long', 'icon-sm')} CAMS Units
                  </div>
                  ${ex.cas_transaction ? `
                    <div style="font-weight:600">${Number(ex.cas_transaction.units || 0).toFixed(3)} units</div>
                    <div class="caption">${h(formatDate(ex.cas_transaction.date))} · NAV ${h(money(ex.cas_transaction.nav || 0))}</div>
                    <div class="caption">${h(money(ex.cas_transaction.amount))}</div>
                    ${formatCostBreakdownBadges(ex.cas_transaction, money)}
                    <button class="btn btn-xs btn-text" data-unlink-cas="${ex.cas_transaction.id}" style="align-self:flex-start;padding:2px 0;color:var(--expense)">
                      Unlink
                    </button>` : `
                    <div class="caption" style="font-style:italic">No CAMS units linked</div>
                    <button class="btn btn-xs btn-tonal" data-find-cas="${ex.month}" style="align-self:flex-start;margin-top:4px">
                      Link Allotment
                    </button>`}
                </div>
              </div>
            </div>`;
  }).join('') : `
          <div class="caption" style="text-align:center;padding:16px">
            No execution cycles recorded yet. Upcoming cycles will appear on debit day.
          </div>`}
      </div>
    </div>
  `;

  await sheet('SIP Details', formHtml, {
    actions: `
      <div class="row" style="gap:8px;width:100%">
        <button class="btn btn-outlined btn-block" data-toggle-active style="flex:1">
          ${sip.is_active === 0 ? 'Resume SIP' : 'Pause SIP'}
        </button>
        <button class="btn btn-tonal btn-block" data-edit-sip style="flex:1">
          ${icon('edit', 'icon-sm')} Edit
        </button>
        <button class="btn btn-outlined btn-block" data-delete-sip style="flex:0.8;color:var(--expense)">
          ${icon('delete', 'icon-sm')} Delete
        </button>
      </div>`,
    onMount(node, close) {
      // Toggle Active / Pause
      node.querySelector('[data-toggle-active]').addEventListener('click', async () => {
        const nextState = sip.is_active === 0 ? 1 : 0;
        await Bridge.db('save_sip', {
          ...sip,
          is_active: nextState,
        });
        toast(nextState === 1 ? 'SIP resumed' : 'SIP paused', 'success');
        close(null);
        if (onRefresh) onRefresh();
      });

      // Edit SIP
      node.querySelector('[data-edit-sip]').addEventListener('click', () => {
        close(null);
        openSipFormSheet(app, sip, null, onRefresh);
      });

      // Delete SIP
      node.querySelector('[data-delete-sip]').addEventListener('click', async () => {
        const confirmed = await confirmDialog(
          'Delete SIP',
          `Delete tracking for "${sip.scheme_name}"? Existing statement transactions will remain intact.`,
          { confirmLabel: 'Delete', danger: true },
        );
        if (confirmed) {
          await Bridge.db('delete_sip', { sip_id: sip.id, id: sip.id });
          toast('SIP deleted', 'success');
          close(null);
          if (onRefresh) onRefresh();
        }
      });

      // Unlink Handlers
      node.querySelectorAll('[data-unlink-debit]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const txId = Number(btn.dataset.unlinkDebit);
          await Bridge.db('unlink_sip_transaction', { sip_id: sip.id, transaction_id: txId, is_cas: false });
          toast('Transaction unlinked', 'success');
          close(null);
          openSipDetailsSheet(app, sipId, onRefresh);
        });
      });

      node.querySelectorAll('[data-unlink-cas]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const txId = Number(btn.dataset.unlinkCas);
          await Bridge.db('unlink_sip_transaction', { sip_id: sip.id, transaction_id: txId, is_cas: true });
          toast('Statement allotment unlinked', 'success');
          close(null);
          openSipDetailsSheet(app, sipId, onRefresh);
        });
      });

      // Manual Link Handlers
      node.querySelectorAll('[data-find-debit], [data-find-cas]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          close(null);
          await openManualLinkModal(app, sip, onRefresh);
        });
      });
    },
  });
}

/**
 * Form sheet to create or edit a SIP.
 */
export async function openSipFormSheet(app, existingSip = null, mandatePreset = null, onRefresh = null) {
  const [accountsRes, sipsRes, investRes] = await Promise.all([
    Bridge.db('list_records', { record_type: 'account', member_id: app.memberFilter }),
    Bridge.db('list_sips', { member_id: app.memberFilter }),
    Bridge.db('list_investments', { member_id: app.memberFilter }),
  ]);

  const accounts = accountsRes.records || [];
  const mandates = sipsRes.mandates || [];
  const holdings = investRes.holdings || [];

  const accountOptions = [
    { value: '', label: 'Select Bank Account' },
    ...accounts.map((a) => ({ value: String(a.id), label: `${a.name}${a.account_number ? ` (···${a.account_number.slice(-4)})` : ''}` })),
  ];

  const mandateOptions = [
    { value: '', label: 'None (Standalone SIP)' },
    ...mandates.map((m) => ({ value: String(m.id), label: m.name })),
  ];

  const dayOptions = DAY_OPTIONS.map((d) => ({ value: d, label: `Day ${d}` }));

  const isEditing = Boolean(existingSip && existingSip.id);
  const currentType = existingSip?.investment_type || 'mf';

  const formHtml = `
    <!-- Investment Type Switch -->
    <div class="row" style="gap:8px;margin-bottom:var(--gap-3)">
      <button type="button" class="chip" data-type-btn="mf" aria-selected="${currentType !== 'stock'}">
        Mutual Fund
      </button>
      <button type="button" class="chip" data-type-btn="stock" aria-selected="${currentType === 'stock'}">
        Stock / ETF
      </button>
    </div>

    <!-- Quick Holdings Suggestions -->
    ${holdings.length ? `
      <div style="margin-bottom:var(--gap-3)">
        <div class="caption" style="margin-bottom:4px">Autofill from portfolio holdings</div>
        <div class="holding-quick-chips">
          ${holdings.slice(0, 10).map((hld) => `
            <button type="button" class="holding-quick-chip"
                    data-hld-name="${h(hld.name)}"
                    data-hld-isin="${h(hld.isin || '')}"
                    data-hld-folio="${h(hld.account || '')}"
                    data-hld-symbol="${h(hld.symbol || '')}"
                    data-hld-broker="${h(hld.portfolio || '')}"
                    data-hld-type="${hld.asset_class?.toLowerCase().includes('stock') ? 'stock' : 'mf'}">
              ${h(hld.name)}
            </button>`).join('')}
        </div>
      </div>` : ''}

    <div class="field">
      <label class="field-label" for="sipSchemeName">Scheme Name / Symbol *</label>
      <input class="input" id="sipSchemeName" placeholder="e.g. Parag Parikh Flexi Cap or NIFTYBEES" value="${h(existingSip?.scheme_name || '')}" required autocomplete="off">
    </div>

    <div class="row-between" style="gap:10px">
      <div class="field" style="flex:1">
        <label class="field-label" for="sipAmount">Monthly Amount *</label>
        <input class="input numeric" id="sipAmount" type="number" step="100" placeholder="5000" value="${existingSip?.monthly_amount || ''}" required>
      </div>
      <div class="field" style="flex:1">
        ${selectField({
    key: 'debit_day',
    id: 'sipDebitDay',
    label: 'Debit Day',
    value: String(existingSip?.debit_day || mandatePreset?.debit_day || '5'),
    options: dayOptions,
  })}
      </div>
    </div>

    <div class="field">
      ${selectField({
    key: 'mandate_id',
    id: 'sipMandateId',
    label: 'Umbrella Mandate',
    value: String(existingSip?.mandate_id || mandatePreset?.id || ''),
    options: mandateOptions,
  })}
    </div>

    <div class="field">
      ${selectField({
    key: 'account_id',
    id: 'sipAccountId',
    label: 'Bank Account',
    value: String(existingSip?.account_id || ''),
    options: accountOptions,
  })}
    </div>

    <div class="row-between" style="gap:10px">
      <div class="field" style="flex:1">
        <label class="field-label" for="sipIsin">ISIN (Optional)</label>
        <input class="input" id="sipIsin" placeholder="INF..." value="${h(existingSip?.isin || '')}" autocomplete="off">
      </div>
      <div class="field" style="flex:1">
        <label class="field-label" for="sipFolio">Folio Number (Optional)</label>
        <input class="input" id="sipFolio" placeholder="e.g. 1234567/89" value="${h(existingSip?.folio_number || '')}" autocomplete="off">
      </div>
    </div>

    <div class="row-between" style="gap:10px">
      <div class="field" style="flex:1">
        <label class="field-label" for="sipStepUp">Yearly Step-Up %</label>
        <input class="input numeric" id="sipStepUp" type="number" placeholder="10" value="${existingSip?.step_up_percent || ''}">
      </div>
      <div class="field" style="flex:1">
        ${selectField({
    key: 'step_up_month',
    id: 'sipStepUpMonth',
    label: 'Step-Up Timing',
    value: String(existingSip?.step_up_month || '0'),
    options: STEP_UP_MONTHS,
  })}
      </div>
    </div>

    <div class="row-between" style="gap:10px">
      <div class="field" style="flex:1">
        <label class="field-label" for="sipStartDate">Start Date</label>
        <input class="input" id="sipStartDate" type="date" value="${existingSip?.start_date || todayISO()}">
      </div>
      <div class="field" style="flex:1">
        <label class="field-label" for="sipEndDate">End Date (Optional)</label>
        <input class="input" id="sipEndDate" type="date" value="${existingSip?.end_date || ''}">
      </div>
    </div>
  `;

  await sheet(isEditing ? 'Edit SIP' : 'Add SIP', formHtml, {
    actions: `
      <button class="btn btn-filled btn-block" data-submit-sip>${icon('check', 'icon-sm')} Save SIP</button>
      <button class="btn btn-outlined btn-block" data-cancel style="margin-top:8px">Cancel</button>`,
    onMount(node, close) {
      bindSelectFields(node);

      let selectedType = currentType;

      // Type toggles
      node.querySelectorAll('[data-type-btn]').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedType = btn.dataset.typeBtn;
          node.querySelectorAll('[data-type-btn]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
        });
      });

      // Quick holdings chips
      node.querySelectorAll('[data-hld-name]').forEach((chip) => {
        chip.addEventListener('click', () => {
          node.querySelector('#sipSchemeName').value = chip.dataset.hldName;
          if (chip.dataset.hldIsin) node.querySelector('#sipIsin').value = chip.dataset.hldIsin;
          if (chip.dataset.hldFolio) node.querySelector('#sipFolio').value = chip.dataset.hldFolio;
          if (chip.dataset.hldType) {
            selectedType = chip.dataset.hldType;
            node.querySelectorAll('[data-type-btn]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.typeBtn === selectedType)));
          }
        });
      });

      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));

      node.querySelector('[data-submit-sip]').addEventListener('click', async () => {
        const schemeName = node.querySelector('#sipSchemeName').value.trim();
        const amount = Number(node.querySelector('#sipAmount').value);
        const debitDay = Number(node.querySelector('#sipDebitDay').value) || 5;
        const mandateId = node.querySelector('#sipMandateId').value ? Number(node.querySelector('#sipMandateId').value) : null;
        const accountId = node.querySelector('#sipAccountId').value ? Number(node.querySelector('#sipAccountId').value) : null;
        const isin = node.querySelector('#sipIsin').value.trim().toUpperCase() || null;
        const folio = node.querySelector('#sipFolio').value.trim() || null;
        const stepUp = Number(node.querySelector('#sipStepUp').value) || 0;
        const stepUpMonth = Number(node.querySelector('#sipStepUpMonth').value) || 0;
        const startDate = node.querySelector('#sipStartDate').value || todayISO();
        const endDate = node.querySelector('#sipEndDate').value || null;

        if (!schemeName) {
          toast('Please enter a scheme or stock name', 'error');
          return;
        }
        if (!amount || amount <= 0) {
          toast('Please enter a valid monthly amount', 'error');
          return;
        }

        const payload = {
          id: existingSip?.id,
          mandate_id: mandateId,
          scheme_name: schemeName,
          monthly_amount: amount,
          debit_day: debitDay,
          account_id: accountId,
          investment_type: selectedType,
          isin,
          folio_number: folio,
          step_up_percent: stepUp,
          step_up_month: stepUpMonth,
          start_date: startDate,
          end_date: endDate,
          is_active: existingSip?.is_active ?? 1,
          member_id: app.memberFilter,
        };

        const res = await Bridge.db('save_sip', payload);
        if (res.status !== 'success') {
          toast(res.message || 'Failed to save SIP', 'error');
          return;
        }

        const savedSipId = res.id || existingSip?.id;

        // Auto-check for past transactions to link if newly created or amount changed
        if (!isEditing || existingSip.monthly_amount !== amount) {
          const matchRes = await Bridge.db('find_sip_matching_transactions', {
            sip_id: savedSipId,
            isin,
            scheme_name: schemeName,
            amount,
            account_id: accountId,
          });

          const bankMatches = matchRes.bank_transactions || [];
          const casMatches = matchRes.cas_transactions || [];
          const totalMatches = bankMatches.length + casMatches.length;

          if (totalMatches > 0) {
            close(null);
            const shouldLink = await confirmDialog(
              'Link Past Transactions?',
              `Found ${bankMatches.length} matching bank debits and ${casMatches.length} statement records. Would you like to link them now?`,
              { confirmLabel: 'Link' },
            );
            if (shouldLink) {
              await Bridge.db('link_sip_transactions', {
                sip_id: savedSipId,
                bank_transaction_ids: bankMatches.map((t) => t.id),
                cas_transaction_ids: casMatches.map((t) => t.id),
              });
              await Bridge.db('reconcile_sips');
              toast(`Linked ${totalMatches} transactions`, 'success');
            }
            if (onRefresh) onRefresh();
            return;
          }
        }

        await Bridge.db('reconcile_sips');
        toast('SIP saved', 'success');
        close(null);
        if (onRefresh) onRefresh();
      });
    },
  });
}

/**
 * Form sheet to create or edit an Umbrella Mandate with dynamic child fund splits.
 */
export async function openMandateFormSheet(app, existingMandate = null, onRefresh = null) {
  const [accountsRes, investRes] = await Promise.all([
    Bridge.db('list_records', { record_type: 'account', member_id: app.memberFilter }),
    Bridge.db('list_investments', { member_id: app.memberFilter }),
  ]);

  const accounts = accountsRes.records || [];
  const holdings = investRes.holdings || [];

  const accountOptions = [
    { value: '', label: 'Select Bank Account' },
    ...accounts.map((a) => ({ value: String(a.id), label: `${a.name}${a.account_number ? ` (···${a.account_number.slice(-4)})` : ''}` })),
  ];

  const dayOptions = DAY_OPTIONS.map((d) => ({ value: d, label: `Day ${d}` }));

  const initialSplits = existingMandate?.splits?.length
    ? existingMandate.splits
    : [
      { scheme_name: '', monthly_amount: '' },
    ];

  const money = (val) => formatCurrency(val, app.currency, app.locale);

  const formHtml = `
    <div class="field">
      <label class="field-label" for="mandateName">Mandate Name *</label>
      <input class="input" id="mandateName" placeholder="e.g. BSE Star MF (Groww) or ICCL Mandate" value="${h(existingMandate?.name || '')}" required autocomplete="off">
    </div>

    <div class="row-between" style="gap:10px">
      <div class="field" style="flex:1">
        <label class="field-label" for="mandateTotal">Total Mandate Amount *</label>
        <input class="input numeric" id="mandateTotal" type="number" step="500" placeholder="15000" value="${existingMandate?.monthly_amount || ''}" required>
      </div>
      <div class="field" style="flex:1">
        ${selectField({
    key: 'debit_day',
    id: 'mandateDebitDay',
    label: 'Debit Day',
    value: String(existingMandate?.debit_day || '5'),
    options: dayOptions,
  })}
      </div>
    </div>

    <div class="row-between" style="gap:10px">
      <div class="field" style="flex:1">
        ${selectField({
    key: 'bank_account_id',
    id: 'mandateAccountId',
    label: 'Bank Account',
    value: String(existingMandate?.bank_account_id || ''),
    options: accountOptions,
  })}
      </div>
      <div class="field" style="flex:1">
        <label class="field-label" for="mandateKeyword">SMS / Bank Keyword</label>
        <input class="input" id="mandateKeyword" placeholder="bse star, groww, nach" value="${h(existingMandate?.merchant_key || '')}" autocomplete="off">
      </div>
    </div>

    <!-- Child Fund Splits Builder -->
    <div class="section" style="margin-top:var(--gap-3)">
      <div class="row-between" style="align-items:center;margin-bottom:8px">
        <span class="title" style="font-size:14px">Child Fund Splits</span>
        <button type="button" class="btn btn-xs btn-tonal" data-add-split-btn>
          ${icon('add', 'icon-sm')} Add Fund
        </button>
      </div>

      <div data-splits-container>
        <!-- Populated dynamically in onMount -->
      </div>

      <div class="split-total-status" data-split-status>
        <span>Sum of splits: <span data-split-sum>₹0</span></span>
        <span data-split-balance-tag class="badge badge-due">Balanced</span>
      </div>
    </div>
  `;

  await sheet(existingMandate ? 'Edit Mandate' : 'Add Umbrella Mandate', formHtml, {
    actions: `
      <button class="btn btn-filled btn-block" data-submit-mandate>${icon('check', 'icon-sm')} Save Mandate</button>
      <button class="btn btn-outlined btn-block" data-cancel style="margin-top:8px">Cancel</button>`,
    onMount(node, close) {
      bindSelectFields(node);

      const splitsContainer = node.querySelector('[data-splits-container]');
      const splitSumEl = node.querySelector('[data-split-sum]');
      const splitStatusEl = node.querySelector('[data-split-status]');
      const splitBalanceTag = node.querySelector('[data-split-balance-tag]');
      const totalInput = node.querySelector('#mandateTotal');

      let currentSplits = JSON.parse(JSON.stringify(initialSplits));

      function renderSplits() {
        splitsContainer.innerHTML = currentSplits.map((sp, idx) => `
          <div class="split-builder-item" data-split-idx="${idx}">
            <input class="input" data-split-scheme style="flex:2;min-width:0" placeholder="Fund Name" value="${h(sp.scheme_name || '')}">
            <input class="input numeric" data-split-amt style="flex:1;min-width:70px" type="number" placeholder="Amount" value="${sp.monthly_amount || ''}">
            <button class="icon-button" data-remove-split="${idx}" aria-label="Remove split" style="color:var(--expense)">
              ${icon('close', 'icon-sm')}
            </button>
          </div>`).join('');

        // Wire inputs
        splitsContainer.querySelectorAll('[data-split-scheme]').forEach((input) => {
          input.addEventListener('input', (e) => {
            const idx = Number(e.target.closest('[data-split-idx]').dataset.splitIdx);
            currentSplits[idx].scheme_name = e.target.value;
          });
        });

        splitsContainer.querySelectorAll('[data-split-amt]').forEach((input) => {
          input.addEventListener('input', (e) => {
            const idx = Number(e.target.closest('[data-split-idx]').dataset.splitIdx);
            currentSplits[idx].monthly_amount = Number(e.target.value) || 0;
            updateStatus();
          });
        });

        splitsContainer.querySelectorAll('[data-remove-split]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            const idx = Number(btn.dataset.removeSplit);
            if (currentSplits.length <= 1) {
              toast('At least one child split is required', 'error');
              return;
            }
            currentSplits.splice(idx, 1);
            renderSplits();
            updateStatus();
          });
        });

        updateStatus();
      }

      function updateStatus() {
        const sum = currentSplits.reduce((acc, s) => acc + (Number(s.monthly_amount) || 0), 0);
        const total = Number(totalInput.value) || 0;
        splitSumEl.textContent = money(sum);

        if (total > 0 && Math.abs(sum - total) < 0.01) {
          splitStatusEl.className = 'split-total-status balanced';
          splitBalanceTag.className = 'badge badge-allotted';
          splitBalanceTag.textContent = 'Balanced';
        } else {
          splitStatusEl.className = 'split-total-status mismatch';
          splitBalanceTag.className = 'badge badge-warning';
          const diff = total - sum;
          splitBalanceTag.textContent = diff > 0 ? `${money(diff)} remaining` : `${money(Math.abs(diff))} excess`;
        }
      }

      renderSplits();

      totalInput.addEventListener('input', updateStatus);

      node.querySelector('[data-add-split-btn]').addEventListener('click', () => {
        currentSplits.push({ scheme_name: '', monthly_amount: '' });
        renderSplits();
      });

      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));

      node.querySelector('[data-submit-mandate]').addEventListener('click', async () => {
        const name = node.querySelector('#mandateName').value.trim();
        const total = Number(totalInput.value);
        const debitDay = Number(node.querySelector('#mandateDebitDay').value) || 5;
        const accountId = node.querySelector('#mandateAccountId').value ? Number(node.querySelector('#mandateAccountId').value) : null;
        const keyword = node.querySelector('#mandateKeyword').value.trim();

        if (!name) {
          toast('Please enter a mandate name', 'error');
          return;
        }
        if (!total || total <= 0) {
          toast('Please enter a total mandate amount', 'error');
          return;
        }

        const validSplits = currentSplits
          .map((s) => ({ ...s, scheme_name: s.scheme_name.trim(), monthly_amount: Number(s.monthly_amount) || 0 }))
          .filter((s) => s.scheme_name.length > 0 && s.monthly_amount > 0);

        if (!validSplits.length) {
          toast('Please add at least one child fund split', 'error');
          return;
        }

        const sum = validSplits.reduce((acc, s) => acc + s.monthly_amount, 0);
        if (Math.abs(sum - total) >= 0.01) {
          toast(`Split total (${money(sum)}) does not equal mandate total (${money(total)})`, 'error');
          return;
        }

        const payload = {
          id: existingMandate?.id,
          name,
          merchant_key: keyword,
          bank_account_id: accountId,
          monthly_amount: total,
          debit_day: debitDay,
          member_id: app.memberFilter,
          splits: validSplits,
        };

        const res = await Bridge.db('save_sip_mandate', payload);
        if (res.status !== 'success') {
          toast(res.message || 'Failed to save mandate', 'error');
          return;
        }

        await Bridge.db('reconcile_sips');
        toast('Mandate saved successfully', 'success');
        close(null);
        if (onRefresh) onRefresh();
      });
    },
  });
}

/**
 * Wizard to review and track candidate SIPs and umbrella mandates discovered from statements & SMS.
 */
export async function openDiscoverSipsWizard(app, onRefresh = null) {
  const modal = showProgressModal('Scanning Statements & SMS', {
    message: 'Correlating bank debits with portfolio purchases...',
    initialPercent: 25,
  });

  const res = await Bridge.db('discover_sips', { member_id: app.memberFilter });
  modal.close();

  const candidatesCount = res.total_candidates ?? ((res.discovered_mandates?.length || 0) + (res.discovered_sips?.length || 0));

  if (res.status !== 'success' || candidatesCount === 0) {
    const foliosRes = await Bridge.db('list_folios').catch(() => ({}));
    const hasFolios = (foliosRes?.folios?.length || 0) > 0;

    const goAction = await confirmDialog(
      'No SIPs Discovered',
      hasFolios
        ? 'No new recurring monthly mutual fund or stock patterns were found in your current records. You can add a SIP manually.'
        : 'No mutual fund statement records found. Import your CAMS or KFintech CAS statement PDF under Wealth > Account Statement first to discover recurring SIPs, or add your SIPs manually.',
      {
        confirmLabel: hasFolios ? 'Add SIP' : 'Import Statement',
        cancelLabel: 'Close',
      },
    );

    if (goAction) {
      if (hasFolios) {
        openSipFormSheet(app, null, null, onRefresh);
      } else {
        app.open('cas');
      }
    }
    return;
  }

  const discoveredMandates = res.discovered_mandates || [];
  const discoveredSips = res.discovered_sips || [];
  const money = (val) => formatCurrency(val, app.currency, app.locale);

  const formHtml = `
    <div style="margin-bottom:var(--gap-3)">
      <div class="caption">
        Correlated ${discoveredMandates.length} umbrella mandates and ${discoveredSips.length} standalone plans from your financial history.
      </div>
    </div>

    <!-- Candidate Mandates -->
    ${discoveredMandates.length ? `
      <div class="section" style="margin-bottom:var(--gap-3)">
        <div class="section-header">
          <span class="title" style="font-size:14px">Discovered Umbrella Mandates</span>
        </div>
        ${discoveredMandates.map((m, idx) => `
          <div class="card-flat" style="background:var(--surface-container-high);border:1px solid var(--outline-variant);border-radius:var(--radius-md);padding:12px;margin-bottom:8px">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
              <input type="checkbox" data-disc-mandate-idx="${idx}" checked style="width:18px;height:18px">
              <div style="min-width:0;flex:1">
                <div style="font-weight:600;font-size:13.5px;color:var(--on-surface)">${h(m.name)}</div>
                <div class="caption">Day ${m.debit_day} · Total ${h(money(m.total_amount))} / mo</div>
              </div>
            </label>
            <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--outline-variant)">
              <div class="caption" style="font-size:11px;margin-bottom:4px">Funds in this mandate:</div>
              ${m.splits.map((s) => `
                <div class="row-between" style="font-size:12px;padding:2px 0">
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(s.scheme_name)}</span>
                  <span style="font-weight:600">${h(money(s.monthly_amount))}</span>
                </div>`).join('')}
            </div>
          </div>`).join('')}
      </div>` : ''}

    <!-- Candidate Standalone SIPs -->
    ${discoveredSips.length ? `
      <div class="section">
        <div class="section-header">
          <span class="title" style="font-size:14px">Discovered Systematic Plans</span>
        </div>
        ${discoveredSips.map((sip, idx) => `
          <div class="card-flat" style="background:var(--surface-container-high);border:1px solid var(--outline-variant);border-radius:var(--radius-md);padding:10px 12px;margin-bottom:6px">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
              <input type="checkbox" data-disc-sip-idx="${idx}" checked style="width:18px;height:18px">
              <div style="min-width:0;flex:1">
                <div style="font-weight:600;font-size:13px;color:var(--on-surface)">${h(sip.scheme_name)}</div>
                <div class="caption">
                  ${h([
    `Day ${sip.debit_day}`,
    sip.folio_number ? `Folio ${sip.folio_number}` : null,
    sip.source === 'cas_recurring' ? 'CAMS Recurring' : 'SMS Debit',
  ].filter(Boolean).join(' · '))}
                </div>
              </div>
              <span style="font-weight:600;font-size:13px">${h(money(sip.monthly_amount))}</span>
            </label>
          </div>`).join('')}
      </div>` : ''}
  `;

  await sheet('Discovered SIPs', formHtml, {
    actions: `
      <button class="btn btn-filled btn-block" data-confirm-discovery>${icon('check', 'icon-sm')} Track Selected</button>
      <button class="btn btn-outlined btn-block" data-cancel style="margin-top:8px">Cancel</button>`,
    onMount(node, close) {
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));

      node.querySelector('[data-confirm-discovery]').addEventListener('click', async () => {
        const selectedMandates = [];
        node.querySelectorAll('[data-disc-mandate-idx]:checked').forEach((cb) => {
          const idx = Number(cb.dataset.discMandateIdx);
          selectedMandates.push(discoveredMandates[idx]);
        });

        const selectedSips = [];
        node.querySelectorAll('[data-disc-sip-idx]:checked').forEach((cb) => {
          const idx = Number(cb.dataset.discSipIdx);
          selectedSips.push(discoveredSips[idx]);
        });

        if (!selectedMandates.length && !selectedSips.length) {
          toast('No candidates selected', 'error');
          return;
        }

        const confirmRes = await Bridge.db('confirm_discovered_sips', {
          mandates: selectedMandates,
          sips: selectedSips,
        });

        if (confirmRes.status !== 'success') {
          toast(confirmRes.message || 'Failed to confirm discovered SIPs', 'error');
          return;
        }

        await Bridge.db('reconcile_sips');
        toast(`Tracked ${selectedMandates.length} mandates and ${selectedSips.length} SIPs`, 'success');
        close(null);
        if (onRefresh) onRefresh();
      });
    },
  });
}

/**
 * Manual picker dialog to link an unlinked execution cycle to a specific transaction.
 */
async function openManualLinkModal(app, sip, onRefresh) {
  const matchRes = await Bridge.db('find_sip_matching_transactions', {
    sip_id: sip.id,
    isin: sip.isin,
    scheme_name: sip.scheme_name,
    amount: sip.monthly_amount,
    account_id: sip.account_id,
    lookback_months: 6,
  });

  const bankTx = matchRes.bank_transactions || [];
  const casTx = matchRes.cas_transactions || [];
  const money = (val) => formatCurrency(val, app.currency, app.locale);

  if (!bankTx.length && !casTx.length) {
    toast('No candidate unlinked transactions found', 'info');
    return;
  }

  const formHtml = `
    <div class="caption" style="margin-bottom:var(--gap-3)">
      Select transactions to link to "${h(sip.scheme_name)}".
    </div>

    ${bankTx.length ? `
      <div class="section" style="margin-bottom:var(--gap-3)">
        <div class="caption" style="font-weight:600;margin-bottom:6px">Bank Debits (${bankTx.length})</div>
        ${bankTx.map((tx) => `
          <label class="card-flat" style="display:flex;align-items:center;gap:10px;background:var(--surface-container-high);padding:8px 10px;border-radius:var(--radius-sm);margin-bottom:4px;cursor:pointer">
            <input type="checkbox" data-link-bank-id="${tx.id}">
            <div style="min-width:0;flex:1">
              <div style="font-size:12.5px;font-weight:600">${h(money(tx.amount))} · ${h(formatDate(tx.date))}</div>
              <div class="caption">${h(tx.notes || tx.account_name || 'Debit')}</div>
            </div>
          </label>`).join('')}
      </div>` : ''}

    ${casTx.length ? `
      <div class="section">
        <div class="caption" style="font-weight:600;margin-bottom:6px">CAMS Allotments (${casTx.length})</div>
        ${casTx.map((tx) => `
          <label class="card-flat" style="display:flex;align-items:center;gap:10px;background:var(--surface-container-high);padding:8px 10px;border-radius:var(--radius-sm);margin-bottom:4px;cursor:pointer">
            <input type="checkbox" data-link-cas-id="${tx.id}">
            <div style="min-width:0;flex:1">
              <div style="font-size:12.5px;font-weight:600">${Number(tx.units || 0).toFixed(3)} units · ${h(money(tx.amount))}</div>
              <div class="caption">${h(formatDate(tx.date))} · NAV ${h(money(tx.nav || 0))}</div>
              ${formatCostBreakdownBadges(tx, money)}
            </div>
          </label>`).join('')}
      </div>` : ''}
  `;

  await sheet('Link Transactions', formHtml, {
    actions: `
      <button class="btn btn-filled btn-block" data-submit-links>${icon('check', 'icon-sm')} Link Selected</button>
      <button class="btn btn-outlined btn-block" data-cancel style="margin-top:8px">Cancel</button>`,
    onMount(node, close) {
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));

      node.querySelector('[data-submit-links]').addEventListener('click', async () => {
        const bankIds = [];
        node.querySelectorAll('[data-link-bank-id]:checked').forEach((cb) => bankIds.push(Number(cb.dataset.linkBankId)));

        const casIds = [];
        node.querySelectorAll('[data-link-cas-id]:checked').forEach((cb) => casIds.push(Number(cb.dataset.linkCasId)));

        if (!bankIds.length && !casIds.length) {
          toast('Select at least one transaction', 'error');
          return;
        }

        await Bridge.db('link_sip_transactions', {
          sip_id: sip.id,
          bank_transaction_ids: bankIds,
          cas_transaction_ids: casIds,
        });

        await Bridge.db('reconcile_sips');
        toast('Transactions linked', 'success');
        close(null);
        openSipDetailsSheet(app, sip.id, onRefresh);
      });
    },
  });
}
