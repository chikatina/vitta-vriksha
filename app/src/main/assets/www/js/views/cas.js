import { Bridge } from '../bridge.js';
import {
  icon, h, toast, pickFile, saveFile, emptyState, errorBlock, taxDisclaimerCard, showProgressModal,
  selectField, bindSelectFields,
} from '../ui.js';
import { formatCurrency, formatDate, daysUntil } from '../formatters.js';

export async function renderCas(container, app) {
  const lastUpload = app.settings.last_cas_upload_date || '';
  const age = lastUpload ? Math.abs(daysUntil(lastUpload)) : null;
  const stale = age !== null && age > 30;

  const [funds, demat, nps, accountsRes] = await Promise.all([
    Bridge.db('list_folios', { member_id: app.memberFilter }),
    Bridge.db('list_demat_holdings', { member_id: app.memberFilter }),
    Bridge.db('list_nps_holdings', { member_id: app.memberFilter }),
    Bridge.db('get_records', { record_type: 'account', member_id: app.memberFilter }),
  ]);

  const folios = funds.folios || [];
  const accounts = accountsRes?.records || [];
  const linkedNpsAccount = accounts.find((a) => a.linked_holding_type === 'nps');
  const money = (value) => formatCurrency(value, app.currency, app.locale);
  const gain = (funds.total_value || 0) - (funds.total_invested || 0);
  const held = (funds.total_value || 0) + (demat.total_value || 0) + (nps.total_value || 0);

  const npsHoldingRows = (nps.holdings || []).map((holding) => ({
    title: holding.scheme,
    subtitle: [holding.tier ? `Tier ${holding.tier}` : '', holding.asset_class,
      holding.fund_manager].filter(Boolean).join(' · '),
    value: holding.current_value,
    footnote: holding.nav ? `NAV ${money(holding.nav)}` : '',
  }));

  const npsLinkBanner = npsHoldingRows.length ? (linkedNpsAccount ? `
    <div class="card-flat" style="margin-top:10px;padding:8px 12px;background:var(--surface-container-high);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:space-between">
      <div class="row" style="gap:6px;align-items:center">
        <span style="color:var(--income);display:flex">${icon('check_circle', 'icon-sm')}</span>
        <span class="caption" style="font-weight:600">Linked to Account: ${h(linkedNpsAccount.name)} (${money(linkedNpsAccount.balance)})</span>
      </div>
      <button class="btn btn-text btn-xs" data-unlink-nps="${linkedNpsAccount.id}" style="color:var(--expense);padding:2px 8px">Unlink</button>
    </div>` : `
    <div class="card-flat" style="margin-top:10px;padding:10px 12px;background:var(--surface-container-high);border:1px solid var(--outline-variant);display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div>
        <span style="font-weight:600;font-size:12px;display:block">Link NPS to Accounts</span>
        <span class="caption">Auto-sync balance & prevent double counting in Net Worth.</span>
      </div>
      <button class="btn btn-tonal btn-xs" data-link-nps-quick>${icon('autorenew', 'icon-sm')}Link Account</button>
    </div>`) : '';

  container.innerHTML = `
    ${stale ? `
      <div class="banner banner-warning">
        ${icon('schedule')}
        <span class="banner-main">
          <span class="banner-title">Statement is ${age} days old</span>
          <span class="banner-body">Import a fresh statement to update prices.</span>
        </span>
      </div>` : ''}

    ${held ? `
      <div class="card-accent">
        <span class="overline" style="color:inherit;opacity:0.7">Imported holdings</span>
        <div class="balance-amount" style="font-size:30px">${h(money(held))}</div>
        ${funds.total_invested ? `
          <div class="caption" style="color:inherit;opacity:0.85;margin-top:4px">
            Invested ${h(money(funds.total_invested))} · Gain ${gain >= 0 ? '+' : ''}${h(money(gain))}
          </div>` : ''}
      </div>` : ''}

    <div class="card">
      <div class="card-title">Import statement</div>
      <p class="caption" style="margin-bottom:16px">
        Supports CAMS, KFintech, NSDL and CDSL PDFs. Parsed locally on-device.
      </p>

      <div class="field">
        <label class="field-label" for="casPassword">PDF password</label>
        <input class="input" id="casPassword" type="password" autocomplete="off"
               placeholder="Usually your PAN">
      </div>

      <button class="btn btn-filled btn-block" data-pick style="margin-top:16px">
        ${icon('picture_as_pdf')}Choose a PDF
      </button>
      <button class="btn btn-outlined btn-block" data-gains style="margin-top:10px">
        ${icon('receipt_long')}Capital gains report
      </button>
      <div class="caption" data-status style="margin-top:12px"></div>
    </div>

    <!-- Download CAS & eCAS Helper Card -->
    <div class="card" style="border:1px solid var(--outline-variant);background:var(--surface-container-low)">
      <div class="row-between" style="align-items:center;margin-bottom:8px">
        <div class="row" style="gap:8px;align-items:center">
          <span style="color:var(--accent);display:flex">${icon('description', 'icon-sm')}</span>
          <span style="font-weight:700;font-size:13.5px">Download CAS &amp; eCAS Reports</span>
        </div>
      </div>
      <p class="caption" style="margin-bottom:12px;font-size:12px;line-height:1.45">
        Request a <strong>Detailed CAS</strong> (dated from your earliest investment, e.g. 01-01-1990) to import full mutual fund SIPs, redemptions &amp; capital gains.
      </p>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <button type="button" class="btn btn-tonal btn-xs" data-open-url="https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement">
          ${icon('open_in_new', 'icon-sm')} CAMS Online
        </button>
        <button type="button" class="btn btn-tonal btn-xs" data-open-url="https://mfs.kfintech.com/investor/General/CAS">
          ${icon('open_in_new', 'icon-sm')} KFintech CAS
        </button>
        <button type="button" class="btn btn-tonal btn-xs" data-open-url="https://www.mfcentral.com">
          ${icon('open_in_new', 'icon-sm')} MF Central
        </button>
        <button type="button" class="btn btn-tonal btn-xs" data-open-url="https://www.cdslindia.com/cas/logincas.aspx">
          ${icon('open_in_new', 'icon-sm')} CDSL eCAS
        </button>
        <button type="button" class="btn btn-tonal btn-xs" data-open-url="https://eservices.nsdl.com/kyc-web/#/casLogin">
          ${icon('open_in_new', 'icon-sm')} NSDL eCAS
        </button>
      </div>
      <div style="font-size:11.5px;color:var(--on-surface-variant);line-height:1.4;border-top:1px solid var(--outline-variant);padding-top:8px">
        <strong>Looking for stock/equity trades?</strong> NSDL/CDSL eCAS only provides holding snapshots. Download your broker's tradebook CSV (Zerodha, Groww, Upstox, etc.) and import it under <strong>Wealth &rarr; Investments &rarr; Import CSV</strong>.
      </div>
    </div>

    ${lastUpload ? `<div class="caption" style="text-align:center">Last imported ${h(formatDate(lastUpload))}</div>` : ''}

    ${holdingsSection('Funds', 'trending_up', folios.map((folio) => ({
    title: folio.scheme_name,
    subtitle: [folio.amc, folio.units ? `${Number(folio.units).toFixed(3)} units` : '']
      .filter(Boolean).join(' · '),
    value: folio.current_value,
    footnote: folio.nav ? `NAV ${money(folio.nav)}` : '',
  })), money)}

    ${holdingsSection('Demat', 'show_chart', (demat.holdings || []).map((holding) => ({
    title: holding.name || holding.isin,
    subtitle: [holding.symbol || holding.isin, holding.quantity
      ? `${Number(holding.quantity)} ${holding.kind === 'bond' ? 'units' : 'shares'}` : '']
      .filter(Boolean).join(' · '),
    value: holding.current_value,
    footnote: holding.price ? money(holding.price) : '',
  })), money)}

    ${npsHoldingRows.length ? `
      <div class="section">
        <div class="section-header"><span class="title">Pension (NPS)</span></div>
        <div class="list">
          ${npsHoldingRows.map((row) => `
            <div class="list-row">
              <span class="avatar avatar-sm" style="background:var(--accent-container);color:var(--on-accent-container)">
                ${icon('savings')}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">${h(row.title)}</span>
                <span class="list-row-sub">${h(row.subtitle)}</span>
              </span>
              <span class="list-row-trailing">
                <span class="list-row-amount">${h(money(row.value))}</span>
                ${row.footnote ? `<span class="list-row-sub">${h(row.footnote)}</span>` : ''}
              </span>
            </div>`).join('')}
        </div>
        ${npsLinkBanner}
      </div>` : ''}

    ${folios.length || (demat.holdings || []).length || npsHoldingRows.length ? '' : `
      <div class="card">${emptyState('picture_as_pdf', 'Nothing imported yet',
    'Import a statement above, or add holdings by hand under Accounts.')}</div>`}`;

  container.querySelector('[data-pick]')
    ?.addEventListener('click', () => importStatement(container, app));
  container.querySelector('[data-gains]')
    ?.addEventListener('click', () => gainsReport(container, app));

  container.querySelector('[data-link-nps-quick]')
    ?.addEventListener('click', () => openLinkNpsModal(app, nps, accounts));

  container.querySelector('[data-unlink-nps]')
    ?.addEventListener('click', async (e) => {
      const accId = e.currentTarget.dataset.unlinkNps;
      const res = await Bridge.db('link_nps_account', { unlink: true, account_id: accId });
      if (res && res.status === 'success') {
        toast('NPS account unlinked.', 'success');
        app.refresh();
      }
    });

  container.querySelectorAll('[data-open-url]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const url = el.dataset.openUrl;
      if (url) Bridge.openUrl(url);
    });
  });
}

/** Modal to link NPS holdings to an account */
async function openLinkNpsModal(app, nps, accounts) {
  const pran = nps.holdings?.[0]?.pran || '';
  const totalVal = nps.total_value || 0;
  const money = (v) => formatCurrency(v, app.currency, app.locale);
  const eligibleAccounts = accounts.filter((a) => a.category === 'NPS' || a.category === 'Bank' || a.category === 'Other');

  const body = `
    <p class="caption" style="margin-bottom:var(--gap-3)">
      Link your imported NPS holdings (${nps.holdings.length} schemes · ${money(totalVal)}) to an account in your ledger. This keeps the balance in sync and prevents double counting in Net Worth.
    </p>

    <div class="field">
      <span class="field-label">Linking Option</span>
      <div class="segmented" data-link-mode style="display:grid;grid-template-columns:${eligibleAccounts.length ? '1fr 1fr' : '1fr'};gap:4px">
        <button type="button" data-mode="new" aria-selected="true">Create New NPS Account</button>
        ${eligibleAccounts.length ? '<button type="button" data-mode="existing" aria-selected="false">Link Existing Account</button>' : ''}
      </div>
    </div>

    <div data-mode-fields style="margin-top:var(--gap-3)"></div>
  `;

  const saved = await sheet('Link NPS Account', body, {
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>Link & Sync</button>`,
    onMount(node, close) {
      let mode = 'new';
      const modeFields = node.querySelector('[data-mode-fields]');

      const renderMode = () => {
        if (mode === 'new') {
          modeFields.innerHTML = `
            <div class="field">
              <label class="field-label" for="npsAccName">Account Name</label>
              <input class="input" id="npsAccName" data-name type="text" value="${h(pran ? `NPS (${pran})` : 'NPS Portfolio')}">
            </div>
            <div class="row" style="gap:12px">
              <div class="field" style="flex:1">
                <label class="field-label" for="npsInst">Institution / CRA</label>
                <input class="input" id="npsInst" data-inst type="text" value="CRA-NSDL / PFRDA">
              </div>
              <div class="field" style="flex:1">
                <label class="field-label" for="npsPran">PRAN Number</label>
                <input class="input" id="npsPran" data-pran type="text" value="${h(pran)}">
              </div>
            </div>
            <div class="field">
              <label class="field-label">Synced Balance</label>
              <input class="input numeric" type="text" value="${money(totalVal)}" readonly disabled>
            </div>
          `;
        } else {
          modeFields.innerHTML = `
            ${selectField({
              key: 'selNpsAcc',
              id: 'selNpsAcc',
              label: 'Select Account to Link',
              value: eligibleAccounts[0]?.id || '',
              options: eligibleAccounts.map((a) => ({
                value: a.id,
                label: `${a.name} (${a.category} · ${money(a.balance)})`,
              })),
            })}
            <p class="caption" style="margin-top:6px">
              The chosen account's category will be set to NPS and its balance will be updated to ${money(totalVal)}.
            </p>
          `;
          bindSelectFields(modeFields);
        }
      };

      renderMode();

      node.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          mode = btn.dataset.mode;
          node.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
          renderMode();
        });
      });

      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));

      node.querySelector('[data-save]').addEventListener('click', async () => {
        let payload = { member_id: app.memberFilter, pran };
        if (mode === 'new') {
          payload.name = node.querySelector('[data-name]').value.trim() || 'NPS Portfolio';
          payload.institution = node.querySelector('[data-inst]').value.trim() || 'CRA-NSDL / PFRDA';
          payload.pran = node.querySelector('[data-pran]').value.trim() || pran;
        } else {
          const accId = node.querySelector('#selNpsAcc')?.value || node.querySelector('[data-field="selNpsAcc"]')?.value || node.querySelector('[data-sel-acc]')?.value;
          payload.account_id = accId;
        }

        const res = await Bridge.db('link_nps_account', payload);
        if (res && res.status === 'success') {
          toast('NPS account linked & synced!', 'success');
          close(true);
        } else {
          toast('Failed to link NPS account.', 'error');
        }
      });
    },
  });

  if (saved) app.refresh();
}

/** One titled list of holdings, or nothing at all when there are none. */
function holdingsSection(title, glyph, rows, money) {
  if (!rows.length) return '';
  return `
    <div class="section">
      <div class="section-header"><span class="title">${h(title)}</span></div>
      <div class="list">
        ${rows.map((row) => `
          <div class="list-row">
            <span class="avatar avatar-sm" style="background:var(--accent-container);color:var(--on-accent-container)">
              ${icon(glyph)}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">${h(row.title)}</span>
              <span class="list-row-sub">${h(row.subtitle)}</span>
            </span>
            <span class="list-row-trailing">
              <span class="list-row-amount">${h(money(row.value))}</span>
              ${row.footnote ? `<span class="list-row-sub">${h(row.footnote)}</span>` : ''}
            </span>
          </div>`).join('')}
      </div>
    </div>`;
}

async function importStatement(container, app) {
  const status = container.querySelector('[data-status]');
  const password = document.getElementById('casPassword').value;

  const picked = await pickFile('application/pdf,.pdf', { binary: true });
  if (!picked) return;

  const progress = showProgressModal('Importing Statement', {
    message: `Reading ${picked.name}...`,
    initialPercent: 15,
    detail: 'Decrypting PDF text and extracting folios',
  });

  const stepTimer1 = setTimeout(() => {
    progress.update({
      percent: 45,
      message: 'Extracting holdings and transactions...',
      detail: 'Scanning mutual funds, stocks, and NPS schemes',
    });
  }, 400);

  const stepTimer2 = setTimeout(() => {
    progress.update({
      percent: 75,
      message: 'Matching scheme ISINs & transactions...',
      detail: 'Validating against ISIN scheme reference database',
    });
  }, 1200);

  const stepTimer3 = setTimeout(() => {
    progress.update({
      percent: 90,
      message: 'Storing holdings in encrypted vault...',
      detail: 'Writing records to database',
    });
  }, 2200);

  let result;
  try {
    result = await Bridge.call('cas', {
      action: 'parse_base64',
      pdf_base64: picked.base64,
      password,
      member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter),
    });
  } catch (err) {
    result = { status: 'error', message: err.message || 'Statement parsing failed.' };
  } finally {
    clearTimeout(stepTimer1);
    clearTimeout(stepTimer2);
    clearTimeout(stepTimer3);
  }

  if (result.status !== 'success') {
    progress.fail(result.message || 'Statement parsing failed.');
    console.error('Statement import failed', result);
    showFailure(status, result, picked, password);
    return;
  }

  progress.complete('Statement imported successfully!', 350);

  const imported = [
    [result.scheme_count, 'fund'],
    [result.equity_count, 'share'],
    [result.bond_count, 'bond'],
    [result.nps_count, 'pension scheme'],
  ].filter(([count]) => count)
    .map(([count, noun]) => `${count} ${noun}${count === 1 ? '' : 's'}`)
    .join(', ');

  // The holdings were refreshed whether or not this file had been read before. Saying so
  // only matters in case a different file was meant.
  const dated = result.as_of ? ` Statement dated ${result.as_of}.` : '';
  toast(result.already_imported
    ? `Imported ${imported}.${dated} This file had been read before.`
    : `Imported ${imported}.${dated}`, 'success');

  const fresh = await Bridge.db('get_settings');
  if (fresh.status === 'success') app.settings = fresh.settings;
  await app.refresh();

  if (result.parse_warnings && result.parse_warnings.length) {
    // The statement carries its own running balance, so a mismatch means a row was
    // probably missed. Saying so is the whole value of the check.
    const refreshed = container.querySelector('[data-status]');
    if (refreshed) refreshed.innerHTML = warningsBlock(result.parse_warnings);
  }
}

function warningsBlock(warnings) {
  return `
    <div class="card-flat" style="margin-top:12px">
      <div class="card-title">Worth a second look</div>
      ${warnings.map((warning) => `
        <div class="caption" style="padding:3px 0">${h(warning)}</div>`).join('')}
    </div>`;
}

/** The failure, with a way to find out what the file actually is. */
function showFailure(status, result, picked, password) {
  status.innerHTML = `
    ${errorBlock(result)}
    <button class="btn btn-outlined btn-block" data-diagnose style="margin-top:12px">
      ${icon('science')}Check what this file is
    </button>
    <div data-diagnosis></div>`;

  status.querySelector('[data-diagnose]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Checking';

    const report = await Bridge.call('cas', {
      action: 'diagnose', pdf_base64: picked.base64, password,
    });

    button.remove();
    status.querySelector('[data-diagnosis]').innerHTML = diagnosisBlock(report);

    const copy = status.querySelector('[data-copy]');
    if (!copy) return;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(
          JSON.stringify({ failure: result.code, ...report }, null, 2),
        );
        toast('Copied.', 'success');
      } catch {
        toast('Could not reach the clipboard.', 'error');
      }
    });
  });
}

async function gainsReport(container, app) {
  const status = container.querySelector('[data-status]');
  const password = document.getElementById('casPassword').value;

  const picked = await pickFile('application/pdf,.pdf', { binary: true });
  if (!picked) return;

  status.textContent = 'Working out what was sold and what it cost.';
  const report = await Bridge.call('cas', {
    action: 'gains', pdf_base64: picked.base64, password,
  });

  if (report.status !== 'success') {
    status.innerHTML = errorBlock(report);
    return;
  }
  status.innerHTML = gainsBlock(report, app);

  const download = status.querySelector('[data-112a]');
  if (!download || !report.schedule_112a_csv) return;
  download.addEventListener('click', () => {
    const filename = `schedule-112a-${report.financial_year}.csv`;
    const res = saveFile(filename, report.schedule_112a_csv, 'text/csv');
    if (res && res.success === false) {
      toast(res.error || 'Could not save Schedule 112A file.', 'error');
    } else {
      toast(`Saved ${filename} to Downloads`, 'success');
    }
  });
}

/** What the gains came to, by year and by fund. */
function gainsBlock(report, app) {
  const money = (value) => formatCurrency(value, app.currency, app.locale);
  if (!report.summary.length) {
    return `
      ${taxDisclaimerCard({ compact: true })}
      <div class="card" style="margin-top:12px;border:1px solid var(--outline-variant);padding:16px">
        <div style="font-weight:700;font-size:14px;color:var(--on-surface);margin-bottom:4px">Nothing was sold</div>
        <div style="font-size:12px;color:var(--on-surface-variant)">This statement records no redemptions, so there is no realised gain to report.</div>
      </div>`;
  }

  const rows = report.summary.filter((row) => row.financial_year === report.financial_year);
  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);

  return `
    ${taxDisclaimerCard({ compact: false })}
    <div class="card" style="margin-top:12px;border:1px solid var(--outline-variant);padding:16px">
      <div style="font-weight:700;font-size:14px;color:var(--on-surface);margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--outline-variant)">
        Realised gains (${h(report.financial_year)})
      </div>
      ${rows.map((row) => `
        <div class="row-between" style="padding:6px 0">
          <span style="font-size:12.5px;color:var(--on-surface)">${h(row.fund)}</span>
          <span class="numeric" style="color:var(--on-surface);font-weight:700;font-size:12.5px">
            ${h(money(row.ltcg + row.stcg))}
          </span>
        </div>`).join('')}
      <div class="row-between" style="padding:8px 0 4px;margin-top:6px;border-top:1px solid var(--outline-variant)">
        <span style="font-size:12.5px;font-weight:600;color:var(--on-surface)">Long term, taxable</span>
        <span class="numeric" style="color:var(--on-surface);font-weight:700;font-size:12.5px">${h(money(total('ltcg_taxable')))}</span>
      </div>
      <div class="row-between" style="padding:4px 0">
        <span style="font-size:12.5px;font-weight:600;color:var(--on-surface)">Short term</span>
        <span class="numeric" style="color:var(--on-surface);font-weight:700;font-size:12.5px">${h(money(total('stcg')))}</span>
      </div>
      ${report.errors.length ? `
        <div style="font-size:11.5px;color:var(--expense);margin-top:10px;line-height:1.4">
          ${report.errors.length} scheme${report.errors.length === 1 ? '' : 's'} could not be
          computed, usually because the statement does not go back far enough.
        </div>` : ''}
      <button class="btn btn-tonal btn-block" data-112a style="margin-top:14px">
        ${icon('download')}Save the Schedule 112A file
      </button>
    </div>`;
}

/**
 * What the parser could tell about a file it could not import.
 *
 * The sample has digits, permanent account numbers and email addresses stripped before it
 * gets here, so this can be copied into a bug report without carrying anything personal.
 */
function diagnosisBlock(report) {
  if (report.status !== 'success') return errorBlock(report, { compact: true });

  const rows = [
    ['Looks like', report.issuer && report.issuer !== 'UNKNOWN' ? report.issuer : 'not recognised'],
    ['Statement kind', report.cas_type || ''],
    ['Pages', report.pages ? String(report.pages) : ''],
    ['Readable text', `${report.text_chars || 0} characters`],
    ['Size', `${report.size_kb} KB`],
    ['Parser version', report.parser],
  ].filter(([, value]) => value);

  return `
    <div class="card-flat" style="margin-top:12px">
      <div class="card-title">What this file looks like</div>
      ${rows.map(([label, value]) => `
        <div class="row-between" style="padding:3px 0">
          <span class="caption">${h(label)}</span>
          <span class="caption" style="color:var(--on-surface);font-weight:600">${h(value)}</span>
        </div>`).join('')}

      ${report.sample ? `
        <div class="error-detail" style="margin-top:10px">${h(report.sample)}</div>` : ''}

      <button class="btn btn-tonal btn-block" data-copy style="margin-top:14px">
        ${icon('content_copy')}Copy this report
      </button>
    </div>`;
}
