/*
 * The statement importer, minus the PDF.
 *
 * The parser has its own suite, which reads real statements and checks the numbers that
 * come out. What is tested here is the app's side of it: rejecting a file that is not a
 * statement, keeping anything identifying out of a diagnostic, and turning a parsed
 * statement into the right database rows.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { BACKEND, call, database, errors, freshBackend, ok } from './_harness.mjs';

const cas = await import(new URL(`file://${BACKEND.replace(/\\/g, '/')}/cas.js`).href);

const encode = (text) => Buffer.from(text, 'binary').toString('base64');

beforeEach(async () => {
  await freshBackend();
});

describe('what reaches the parser', () => {
  it('reports a missing file', async () => {
    const result = await cas.handleCasAction({ action: 'parse_base64', pdf_base64: '' });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'CAS_NO_FILE');
  });

  it('accepts either spelling of the argument', async () => {
    // The two sides of this call disagreed on the name once, which silently sent an empty
    // file to the parser.
    for (const key of ['pdf_base64', 'base64_pdf']) {
      const result = await cas.handleCasAction({
        action: 'parse_base64', [key]: encode('not a pdf'),
      });
      assert.equal(result.code, 'CAS_NOT_PDF', key);
    }
  });

  it('rejects something that is not a PDF before opening anything', async () => {
    const result = await cas.handleCasAction({
      action: 'parse_base64', pdf_base64: encode('PK this is a zip'),
    });
    assert.equal(result.code, 'CAS_NOT_PDF');
  });

  it('rejects an unreadable payload', async () => {
    const result = await cas.handleCasAction({
      action: 'parse_base64', pdf_base64: '!!!not base64!!!',
    });
    assert.equal(result.status, 'error');
    assert.ok(['CAS_DECODE_FAILED', 'CAS_NOT_PDF'].includes(result.code), result.code);
  });

  it('rejects an action it does not have', async () => {
    const result = await cas.handleCasAction({ action: 'nope' });
    assert.equal(result.code, 'UNKNOWN_ACTION');
  });

  it('codes every input failure', async () => {
    const replies = [
      await cas.handleCasAction({ action: 'diagnose', pdf_base64: '' }),
      await cas.handleCasAction({ action: 'diagnose', pdf_base64: encode('nope') }),
      await cas.handleCasAction({ action: 'gains', pdf_base64: '' }),
    ];
    for (const reply of replies) {
      assert.equal(reply.status, 'error');
      assert.ok(reply.code in errors.ERROR_CODES, reply.code);
    }
  });
});

describe('the diagnostic sample', () => {
  it('carries nothing personal', () => {
    const sample = cas.redact(
      'Investor ABCDE1234F holds 1,234.567 units, mail me@example.com, 45000',
    );
    assert.ok(!sample.includes('ABCDE1234F'));
    assert.ok(!sample.includes('me@example.com'));
    assert.ok(sample.includes('<pan>'));
    assert.ok(sample.includes('<email>'));
    // Every digit is flattened, so no amount or account number survives.
    assert.ok(![...sample].some((character) => /\d/.test(character) && character !== '0'));
  });
});

describe('importing a registrar statement', () => {
  const statement = () => ({
    folios: [{
      folio: '12345678',
      amc: 'A fund house',
      schemes: [{
        scheme: 'An index fund - Direct Growth',
        isin: 'INF123456789',
        close: '100.500',
        valuation: { nav: '250.1234', value: '25137.40', cost: '20000.00' },
      }],
    }],
  });

  it('writes one folio row per scheme', async (t) => {
    const db = database.currentDatabase();
    const counts = cas.importRegistrarStatement(db, statement(), 1, '2026-08-10');
    assert.equal(counts.folio_count, 1);
    assert.equal(counts.scheme_count, 1);

    const { folios } = await ok(t, 'list_folios');
    assert.equal(folios.length, 1);
    assert.equal(folios[0].folio_number, '12345678');
    assert.equal(folios[0].scheme_name, 'An index fund - Direct Growth');
    assert.equal(folios[0].units, 100.5);
    assert.equal(folios[0].current_value, 25137.4);
    assert.equal(folios[0].invested_value, 20000);
  });

  it('refreshes a holding on a second import rather than duplicating it', async (t) => {
    const db = database.currentDatabase();
    cas.importRegistrarStatement(db, statement(), 1, '2026-08-10');

    const later = statement();
    later.folios[0].schemes[0].valuation.value = '31000.00';
    cas.importRegistrarStatement(db, later, 1, '2026-09-10');

    const { folios } = await ok(t, 'list_folios');
    assert.equal(folios.length, 1);
    assert.equal(folios[0].current_value, 31000);
    assert.equal(folios[0].last_updated, '2026-09-10');
  });

  it('skips a scheme with no name', async (t) => {
    const db = database.currentDatabase();
    const nameless = statement();
    nameless.folios[0].schemes[0].scheme = '';
    assert.equal(cas.importRegistrarStatement(db, nameless, 1, '2026-08-10').scheme_count, 0);
    assert.deepEqual((await ok(t, 'list_folios')).folios, []);
  });

  it('deduplicates transactions from overlapping imports and prevents inflated net into funds', async (t) => {
    const db = database.currentDatabase();

    // Statement 1 covers Jan and Feb with folio formatted as 12345/0 and no ISIN
    const stmt1 = {
      folios: [{
        folio: '12345/0',
        amc: 'HDFC Mutual Fund',
        schemes: [{
          scheme: 'HDFC Top 100 Fund - Direct Growth',
          isin: '',
          close: '100.000',
          valuation: { nav: '100.00', value: '10000.00', cost: '10000.00' },
          transactions: [
            { date: '2026-01-10', amount: '5000.00', units: '50.000', nav: '100.00', type: 'purchase', description: 'SIP' },
            { date: '2026-02-10', amount: '5000.00', units: '50.000', nav: '100.00', type: 'purchase', description: 'SIP' },
          ],
        }],
      }],
    };
    cas.importRegistrarStatement(db, stmt1, 1, '2026-02-15');

    // Statement 2 covers Feb and Mar with folio 12345 and ISIN present
    const stmt2 = {
      folios: [{
        folio: '12345',
        amc: 'HDFC Mutual Fund',
        schemes: [{
          scheme: 'HDFC Top 100 Fund - Direct Growth',
          isin: 'INF179K01BE2',
          close: '150.000',
          valuation: { nav: '110.00', value: '16500.00', cost: '15000.00' },
          transactions: [
            { date: '2026-02-10', amount: '5000.00', units: '50.000', nav: '100.00', type: 'purchase', description: 'SIP' },
            { date: '2026-03-10', amount: '5000.00', units: '50.000', nav: '100.00', type: 'purchase', description: 'SIP' },
          ],
        }],
      }],
    };
    cas.importRegistrarStatement(db, stmt2, 1, '2026-03-15');

    const txs = await ok(t, 'get_folio_transactions');
    // Exactly 3 unique transactions (Jan, Feb, Mar), NOT 4 (Feb should not be duplicated)
    assert.equal(txs.count, 3);
    assert.equal(txs.bought, 15000);
    assert.equal(txs.net, 15000);

    // Verify Net into funds (invest_cumulative) is not inflated
    const series = await ok(t, 'get_series', {
      metric: 'invest_cumulative', granularity: 'month', periods: 4,
    });
    // Last value should be exactly 15000, not inflated to 20000
    assert.equal(series.series[0].values.at(-1), 15000);
  });
});

describe('importing a depository statement', () => {
  const statement = () => ({
    accounts: [{
      name: 'A broker',
      type: 'NSDL Demat Account',
      dp_id: 'IN301151',
      client_id: '12241815',
      equities: [{
        isin: 'INE002A01018',
        name: 'A listed company',
        symbol: 'EXAMPLE',
        exchange: 'NSE',
        num_shares: '10',
        price: '1500.50',
        value: '15005.00',
      }],
      mutual_funds: [{
        isin: 'INF123456789',
        name: 'An exchange traded fund',
        folio: null,
        balance: '200.000',
        nav: '55.2500',
        value: '11050.00',
        total_cost: '9000.00',
      }],
      bonds: [{
        isin: 'INE000A07001',
        name: 'A bond',
        num_bonds: '5',
        face_value: '1000.00',
        market_price: null,
        value: '5000.00',
      }],
    }],
    nps: {
      pran: '110099887766',
      schemes: [{
        scheme: 'A pension scheme - Tier I',
        fund_manager: 'A pension fund',
        tier: 'I',
        asset_class: 'E',
        units: '1000.0000',
        nav: '45.2500',
        value: '45250.00',
      }],
    },
  });

  it('writes each kind of holding to its own table', async (t) => {
    const db = database.currentDatabase();
    const counts = cas.importDepositoryStatement(db, statement(), 1, '2026-08-10');
    assert.equal(counts.account_count, 1);
    assert.equal(counts.scheme_count, 1);
    assert.equal(counts.equity_count, 1);
    assert.equal(counts.bond_count, 1);
    assert.equal(counts.nps_count, 1);

    const demat = await ok(t, 'list_demat_holdings');
    assert.equal(demat.holdings.length, 2);
    assert.equal(demat.totals_by_kind.equity, 15005);
    assert.equal(demat.totals_by_kind.bond, 5000);

    const equity = demat.holdings.find((holding) => holding.kind === 'equity');
    assert.equal(equity.symbol, 'EXAMPLE');
    assert.equal(equity.exchange, 'NSE');
    assert.equal(equity.quantity, 10);

    // A bond has no market price on a summary row, so the face value stands in.
    const bond = demat.holdings.find((holding) => holding.kind === 'bond');
    assert.equal(bond.price, 1000);

    const nps = await ok(t, 'list_nps_holdings');
    assert.equal(nps.holdings.length, 1);
    assert.equal(nps.holdings[0].tier, 'I');
    assert.equal(nps.total_value, 45250);
  });

  it('gives a fund holding with no folio number one that is still unique', async (t) => {
    const db = database.currentDatabase();
    cas.importDepositoryStatement(db, statement(), 1, '2026-08-10');
    cas.importDepositoryStatement(db, statement(), 1, '2026-09-10');

    const { folios } = await ok(t, 'list_folios');
    assert.equal(folios.length, 1, 'a second import should refresh, not duplicate');
    assert.equal(folios[0].folio_number, 'IN301151/12241815');
    assert.equal(folios[0].last_updated, '2026-09-10');
  });

  it('counts every kind towards net worth', async (t) => {
    cas.importDepositoryStatement(database.currentDatabase(), statement(), 1, '2026-08-10');
    const summary = await ok(t, 'get_summary');
    assert.equal(summary.asset_totals.MF, 11050);
    assert.equal(summary.asset_totals.Demat, 20005);
    assert.equal(summary.asset_totals.NPS, 45250);
    assert.equal(summary.net_worth, 76305);
  });

  it('leaves the pension section out when there is none', async (t) => {
    const db = database.currentDatabase();
    const withoutNps = statement();
    withoutNps.nps = null;
    assert.equal(cas.importDepositoryStatement(db, withoutNps, 1, '2026-08-10').nps_count, 0);
    assert.deepEqual((await ok(t, 'list_nps_holdings')).holdings, []);
  });
});

describe('the last import date', () => {
  it('is what the reminder reads', async (t) => {
    await ok(t, 'update_setting', { key: 'last_cas_upload_date', value: '2026-08-10' });
    const { settings } = await ok(t, 'get_settings');
    assert.equal(settings.last_cas_upload_date, '2026-08-10');
    assert.equal((await call('get_settings')).status, 'success');
  });
});
