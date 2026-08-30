import { Bridge } from '../bridge.js';
import {
  icon, h, toast, errorBlock, confirmDialog, showProgressModal,
} from '../ui.js';
import { formatCurrency } from '../formatters.js';

export async function renderSmsIngest(container, app) {
  const isInitial = app.pageArgs?.initialSetup;
  let selectedDays = 90;
  let isScanning = false;

  container.innerHTML = `
    <div class="card" style="text-align:center;padding:var(--gap-6) var(--gap-4)">
      <div class="setup-hero" style="margin:0 auto var(--gap-4);animation:pulse 2s infinite">
        ${icon('sms')}
      </div>
      <h1 class="headline" style="font-size:22px;margin-bottom:var(--gap-2)">
        Scan Bank SMS
      </h1>
      <p class="caption" style="max-width:36ch;margin:0 auto var(--gap-5)">
        Scan bank alerts on this device to populate your ledger and detect recurring payments.
      </p>

      <div class="field" style="text-align:left;margin-bottom:var(--gap-5)" data-options-section>
        <label class="field-label">Scan range</label>
        <div class="list" style="margin-top:var(--gap-2)">
          <label class="list-row" style="cursor:pointer">
            <span class="avatar avatar-sm" style="background:var(--accent-container);color:var(--on-accent-container)">
              ${icon('schedule', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">Last 90 days</span>
              <span class="caption">Fast scan · 90 days</span>
            </span>
            <input type="radio" name="scanRange" value="90" checked>
          </label>
          <label class="list-row" style="cursor:pointer">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
              ${icon('calendar_month', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">Last 1 year</span>
              <span class="caption">Past 365 days of transactions</span>
            </span>
            <input type="radio" name="scanRange" value="365">
          </label>
          <label class="list-row" style="cursor:pointer">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
              ${icon('history', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">All time</span>
              <span class="caption">Complete SMS inbox history</span>
            </span>
            <input type="radio" name="scanRange" value="0">
          </label>
        </div>
      </div>

      <div class="card-flat" style="display:none;margin-bottom:var(--gap-5);text-align:left" data-progress-section>
        <div class="row" style="justify-content:space-between;margin-bottom:var(--gap-2)">
          <span class="list-row-title" data-progress-status style="font-size:13px">Reading SMS inbox...</span>
          <span class="caption" data-progress-pct>0%</span>
        </div>
        <div class="progress" style="height:10px;margin-bottom:var(--gap-3)">
          <div class="progress-bar" data-progress-bar style="width:5%"></div>
        </div>
        <p class="caption" data-progress-desc style="font-size:12px">
          Matching bank alerts against classification rules on-device...
        </p>
      </div>

      <div class="card-flat" style="display:none;margin-bottom:var(--gap-5);text-align:left" data-result-section>
        <div class="row" style="gap:10px;align-items:center;margin-bottom:var(--gap-3)">
          <span class="avatar avatar-sm" style="background:var(--income-container);color:var(--income)">
            ${icon('check', 'icon-sm')}
          </span>
          <span class="list-row-title" style="font-size:15px">Scan Complete</span>
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap" data-stat-chips></div>
      </div>

      <div class="row" style="gap:10px;justify-content:center" data-action-buttons>
        <button class="btn btn-filled btn-block" data-start-scan>
          ${icon('autorenew')}Start Scan
        </button>
        <button class="btn btn-outlined btn-block" data-skip style="margin-top:8px">
          ${isInitial ? 'Skip' : 'Cancel'}
        </button>
      </div>
    </div>`;

  const optionsSection = container.querySelector('[data-options-section]');
  const progressSection = container.querySelector('[data-progress-section]');
  const resultSection = container.querySelector('[data-result-section]');
  const progressBar = container.querySelector('[data-progress-bar]');
  const progressStatus = container.querySelector('[data-progress-status]');
  const progressPct = container.querySelector('[data-progress-pct]');
  const progressDesc = container.querySelector('[data-progress-desc]');
  const statChips = container.querySelector('[data-stat-chips]');
  const actionButtons = container.querySelector('[data-action-buttons]');
  const startBtn = container.querySelector('[data-start-scan]');
  const skipBtn = container.querySelector('[data-skip]');

  container.querySelectorAll('input[name="scanRange"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      selectedDays = Number(e.target.value);
    });
  });

  const runScan = async () => {
    if (isScanning) return;

    if (!Bridge.checkPermission('SMS')) {
      if (Bridge.permissionIsBlocked('SMS')) {
        const goSettings = await confirmDialog(
          'SMS Permission Required',
          'Bank SMS scanning requires SMS permission to read transaction messages on this device. Please allow SMS permission in settings.',
          { confirmLabel: 'Open Settings' },
        );
        if (goSettings) Bridge.openAppSettings();
        return;
      }
      await Bridge.requestPermission('SMS');
      if (!Bridge.checkPermission('SMS')) {
        toast('SMS permission is required to scan bank alerts.', 'error');
        return;
      }
      Bridge.setSmsTrackingEnabled(true);
    }

    isScanning = true;

    optionsSection.style.display = 'none';
    resultSection.style.display = 'none';
    progressSection.style.display = 'block';
    actionButtons.innerHTML = `
      <button class="btn btn-tonal btn-block" disabled>
        ${icon('autorenew')}Scanning in progress...
      </button>`;

    // Animate initial progress stages
    progressBar.style.width = '25%';
    progressPct.textContent = '25%';
    progressStatus.textContent = 'Reading bank alerts from inbox...';
    progressDesc.textContent = 'Filtering financial messages locally...';

    await new Promise((r) => setTimeout(r, 400));

    progressBar.style.width = '60%';
    progressPct.textContent = '60%';
    progressStatus.textContent = 'Categorizing debits and credits...';
    progressDesc.textContent = 'Applying merchant rules and detecting accounts...';

    const memberId = app.memberFilter === 'all' ? 1 : Number(app.memberFilter || 1);
    const res = await Bridge.call('sms', {
      action: 'reimport',
      days: selectedDays,
      member_id: memberId,
    });

    progressBar.style.width = '100%';
    progressPct.textContent = '100%';
    progressStatus.textContent = 'Finalizing transactions...';

    await new Promise((r) => setTimeout(r, 300));
    progressSection.style.display = 'none';

    if (res.status !== 'success') {
      resultSection.style.display = 'block';
      resultSection.innerHTML = errorBlock(res, { compact: false });
      actionButtons.innerHTML = `
        <button class="btn btn-filled btn-block" data-done>Go to Dashboard</button>`;
      container.querySelector('[data-done]').addEventListener('click', () => app.open('home'));
      return;
    }

    // Check for discovered accounts & cards
    const discoverRes = await Bridge.db('discover_accounts_from_sms');
    const discovered = discoverRes?.discovered || [];

    // Success rendering
    resultSection.style.display = 'block';
    statChips.innerHTML = `
      <span class="badge badge-income" style="font-size:12px;padding:6px 12px">
        ${icon('receipt_long', 'icon-sm')} ${res.imported || 0} Filed
      </span>
      <span class="badge badge-tonal" style="font-size:12px;padding:6px 12px">
        ${icon('sms', 'icon-sm')} ${res.read || 0} Read
      </span>
      <span class="badge badge-tonal" style="font-size:12px;padding:6px 12px">
        ${icon('check', 'icon-sm')} ${res.skipped || 0} Existing
      </span>`;

    if (discovered.length) {
      resultSection.insertAdjacentHTML('beforeend', `
        <div style="margin-top:var(--gap-4);border-top:1px solid var(--outline-variant);padding-top:var(--gap-3)">
          <div class="row-between" style="align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:var(--gap-2)">
            <div class="row" style="gap:6px;align-items:center;min-width:0">
              <span style="color:var(--accent);display:flex;flex-shrink:0">${icon('star', 'icon-sm')}</span>
              <span style="font-weight:700;font-size:13.5px;white-space:nowrap">Discovered Accounts</span>
              <span class="badge badge-income" style="font-size:11px;padding:2px 8px">${discovered.length}</span>
            </div>
            <button class="btn btn-filled btn-xs" data-ingest-add-all style="flex-shrink:0">
              ${icon('check_circle', 'icon-sm')}Add All
            </button>
          </div>
          <p class="caption" style="margin-bottom:var(--gap-3)">
            Detected bank accounts, food cards, and credit cards from your SMS alerts.
          </p>
          <div class="list" data-discovered-list style="background:transparent;box-shadow:none;display:flex;flex-direction:column;gap:8px">
            ${discovered.map((d, i) => {
              const isCredit = d.instrument_type === 'credit_card';
              const isDebit = d.instrument_type === 'debit_card';
              const isMeal = d.instrument_type === 'meal_card' || d.category === 'Meal Card';
              const isWallet = d.instrument_type === 'wallet' || d.category === 'Wallet';
              const isPrepaid = d.instrument_type === 'prepaid_card' || d.category === 'Prepaid Card';

              let glyph = 'account_balance';
              let avatarClass = 'avatar-bank';
              let label = 'Savings';

              if (isCredit) {
                glyph = 'credit_card';
                avatarClass = 'avatar-credit';
                label = 'Credit Card';
              } else if (isDebit) {
                glyph = 'payments';
                avatarClass = 'avatar-debit';
                label = 'Debit Card';
              } else if (isMeal) {
                glyph = 'restaurant';
                avatarClass = 'avatar-meal';
                label = 'Meal Card';
              } else if (isWallet) {
                glyph = 'account_balance_wallet';
                avatarClass = 'avatar-wallet';
                label = 'Wallet';
              } else if (isPrepaid) {
                glyph = 'credit_card';
                avatarClass = 'avatar-debit';
                label = 'Prepaid Card';
              }

              return `
              <div class="card-flat" style="background:var(--surface-container-high);padding:12px 14px;border-radius:var(--radius-md);border:1px solid var(--outline-variant);display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box">
                <span class="avatar avatar-sm ${avatarClass}" style="flex-shrink:0">
                  ${icon(glyph, 'icon-sm')}
                </span>
                <span class="list-row-main" style="min-width:0">
                  <span class="list-row-title">${h(d.suggested_name || d.name || d.card_name)}</span>
                  <span class="list-row-sub">${h(d.bank || d.institution)} · ${h(label)} · ending ${h(d.last_4)}</span>
                  ${d.balance ? `<span class="caption" style="color:var(--income);font-size:11.5px;margin-top:2px;display:block">Latest Bal: ${h(formatCurrency(d.balance, app.currency, app.locale))}</span>` : ''}
                  ${isCredit && (d.total_limit || d.current_balance) ? `<span class="caption" style="color:var(--expense);font-size:11.5px;margin-top:2px;display:block">${d.current_balance ? `Bal: ${h(formatCurrency(d.current_balance, app.currency, app.locale))}` : ''}${d.total_limit ? ` · Limit: ${h(formatCurrency(d.total_limit, app.currency, app.locale))}` : ''}</span>` : ''}
                  ${d.txn_count ? `<span class="caption" style="color:var(--accent);font-size:11.5px;margin-top:2px;display:block">${d.txn_count} transaction${d.txn_count === 1 ? '' : 's'}${d.total_spent ? ` · ${h(formatCurrency(d.total_spent, app.currency, app.locale))}` : ''}</span>` : ''}
                </span>
                <button class="btn btn-filled btn-xs" data-ingest-add="${i}" style="flex-shrink:0;padding:6px 10px">
                  ${icon('add', 'icon-sm')}Add
                </button>
              </div>`;
            }).join('')}
          </div>
        </div>`);

      resultSection.querySelectorAll('[data-ingest-add]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const item = discovered[Number(btn.dataset.ingestAdd)];
          if (!item) return;
          btn.disabled = true;
          btn.textContent = 'Adding...';

          const isCard = item.kind === 'card' || item.instrument_type === 'credit_card';
          const isDebit = item.is_debit_card || item.instrument_type === 'debit_card';
          const bank = item.bank || item.institution || 'Bank';
          const last4 = item.last_4 || '';

          const recordPayload = isCard ? {
            card_name: item.suggested_name || item.name || `${bank} Credit Card`,
            bank,
            last_4: last4,
            total_limit: item.total_limit || 0,
            available_limit: item.available_limit !== null && item.available_limit !== undefined ? item.available_limit : 0,
            current_balance: item.current_balance || 0,
          } : {
            name: item.suggested_name || item.name || `${bank} Account`,
            category: item.category || (isDebit ? 'Bank' : (item.instrument_type === 'meal_card' ? 'Meal Card' : (item.instrument_type === 'wallet' ? 'Wallet' : 'Bank'))),
            institution: bank,
            account_number: isDebit ? (item.account_number || '') : (last4 || item.account_number || ''),
            debit_card_last_4: isDebit ? (last4 || '') : (item.debit_card_last_4 || ''),
            balance: item.balance || 0,
          };

          const saveRes = await Bridge.db('save_record', {
            record_type: isCard ? 'card' : 'account',
            record: recordPayload,
          });

          if (saveRes && saveRes.status === 'success') {
            await Bridge.db('ignore_discovered_account', {
              issuer: bank,
              last_4: last4,
              instrument_type: item.instrument_type,
            });
            toast(`Added ${recordPayload.name || recordPayload.card_name}!`, 'success');
            btn.innerHTML = `${icon('check', 'icon-sm')}Added`;
            btn.classList.replace('btn-filled', 'btn-tonal');
          } else {
            toast(saveRes?.message || 'Could not add record.', 'error');
            btn.disabled = false;
            btn.innerHTML = `${icon('add', 'icon-sm')}Add`;
          }
        });
      });

      const addAllBtn = resultSection.querySelector('[data-ingest-add-all]');
      if (addAllBtn) {
        addAllBtn.addEventListener('click', async () => {
          addAllBtn.disabled = true;
          const progress = showProgressModal('Adding Discovered Accounts', {
            message: `Saving ${discovered.length} accounts & cards to vault...`,
            initialPercent: 40,
            detail: 'Writing records into encrypted database',
          });

          const res = await Bridge.db('add_discovered_accounts', {
            accounts: discovered,
            member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter || 1),
          });

          if (res && res.status === 'success') {
            progress.complete(`Added ${res.added} accounts & cards!`, 350);
            toast(`Added ${res.added} accounts and cards!`, 'success');
            resultSection.querySelectorAll('[data-ingest-add]').forEach((b) => {
              b.disabled = true;
              b.innerHTML = `${icon('check', 'icon-sm')}Added`;
              b.classList.replace('btn-filled', 'btn-tonal');
            });
            addAllBtn.innerHTML = `${icon('check', 'icon-sm')}Added All`;
          } else {
            progress.fail('Could not add accounts.');
            toast('Could not add accounts.', 'error');
          }
        });
      }
    }

    if (res.imported > 0) {
      toast(`Successfully imported ${res.imported} transactions from bank messages!`, 'success');
    } else {
      toast(`Scan complete. ${res.read} messages reviewed.`, 'info');
    }

    actionButtons.innerHTML = `
      <button class="btn btn-filled btn-block" data-go-home>
        ${icon('dashboard')}Go to Dashboard
      </button>`;

    container.querySelector('[data-go-home]').addEventListener('click', () => app.open('home'));

    // Auto-advance if initial setup and no pending manual actions
    if (isInitial && discovered.length === 0) {
      setTimeout(() => {
        if (container.isConnected) app.open('home');
      }, 2500);
    }
  };

  startBtn.addEventListener('click', runScan);
  skipBtn.addEventListener('click', () => app.open('home'));

  // If initial setup, automatically begin scanning with 90-day default
  if (isInitial) {
    runScan();
  }
}
