/*
 * Reading a consolidated account statement into the database.
 *
 * The PDF is parsed on the device. Nothing is uploaded, and the app has no network
 * permission to upload it with even if something tried. The investor's name and permanent
 * account number appear in these statements; neither is stored, because the app has no
 * use for them and not keeping them is the safer default.
 *
 * All four issuers now work. A registrar statement from CAMS or KFintech gives fund
 * folios with their full transaction history; a depository statement from NSDL or CDSL
 * gives the demat account as well, which is shares, exchange-traded funds, bonds and
 * pension holdings that a registrar statement cannot see at all.
 */

import { fail } from './errors.js';
import { getDatabase, initDb, resolveMemberId } from './database.js';
import { decodeBase64 } from './native.js';
import { isinDatabaseVersion, loadIsinDatabase, nameForIsin } from './isin.js';
// The parser's own name matcher. Reused rather than reinvented: it already knows that a
// registrar reorders a scheme's modifiers freely.
import { defaultProcess, tokenSortRatio } from '../../vendor/casparser/isin-db.js';

const PDFJS_URL = new URL('../../vendor/pdfjs/pdf.mjs', import.meta.url);
const PDFJS_WORKER_URL = new URL('../../vendor/pdfjs/pdf.worker.mjs', import.meta.url);
const CASPARSER_URL = new URL('../../vendor/casparser/index.js', import.meta.url);

/** Below this much readable text, the file is a scan rather than a statement. */
const MIN_TEXT_CHARS = 40;

let parser = null;

/** Loads the parser and points it at the vendored pdf.js, once. */
async function loadParser() {
  if (parser) return parser;

  const [casparser, pdfjsLib] = await Promise.all([
    import(CASPARSER_URL.href),
    import(PDFJS_URL.href),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL.href;

  const backend = casparser.createPdfjsBackend(pdfjsLib);
  casparser.setPdfBackend(backend);
  parser = { casparser, backend };
  return parser;
}

/* -------------------------------------------------------------- classification */

/**
 * Turns a parser failure into a coded reply.
 *
 * The parser reports what went wrong precisely, so this is a mapping rather than the
 * guesswork the previous implementation needed. The one case worth a second look is a
 * file whose issuer could not be identified: that is either a statement from somewhere
 * else or a scan with no text in it at all, and the two need entirely different advice.
 */
async function classify(error, bytes, password) {
  const name = error && error.name;
  const message = String((error && error.message) || error);

  if (name === 'IncorrectPasswordError') {
    return fail('CAS_WRONG_PASSWORD', 'That password did not open the PDF.',
      'It is usually your PAN in capitals. Some statements use the password you chose '
      + 'when you asked for it.');
  }

  if (message.includes('Could not identify the CAS issuer')) {
    const text = await readableText(bytes, password);
    if (text !== null && text.trim().length < MIN_TEXT_CHARS) {
      return fail('CAS_NO_TEXT_LAYER', 'That PDF has no readable text in it.',
        'It looks like a scan or a photo. Import the original PDF that was emailed to '
        + 'you, rather than a printed or scanned copy.');
    }
    return fail('CAS_UNKNOWN_TYPE', 'That PDF is not a statement this app recognises.',
      'It needs a consolidated account statement from CAMS, KFintech, NSDL or CDSL.');
  }

  if (message.includes('Could not extract investor info')) {
    return fail('CAS_UNREADABLE_LAYOUT',
      'The PDF opened, but the statement was not laid out the way the parser expects.',
      'Ask for a fresh statement. A scanned or printed copy has no text to read and will '
      + 'not work.', { detail: message });
  }

  if (message.includes('DETAILED or SUMMARY')) {
    return fail('CAS_HEADER_UNREADABLE', 'The statement header could not be read.',
      'The file may be truncated. Try downloading it again.', { detail: message });
  }

  if (message.includes('Unhandled error while opening')) {
    return fail('CAS_FILE_UNREADABLE', 'The PDF could not be opened.',
      'The file looks damaged or is not really a PDF. Try downloading it again.',
      { detail: message });
  }

  return fail('CAS_FILE_UNREADABLE', 'The statement could not be read.',
    'If this keeps happening, the statement format may not be supported yet.',
    { detail: `${name}: ${message}` });
}

/** The text of the first few pages, or null when the file will not open at all. */
async function readableText(bytes, password, maxPages = 3) {
  try {
    const { backend } = await loadParser();
    const document = await backend.open(bytes, password);
    try {
      const parts = [];
      for (let page = 1; page <= Math.min(maxPages, document.numPages); page += 1) {
        // eslint-disable-next-line no-await-in-loop
        parts.push(await document.getText(page));
      }
      return parts.join('\n');
    } finally {
      await document.close();
    }
  } catch {
    return null;
  }
}

/**
 * A structural sample of a file's text with everything identifying removed.
 *
 * This is only ever shown to the person whose statement it is, but it exists to be pasted
 * into a bug report, so names, numbers, permanent account numbers and email addresses do
 * not travel with it.
 */
export function redact(text, limit = 600) {
  return text.slice(0, limit)
    .replace(/[A-Z]{5}\d{4}[A-Z]/gi, '<pan>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/\d/g, '0')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/* ---------------------------------------------------------------------- input */

function decode(payload) {
  if (!payload) return fail('CAS_NO_FILE', 'No file reached the parser.', 'Try choosing the file again.');
  let bytes;
  try {
    bytes = decodeBase64(payload);
  } catch {
    return fail('CAS_DECODE_FAILED', 'That file could not be decoded.');
  }
  const header = String.fromCharCode(...bytes.slice(0, 4));
  if (header !== '%PDF') {
    return fail('CAS_NOT_PDF', 'That is not a PDF.',
      'Statements arrive as a PDF attachment. A zip needs extracting first.');
  }
  return bytes;
}

/* --------------------------------------------------------------------- import */

function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value.toString ? value.toString() : value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Writes or refreshes one fund holding. A repeat import updates rather than duplicates. */
/*
 * The pseudo-account a depository uses for units held with the AMC rather than in demat.
 * It is the section that overlaps a registrar statement, so it is worth telling apart
 * from a real demat account.
 */
/*
 * Two names for one scheme.
 *
 * Statements write a scheme every way there is: "Nifty50Index Fund-Direct Plan Growth"
 * against "Nifty 50 Index Fund - Direct Plan - Growth", and "Axis Small Cap Fund - Direct
 * Plan Growth" against "Axis Small Cap Fund Direct Growth". Stripping punctuation closes
 * the first pair and not the second, because one side simply has a word the other lacks.
 * The parser already carries a token-sort ratio for this, so the comparison is its job
 * rather than a second rule invented here.
 */
const SIMILAR_ENOUGH = 88;

/*
 * The words that must not be fuzzed over. A direct plan and a regular plan are different
 * schemes with different ISINs and different NAVs, and so are growth and IDCW. They differ
 * by one word out of eight, which any similarity score calls a match, so they are checked
 * exactly and separately from the rest of the name.
 */
const PLAN_WORDS = /\b(direct|regular)\b/g;
const OPTION_WORDS = /\b(growth|idcw|dividend|payout|reinvestment|bonus)\b/g;

function variantOf(name) {
  const text = defaultProcess(name);
  const words = (pattern) => [...new Set(text.match(pattern) || [])].sort().join(' ');
  return { plan: words(PLAN_WORDS), option: words(OPTION_WORDS) };
}

/** Everything that is not a letter or a digit, gone. */
function squashed(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/*
 * Whether two scheme names describe the same scheme.
 *
 * Two routes, because neither closes both of the shapes a statement produces. Squashing
 * the punctuation away matches "Nifty50Index Fund" against "Nifty 50 Index Fund", which
 * the token ratio scores at only 78 because one side is a single token and the other is
 * three. The token ratio matches "Direct Plan Growth" against "Direct Growth", where one
 * side simply has a word the other lacks and squashing leaves two different strings.
 *
 * Both routes run behind the same guard, because both are happy to match a direct plan
 * with a regular one. "Direct Growth" against "Direct IDCW" scores 88 on the ratio, which
 * is the threshold itself, so the guard rather than the score is what keeps them apart.
 */
function sameScheme(a, b) {
  const left = variantOf(a);
  const right = variantOf(b);
  // A disagreement counts only when both sides said something. A statement that omits the
  // plan entirely should not be ruled out on the strength of a word it never printed.
  if (left.plan && right.plan && left.plan !== right.plan) return false;
  if (left.option && right.option && left.option !== right.option) return false;

  if (squashed(a) && squashed(a) === squashed(b)) return true;
  return tokenSortRatio(defaultProcess(a), defaultProcess(b)) >= SIMILAR_ENOUGH;
}

/**
 * A fingerprint of the file itself.
 *
 * Returns nothing where WebCrypto is unavailable, which only means a repeat upload goes
 * unnoticed rather than that anything breaks.
 */
async function digestOf(bytes) {
  const engine = globalThis.crypto && globalThis.crypto.subtle;
  if (!engine) return '';
  try {
    const hash = await engine.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

/** The day a statement was drawn up, as a sortable date, or nothing if it does not say. */
function statementDate(data) {
  const to = data.statement_period && data.statement_period.to;
  if (!to) return '';
  const text = String(to).trim();
  // Registrars write DD-MMM-YYYY and depositories write YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

function isFolioAccount(account) {
  return /folio/i.test(account.name || '') || /folio/i.test(account.type || '');
}

/*
 * Where a holding is kept, which is what a statement is a snapshot of.
 *
 * Units held with an AMC are one place however they were reported: a registrar prints the
 * folio and a depository masks it, but they are the same money. Units in demat belong to
 * the account they sit in, and the same scheme in two demat accounts is two holdings.
 */
function scopeOf(source, dpId, clientId) {
  return source === 'depository' ? `demat:${dpId || ''}/${clientId || ''}` : 'with-amc';
}

/*
 * Writes one fund holding into its scope.
 *
 * Identity is the scheme, not the units. An earlier version matched on units, which works
 * exactly once: the next month's statement carries a monthly instalment more and the same
 * holding stops matching itself. The ISIN is what a scheme is, and the name is the way in
 * when a depository masks the ISIN.
 *
 * The newer statement wins on everything it knows. A cost is never overwritten by a
 * statement that does not carry one, which is the whole reason for reading both: only a
 * registrar prints what was paid.
 */
function upsertFolio(db, row, scope) {
  const [memberId, folioNumber, amc, schemeName, isin, units, nav,
    value, invested, updated, source] = row;

  /*
   * Candidates from everywhere, not just this scope.
   *
   * A registrar and a depository both report units of a fund held in demat: the units are
   * RTA serviced whichever way they are held, so one holding turns up in both statements.
   * Ten of them did, six with byte identical unit counts, and keeping the scopes apart
   * counted fifteen lakh twice.
   *
   * Two demat accounts are the exception and are genuinely two places. The same gold ETF
   * sat in two of them with a hundred units in one and nine hundred in the other, and
   * merging those would have lost one outright.
   */
  const twoDematAccounts = (other) => other.scope !== scope
    && other.scope.startsWith('demat:') && scope.startsWith('demat:');

  const candidates = db.all(
    'SELECT id, scheme_name, isin, scope, last_updated FROM mf_folios',
  ).filter((other) => !twoDematAccounts(other));

  /*
   * An ISIN settles it when both sides have one. Names do not: "Axis Small Cap Fund -
   * Direct Plan Growth" and "Axis Small Cap Fund - Direct Growth" score 93 against each
   * other and are two different schemes with two different codes. So the name is only
   * consulted where a code is missing, which is the case a depository creates by masking
   * it, and never to overrule one.
   */
  const twin = (isin && candidates.find((row2) => row2.isin === isin))
    || (schemeName && candidates.find((row2) => (!row2.isin || !isin)
      && sameScheme(row2.scheme_name, schemeName)))
    || null;

  if (twin) {
    const fresher = !twin.last_updated || String(updated) >= String(twin.last_updated);
    db.run(
      'UPDATE mf_folios SET'
      + ' folio_number = CASE WHEN ? THEN ? ELSE folio_number END,'
      + ' scheme_name = CASE WHEN ? THEN ? ELSE scheme_name END,'
      + ' amc = CASE WHEN ? THEN ? ELSE amc END,'
      + ' isin = CASE WHEN ? AND ? != \'\' THEN ? ELSE isin END,'
      + ' units = CASE WHEN ? THEN ? ELSE units END,'
      + ' nav = CASE WHEN ? THEN ? ELSE nav END,'
      + ' current_value = CASE WHEN ? THEN ? ELSE current_value END,'
      + ' source = CASE WHEN ? THEN ? ELSE source END,'
      // The newest statement decides where a holding is filed too, otherwise two
      // statements disagreeing about it move the row back and forth on every import.
      + ' scope = CASE WHEN ? THEN ? ELSE scope END,'
      + ' last_updated = CASE WHEN ? THEN ? ELSE last_updated END,'
      + ' invested_value = CASE WHEN ? > 0 THEN ? ELSE invested_value END'
      + ' WHERE id = ?',
      [fresher, folioNumber, fresher, schemeName, fresher, amc,
        fresher, isin, isin, fresher, units, fresher, nav, fresher, value,
        fresher, source, fresher, scope, fresher, updated, invested, invested, twin.id],
    );
    return twin.id;
  }

  /*
   * The exact key, looked up rather than left to ON CONFLICT.
   *
   * An upsert that resolves to an update performs no insert, so the rowid the driver
   * reports afterwards belongs to whatever was inserted last, possibly in another
   * statement entirely. Handing that id to the pruner marked the wrong row as kept and
   * deleted the right one, which looked like a second import's data never arriving.
   */
  const exact = db.get(
    'SELECT id, last_updated FROM mf_folios WHERE folio_number = ? AND scheme_name = ?'
    + ' AND isin = ?',
    [folioNumber, schemeName, isin],
  );

  if (exact) {
    // The same freshness rule as the merge path above. Without it this branch overwrote
    // whatever it found, so loading last month's statement after this month's walked the
    // units and the valuation backwards.
    const fresher = !exact.last_updated || String(updated) >= String(exact.last_updated);
    db.run(
      'UPDATE mf_folios SET'
      + ' amc = CASE WHEN ? THEN ? ELSE amc END,'
      + ' units = CASE WHEN ? THEN ? ELSE units END,'
      + ' nav = CASE WHEN ? THEN ? ELSE nav END,'
      + ' current_value = CASE WHEN ? THEN ? ELSE current_value END,'
      + ' last_updated = CASE WHEN ? THEN ? ELSE last_updated END,'
      + ' source = CASE WHEN ? THEN ? ELSE source END,'
      + ' scope = ?,'
      // A cost is taken from whichever statement carries one, new or old, because only a
      // registrar prints it and it does not go stale the way a valuation does.
      + ' invested_value = CASE WHEN ? > 0 THEN ? ELSE invested_value END'
      + ' WHERE id = ?',
      [fresher, amc, fresher, units, fresher, nav, fresher, value,
        fresher, updated, fresher, source, scope, invested, invested, exact.id],
    );
    return exact.id;
  }

  const result = db.run(
    'INSERT INTO mf_folios (member_id, folio_number, amc, scheme_name, isin, units, nav,'
    + ' current_value, invested_value, last_updated, source, scope)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [...row, scope],
  );
  return result.lastInsertRowid;
}

/*
 * Forgets holdings a newer statement no longer lists.
 *
 * A statement is a snapshot of a place, not a list of additions. Without this a fund that
 * was sold sits in the table for ever, because nothing an import does ever removes a row,
 * and somebody uploading a statement every month would watch their holdings only ever
 * grow. Only scopes this statement actually covered are pruned, and only when it is at
 * least as recent as what is already recorded.
 */
function pruneScopes(db, scopes, keptIds, asOf) {
  for (const scope of scopes) {
    const stale = db.all(
      'SELECT id FROM mf_folios WHERE scope = ? AND (last_updated IS NULL OR last_updated <= ?)',
      [scope, asOf],
    ).filter((row) => !keptIds.has(row.id));
    for (const row of stale) db.run('DELETE FROM mf_folios WHERE id = ?', [row.id]);
  }
}

function upsertDematHolding(db, row) {
  db.run(
    'INSERT INTO demat_holdings (member_id, account_type, broker, dp_id, client_id, kind,'
    + ' isin, name, symbol, exchange, quantity, price, current_value, last_updated)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    + ' ON CONFLICT(dp_id, client_id, isin, kind) DO UPDATE SET'
    + ' account_type = excluded.account_type, broker = excluded.broker,'
    + ' name = excluded.name, symbol = excluded.symbol, exchange = excluded.exchange,'
    + ' quantity = excluded.quantity, price = excluded.price,'
    + ' current_value = excluded.current_value, last_updated = excluded.last_updated',
    row,
  );
}

function upsertNpsHolding(db, row) {
  db.run(
    'INSERT INTO nps_holdings (member_id, pran, scheme, fund_manager, tier, asset_class,'
    + ' units, nav, current_value, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    + ' ON CONFLICT(pran, scheme) DO UPDATE SET'
    + ' fund_manager = excluded.fund_manager, tier = excluded.tier,'
    + ' asset_class = excluded.asset_class, units = excluded.units, nav = excluded.nav,'
    + ' current_value = excluded.current_value, last_updated = excluded.last_updated',
    row,
  );
}

/** Writes a registrar statement's folios. */
export function importRegistrarStatement(db, data, memberId, stamp) {
  let schemes = 0;
  let movements = 0;
  const kept = new Set();
  for (const folio of data.folios) {
    const folioNumber = folio.folio || '';
    for (const scheme of folio.schemes) {
      if (!scheme.scheme) continue;
      const units = toNumber(scheme.close);
      const nav = toNumber(scheme.valuation && scheme.valuation.nav);
      kept.add(upsertFolio(db, [
        memberId, folioNumber, folio.amc || '', scheme.scheme, scheme.isin || '',
        units, nav,
        toNumber(scheme.valuation && scheme.valuation.value, units * nav),
        toNumber(scheme.valuation && scheme.valuation.cost),
        stamp, 'registrar',
      ], 'with-amc'));
      schemes += 1;
      movements += writeTransactions(db, memberId, folioNumber, scheme, stamp);
    }
  }
  // A registrar statement is the whole of what is held with the AMCs, so anything in that
  // scope it did not mention has been sold.
  pruneScopes(db, ['with-amc'], kept, stamp);
  return {
    folio_count: data.folios.length, scheme_count: schemes, transaction_count: movements,
  };
}

export function normalizeFolio(folio) {
  return String(folio || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/\/0+$/, '')
    .replace(/^\/+/, '');
}

/*
 * The lines behind a holding, where the statement carries them.
 *
 * A summary statement says what is held today and nothing about how it got there. Only a
 * detailed one lists the instalments, the redemptions and the dividends, so this writes
 * nothing at all most of the time and everything when somebody asks their registrar for
 * the longer file.
 *
 * Rows are keyed on the line rather than counted, so reading the same statement twice, or
 * a longer one covering the same period, leaves one row per movement.
 */
function writeTransactions(db, memberId, folioNumber, scheme, stamp) {
  const lines = scheme.transactions || [];
  let written = 0;
  const isin = String(scheme.isin || '').trim();
  const schemeName = String(scheme.scheme || '').trim();
  const folio = String(folioNumber || '').trim();
  const normFolio = normalizeFolio(folio);

  for (const line of lines) {
    const date = String(line.date || '').slice(0, 10);
    if (!date) continue;
    const amount = toNumber(line.amount);
    const units = toNumber(line.units);
    // A statement repeats its opening balance as a line with neither. Nothing moved.
    if (!amount && !units) continue;

    // Check for existing matching line in folio_transactions to avoid duplicate lines from overlapping imports
    const candidates = db.all(
      'SELECT id, folio_number, isin, scheme_name, description, kind, nav, balance, last_updated'
      + ' FROM folio_transactions'
      + ' WHERE member_id = ? AND date = ? AND ABS(amount - ?) < 0.01 AND ABS(units - ?) < 0.0001',
      [memberId, date, amount, units],
    );

    const existing = candidates.find((c) => {
      if (isin && c.isin && c.isin === isin) return true;
      if (normFolio && normalizeFolio(c.folio_number) === normFolio) return true;
      if (schemeName && c.scheme_name && sameScheme(c.scheme_name, schemeName)) return true;
      if (c.folio_number === folio) return true;
      return false;
    });

    if (existing) {
      const bestIsin = isin || existing.isin || '';
      const bestFolio = folio || existing.folio_number || '';
      const bestScheme = schemeName || existing.scheme_name || '';
      const bestNav = toNumber(line.nav) || existing.nav || 0;
      const bestBalance = toNumber(line.balance) || existing.balance || 0;
      const bestDesc = String(line.description || '') || existing.description || '';
      const bestKind = String(line.type || '') || existing.kind || '';

      db.run(
        'UPDATE folio_transactions SET folio_number = ?, isin = ?, scheme_name = ?,'
        + ' description = ?, kind = ?, nav = ?, balance = ?, last_updated = ?'
        + ' WHERE id = ?',
        [bestFolio, bestIsin, bestScheme, bestDesc, bestKind, bestNav, bestBalance, stamp, existing.id],
      );
    } else {
      db.run(
        'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date,'
        + ' description, kind, amount, units, nav, balance, last_updated)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        + ' ON CONFLICT(folio_number, isin, date, amount, units) DO UPDATE SET'
        + ' description = excluded.description, kind = excluded.kind,'
        + ' nav = excluded.nav, balance = excluded.balance,'
        + ' last_updated = excluded.last_updated',
        [memberId, folio, isin, schemeName, date,
          String(line.description || ''), String(line.type || ''), amount, units,
          toNumber(line.nav), toNumber(line.balance), stamp],
      );
    }
    written += 1;
  }
  return written;
}

/** Writes a depository statement: funds, shares, bonds and pension holdings. */
export function importDepositoryStatement(db, data, memberId, stamp) {
  let schemes = 0;
  let equities = 0;
  let bonds = 0;
  let npsSchemes = 0;
  const keptIds = new Set();
  const scopes = new Set();

  for (const account of data.accounts) {
    const dpId = account.dp_id || '';
    const clientId = account.client_id || '';
    // A depository does not always print a folio number for a fund holding, and the
    // uniqueness of a holding has to come from somewhere, so the account stands in.
    const fallbackFolio = `${dpId || 'DEMAT'}/${clientId || account.type}`;
    const source = isFolioAccount(account) ? 'amc-folio' : 'depository';
    const scope = scopeOf(source, dpId, clientId);
    /*
     * A depository is authoritative for what sits in its own accounts and not for what is
     * held directly with an AMC: it masks that section, so it lists some of those folios
     * and not others. Pruning on the strength of a partial list would delete real
     * holdings, so only the demat scopes are pruned here and the registrar prunes its own.
     */
    if (account.mutual_funds.length && source === 'depository') scopes.add(scope);

    for (const fund of account.mutual_funds) {
      // The reference database wins here. What a depository prints is the fund house, so
      // taking the statement's word for it files every scheme an AMC runs under one name.
      const name = nameForIsin(fund.isin) || fund.name || fund.isin;
      if (!name) continue;
      const units = toNumber(fund.balance);
      const nav = toNumber(fund.nav);
      keptIds.add(upsertFolio(db, [
        memberId, fund.folio || fallbackFolio, account.name || account.type, name,
        fund.isin || '', units, nav,
        toNumber(fund.value, units * nav), toNumber(fund.total_cost), stamp,
        // Where the units sit, not who runs the scheme. A depository holding belongs to
        // the broker's account; a registrar folio belongs to no broker at all.
        source,
      ], scope));
      schemes += 1;
    }

    for (const equity of account.equities) {
      upsertDematHolding(db, [
        memberId, account.type, account.name || '', dpId, clientId, 'equity',
        // A depository does print a company name, so that is preferred and the reference
        // database only fills in for the rows where it printed nothing.
        equity.isin, equity.name || nameForIsin(equity.isin), equity.symbol || '', equity.exchange || '',
        toNumber(equity.num_shares), toNumber(equity.price), toNumber(equity.value), stamp,
      ]);
      equities += 1;
    }

    for (const bond of account.bonds) {
      upsertDematHolding(db, [
        memberId, account.type, account.name || '', dpId, clientId, 'bond',
        bond.isin, bond.name || '', '', '',
        toNumber(bond.num_bonds), toNumber(bond.market_price ?? bond.face_value),
        toNumber(bond.value), stamp,
      ]);
      bonds += 1;
    }
  }

  if (data.nps && data.nps.schemes.length) {
    const pran = data.nps.pran || 'NPS';
    for (const scheme of data.nps.schemes) {
      upsertNpsHolding(db, [
        memberId, pran, scheme.scheme, scheme.fund_manager || '', scheme.tier || '',
        scheme.asset_class || '', toNumber(scheme.units), toNumber(scheme.nav),
        toNumber(scheme.value), stamp,
      ]);
      npsSchemes += 1;
    }
  }

  // Only the places this statement actually reported on. A depository statement says
  // nothing about a folio held directly with an AMC, so it must not clear one.
  pruneScopes(db, scopes, keptIds, stamp);

  return {
    account_count: data.accounts.length,
    scheme_count: schemes,
    equity_count: equities,
    bond_count: bonds,
    nps_count: npsSchemes,
  };
}

/** Parses a statement and writes what it holds. */
export async function parseCasBase64(payload, password = '', memberId = 1) {
  const bytes = decode(payload);
  if (bytes.status === 'error') return bytes;

  /*
   * Hashed before the parser sees it.
   *
   * pdf.js takes ownership of the array it is handed and detaches the buffer behind it, so
   * anything read afterwards reads nothing. Hashing after parsing produced the SHA-256 of
   * an empty input, the same constant for every file, and every statement after the first
   * was reported as one already imported.
   */
  const digest = await digestOf(bytes);

  const { casparser } = await loadParser();
  await loadIsinDatabase();

  let data;
  try {
    data = await casparser.readCasPdf(bytes, password);
  } catch (error) {
    return classify(error, bytes, password);
  }

  const db = await getDatabase();
  initDb(db);
  const stamp = today();
  const member = resolveMemberId(db, memberId);

  /*
   * The same file twice.
   *
   * Noted, never refused. Re-importing is harmless, because a statement replaces the
   * places it covers rather than adding to them, and refusing it is how somebody ends up
   * unable to load a statement again after the reader itself has improved. The only thing
   * worth doing is saying so, in case they meant to pick a different file.
   */
  const seenBefore = digest
    ? db.get('SELECT imported_at FROM imported_statements WHERE digest = ?', [digest])
    : null;

  /*
   * A holding is stamped with the date the statement was drawn up, not the date it was
   * imported. Two statements describing the same holding agree on the units and disagree
   * on the value, because they were priced on different days, and the only way to know
   * which value is current is to know which statement is newer. Importing both on the
   * same afternoon makes the import date useless for that.
   */
  const asOf = statementDate(data) || stamp;

  const counts = db.transaction(() => (data.accounts
    ? importDepositoryStatement(db, data, member, asOf)
    : importRegistrarStatement(db, data, member, asOf)));

  const imported = (counts.scheme_count || 0) + (counts.equity_count || 0)
    + (counts.bond_count || 0) + (counts.nps_count || 0);

  if (imported === 0) {
    return fail('CAS_NO_HOLDINGS', 'The statement was read but held no holdings.',
      'A statement for a period with no activity can come back empty. Try a wider date '
      + 'range.');
  }

  if (digest) {
    db.run(
      'INSERT OR REPLACE INTO imported_statements (digest, issuer, period_to, imported_at)'
      + ' VALUES (?, ?, ?, ?)',
      [digest, data.file_type || '', asOf, stamp],
    );
  }

  db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_cas_upload_date', ?)",
    [stamp]);
  await db.persistNow();

  return {
    status: 'success',
    issuer: data.file_type,
    statement_period: data.statement_period ? data.statement_period.dump() : {},
    parse_warnings: data.parse_warnings || [],
    // Said, not enforced. The holdings were refreshed either way.
    already_imported: Boolean(seenBefore),
    previously_imported_at: seenBefore ? seenBefore.imported_at : '',
    // Enough of the fingerprint to tell two files apart when one is mistaken for the other.
    file_digest: digest ? digest.slice(0, 12) : '',
    as_of: asOf,
    ...counts,
  };
}

/* ------------------------------------------------------------------ diagnosis */

/**
 * Reports what a file looks like, without importing it.
 *
 * Exists so a failing import can be described precisely. The sample it returns has
 * digits, permanent account numbers and email addresses stripped, so it can be pasted
 * into a bug report.
 */
export async function diagnose(payload, password = '') {
  const bytes = decode(payload);
  if (bytes.status === 'error') return bytes;

  const { casparser, backend } = await loadParser();
  const report = {
    status: 'success',
    size_kb: Math.round((bytes.length / 1024) * 10) / 10,
    parser: casparser.VERSION,
  };

  let document;
  try {
    document = await backend.open(bytes, password);
  } catch (error) {
    return { ...report, ...(await classify(error, bytes, password)), status: 'success' };
  }

  try {
    report.pages = document.numPages;
    report.issuer = await casparser.detectFileType(document);
    if (report.issuer === 'CAMS' || report.issuer === 'KFINTECH') {
      report.cas_type = await casparser.detectCasType(document);
    }
    const parts = [];
    for (let page = 1; page <= Math.min(3, document.numPages); page += 1) {
      // eslint-disable-next-line no-await-in-loop
      parts.push(await document.getText(page));
    }
    const text = parts.join('\n');
    report.text_chars = text.length;
    report.sample = redact(text);
  } finally {
    await document.close();
  }
  return report;
}

/* ---------------------------------------------------------------------- gains */

/**
 * The realised capital gains a statement implies.
 *
 * Only a detailed registrar statement carries the transaction history this needs, and
 * only one that starts from a zero balance: without the purchases, a sale has no cost to
 * be measured against. Nothing is stored; the report is computed and handed back.
 */
export async function capitalGains(payload, password = '', financialYear = null) {
  const bytes = decode(payload);
  if (bytes.status === 'error') return bytes;

  const { casparser } = await loadParser();
  await loadIsinDatabase();

  let data;
  try {
    data = await casparser.readCasPdf(bytes, password);
  } catch (error) {
    return classify(error, bytes, password);
  }

  if (!data.folios) {
    return fail('CAS_SUMMARY_ONLY',
      'A depository statement lists holdings but not the transactions gains are computed from.',
      'Ask CAMS or KFintech for a detailed statement covering the whole holding period.');
  }

  let report;
  try {
    report = new casparser.CapitalGainsReport(data);
  } catch (error) {
    if (error.name === 'IncompleteCASError') {
      return fail('CAS_SUMMARY_ONLY',
        'That statement does not go back far enough to work out what the units cost.',
        'Ask for one that starts before your first purchase, so every sale has a purchase '
        + 'to be matched against.');
    }
    throw error;
  }

  const years = report.getFyList();
  const year = financialYear && years.includes(financialYear) ? financialYear : years[0] || null;

  return {
    status: 'success',
    financial_years: years,
    financial_year: year,
    summary: report.getSummary().map(([fy, fund, isin, type, ltcg, taxable, stcg]) => ({
      financial_year: fy,
      fund,
      isin,
      type,
      ltcg: toNumber(ltcg),
      ltcg_taxable: toNumber(taxable),
      stcg: toNumber(stcg),
    })),
    quarterly: year
      ? Object.fromEntries(Object.entries(report.quarterlyGains(year))
        .map(([category, quarters]) => [category, quarters.map((q) => toNumber(q))]))
      : {},
    quarter_labels: casparser.QUARTER_LABELS,
    schedule_112a_csv: year ? report.generate112aCsvData(year) : '',
    gains_csv: report.getGainsCsvData(),
    gifts: report.gifts.map((gift) => ({
      financial_year: gift.fy,
      fund: gift.fund.name,
      direction: gift.direction,
      date: String(gift.date),
      units: toNumber(gift.units),
      value: toNumber(gift.value),
      counterparty_folio: gift.counterparty_folio,
    })),
    errors: report.errors.map(([fund, message]) => ({ fund, message })),
    invested: toNumber(report.invested_amount),
    current_value: toNumber(report.current_value),
  };
}

/* --------------------------------------------------------------------- router */

export async function handleCasAction(args = {}) {
  try {
    const memberId = args.member_id;
    // The two sides of this call disagreed on the name once, which silently sent an empty
    // file to the parser. Both spellings work.
    const payload = args.pdf_base64 || args.base64_pdf || '';

    if (args.action === 'parse_base64') {
      return await parseCasBase64(payload, args.password ?? '', memberId);
    }
    if (args.action === 'diagnose') {
      return await diagnose(payload, args.password ?? '');
    }
    if (args.action === 'gains') {
      return await capitalGains(payload, args.password ?? '', args.financial_year ?? null);
    }
    if (args.action === 'versions') {
      // What is actually bundled, for the About screen and for a bug report. The
      // reference data is published on its own schedule, so its date is the useful part.
      const { casparser } = await loadParser();
      await loadIsinDatabase();
      return {
        status: 'success',
        parser: casparser.VERSION,
        reference_data: isinDatabaseVersion(),
      };
    }
    return fail('UNKNOWN_ACTION', `Unknown CAS action: ${args.action}`);
  } catch (error) {
    return fail('INTERNAL', `${error.name}: ${error.message}`);
  }
}
