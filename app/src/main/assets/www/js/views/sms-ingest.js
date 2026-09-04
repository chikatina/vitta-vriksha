import { Bridge } from '../bridge.js';
import {
  icon, h, toast, errorBlock, confirmDialog, showProgressModal,
} from '../ui.js';
import { formatCurrency, formatDate } from '../formatters.js';

export async function renderSmsIngest(container, app) {
  const isInitial = app.pageArgs?.initialSetup;
  let selectedDays = 0;
  let isScanning = false;
  let autoLandTimer = null;

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
              ${icon('history', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">All time</span>
              <span class="caption">Complete SMS inbox history (Recommended)</span>
            </span>
            <input type="radio" name="scanRange" value="0" checked>
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
              ${icon('schedule', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">Last 90 days</span>
              <span class="caption">Fast scan · 90 days</span>
            </span>
            <input type="radio" name="scanRange" value="90">
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
        <div data-autoland-banner style="margin-top:var(--gap-3)"></div>
        <div data-classification-content style="margin-top:var(--gap-3)"></div>
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
  const autolandBanner = container.querySelector('[data-autoland-banner]');
  const classificationContent = container.querySelector('[data-classification-content]');
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

    // Check for discovered accounts & duplicate alerts
    const [discoverRes, reviewRes] = await Promise.all([
      Bridge.db('discover_accounts_from_sms'),
      Bridge.call('sms', { action: 'review', days: 0, filter: 'pending' }),
    ]);

    const discovered = discoverRes?.discovered || [];
    let dupList = (reviewRes?.items || []).filter((i) => i.duplicate_of > 0 || i.reason === 'possible-duplicate');
    const addedIndices = new Set();

    resultSection.style.display = 'block';

    const renderSummaryAndSections = () => {
      // Stat chips
      statChips.innerHTML = `
        <span class="badge badge-income" style="font-size:12px;padding:6px 12px">
          ${icon('receipt_long', 'icon-sm')} ${res.imported || 0} Filed
        </span>
        <span class="badge ${dupList.length ? 'badge-warning' : 'badge-tonal'}" style="font-size:12px;padding:6px 12px">
          ${icon('content_copy', 'icon-sm')} ${dupList.length} Duplicates
        </span>
        <span class="badge ${discovered.length ? 'badge-accent' : 'badge-tonal'}" style="font-size:12px;padding:6px 12px">
          ${icon('star', 'icon-sm')} ${discovered.length} Discovered
        </span>
        <span class="badge badge-tonal" style="font-size:12px;padding:6px 12px">
          ${icon('sms', 'icon-sm')} ${res.read || 0} Read
        </span>`;

      let sectionsHtml = '';

      // 1. Discovered Accounts Section
      if (discovered.length) {
        const unaddedCount = discovered.filter((_, i) => !addedIndices.has(i)).length;
        sectionsHtml += `
          <div style="margin-top:var(--gap-3);border-top:1px solid var(--outline-variant);padding-top:var(--gap-3)">
            <div class="row-between" style="align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:var(--gap-2)">
              <div class="row" style="gap:6px;align-items:center;min-width:0">
                <span style="color:var(--accent);display:flex;flex-shrink:0">${icon('star', 'icon-sm')}</span>
                <span style="font-weight:700;font-size:13.5px;white-space:nowrap">Discovered Accounts</span>
                <span class="badge badge-income" style="font-size:11px;padding:2px 8px">${discovered.length}</span>
              </div>
              ${unaddedCount > 0 ? `
                <button class="btn btn-filled btn-xs" data-ingest-add-all style="flex-shrink:0">
                  ${icon('check_circle', 'icon-sm')}Add All (${unaddedCount})
                </button>` : `
                <span class="badge badge-income" style="font-size:11px;padding:3px 8px">
                  ${icon('check', 'icon-sm')}All Added
                </span>`}
            </div>
            <p class="caption" style="margin-bottom:var(--gap-2)">
              Classify as Bank Account or Credit Card before adding to vault.
            </p>
            <div class="virtual-scroll-box" data-discovered-box style="display:flex;flex-direction:column;gap:8px">
              ${discovered.map((d, i) => {
                const isAdded = addedIndices.has(i);
                const isCredit = d.instrument_type === 'credit_card';
                const isDebit = d.instrument_type === 'debit_card';
                const isMeal = d.instrument_type === 'meal_card' || d.category === 'Meal Card';
                const isWallet = d.instrument_type === 'wallet' || d.category === 'Wallet';
                const isPrepaid = d.instrument_type === 'prepaid_card' || d.category === 'Prepaid Card';

                let glyph = 'account_balance';
                let avatarClass = 'avatar-bank';
                let label = 'Savings / Bank';

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
                <div class="card-flat" style="background:var(--surface-container-high);padding:10px 12px;border-radius:var(--radius-md);border:1px solid var(--outline-variant);display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box">
                  <div class="row-between" style="align-items:flex-start;gap:8px">
                    <div class="row" style="gap:10px;align-items:center;min-width:0">
                      <span class="avatar avatar-sm ${avatarClass}" style="flex-shrink:0">
                        ${icon(glyph, 'icon-sm')}
                      </span>
                      <div style="min-width:0">
                        <div class="list-row-title" style="font-size:13.5px">${h(d.suggested_name || d.name || d.card_name)}</div>
                        <div class="list-row-sub" style="font-size:11.5px">${h(d.bank || d.institution)} · ${h(label)} · ending ${h(d.last_4)}</div>
                      </div>
                    </div>
                    <button class="btn ${isAdded ? 'btn-tonal' : 'btn-filled'} btn-xs" data-ingest-add="${i}" ${isAdded ? 'disabled' : ''} style="flex-shrink:0;padding:4px 8px">
                      ${icon(isAdded ? 'check' : 'add', 'icon-sm')}${isAdded ? 'Added' : 'Add'}
                    </button>
                  </div>
                  <div class="row-between" style="align-items:center;padding-top:4px;border-top:1px solid var(--outline-variant);gap:6px">
                    <div class="row" style="gap:4px;align-items:center;flex-wrap:wrap">
                      ${d.balance ? `<span class="caption" style="color:var(--income);font-size:11px;font-weight:600">Bal: ${h(formatCurrency(d.balance, app.currency, app.locale))}</span>` : ''}
                      ${isCredit && (d.total_limit || d.current_balance) ? `<span class="caption" style="color:var(--expense);font-size:11px">${d.current_balance ? `Bal: ${h(formatCurrency(d.current_balance, app.currency, app.locale))}` : ''}${d.total_limit ? ` · Limit: ${h(formatCurrency(d.total_limit, app.currency, app.locale))}` : ''}</span>` : ''}
                      ${d.txn_count ? `<span class="caption" style="font-size:11px;color:var(--on-surface-variant)">${d.txn_count} alert${d.txn_count === 1 ? '' : 's'}</span>` : ''}
                    </div>
                    ${!isAdded ? `
                      <button type="button" class="btn btn-outlined btn-xs" data-toggle-type="${i}" style="gap:3px;padding:3px 6px;font-size:11px;flex-shrink:0">
                        ${icon('autorenew', 'icon-sm')}Make ${isCredit ? 'Bank A/c' : 'Credit Card'}
                      </button>` : ''}
                  </div>
                </div>`;
              }).join('')}
            </div>
          </div>`;
      }

      // 2. Duplicates Section
      if (dupList.length) {
        sectionsHtml += `
          <div style="margin-top:var(--gap-3);border-top:1px solid var(--outline-variant);padding-top:var(--gap-3)">
            <div class="row-between" style="align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:var(--gap-2)">
              <div class="row" style="gap:6px;align-items:center;min-width:0">
                <span style="color:var(--warning);display:flex;flex-shrink:0">${icon('content_copy', 'icon-sm')}</span>
                <span style="font-weight:700;font-size:13.5px;white-space:nowrap">Duplicate Alerts</span>
                <span class="badge badge-warning" style="font-size:11px;padding:2px 8px">${dupList.length}</span>
              </div>
              <button class="btn btn-tonal btn-xs" data-discard-all-dups style="color:var(--expense);gap:3px;flex-shrink:0">
                ${icon('visibility_off', 'icon-sm')}Discard All (${dupList.length})
              </button>
            </div>
            <p class="caption" style="margin-bottom:var(--gap-2)">
              Potential duplicate alerts held from ledger to prevent double-counting.
            </p>
            <div class="virtual-scroll-box" data-dups-box style="display:flex;flex-direction:column;gap:8px">
              ${dupList.map((item, idx) => {
                const twin = item.duplicate_twin;
                return `
                <div class="card-flat" style="background:var(--surface-container-high);padding:10px 12px;border-radius:var(--radius-md);border:1px solid var(--outline-variant);display:flex;flex-direction:column;gap:6px;box-sizing:border-box">
                  <div class="row-between" style="align-items:flex-start;gap:8px">
                    <div style="min-width:0;flex:1">
                      <div class="row" style="gap:6px;align-items:center">
                        <span style="font-weight:700;font-size:14px;color:var(--on-surface)">
                          ${item.amount ? h(formatCurrency(item.amount, app.currency, app.locale)) : 'Amount unclear'}
                        </span>
                        ${item.merchant ? `<span style="font-size:12px;color:var(--on-surface-variant)">· ${h(item.merchant)}</span>` : ''}
                      </div>
                      ${twin ? `
                        <div class="badge badge-warning" style="margin-top:4px;font-size:11px;gap:4px;display:inline-flex;align-items:center">
                          ${icon('content_copy', 'icon-sm')}Matches: ${h(formatCurrency(twin.amount, app.currency, app.locale))} on ${h(formatDate(twin.date))}${twin.merchant ? ` (${h(twin.merchant)})` : ''}
                        </div>` : ''}
                      <div class="caption" style="margin-top:4px;font-size:11px;line-height:1.35;word-break:break-word">${h(item.body.slice(0, 120))}</div>
                    </div>
                    <div class="row" style="gap:4px;flex-shrink:0">
                      <button class="btn btn-filled btn-xs" data-keep-dup="${idx}" style="padding:4px 8px" aria-label="Keep duplicate">
                        ${icon('check', 'icon-sm')}Keep
                      </button>
                      <button class="btn btn-tonal btn-xs" data-discard-dup="${idx}" style="padding:4px 8px;color:var(--expense)" aria-label="Discard duplicate">
                        ${icon('visibility_off', 'icon-sm')}Discard
                      </button>
                    </div>
                  </div>
                </div>`;
              }).join('')}
            </div>
          </div>`;
      }

      classificationContent.innerHTML = sectionsHtml;
      bindInteractiveActions();
      checkAutoLandCondition();
    };

    const checkAutoLandCondition = () => {
      const unaddedCount = discovered.filter((_, i) => !addedIndices.has(i)).length;
      const dupsCount = dupList.length;

      if (autoLandTimer) {
        clearTimeout(autoLandTimer);
        autoLandTimer = null;
      }

      if (unaddedCount === 0 && dupsCount === 0) {
        autolandBanner.innerHTML = `
          <div class="card-flat" style="background:var(--income-container);color:var(--on-income-container);padding:10px 14px;border-radius:var(--radius-md);display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div class="row" style="gap:8px;align-items:center;min-width:0">
              <span style="color:var(--income);display:flex">${icon('check_circle', 'icon-sm')}</span>
              <span style="font-size:12.5px;font-weight:600">All set! Landing on Dashboard in 2s...</span>
            </div>
            <button class="btn btn-filled btn-xs" data-cancel-autoland style="flex-shrink:0">Pause</button>
          </div>`;

        autolandBanner.querySelector('[data-cancel-autoland]')?.addEventListener('click', () => {
          if (autoLandTimer) {
            clearTimeout(autoLandTimer);
            autoLandTimer = null;
          }
          autolandBanner.innerHTML = `
            <div class="caption" style="font-size:12px;color:var(--on-surface-variant)">Auto-landing paused. Tap "Go to Dashboard" below when ready.</div>`;
        });

        autoLandTimer = setTimeout(() => {
          if (container.isConnected) app.open('home');
        }, 2200);
      } else {
        autolandBanner.innerHTML = '';
      }
    };

    const bindInteractiveActions = () => {
      // Toggle discovered type between Bank Account and Credit Card
      classificationContent.querySelectorAll('[data-toggle-type]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.toggleType);
          const item = discovered[idx];
          if (!item) return;
          const wasCredit = item.instrument_type === 'credit_card';
          if (wasCredit) {
            item.instrument_type = 'bank_account';
            item.kind = 'account';
            item.suggested_name = `${item.bank || 'Bank'} Account`;
          } else {
            item.instrument_type = 'credit_card';
            item.kind = 'card';
            item.suggested_name = `${item.bank || 'Bank'} Credit Card`;
          }
          renderSummaryAndSections();
        });
      });

      // Add single discovered account
      classificationContent.querySelectorAll('[data-ingest-add]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = Number(btn.dataset.ingestAdd);
          const item = discovered[idx];
          if (!item) return;

          btn.disabled = true;
          btn.textContent = '...';

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
            addedIndices.add(idx);
            toast(`Added ${recordPayload.name || recordPayload.card_name}!`, 'success');
            renderSummaryAndSections();
          } else {
            toast(saveRes?.message || 'Could not add record.', 'error');
            btn.disabled = false;
            btn.innerHTML = `${icon('add', 'icon-sm')}Add`;
          }
        });
      });

      // Add all discovered accounts
      const addAllBtn = classificationContent.querySelector('[data-ingest-add-all]');
      if (addAllBtn) {
        addAllBtn.addEventListener('click', async () => {
          addAllBtn.disabled = true;
          const unadded = discovered.filter((_, i) => !addedIndices.has(i));
          if (!unadded.length) return;

          const progress = showProgressModal('Adding Discovered Accounts', {
            message: `Saving ${unadded.length} accounts & cards to vault...`,
            initialPercent: 40,
            detail: 'Writing records into encrypted database',
          });

          const addRes = await Bridge.db('add_discovered_accounts', {
            accounts: unadded,
            member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter || 1),
          });

          if (addRes && addRes.status === 'success') {
            progress.complete(`Added ${addRes.added} accounts & cards!`, 350);
            toast(`Added ${addRes.added} accounts and cards!`, 'success');
            discovered.forEach((_, i) => addedIndices.add(i));
            renderSummaryAndSections();
          } else {
            progress.fail('Could not add accounts.');
            toast('Could not add accounts.', 'error');
            addAllBtn.disabled = false;
          }
        });
      }

      // Discard all duplicates
      const discardAllDupsBtn = classificationContent.querySelector('[data-discard-all-dups]');
      if (discardAllDupsBtn) {
        discardAllDupsBtn.addEventListener('click', async () => {
          if (!dupList.length) return;
          const confirmed = await confirmDialog(
            'Discard All Duplicates?',
            `Discard ${dupList.length} duplicate alert${dupList.length === 1 ? '' : 's'} and preserve existing transactions?`,
            { confirmLabel: `Discard ${dupList.length}`, danger: true },
          );
          if (!confirmed) return;

          discardAllDupsBtn.disabled = true;
          const ignoreRes = await Bridge.call('sms', {
            action: 'ignore_batch',
            bodies: dupList.map((i) => i.body),
          });

          if (ignoreRes && ignoreRes.status === 'success') {
            toast(`Discarded ${dupList.length} duplicate alerts.`, 'success');
            dupList = [];
            renderSummaryAndSections();
          } else {
            toast('Could not discard duplicates.', 'error');
            discardAllDupsBtn.disabled = false;
          }
        });
      }

      // Single duplicate discard
      classificationContent.querySelectorAll('[data-discard-dup]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = Number(btn.dataset.discardDup);
          const item = dupList[idx];
          if (!item) return;
          await Bridge.call('sms', { action: 'ignore_alert', body: item.body });
          dupList.splice(idx, 1);
          toast('Alert discarded.', 'info');
          renderSummaryAndSections();
        });
      });

      // Single duplicate keep both
      classificationContent.querySelectorAll('[data-keep-dup]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = Number(btn.dataset.keepDup);
          const item = dupList[idx];
          if (!item) return;
          await Bridge.call('sms', {
            action: 'classify_alert',
            body: item.body,
            amount: item.amount,
            category: item.suggested_category || 'Shopping',
            type: item.suggested_type || 'Expense',
            merchant: item.merchant || '',
            date: item.date,
          });
          dupList.splice(idx, 1);
          toast('Transaction filed.', 'success');
          renderSummaryAndSections();
        });
      });
    };

    renderSummaryAndSections();

    if (res.imported > 0) {
      toast(`Imported ${res.imported} transactions from bank messages!`, 'success');
    } else {
      toast(`Scan complete. ${res.read} messages reviewed.`, 'info');
    }

    actionButtons.innerHTML = `
      <button class="btn btn-filled btn-block" data-go-home>
        ${icon('dashboard')}Go to Dashboard
      </button>`;

    container.querySelector('[data-go-home]').addEventListener('click', () => {
      if (autoLandTimer) clearTimeout(autoLandTimer);
      app.open('home');
    });
  };

  startBtn.addEventListener('click', runScan);
  skipBtn.addEventListener('click', () => {
    if (autoLandTimer) clearTimeout(autoLandTimer);
    app.open('home');
  });

  // If initial setup, automatically begin scanning with all-time default
  if (isInitial) {
    runScan();
  }
}
