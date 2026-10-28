import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { call, freshBackend } from './_harness.mjs';

async function ok(action, args = {}) {
  const res = await call(action, args);
  if (res?.status !== 'success') {
    throw new Error(`${action} failed: ${res?.code || 'ERROR'} - ${res?.message || ''}`);
  }
  return res;
}

beforeEach(async () => {
  await freshBackend();
});

describe('SIP Tracker & Mandate Overhaul', () => {
  it('creates an umbrella mandate with child SIP splits and verifies totals', async () => {
    // 1. Create a bank account
    const acc = await ok('save_record', {
      record_type: 'account',
      record: {
        name: 'HDFC Savings',
        category: 'Bank',
        balance: 100000,
        account_number: '1234',
      },
    });
    const accountId = acc.record_id;

    // 2. Save an umbrella mandate of ₹15,000 split across 2 funds and 1 stock SIP
    const mandateRes = await ok('save_sip_mandate', {
      name: 'Groww NACH Mandate',
      mandate_type: 'nach',
      bank_account_id: accountId,
      total_amount: 15000,
      debit_day: 5,
      linked_merchant_key: 'groww_mandate',
      splits: [
        {
          scheme_name: 'Parag Parikh Flexi Cap Fund',
          monthly_amount: 5000,
          investment_type: 'mf',
          isin: 'INF879O01018',
          folio_number: '12345/67',
        },
        {
          scheme_name: 'UTI Nifty 50 Index Fund',
          monthly_amount: 5000,
          investment_type: 'mf',
          isin: 'INF789F01020',
          folio_number: '89012/34',
        },
        {
          scheme_name: 'Tata Motors ETF',
          monthly_amount: 5000,
          investment_type: 'stock',
          symbol: 'TATAMOTORS',
          broker: 'Groww',
        },
      ],
    });

    assert.ok(mandateRes.id > 0);

    // 3. List SIPs and verify structure
    const list = await ok('list_sips');
    assert.equal(list.mandates.length, 1);
    const m = list.mandates[0];
    assert.equal(m.name, 'Groww NACH Mandate');
    assert.equal(m.total_amount, 15000);
    assert.equal(m.child_sips.length, 3);
    assert.equal(m.allocated_total, 15000);

    // Verify all 3 child sips are disambiguated even with identical ₹5,000 amounts
    const names = m.child_sips.map((s) => s.scheme_name);
    assert.ok(names.includes('Parag Parikh Flexi Cap Fund'));
    assert.ok(names.includes('UTI Nifty 50 Index Fund'));
    assert.ok(names.includes('Tata Motors ETF'));
    for (const s of m.child_sips) {
      assert.equal(s.monthly_amount, 5000);
    }
  });

  it('rejects an umbrella mandate when child splits do not equal the total amount', async () => {
    const err = await call('save_sip_mandate', {
      name: 'BSE Star MF',
      total_amount: 10000,
      debit_day: 10,
      splits: [
        { scheme_name: 'Fund A', monthly_amount: 4000 },
        { scheme_name: 'Fund B', monthly_amount: 4000 },
      ], // Sum = 8000 != 10000
    });

    assert.equal(err.status, 'error');
    assert.equal(err.code, 'SPLIT_TOTAL_MISMATCH');
  });

function dateMonthsAgo(months, day = 5) {
  const now = new Date();
  let m = now.getMonth() + 1 - months;
  let y = now.getFullYear();
  while (m < 1) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

  it('finds matching historical bank debits and CAMS purchases and links them to a SIP', async () => {
    const testDate = dateMonthsAgo(2, 5);
    const testMonthKey = testDate.slice(0, 7);

    // 1. Create a historical bank transaction for ₹5,000 on day 5
    await ok('save_transaction', {
      transaction: {
        date: testDate,
        amount: 5000,
        merchant: 'ACH Dr BSE Limited',
        type: 'Investment',
        category: 'Mutual Funds',
      },
    });

    // 2. Insert a historical CAMS folio transaction on day 6
    const db = (await call('get_settings')).status; // ensures db is ready
    const res = await call('save_record', {
      record_type: 'mf_folio',
      record: {
        scheme_name: 'Mirae Asset Large Cap Fund',
        isin: 'INF769K01024',
        folio_number: '998877/11',
        units: 100,
        nav: 50,
      },
    });

    // 3. Save a SIP and check candidate matches
    const sipRes = await ok('save_sip', {
      scheme_name: 'Mirae Asset Large Cap Fund',
      monthly_amount: 5000,
      debit_day: 5,
      isin: 'INF769K01024',
    });

    assert.ok(sipRes.id > 0);
    assert.ok(sipRes.candidates.length > 0);
    const bankCand = sipRes.candidates.find((c) => c.type === 'bank_transaction');
    assert.ok(bankCand);
    assert.equal(bankCand.amount, 5000);

    // 4. Link the candidate transaction
    const linkRes = await ok('link_sip_transactions', {
      sip_id: sipRes.id,
      links: [
        {
          month_key: testMonthKey,
          transaction_id: bankCand.transaction_id,
        },
      ],
    });
    assert.equal(linkRes.linked, 1);

    // 5. Check SIP details and execution history
    const detail = await ok('get_sip_details', { id: sipRes.id });
    assert.equal(detail.sip.scheme_name, 'Mirae Asset Large Cap Fund');
    assert.equal(detail.executions.length, 1);
    assert.equal(detail.executions[0].month_key, testMonthKey);
    assert.equal(detail.executions[0].status, 'debited');
    assert.equal(detail.executions[0].tx_amount, 5000);

    // 6. Unlink transaction
    await ok('unlink_sip_transaction', {
      execution_id: detail.executions[0].id,
      type: 'transaction',
    });

    const detailAfter = await ok('get_sip_details', { id: sipRes.id });
    assert.equal(detailAfter.executions[0].transaction_id, null);
    assert.equal(detailAfter.executions[0].status, 'due');
  });

  it('discovers umbrella mandates by cross-referencing CAMS purchases with bank debits', async () => {
    const m1Bank = dateMonthsAgo(3, 10);
    const m2Bank = dateMonthsAgo(2, 10);
    const m1Cams = dateMonthsAgo(3, 11);
    const m2Cams = dateMonthsAgo(2, 11);

    // 1. Bank debits of ₹10,000 on day 10 of two consecutive months to "BSE LIMITED"
    await ok('save_transaction', {
      transaction: {
        date: m1Bank,
        amount: 10000,
        merchant: 'ACH Dr BSE Limited NACH',
        type: 'Investment',
        category: 'Mutual Funds',
      },
    });
    await ok('save_transaction', {
      transaction: {
        date: m2Bank,
        amount: 10000,
        merchant: 'ACH Dr BSE Limited NACH',
        type: 'Investment',
        category: 'Mutual Funds',
      },
    });

    // 2. In CAMS, two funds of ₹5,000 each purchased on day 10/11
    await call('list_folios'); // initializes DB
    const { getDatabase } = await import('../app/src/main/assets/www/js/backend/database.js');
    const rawDb = await getDatabase();
    rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['111/22', 'INF111A01011', 'Axis Bluechip Fund', m1Cams, 'Purchase - SIP', 5000, 100, 50],
    );
    rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['111/22', 'INF111A01011', 'Axis Bluechip Fund', m2Cams, 'Purchase - SIP', 5000, 98, 51],
    );
    rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['333/44', 'INF222B01022', 'Quant Active Fund', m1Cams, 'SIP Purchase', 5000, 80, 62.5],
    );
    rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['333/44', 'INF222B01022', 'Quant Active Fund', m2Cams, 'SIP Purchase', 5000, 78, 64.1],
    );

    // 3. Run discovery
    const disc = await ok('discover_sips', { months: 6 });
    assert.ok(disc.discovered_mandates.length >= 1, 'Should detect umbrella mandate');
    const m = disc.discovered_mandates[0];
    assert.equal(m.total_amount, 10000);
    assert.equal(m.splits.length, 2);
    assert.equal(m.splits[0].monthly_amount, 5000);
    assert.equal(m.splits[1].monthly_amount, 5000);

    // 4. Confirm discovery via wizard
    const confirmRes = await ok('confirm_discovered_sips', {
      mandates: disc.discovered_mandates,
      sips: disc.discovered_sips,
    });
    assert.equal(confirmRes.created_mandates, 1);

    // 5. Verify the created mandate and its child SIPs
    const sipsList = await ok('list_sips');
    assert.equal(sipsList.mandates.length, 1);
    assert.equal(sipsList.mandates[0].child_sips.length, 2);
  });

  it('reconciles bank transactions and CAMS folio transactions automatically', async () => {
    // 1. Create a standalone SIP
    const sip = await ok('save_sip', {
      scheme_name: 'HDFC Mid-Cap Opportunities Fund',
      monthly_amount: 10000,
      debit_day: 15,
      isin: 'INF179K01BE2',
      linked_merchant_key: 'hdfc_mf_debit',
    });

    const curMonth = new Date().toISOString().slice(0, 7);

    // 2. Ingest bank transaction for this month
    await ok('save_transaction', {
      transaction: {
        date: `${curMonth}-15`,
        amount: 10000,
        merchant: 'ACH Dr HDFC MF',
        merchant_key: 'hdfc_mf_debit',
        type: 'Investment',
        category: 'Mutual Funds',
      },
    });

    // 3. Verify status transitioned to 'debited'
    let detail = await ok('get_sip_details', { id: sip.id });
    const exec = detail.executions.find((e) => e.month_key === curMonth);
    assert.ok(exec, 'Execution should exist for current month');
    assert.equal(exec.status, 'debited');
    assert.ok(exec.transaction_id > 0);

    // 4. Ingest CAMS allotment transaction
    const { getDatabase } = await import('../app/src/main/assets/www/js/backend/database.js');
    const rawDb = await getDatabase();
    rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['777/88', 'INF179K01BE2', 'HDFC Mid-Cap Opportunities Fund', `${curMonth}-16`, 'Purchase - SIP', 10000, 72.45, 138.02],
    );

    // 5. Reconcile
    await ok('reconcile_sips');

    // 6. Verify status transitioned to 'completed' with units and NAV captured
    detail = await ok('get_sip_details', { id: sip.id });
    const execAllotted = detail.executions.find((e) => e.month_key === curMonth);
    assert.equal(execAllotted.status, 'completed');
    assert.equal(execAllotted.allotment_units, 72.45);
    assert.equal(execAllotted.allotment_nav, 138.02);
  });

  it('renders SIP tracker UI with summary cards, mandates, and child SIPs', async () => {
    // 1. Create mandate with 2 splits
    await ok('save_sip_mandate', {
      name: 'Zerodha Coin SIP',
      total_amount: 8000,
      debit_day: 10,
      splits: [
        { scheme_name: 'Nippon India Small Cap Fund', monthly_amount: 5000, isin: 'INF204K01011' },
        { scheme_name: 'Mirae Asset Large Cap Fund', monthly_amount: 3000, isin: 'INF769K01010' },
      ],
    });

    // 2. Mock container and app
    const container = {
      innerHTML: '',
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const mockApp = {
      currency: 'INR',
      locale: 'en-IN',
      memberFilter: 'all',
      open: () => {},
    };

    // 3. Mock Bridge for web layer
    globalThis.Bridge = {
      db: (action, args) => call(action, args),
    };

    const { renderSipTracker } = await import('../app/src/main/assets/www/js/views/sips.js');
    await renderSipTracker(container, mockApp);

    assert.ok(container.innerHTML.includes('Monthly SIP Outflow'));
    assert.ok(container.innerHTML.includes('Zerodha Coin SIP'));
    assert.ok(container.innerHTML.includes('Nippon India Small Cap Fund'));
    assert.ok(container.innerHTML.includes('Mirae Asset Large Cap Fund'));
    assert.ok(container.innerHTML.includes('Umbrella Mandates'));
  });

  it('migrates older sips records and supports dismissing productivity disclaimer', async () => {
    // 1. Verify taxDisclaimerCard renders by default
    const { taxDisclaimerCard } = await import('../app/src/main/assets/www/js/ui.js');
    const rendered = taxDisclaimerCard({ compact: true });
    assert.ok(rendered.includes('Productivity Tool Only'));

    // 2. Dismiss it via localStorage
    localStorage.setItem('dismiss_productivity_disclaimer', '1');

    // 3. Verify it is now permanently dismissed
    const dismissedFull = taxDisclaimerCard({ compact: false });
    assert.equal(dismissedFull, '');
  });

  it('supports deleting SIPs and mandates, re-discovering candidates, and adding via parameter aliases', async () => {
    // 1. Create a standalone SIP with legacy parameter names (name, amount)
    const sipRes = await ok('save_sip', {
      name: 'Axis Midcap Direct Growth',
      amount: 4000,
      debit_day: 12,
      isin: 'INF128K01011',
    });
    assert.ok(sipRes.id > 0);

    // Verify it saved and populated both name & scheme_name, amount & monthly_amount
    const sipDetails = await ok('get_sip_details', { sip_id: sipRes.id });
    assert.equal(sipDetails.sip.scheme_name, 'Axis Midcap Direct Growth');
    assert.equal(sipDetails.sip.monthly_amount, 4000);
    assert.equal(sipDetails.sip.name, 'Axis Midcap Direct Growth');
    assert.equal(sipDetails.sip.amount, 4000);

    // 2. Delete SIP using sip_id alias
    const delRes1 = await ok('delete_sip', { sip_id: sipRes.id });
    assert.equal(delRes1.status, 'success');

    // Verify list is empty
    const listAfterDel = await ok('list_sips');
    assert.equal(listAfterDel.sips.length, 0);

    // 3. Create a mandate and delete using id alias
    const mandateRes = await ok('save_sip_mandate', {
      name: 'Kotak SIP Mandate',
      total_amount: 5000,
      debit_day: 7,
      splits: [{ scheme_name: 'Kotak Emerging Equity', monthly_amount: 5000 }],
    });
    assert.ok(mandateRes.id > 0);

    const delRes2 = await ok('delete_sip_mandate', { id: mandateRes.id });
    assert.equal(delRes2.status, 'success');

    const listAfterMandateDel = await ok('list_sips');
    assert.equal(listAfterMandateDel.mandates.length, 0);
  });

  it('ignores stamp duty transactions in SIP discovery, transaction matching, and reconciliation', async () => {
    const m1Cams = dateMonthsAgo(3, 10);
    const m2Cams = dateMonthsAgo(2, 10);
    const m3Cams = dateMonthsAgo(1, 10);

    // 1. Ingest folio transactions for an AMC with both regular purchases (5,000) and stamp duty rows (0.25)
    await call('list_folios'); // initializes DB
    const { getDatabase } = await import('../app/src/main/assets/www/js/backend/database.js');
    const rawDb = await getDatabase();

    // Purchases & stamp duty lines
    for (const [dt, amt] of [[m1Cams, 5000], [m2Cams, 5000], [m3Cams, 5000]]) {
      rawDb.run(
        'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav)'
        + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['555/01', 'INF846K01014', 'Axis Small Cap Fund Direct Growth', dt, 'Purchase - SIP', 'purchase', amt, 65.2, 76.68],
      );
      // Stamp duty row on same date (kind: STAMP_DUTY_TAX, or description 'Stamp Duty')
      rawDb.run(
        'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav)'
        + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['555/01', 'INF846K01014', 'Axis Small Cap Fund Direct Growth', dt, 'Stamp Duty Charges', 'STAMP_DUTY_TAX', 0.25, 0, 0],
      );
    }

    // Also insert bank debit of ₹50 for NACH stamp duty charges
    await ok('save_transaction', {
      transaction: {
        date: m1Cams,
        amount: 50,
        merchant: 'HDFC Bank',
        description: 'NACH MANDATE STAMP DUTY CHARGES',
        type: 'Expense',
        category: 'Charges',
      },
    });

    // 2. Run discover_sips
    const disc = await ok('discover_sips', { months: 6 });
    // Verify it found the Axis Small Cap SIP for 5,000, and NOT for 0.25
    const axisSip = disc.discovered_sips.find((s) => /Axis Small Cap/i.test(s.scheme_name));
    assert.ok(axisSip, 'Should discover Axis Small Cap SIP');
    assert.equal(axisSip.monthly_amount, 5000, 'Monthly amount must be 5000, not stamp duty 0.25');

    const stampSip = disc.discovered_sips.find((s) => s.monthly_amount === 0.25 || /stamp/i.test(s.scheme_name));
    assert.equal(stampSip, undefined, 'Stamp duty must never be discovered as a SIP');

    // 3. Test find_sip_matching_transactions ignores stamp duty transactions
    // Insert a stamp duty transaction with the exact SIP amount to test exclusion
    rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['555/01', 'INF846K01014', 'Axis Small Cap Fund Direct Growth', m3Cams, 'Stamp duty levy', 'STAMP_DUTY', 5000, 0, 0],
    );

    const matches = await ok('find_sip_matching_transactions', {
      monthly_amount: 5000,
      isin: 'INF846K01014',
      scheme_name: 'Axis Small Cap Fund',
      lookback_months: 6,
    });

    // Verify all returned CAMS matches are legitimate purchases and NONE are stamp duty
    for (const casTx of matches.cas_transactions) {
      assert.ok(!casTx.description?.toLowerCase().includes('stamp'), 'Must not match stamp duty CAMS transactions');
      assert.ok(casTx.units > 0, 'Legitimate purchase must have positive units');
    }

    // 4. Test reconcile_sips ignores stamp duty
    const curMonth = new Date().toISOString().slice(0, 7);
    const testSip = await ok('save_sip', {
      scheme_name: 'Mirae Asset Large Cap Fund',
      monthly_amount: 100,
      debit_day: 15,
      isin: 'INF769K01024',
    });

    // Add a stamp duty row for ₹100
    rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['999/88', 'INF769K01024', 'Mirae Asset Large Cap Fund', `${curMonth}-15`, 'Stamp Duty on Allotment', 'STAMP_DUTY_TAX', 100, 0, 0],
    );

    await ok('reconcile_sips');

    const detail = await ok('get_sip_details', { sip_id: testSip.id });
    const exec = detail.executions.find((e) => e.month_key === curMonth);
    assert.equal(exec?.folio_transaction_id ?? null, null, 'Reconciliation must not link stamp duty transaction as allotment');
  });

  it('links stamp duty to actual mutual fund purchase and hides individual stamp duty records in lists', async () => {
    await call('list_folios');
    const { getDatabase } = await import('../app/src/main/assets/www/js/backend/database.js');
    const { linkStampDutyFolioTransactions } = await import('../app/src/main/assets/www/js/backend/sips.js');
    const rawDb = await getDatabase();

    const pDate = '2024-05-15';
    // 1. Insert purchase transaction
    const pRes = rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['1234/56', 'INF200K01014', 'SBI Bluechip Fund Direct Growth', pDate, 'SIP Purchase', 'purchase', 5000, 70.5, 70.92],
    );
    const purchaseId = pRes.lastInsertRowid;

    // 2. Insert stamp duty transaction (₹0.25, 0 units)
    const sRes = rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['1234/56', 'INF200K01014', 'SBI Bluechip Fund Direct Growth', pDate, 'Stamp Duty Levy', 'STAMP_DUTY_TAX', 0.25, 0, 0],
    );
    const stampId = sRes.lastInsertRowid;

    // 3. Run linkStampDutyFolioTransactions
    const linkedCount = linkStampDutyFolioTransactions(rawDb);
    assert.equal(linkedCount, 1);

    // Verify DB linkage
    const updatedPurchase = rawDb.get('SELECT * FROM folio_transactions WHERE id = ?', [purchaseId]);
    assert.equal(updatedPurchase.stamp_duty, 0.25);
    assert.equal(updatedPurchase.linked_stamp_duty_id, stampId);

    const updatedStamp = rawDb.get('SELECT * FROM folio_transactions WHERE id = ?', [stampId]);
    assert.equal(updatedStamp.parent_txn_id, purchaseId);

    // 4. Verify get_folio_transactions excludes standalone stamp duty rows and only shows the purchase
    const folioTxns = await ok('get_folio_transactions', { isin: 'INF200K01014' });
    assert.equal(folioTxns.count, 1);
    assert.equal(folioTxns.transactions.length, 1);
    assert.equal(folioTxns.transactions[0].id, purchaseId);
    assert.equal(folioTxns.transactions[0].amount, 5000);
    assert.equal(folioTxns.transactions[0].stamp_duty, 0.25);
    assert.ok(!folioTxns.transactions.some((t) => t.kind === 'STAMP_DUTY_TAX' || t.description?.includes('Stamp')));

    // 5. Verify get_holding_detail excludes stamp duty rows and only shows the purchase
    const holdingDetail = await ok('get_holding_detail', { isin: 'INF200K01014' });
    assert.equal(holdingDetail.counted, 1);
    assert.equal(holdingDetail.transactions.length, 1);
    assert.equal(holdingDetail.transactions[0].id, purchaseId);
    assert.equal(holdingDetail.transactions[0].stamp_duty, 0.25);
    assert.ok(holdingDetail.invested_from_history >= 5000);
  });

  it('links additional costs (STT, exchange fees, transaction charges) to parent transaction and hides individual records from lists', async () => {
    await call('list_folios');
    const { getDatabase } = await import('../app/src/main/assets/www/js/backend/database.js');
    const { linkCostAndTaxFolioTransactions } = await import('../app/src/main/assets/www/js/backend/sips.js');
    const rawDb = await getDatabase();

    const tDate = '2024-06-20';
    // 1. Insert parent purchase transaction
    const pRes = rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['9876/54', 'INF179K01BE2', 'HDFC Mid-Cap Opportunities Fund', tDate, 'SIP Purchase Allotment', 'purchase', 10000, 100, 100],
    );
    const purchaseId = pRes.lastInsertRowid;

    // 2. Insert STT tax record (₹10, 0 units)
    const sttRes = rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['9876/54', 'INF179K01BE2', 'HDFC Mid-Cap Opportunities Fund', tDate, 'Securities Transaction Tax', 'STT_TAX', 10, 0, 0],
    );
    const sttId = sttRes.lastInsertRowid;

    // 3. Insert Exchange / turnover charge record (₹2.50, 0 units)
    const exRes = rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['9876/54', 'INF179K01BE2', 'HDFC Mid-Cap Opportunities Fund', tDate, 'Exchange Turnover Charges', 'EXCHANGE_FEE', 2.5, 0, 0],
    );
    const exId = exRes.lastInsertRowid;

    // 4. Run linking routine
    const linked = linkCostAndTaxFolioTransactions(rawDb);
    assert.equal(linked, 2);

    // 5. Verify parent transaction received the charges
    const updatedParent = rawDb.get('SELECT * FROM folio_transactions WHERE id = ?', [purchaseId]);
    assert.equal(updatedParent.stt, 10);
    assert.equal(updatedParent.charges, 2.5);

    const updatedStt = rawDb.get('SELECT * FROM folio_transactions WHERE id = ?', [sttId]);
    assert.equal(updatedStt.parent_txn_id, purchaseId);

    const updatedEx = rawDb.get('SELECT * FROM folio_transactions WHERE id = ?', [exId]);
    assert.equal(updatedEx.parent_txn_id, purchaseId);

    // 6. Verify get_folio_transactions excludes STT and exchange fee standalone rows
    const listRes = await ok('get_folio_transactions', { isin: 'INF179K01BE2' });
    assert.equal(listRes.count, 1);
    assert.equal(listRes.transactions.length, 1);
    assert.equal(listRes.transactions[0].id, purchaseId);
    assert.equal(listRes.transactions[0].stt, 10);
    assert.equal(listRes.transactions[0].charges, 2.5);

    // 7. Verify get_holding_detail only counts the parent transaction
    const detailRes = await ok('get_holding_detail', { isin: 'INF179K01BE2' });
    assert.equal(detailRes.counted, 1);
    assert.equal(detailRes.transactions.length, 1);
    assert.equal(detailRes.transactions[0].id, purchaseId);
    assert.equal(detailRes.transactions[0].stt, 10);
    assert.equal(detailRes.transactions[0].charges, 2.5);
  });
});


