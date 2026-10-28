/*
 * Systematic Investment Plan (SIP) Tracker & Mandate Reconciliation Engine.
 *
 * Provides two-tier mandate and child SIP management, automated split allocations,
 * disambiguation of same-amount investments, CAMS/CAS folio transaction correlation,
 * historical transaction linking, and background reconciliation.
 */

import { fail } from './errors.js';
import { merchantKey } from './merchants.js';
import {
  addMonths, daysBetween, isoDate, memberClause, number, parseISO, today,
} from './periods.js';

/** Maximum day difference between bank debit and CAMS/demat allotment */
const ALLOTMENT_LAG_DAYS = 5;

/** Matching window for debit day variance (holidays, weekends) */
const DEBIT_DAY_WINDOW = 3;

/* ---------------------------------------------------------------- helpers */

function currentMonthKey() {
  return today().slice(0, 7);
}

function normalizeScheme(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s*-\s*(Direct|Regular)?\s*(Plan)?\s*-\s*(Growth|IDCW|Dividend|Bonus).*$/i, '')
    .trim();
}

/**
 * Detect if a transaction or folio transaction represents a statutory stamp duty charge or tax.
 * Mutual fund purchases in India attract a 0.005% stamp duty. In statements (CAMS, KFintech, CAS),
 * AMCs/registrars record stamp duty as a separate transaction row (e.g. STAMP_DUTY_TAX, or description
 * containing 'Stamp Duty'). Banks also occasionally debit stamp duty for e-mandates.
 * These records must be ignored by the SIP tracker.
 */
/**
 * Classifies if a transaction or folio transaction represents an additional statutory
 * cost, tax, or fee (stamp duty, STT / transaction tax, exchange fees, turnover charges,
 * transaction charges, TDS, GST, etc.).
 *
 * Returns an object { type, category, label } or null if it is a normal trade/investment:
 * - 'stamp_duty': Stamp duty (0.005% MF, 0.015% delivery equity)
 * - 'stt': Securities Transaction Tax / Transaction Tax
 * - 'exchange_fee': Exchange turnover fees, SEBI charges, clearing fees
 * - 'charges': Transaction charges, AMC charges, brokerage, GST, service tax
 * - 'tds': Tax Deducted at Source
 */
export function classifyAdditionalCost(item) {
  if (!item) return null;
  const desc = String(item.description || '').toLowerCase();
  const kind = String(item.kind || item.type || '').toLowerCase();
  const merchant = String(item.merchant || item.merchant_key || item.name || '').toLowerCase();
  const notes = String(item.notes || '').toLowerCase();
  const text = `${desc} ${kind} ${merchant} ${notes}`;

  // 1. Stamp Duty
  if (
    kind === 'stamp_duty_tax' || kind === 'stamp_duty' || kind === 'stamp'
    || /\bstamp\s*(duty|charges?|tax|levy)?\b/i.test(text)
    || /^stamp\b/i.test(desc.trim()) || /^stamp\b/i.test(kind.trim())
  ) {
    return { type: 'stamp_duty', label: 'Stamp duty' };
  }

  // 2. Securities Transaction Tax (STT) / Transaction Tax
  if (
    kind === 'stt_tax' || kind === 'stt' || kind === 'sec_tax' || kind === 'transaction_tax' || kind === 'securities_transaction_tax'
    || /\b(securities\s*transaction\s*tax|transaction\s*tax|\bstt\s*(tax|charges?|levy)?)\b/i.test(text)
    || /^stt\b/i.test(desc.trim()) || /^stt\b/i.test(kind.trim())
  ) {
    return { type: 'stt', label: 'STT' };
  }

  // 3. Exchange Fees, Turnover Charges, SEBI Charges
  if (
    kind === 'exchange_fee' || kind === 'exchange_fees' || kind === 'exchange_charges' || kind === 'turnover_charges' || kind === 'sebi_charges' || kind === 'sebi_turnover'
    || /\b(exchange\s*(transaction\s*)?(fees?|charges?)|turnover\s*(fees?|charges?)|sebi\s*(turnover\s*)?(fees?|charges?))\b/i.test(text)
  ) {
    return { type: 'exchange_fee', label: 'Exchange fees' };
  }

  // 4. Transaction Charges, AMC fees, Brokerage, GST, Service Tax
  if (
    kind === 'transaction_charges' || kind === 'trans_charge' || kind === 'trans_charges' || kind === 'txn_charges' || kind === 'amc_charges'
    || kind === 'gst' || kind === 'service_tax' || kind === 'brokerage'
    || /\b(transaction\s*(charges?|fees?)|trans(action)?\s*charge|amc\s*charges?|brokerage|gst(\s*charges?)?|service\s*tax)\b/i.test(text)
  ) {
    return { type: 'charges', label: 'Charges' };
  }

  // 5. TDS (Tax Deducted at Source)
  if (
    kind === 'tds_tax' || kind === 'tds'
    || /\b(tds\s*(tax|deducted)?|tax\s*deducted\s*at\s*source)\b/i.test(text)
  ) {
    return { type: 'tds', label: 'TDS' };
  }

  return null;
}

export function isCostOrTaxTransaction(item) {
  return classifyAdditionalCost(item) !== null;
}

export function isStampDutyTransaction(item) {
  return classifyAdditionalCost(item) !== null;
}

/**
 * Correlates and links individual statutory cost and tax transactions (stamp duty,
 * securities transaction tax / STT, exchange fees, transaction charges, TDS) to their
 * parent purchase or redemption transactions in folio_transactions.
 *
 * This routine links the costs to the actual transaction that incurred them, storing the
 * respective amounts directly on the parent line, so individual cost records do not clutter
 * transaction lists.
 */
export function linkCostAndTaxFolioTransactions(db, memberId = null) {
  if (!db) return 0;
  const mFilter = memberId ? ' AND member_id = ?' : '';
  const mParams = memberId ? [memberId] : [];

  const costRows = db.all(
    'SELECT id, member_id, folio_number, isin, scheme_name, date, amount, description, kind'
    + ' FROM folio_transactions'
    + " WHERE (kind = 'STAMP_DUTY_TAX' OR kind LIKE '%stamp%' OR kind LIKE '%stt%' OR kind LIKE '%tax%' OR kind LIKE '%charge%' OR kind LIKE '%fee%' OR kind LIKE '%turnover%' OR kind LIKE '%tds%'"
    + "    OR description LIKE '%stamp%' OR description LIKE '%stt%' OR description LIKE '%tax%' OR description LIKE '%charge%' OR description LIKE '%fee%' OR description LIKE '%turnover%' OR description LIKE '%tds%')"
    + ` AND (parent_txn_id IS NULL OR parent_txn_id = 0)${mFilter}`,
    mParams,
  );

  if (!costRows.length) return 0;

  let linkedCount = 0;
  db.transaction(() => {
    for (const c of costRows) {
      const costInfo = classifyAdditionalCost(c);
      if (!costInfo) continue;
      const isin = String(c.isin || '').trim();
      const folio = String(c.folio_number || '').trim();
      const scheme = String(c.scheme_name || '').trim();
      const cDate = String(c.date || '').slice(0, 10);
      const costAmt = Math.abs(Number(c.amount) || 0);

      const d = parseISO(cDate) || new Date();
      const prevDay = isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
      const nextDay = isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));

      // Find the parent purchase or redemption on the same date or adjacent date (within 1 day)
      // that has units != 0 and is NOT itself a fee/tax row
      const parent = db.get(
        'SELECT id, kind, description, stamp_duty, stt, charges FROM folio_transactions'
        + ' WHERE member_id = ?'
        + ' AND id != ?'
        + ' AND (parent_txn_id IS NULL OR parent_txn_id = 0)'
        + ' AND ('
        + "   (isin != '' AND isin = ?)"
        + "   OR (folio_number != '' AND folio_number = ?)"
        + "   OR (scheme_name != '' AND scheme_name = ?)"
        + ' )'
        + ' AND date BETWEEN ? AND ?'
        + ' AND units != 0'
        + ' ORDER BY CASE WHEN date = ? THEN 0 ELSE 1 END ASC, id DESC'
        + ' LIMIT 1',
        [c.member_id, c.id, isin, folio, scheme, prevDay, nextDay, cDate],
      );

      if (parent && !classifyAdditionalCost(parent)) {
        if (costInfo.type === 'stamp_duty') {
          db.run(
            'UPDATE folio_transactions SET stamp_duty = COALESCE(stamp_duty, 0) + ?, linked_stamp_duty_id = ? WHERE id = ?',
            [costAmt, c.id, parent.id],
          );
        } else if (costInfo.type === 'stt') {
          db.run(
            'UPDATE folio_transactions SET stt = COALESCE(stt, 0) + ? WHERE id = ?',
            [costAmt, parent.id],
          );
        } else {
          // 'exchange_fee', 'charges', 'tds'
          db.run(
            'UPDATE folio_transactions SET charges = COALESCE(charges, 0) + ? WHERE id = ?',
            [costAmt, parent.id],
          );
        }

        db.run(
          'UPDATE folio_transactions SET parent_txn_id = ? WHERE id = ?',
          [parent.id, c.id],
        );
        linkedCount += 1;
      }
    }
  });

  return linkedCount;
}

export const linkStampDutyFolioTransactions = linkCostAndTaxFolioTransactions;

/* ----------------------------------------------------------- list & detail */

/**
 * Lists all active and paused SIPs, organized by umbrella mandates and standalone SIPs,
 * enriched with portfolio metrics and current month execution lifecycle status.
 */
export function listSips(db, args = {}) {
  const [mClause, mParams] = memberClause(args.member_id);
  const curMonth = currentMonthKey();
  const curDay = Number.parseInt(today().slice(8, 10), 10) || 1;

  // 1. Fetch Mandates
  const mandateRows = db.all(
    'SELECT m.*, a.name AS account_name, a.institution, a.account_number'
    + ' FROM sip_mandates m'
    + ' LEFT JOIN asset_accounts a ON m.bank_account_id = a.id'
    + `${mClause ? mClause.replace('WHERE', 'WHERE m.') : ''}`
    + ' ORDER BY m.debit_day ASC, m.id ASC',
    mParams,
  );

  // 2. Fetch SIPs with linked holding metrics from mf_folios
  const sipRows = db.all(
    'SELECT s.*, a.name AS account_name, a.institution, a.account_number,'
    + ' f.units AS folio_units, f.current_value AS folio_current_value,'
    + ' f.invested_value AS folio_invested_value, f.nav AS folio_nav, f.folio_number AS mf_folio'
    + ' FROM sips s'
    + ' LEFT JOIN asset_accounts a ON s.account_id = a.id'
    + " LEFT JOIN mf_folios f ON (s.isin != '' AND s.isin = f.isin) OR (s.folio_number != '' AND s.folio_number = f.folio_number)"
    + `${mClause ? mClause.replace('WHERE', 'WHERE s.') : ''}`
    + ' ORDER BY s.debit_day ASC, s.id ASC',
    mParams,
  );

  // 3. Fetch current month execution records
  const sipIds = sipRows.map((s) => s.id);
  const execMap = new Map();
  if (sipIds.length > 0) {
    const placeholders = sipIds.map(() => '?').join(',');
    const execRows = db.all(
      'SELECT e.*, t.merchant AS tx_merchant, t.amount AS tx_amount, t.date AS tx_date,'
      + ' ft.units AS ft_units, ft.nav AS ft_nav, ft.date AS ft_date'
      + ' FROM sip_executions e'
      + ' LEFT JOIN transactions t ON e.transaction_id = t.id'
      + ' LEFT JOIN folio_transactions ft ON e.folio_transaction_id = ft.id'
      + ` WHERE e.month_key = ? AND e.sip_id IN (${placeholders})`,
      [curMonth, ...sipIds],
    );
    for (const er of execRows) {
      execMap.set(er.sip_id, er);
    }
  }

  // 4. Enrich SIP rows with execution status
  const enrichedSips = sipRows.map((sip) => {
    const exec = execMap.get(sip.id);
    let status = 'due';
    let statusLabel = 'Due';
    let statusDetail = '';
    const debitDay = Number(sip.debit_day) || 5;

    if (exec) {
      status = exec.status;
      if (status === 'completed') {
        statusLabel = 'Allotted';
        statusDetail = exec.allotment_units
          ? `Allotted ${Number(exec.allotment_units).toFixed(3)} units @ ₹${Number(exec.allotment_nav).toFixed(2)}`
          : `Debited on ${exec.debit_date || curMonth}`;
      } else if (status === 'allotted') {
        statusLabel = 'Allotted';
        statusDetail = `Allotted ${Number(exec.allotment_units || 0).toFixed(3)} units`;
      } else if (status === 'debited') {
        statusLabel = 'Debited';
        statusDetail = `Debited on ${exec.debit_date || curMonth} · Awaiting CAS allotment`;
      } else if (status === 'missed') {
        statusLabel = 'Missed';
        statusDetail = 'No debit detected for this month';
      }
    } else if (sip.is_active === 0) {
      status = 'paused';
      statusLabel = 'Paused';
      statusDetail = 'SIP is currently paused';
    } else if (curDay > debitDay + DEBIT_DAY_WINDOW) {
      status = 'missed';
      statusLabel = 'Unfulfilled';
      statusDetail = `Scheduled for day ${debitDay} · No debit detected`;
    } else {
      const daysUntil = debitDay - curDay;
      status = 'due';
      statusLabel = daysUntil === 0 ? 'Due today' : (daysUntil > 0 ? `Due in ${daysUntil}d` : 'Processing');
      statusDetail = `Scheduled for day ${debitDay} of this month`;
    }

    return {
      ...sip,
      monthly_amount: number(sip.monthly_amount),
      step_up_percent: number(sip.step_up_percent),
      execution: exec || null,
      lifecycle_status: status,
      lifecycle_label: statusLabel,
      lifecycle_detail: statusDetail,
      portfolio: {
        units: number(sip.folio_units),
        invested: number(sip.folio_invested_value),
        current_value: number(sip.folio_current_value),
        nav: number(sip.folio_nav),
        folio_number: sip.mf_folio || sip.folio_number || '',
      },
    };
  });

  // 5. Group by Mandates vs Standalone
  const mandateMap = new Map();
  for (const m of mandateRows) {
    const totalAmt = number(m.total_amount);
    const childArr = [];
    mandateMap.set(m.id, {
      ...m,
      total_amount: totalAmt,
      monthly_amount: totalAmt,
      child_sips: childArr,
      splits: childArr,
      allocated_total: 0,
    });
  }

  const standaloneSips = [];
  for (const sip of enrichedSips) {
    if (sip.mandate_id && mandateMap.has(sip.mandate_id)) {
      const m = mandateMap.get(sip.mandate_id);
      m.child_sips.push(sip);
      m.allocated_total += sip.monthly_amount;
    } else {
      standaloneSips.push(sip);
    }
  }

  const mandates = Array.from(mandateMap.values());

  // 6. Summary metrics
  let totalMonthly = 0;
  let activeCount = 0;
  let allottedCount = 0;
  let debitedCount = 0;
  let dueCount = 0;

  for (const sip of enrichedSips) {
    if (sip.is_active !== 0) {
      totalMonthly += sip.monthly_amount;
      activeCount += 1;
      if (sip.lifecycle_status === 'completed' || sip.lifecycle_status === 'allotted') {
        allottedCount += 1;
      } else if (sip.lifecycle_status === 'debited') {
        debitedCount += 1;
      } else if (sip.lifecycle_status === 'due') {
        dueCount += 1;
      }
    }
  }

  return {
    status: 'success',
    mandates,
    standalone_sips: standaloneSips,
    all_sips: enrichedSips,
    sips: enrichedSips,
    summary: {
      total_monthly_amount: Math.round(totalMonthly * 100) / 100,
      active_sips_count: activeCount,
      mandates_count: mandates.length,
      active_mandates_count: mandates.filter((m) => m.is_active !== 0).length,
      allotted_count: allottedCount,
      debited_count: debitedCount,
      due_count: dueCount,
      current_month_allotted_count: allottedCount,
      current_month_debited_count: debitedCount,
      current_month_due_count: dueCount,
      current_month: curMonth,
    },
  };
}

/**
 * Detailed view for a single SIP with its full paired timeline of executions
 * (Bank Debit side vs CAMS Allotment side) and linked portfolio performance.
 */
export function getSipDetails(db, args = {}) {
  const id = Number(args.sip_id ?? args.id ?? args.record_id);
  if (!id) return fail('SIP_NOT_FOUND', 'A SIP ID is required.');

  const sip = db.get(
    'SELECT s.*, a.name AS account_name, a.institution, a.account_number,'
    + ' m.name AS mandate_name, m.total_amount AS mandate_total, m.debit_day AS mandate_debit_day,'
    + ' f.units AS folio_units, f.current_value AS folio_current_value, f.invested_value AS folio_invested_value, f.nav AS folio_nav'
    + ' FROM sips s'
    + ' LEFT JOIN asset_accounts a ON s.account_id = a.id'
    + ' LEFT JOIN sip_mandates m ON s.mandate_id = m.id'
    + " LEFT JOIN mf_folios f ON (s.isin != '' AND s.isin = f.isin) OR (s.folio_number != '' AND s.folio_number = f.folio_number)"
    + ' WHERE s.id = ?',
    [id],
  );

  if (!sip) return fail('SIP_NOT_FOUND', 'That SIP could not be found.');

  // Fetch past 24 months of executions
  const executions = db.all(
    'SELECT e.*, t.merchant AS tx_merchant, t.description AS tx_description,'
    + ' t.amount AS tx_amount, t.date AS tx_date, acc.name AS tx_account_name,'
    + ' ft.scheme_name AS ft_scheme, ft.units AS ft_units, ft.nav AS ft_nav,'
    + ' ft.amount AS ft_amount, ft.date AS ft_date, ft.folio_number AS ft_folio,'
    + ' ft.stamp_duty AS ft_stamp_duty, ft.stt AS ft_stt, ft.charges AS ft_charges'
    + ' FROM sip_executions e'
    + ' LEFT JOIN transactions t ON e.transaction_id = t.id'
    + ' LEFT JOIN asset_accounts acc ON t.account_id = acc.id'
    + ' LEFT JOIN folio_transactions ft ON e.folio_transaction_id = ft.id'
    + ' WHERE e.sip_id = ?'
    + ' ORDER BY e.month_key DESC',
    [id],
  );

  const formattedExecutions = executions.map((e) => ({
    ...e,
    month: e.month_key,
    debit_transaction: e.transaction_id ? {
      id: e.transaction_id,
      amount: number(e.tx_amount || e.debit_amount),
      date: e.tx_date || e.debit_date,
      account_name: e.tx_account_name || 'Bank',
      merchant: e.tx_merchant,
      description: e.tx_description,
    } : null,
    cas_transaction: e.folio_transaction_id ? {
      id: e.folio_transaction_id,
      amount: number(e.ft_amount),
      units: number(e.ft_units || e.allotment_units),
      nav: number(e.ft_nav || e.allotment_nav),
      date: e.ft_date || e.allotment_date,
      scheme_name: e.ft_scheme,
      folio_number: e.ft_folio,
      stamp_duty: number(e.ft_stamp_duty || 0),
      stt: number(e.ft_stt || 0),
      charges: number(e.ft_charges || 0),
    } : null,
  }));

  const curVal = number(sip.folio_current_value);
  const invVal = number(sip.folio_invested_value);
  const pnl = curVal - invVal;
  const pnlPct = invVal > 0 ? (pnl / invVal) * 100 : 0;

  return {
    status: 'success',
    id: sip.id,
    sip_id: sip.id,
    sip: {
      ...sip,
      id: sip.id,
      scheme_name: sip.scheme_name || sip.name || 'Mutual Fund SIP',
      monthly_amount: number(sip.monthly_amount || sip.amount),
      step_up_percent: number(sip.step_up_percent),
      portfolio: {
        units: number(sip.folio_units),
        invested: invVal,
        current_value: curVal,
        nav: number(sip.folio_nav),
      },
    },
    mandate: sip.mandate_id ? {
      id: sip.mandate_id,
      name: sip.mandate_name,
      total_amount: number(sip.mandate_total),
      debit_day: sip.mandate_debit_day,
    } : null,
    holding: (sip.folio_units || curVal > 0 || invVal > 0) ? {
      units: number(sip.folio_units),
      invested: invVal,
      value: curVal,
      nav: number(sip.folio_nav),
      pnl,
      pnl_percent: pnlPct,
    } : null,
    executions: formattedExecutions,
  };
}

/* ------------------------------------------------------------- save & write */

/**
 * Creates or updates an umbrella Mandate and its child SIP split allocations.
 */
export function saveSipMandate(db, args = {}) {
  const name = String(args.name || '').trim();
  const totalAmount = number(args.total_amount);
  const debitDay = Math.max(1, Math.min(28, Number.parseInt(args.debit_day ?? 5, 10) || 5));
  const memberId = Number.parseInt(args.member_id ?? 1, 10) || 1;
  const bankAccountId = args.bank_account_id ? Number(args.bank_account_id) : null;
  const mandateType = String(args.mandate_type || 'nach');
  const key = String(args.linked_merchant_key || '').trim() || merchantKey(name);
  const splits = Array.isArray(args.splits) ? args.splits : [];

  if (!name) return fail('NAME_REQUIRED', 'A mandate needs a name.');
  if (!(totalAmount > 0)) return fail('AMOUNT_INVALID', 'A mandate needs an amount above zero.');

  // Check split sum if splits are provided
  if (splits.length > 0) {
    const splitSum = splits.reduce((sum, s) => sum + number(s.monthly_amount), 0);
    if (Math.abs(splitSum - totalAmount) > 1) {
      return fail(
        'SPLIT_TOTAL_MISMATCH',
        `The sum of child fund splits (₹${Math.round(splitSum)}) must equal the mandate total (₹${Math.round(totalAmount)}).`,
      );
    }
  }

  let mandateId = Number(args.mandate_id ?? args.id ?? args.record_id) || 0;

  db.transaction(() => {
    if (mandateId) {
      db.run(
        'UPDATE sip_mandates SET name = ?, mandate_type = ?, bank_account_id = ?,'
        + ' total_amount = ?, debit_day = ?, linked_merchant_key = ?, notes = ?, is_active = ?'
        + ' WHERE id = ?',
        [name, mandateType, bankAccountId, totalAmount, debitDay, key,
          String(args.notes || ''), args.is_active !== undefined ? (args.is_active ? 1 : 0) : 1, mandateId],
      );
    } else {
      mandateId = db.run(
        'INSERT INTO sip_mandates (member_id, name, mandate_type, bank_account_id,'
        + ' total_amount, debit_day, linked_merchant_key, is_active, notes, created_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
        [memberId, name, mandateType, bankAccountId, totalAmount, debitDay, key,
          String(args.notes || ''), today()],
      ).lastInsertRowid;
    }

    // Process child splits
    const retainedSipIds = new Set();
    for (const split of splits) {
      const splitAmount = number(split.monthly_amount);
      const splitScheme = String(split.scheme_name || '').trim();
      if (!splitScheme || !(splitAmount > 0)) continue;

      const investType = String(split.investment_type || 'mf');
      const isin = String(split.isin || '').trim();
      const folio = String(split.folio_number || '').trim();
      const symbol = String(split.symbol || '').trim();
      const broker = String(split.broker || '').trim();
      const stepUp = number(split.step_up_percent);
      const stepMonth = Number.parseInt(split.step_up_month ?? 0, 10) || 0;

      if (split.id) {
        const sid = Number(split.id);
        db.run(
          'UPDATE sips SET name = ?, amount = ?, mandate_id = ?, scheme_name = ?, monthly_amount = ?,'
          + ' debit_day = ?, step_up_percent = ?, step_up_month = ?, investment_type = ?,'
          + ' isin = ?, folio_number = ?, symbol = ?, broker = ?, account_id = ?'
          + ' WHERE id = ?',
          [splitScheme, splitAmount, mandateId, splitScheme, splitAmount, debitDay, stepUp, stepMonth,
            investType, isin, folio, symbol, broker, bankAccountId, sid],
        );
        retainedSipIds.add(sid);
      } else {
        const newSid = db.run(
          'INSERT INTO sips (name, amount, member_id, mandate_id, scheme_name, monthly_amount, debit_day,'
          + ' step_up_percent, is_active, start_date, step_up_month, linked_merchant_key,'
          + ' investment_type, isin, folio_number, symbol, broker, account_id, frequency)'
          + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'monthly')",
          [splitScheme, splitAmount, memberId, mandateId, splitScheme, splitAmount, debitDay, stepUp,
            today(), stepMonth, key, investType, isin, folio, symbol, broker, bankAccountId],
        ).lastInsertRowid;
        retainedSipIds.add(newSid);
      }
    }

    // Detach any existing child SIPs of this mandate not included in splits
    if (args.id) {
      const existingChildSips = db.all('SELECT id FROM sips WHERE mandate_id = ?', [mandateId]);
      for (const cs of existingChildSips) {
        if (!retainedSipIds.has(cs.id)) {
          db.run('UPDATE sips SET mandate_id = NULL WHERE id = ?', [cs.id]);
        }
      }
    }
  });

  // Reconcile after saving mandate
  reconcileSips(db);

  return { status: 'success', id: mandateId, mandate_id: mandateId };
}

/**
 * Deletes a mandate and detaches its child SIPs.
 */
export function deleteSipMandate(db, args = {}) {
  const id = Number(args.mandate_id ?? args.id ?? args.record_id);
  if (!id) return fail('MANDATE_NOT_FOUND', 'A mandate ID is required.');

  db.transaction(() => {
    db.run('UPDATE sips SET mandate_id = NULL WHERE mandate_id = ?', [id]);
    db.run('UPDATE transactions SET sip_mandate_id = NULL WHERE sip_mandate_id = ?', [id]);
    db.run('DELETE FROM sip_mandates WHERE id = ?', [id]);
  });

  return { status: 'success', id, mandate_id: id };
}

/**
 * Saves a single SIP (standalone or child of a mandate) and scans for matching historical transactions.
 */
export function saveSip(db, args = {}) {
  const schemeName = String(args.scheme_name || args.name || '').trim();
  const monthlyAmount = number(args.monthly_amount ?? args.amount);
  const debitDay = Math.max(1, Math.min(28, Number.parseInt(args.debit_day ?? 5, 10) || 5));
  const memberId = Number.parseInt(args.member_id ?? 1, 10) || 1;
  const mandateId = args.mandate_id ? Number(args.mandate_id) : null;
  const accountId = args.account_id ? Number(args.account_id) : null;
  const investType = String(args.investment_type || 'mf');
  const isin = String(args.isin || '').trim();
  const folio = String(args.folio_number || '').trim();
  const symbol = String(args.symbol || '').trim();
  const broker = String(args.broker || '').trim();
  const key = String(args.linked_merchant_key || '').trim() || merchantKey(schemeName);
  const stepUp = number(args.step_up_percent);
  const stepMonth = Number.parseInt(args.step_up_month ?? 0, 10) || 0;
  const isActive = args.is_active !== undefined ? (args.is_active ? 1 : 0) : 1;
  const startDate = String(args.start_date || today());

  if (!schemeName) return fail('NAME_REQUIRED', 'A SIP needs a scheme or stock name.');
  if (!(monthlyAmount > 0)) return fail('AMOUNT_INVALID', 'A SIP needs an amount above zero.');

  let sipId = Number(args.sip_id ?? args.id ?? args.record_id) || 0;

  if (sipId) {
    db.run(
      'UPDATE sips SET name = ?, amount = ?, mandate_id = ?, scheme_name = ?, monthly_amount = ?, debit_day = ?,'
      + ' step_up_percent = ?, is_active = ?, start_date = ?, step_up_month = ?,'
      + ' linked_merchant_key = ?, investment_type = ?, isin = ?, folio_number = ?,'
      + ' symbol = ?, broker = ?, account_id = ? WHERE id = ?',
      [schemeName, monthlyAmount, mandateId, schemeName, monthlyAmount, debitDay, stepUp, isActive,
        startDate, stepMonth, key, investType, isin, folio, symbol, broker, accountId, sipId],
    );
  } else {
    sipId = db.run(
      'INSERT INTO sips (name, amount, member_id, mandate_id, scheme_name, monthly_amount, debit_day,'
      + ' step_up_percent, is_active, start_date, step_up_month, linked_merchant_key,'
      + ' investment_type, isin, folio_number, symbol, broker, account_id, frequency)'
      + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'monthly')",
      [schemeName, monthlyAmount, memberId, mandateId, schemeName, monthlyAmount, debitDay, stepUp, isActive,
        startDate, stepMonth, key, investType, isin, folio, symbol, broker, accountId],
    ).lastInsertRowid;
  }

  // Find historical matching candidate transactions to prompt the user
  const candidates = findSipMatchingTransactions(db, {
    sip_id: sipId,
    monthly_amount: monthlyAmount,
    debit_day: debitDay,
    isin,
    scheme_name: schemeName,
    account_id: accountId,
  });

  return {
    status: 'success',
    id: sipId,
    sip_id: sipId,
    candidates: candidates.matches || [],
  };
}

/**
 * Deletes a SIP and its execution history.
 */
export function deleteSip(db, args = {}) {
  const id = Number(args.sip_id ?? args.id ?? args.record_id);
  if (!id) return fail('SIP_NOT_FOUND', 'A SIP ID is required.');

  db.transaction(() => {
    db.run('UPDATE transactions SET sip_id = NULL WHERE sip_id = ?', [id]);
    db.run('DELETE FROM sip_executions WHERE sip_id = ?', [id]);
    db.run('DELETE FROM sips WHERE id = ?', [id]);
  });

  return { status: 'success', id, sip_id: id };
}

/* ---------------------------------------------------- matching & backfill */

/**
 * Finds historical transactions and CAMS purchases matching a SIP's parameters.
 */
export function findSipMatchingTransactions(db, args = {}) {
  let amount = number(args.monthly_amount ?? args.amount);
  let debitDay = Number(args.debit_day) || 5;
  let isin = String(args.isin || '').trim();
  let scheme = String(args.scheme_name || '').trim();

  const sipId = Number(args.sip_id ?? args.id ?? args.record_id);
  if (sipId) {
    const sip = db.get('SELECT * FROM sips WHERE id = ?', [sipId]);
    if (sip) {
      if (!amount) amount = number(sip.monthly_amount || sip.amount);
      if (!args.debit_day) debitDay = Number(sip.debit_day) || 5;
      if (!isin) isin = String(sip.isin || '').trim();
      if (!scheme) scheme = String(sip.scheme_name || sip.name || '').trim();
    }
  }

  const months = Math.max(3, Math.min(36, Number.parseInt(args.months ?? args.lookback_months ?? 12, 10) || 12));
  const fromDate = isoDate(addMonths(parseISO(today()), -months));

  const matches = [];

  // 1. Scan Bank Transactions
  const txRows = db.all(
    'SELECT id, date, amount, merchant, description, account_id, category'
    + ' FROM transactions'
    + " WHERE date >= ? AND type != 'Income' AND type != 'Transfer' AND ABS(amount - ?) <= 1"
    + " AND (merchant IS NULL OR (merchant NOT LIKE '%stamp duty%' AND merchant NOT LIKE '%stamp%'))"
    + " AND (description IS NULL OR (description NOT LIKE '%stamp duty%' AND description NOT LIKE '%stamp%'))"
    + ' ORDER BY date DESC',
    [fromDate, amount],
  );

  // Filter matching debit days within window
  for (const tx of txRows) {
    if (isStampDutyTransaction(tx)) continue;
    const txDay = Number.parseInt(String(tx.date).slice(8, 10), 10);
    const dayDiff = Math.abs(txDay - debitDay);
    if (dayDiff <= DEBIT_DAY_WINDOW || dayDiff >= 27) {
      matches.push({
        type: 'bank_transaction',
        id: tx.id,
        transaction_id: tx.id,
        date: tx.date,
        amount: number(tx.amount),
        merchant: tx.merchant || tx.description || 'Bank Debit',
        notes: tx.merchant || tx.description || 'Bank Debit',
        account_id: tx.account_id,
        month_key: String(tx.date).slice(0, 7),
      });
    }
  }

  // 2. Scan CAMS Folio Transactions
  if (isin || scheme) {
    const folioRows = db.all(
      'SELECT id, date, amount, units, nav, scheme_name, isin, folio_number, description, kind, stamp_duty, stt, charges'
      + ' FROM folio_transactions'
      + ' WHERE date >= ? AND ABS(amount - ?) <= 1'
      + ' AND (isin = ? OR scheme_name LIKE ?)'
      + ' AND (parent_txn_id IS NULL OR parent_txn_id = 0)'
      + " AND (kind IS NULL OR (kind != 'STAMP_DUTY_TAX' AND kind NOT LIKE '%stamp%' AND kind NOT LIKE '%stt%' AND kind NOT LIKE '%tax%' AND kind NOT LIKE '%charge%' AND kind NOT LIKE '%fee%'))"
      + " AND (description IS NULL OR (description NOT LIKE '%stamp%' AND description NOT LIKE '%stt%' AND description NOT LIKE '%tax%' AND description NOT LIKE '%charge%' AND description NOT LIKE '%fee%'))"
      + ' ORDER BY date DESC',
      [fromDate, amount, isin, `%${normalizeScheme(scheme)}%`],
    );

    for (const ft of folioRows) {
      if (isStampDutyTransaction(ft)) continue;
      matches.push({
        type: 'folio_transaction',
        id: ft.id,
        folio_transaction_id: ft.id,
        date: ft.date,
        amount: number(ft.amount),
        units: number(ft.units),
        nav: number(ft.nav),
        scheme_name: ft.scheme_name,
        folio_number: ft.folio_number,
        stamp_duty: number(ft.stamp_duty || 0),
        stt: number(ft.stt || 0),
        charges: number(ft.charges || 0),
        month_key: String(ft.date).slice(0, 7),
      });
    }
  }

  const bankMatches = matches.filter((m) => m.type === 'bank_transaction');
  const casMatches = matches.filter((m) => m.type === 'folio_transaction');

  return {
    status: 'success',
    matches,
    bank_transactions: bankMatches,
    cas_transactions: casMatches,
  };
}

/**
 * Links a set of confirmed transactions / CAMS folio transactions to a SIP's execution ledger.
 */
export function linkSipTransactions(db, args = {}) {
  const sipId = Number(args.sip_id ?? args.id ?? args.record_id);
  if (!sipId) return fail('SIP_NOT_FOUND', 'A SIP ID is required.');

  const sip = db.get('SELECT id, monthly_amount, mandate_id FROM sips WHERE id = ?', [sipId]);
  if (!sip) return fail('SIP_NOT_FOUND', 'That SIP could not be found.');

  const links = Array.isArray(args.links) ? [...args.links] : [];

  if (Array.isArray(args.bank_transaction_ids)) {
    for (const bId of args.bank_transaction_ids) {
      const tx = db.get('SELECT date, merchant, description FROM transactions WHERE id = ?', [bId]);
      if (tx && tx.date && !isStampDutyTransaction(tx)) {
        links.push({
          month_key: String(tx.date).slice(0, 7),
          transaction_id: bId,
        });
      }
    }
  }

  if (Array.isArray(args.cas_transaction_ids)) {
    for (const cId of args.cas_transaction_ids) {
      const ft = db.get('SELECT date, description, kind FROM folio_transactions WHERE id = ?', [cId]);
      if (ft && ft.date && !isStampDutyTransaction(ft)) {
        links.push({
          month_key: String(ft.date).slice(0, 7),
          folio_transaction_id: cId,
        });
      }
    }
  }

  let linkedCount = 0;

  db.transaction(() => {
    for (const link of links) {
      const monthKey = String(link.month_key || '').slice(0, 7);
      if (!monthKey) continue;

      const txId = link.transaction_id ? Number(link.transaction_id) : null;
      const ftId = link.folio_transaction_id ? Number(link.folio_transaction_id) : null;
      const stId = link.stock_transaction_id ? Number(link.stock_transaction_id) : null;

      // Fetch transaction details for denormalized snapshot
      let debitDate = null;
      let debitAmt = null;
      let validTxId = null;
      if (txId) {
        const tx = db.get('SELECT date, amount, merchant, description FROM transactions WHERE id = ?', [txId]);
        if (tx && !isStampDutyTransaction(tx)) {
          validTxId = txId;
          debitDate = tx.date;
          debitAmt = number(tx.amount);
          db.run('UPDATE transactions SET sip_id = ? WHERE id = ?', [sipId, txId]);
        }
      }

      let allotDate = null;
      let allotUnits = null;
      let allotNav = null;
      let validFtId = null;
      if (ftId) {
        const ft = db.get('SELECT date, units, nav, description, kind FROM folio_transactions WHERE id = ?', [ftId]);
        if (ft && !isStampDutyTransaction(ft)) {
          validFtId = ftId;
          allotDate = ft.date;
          allotUnits = number(ft.units);
          allotNav = number(ft.nav);
        }
      }

      let status = 'due';
      if ((validTxId && validFtId) || (validTxId && stId)) status = 'completed';
      else if (validFtId || stId) status = 'allotted';
      else if (validTxId) status = 'debited';

      db.run(
        'INSERT INTO sip_executions (sip_id, mandate_id, month_key, expected_amount, status,'
        + ' transaction_id, folio_transaction_id, stock_transaction_id, debit_date, debit_amount,'
        + ' allotment_date, allotment_units, allotment_nav, created_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        + ' ON CONFLICT(sip_id, month_key) DO UPDATE SET'
        + ' status = excluded.status, transaction_id = COALESCE(excluded.transaction_id, transaction_id),'
        + ' folio_transaction_id = COALESCE(excluded.folio_transaction_id, folio_transaction_id),'
        + ' stock_transaction_id = COALESCE(excluded.stock_transaction_id, stock_transaction_id),'
        + ' debit_date = COALESCE(excluded.debit_date, debit_date),'
        + ' debit_amount = COALESCE(excluded.debit_amount, debit_amount),'
        + ' allotment_date = COALESCE(excluded.allotment_date, allotment_date),'
        + ' allotment_units = COALESCE(excluded.allotment_units, allotment_units),'
        + ' allotment_nav = COALESCE(excluded.allotment_nav, allotment_nav)',
        [sipId, sip.mandate_id, monthKey, number(sip.monthly_amount), status,
          txId, ftId, stId, debitDate, debitAmt, allotDate, allotUnits, allotNav, today()],
      );
      linkedCount += 1;
    }
  });

  return { status: 'success', linked: linkedCount };
}

/**
 * Unlinks a transaction from a SIP execution.
 */
export function unlinkSipTransaction(db, args = {}) {
  let executionId = Number(args.execution_id);
  const unlinkType = String(args.type || (args.is_cas ? 'folio' : 'transaction')); // 'transaction' or 'folio'

  if (!executionId && (args.sip_id || args.id) && (args.transaction_id || args.folio_transaction_id)) {
    const sid = Number(args.sip_id ?? args.id);
    const targetId = Number(args.transaction_id || args.folio_transaction_id);
    const execRow = args.is_cas
      ? db.get('SELECT id FROM sip_executions WHERE sip_id = ? AND folio_transaction_id = ?', [sid, targetId])
      : db.get('SELECT id FROM sip_executions WHERE sip_id = ? AND transaction_id = ?', [sid, targetId]);
    if (execRow) executionId = execRow.id;
  }

  if (!executionId) return fail('BAD_REQUEST', 'An execution ID is required.');

  db.transaction(() => {
    const exec = db.get('SELECT * FROM sip_executions WHERE id = ?', [executionId]);
    if (!exec) return;

    if (unlinkType === 'transaction') {
      if (exec.transaction_id) {
        db.run('UPDATE transactions SET sip_id = NULL WHERE id = ?', [exec.transaction_id]);
      }
      const newStatus = exec.folio_transaction_id ? 'allotted' : 'due';
      db.run(
        'UPDATE sip_executions SET transaction_id = NULL, debit_date = NULL, debit_amount = NULL, status = ? WHERE id = ?',
        [newStatus, executionId],
      );
    } else if (unlinkType === 'folio') {
      const newStatus = exec.transaction_id ? 'debited' : 'due';
      db.run(
        'UPDATE sip_executions SET folio_transaction_id = NULL, allotment_date = NULL, allotment_units = NULL, allotment_nav = NULL, status = ? WHERE id = ?',
        [newStatus, executionId],
      );
    }
  });

  return { status: 'success', execution_id: executionId };
}

/* ------------------------------------------------------------- discovery */

/**
 * Synthesizes CAMS/CAS folio transactions and Bank SMS debits to discover
 * umbrella mandates and standalone SIPs with exact scheme names and bank accounts.
 */
export function discoverSips(db, args = {}) {
  const months = Math.max(3, Math.min(24, Number.parseInt(args.months ?? 12, 10) || 12));
  const fromDate = isoDate(addMonths(parseISO(today()), -months));
  const [mClause, mParams] = memberClause(args.member_id);

  // Existing tracked SIP ISINs and Mandates
  const trackedSips = db.all(`SELECT scheme_name, isin, monthly_amount FROM sips${mClause}`, mParams);
  const trackedIsins = new Set(trackedSips.map((s) => s.isin).filter(Boolean));
  const trackedNames = new Set(trackedSips.map((s) => normalizeScheme(s.scheme_name).toLowerCase()));

  // 1. Analyze CAMS Folio Purchases
  const folioPurchases = db.all(
    'SELECT id, date, amount, units, nav, scheme_name, isin, folio_number, description, kind'
    + ` FROM folio_transactions WHERE date >= ? AND amount > 0${mClause}`
    + " AND (kind IS NULL OR (kind != 'STAMP_DUTY_TAX' AND kind NOT LIKE '%stamp%' AND kind NOT LIKE '%stt%' AND kind NOT LIKE '%tax%' AND kind NOT LIKE '%charge%' AND kind NOT LIKE '%fee%'))"
    + " AND (description IS NULL OR (description NOT LIKE '%stamp%' AND description NOT LIKE '%stt%' AND description NOT LIKE '%tax%' AND description NOT LIKE '%charge%' AND description NOT LIKE '%fee%'))"
    + ' ORDER BY date ASC, id ASC',
    [fromDate, ...mParams],
  );

  // Cluster CAMS purchases by ISIN / Scheme
  const camsClusters = new Map();
  for (const row of folioPurchases) {
    if (isStampDutyTransaction(row)) continue;
    const rawDesc = `${row.description || ''} ${row.kind || ''}`.toLowerCase();
    if (rawDesc.includes('reversal') || rawDesc.includes('redemption') || rawDesc.includes('switch out') || isCostOrTaxTransaction(row)) continue;

    const key = row.isin || normalizeScheme(row.scheme_name);
    if (!key) continue;

    if (!camsClusters.has(key)) {
      camsClusters.set(key, {
        isin: row.isin || '',
        scheme_name: row.scheme_name,
        clean_name: normalizeScheme(row.scheme_name),
        folio_number: row.folio_number || '',
        entries: [],
      });
    }
    const c = camsClusters.get(key);
    c.entries.push({
      date: String(row.date).slice(0, 10),
      amount: number(row.amount),
      units: number(row.units),
      nav: number(row.nav),
      id: row.id,
      is_explicit_sip: rawDesc.includes('sip') || rawDesc.includes('systematic'),
    });
  }

  // Filter clusters that look recurring (at least 2 occurrences with similar amount, or 1 if explicitly SIP)
  const candidateCamsSips = [];
  for (const cluster of camsClusters.values()) {
    const explicitSip = cluster.entries.some((e) => e.is_explicit_sip);
    if (cluster.entries.length < 2 && !explicitSip) continue;

    // Skip if already tracked
    if (cluster.isin && trackedIsins.has(cluster.isin)) continue;
    if (trackedNames.has(cluster.clean_name.toLowerCase())) continue;

    // Check amounts
    const amounts = cluster.entries.map((e) => e.amount);
    const typicalAmount = amounts[amounts.length - 1]; // latest
    const sameAmountCount = amounts.filter((a) => Math.abs(a - typicalAmount) <= 1).length;
    if (sameAmountCount < 2 && !explicitSip) continue;

    // Calculate median debit day of month
    const days = cluster.entries.map((e) => Number.parseInt(e.date.slice(8, 10), 10));
    days.sort((a, b) => a - b);
    const medianDay = days[Math.floor(days.length / 2)] || 5;

    candidateCamsSips.push({
      scheme_name: cluster.scheme_name,
      clean_name: cluster.clean_name,
      isin: cluster.isin,
      folio_number: cluster.folio_number,
      monthly_amount: typicalAmount,
      debit_day: medianDay,
      entries: cluster.entries,
      investment_type: 'mf',
    });
  }

  // 2. Analyze Mandate / Clearing House Bank Debits
  const mandateDebits = db.all(
    'SELECT id, date, amount, merchant, description, account_id'
    + ` FROM transactions WHERE date >= ? AND type != 'Income' AND type != 'Transfer'${mClause}`
    + " AND (merchant IS NULL OR (merchant NOT LIKE '%stamp duty%' AND merchant NOT LIKE '%stamp%'))"
    + " AND (description IS NULL OR (description NOT LIKE '%stamp duty%' AND description NOT LIKE '%stamp%'))"
    + " AND (merchant LIKE '%bse%' OR merchant LIKE '%nach%' OR merchant LIKE '%ach%'"
    + " OR merchant LIKE '%iccl%' OR merchant LIKE '%groww%' OR merchant LIKE '%camspay%'"
    + " OR merchant LIKE '%zerodha%' OR merchant LIKE '%kuvera%' OR merchant LIKE '%mf central%'"
    + " OR merchant LIKE '%mutual fund%' OR merchant LIKE '%mf%'"
    + " OR description LIKE '%nach%' OR description LIKE '%ach%' OR description LIKE '%mandate%'"
    + " OR description LIKE '%sip%' OR description LIKE '%bse%' OR description LIKE '%groww%'"
    + " OR is_investment_outflow = 1 OR category = 'Mutual Funds' OR category = 'Investments')"
    + ' ORDER BY date ASC, id ASC',
    [fromDate, ...mParams],
  );

  // Group bank debits by merchant key and account
  const debitGroups = new Map();
  for (const row of mandateDebits) {
    if (isStampDutyTransaction(row)) continue;
    const mName = row.merchant || row.description || 'Mandate';
    const key = `${merchantKey(mName)}_${row.account_id || 0}`;
    if (!debitGroups.has(key)) {
      debitGroups.set(key, {
        name: mName,
        account_id: row.account_id,
        entries: [],
      });
    }
    debitGroups.get(key).entries.push({
      id: row.id,
      date: String(row.date).slice(0, 10),
      amount: number(row.amount),
    });
  }

  // Filter recurring debits
  const recurringDebits = [];
  for (const group of debitGroups.values()) {
    if (group.entries.length < 2) continue;
    const amounts = group.entries.map((e) => e.amount);
    const typicalAmount = amounts[amounts.length - 1];
    const matching = group.entries.filter((e) => Math.abs(e.amount - typicalAmount) <= 1);
    if (matching.length < 2) continue;

    const days = matching.map((e) => Number.parseInt(e.date.slice(8, 10), 10));
    days.sort((a, b) => a - b);
    const medianDay = days[Math.floor(days.length / 2)] || 5;

    recurringDebits.push({
      name: group.name,
      account_id: group.account_id,
      total_amount: typicalAmount,
      debit_day: medianDay,
      entries: matching,
    });
  }

  // 3. Cross-Correlate: Find Umbrella Mandate matches & Standalone matches
  const discoveredMandates = [];
  const matchedCamsSips = new Set();

  for (const debit of recurringDebits) {
    // Find all CAMS SIPs whose debit_day is within ±3 days of this debit
    const nearbyCams = candidateCamsSips.filter((cs) => {
      if (matchedCamsSips.has(cs.isin || cs.clean_name)) return false;
      const diff = Math.abs(cs.debit_day - debit.debit_day);
      return diff <= DEBIT_DAY_WINDOW || diff >= 27;
    });

    // Check if the sum of multiple CAMS SIPs equals the debit amount
    if (nearbyCams.length >= 2) {
      const sumAll = nearbyCams.reduce((s, c) => s + c.monthly_amount, 0);
      if (Math.abs(sumAll - debit.total_amount) <= 2) {
        // Exact umbrella mandate match!
        discoveredMandates.push({
          name: debit.name,
          total_amount: debit.total_amount,
          debit_day: debit.debit_day,
          bank_account_id: debit.account_id,
          splits: nearbyCams.map((c) => {
            matchedCamsSips.add(c.isin || c.clean_name);
            return {
              scheme_name: c.scheme_name,
              monthly_amount: c.monthly_amount,
              debit_day: debit.debit_day,
              isin: c.isin,
              folio_number: c.folio_number,
              investment_type: 'mf',
            };
          }),
        });
        continue;
      }
    }

    // Check single 1-to-1 match
    const singleMatch = nearbyCams.find((cs) => Math.abs(cs.monthly_amount - debit.total_amount) <= 1);
    if (singleMatch) {
      singleMatch.account_id = debit.account_id;
      singleMatch.debit_day = debit.debit_day;
      singleMatch.mandate_name = debit.name;
      matchedCamsSips.add(singleMatch.isin || singleMatch.clean_name);
    }
  }

  // 4. Any remaining CAMS SIPs become standalone candidate SIPs
  const standaloneCandidates = candidateCamsSips
    .filter((cs) => !matchedCamsSips.has(cs.isin || cs.clean_name))
    .map((cs) => ({
      scheme_name: cs.scheme_name,
      monthly_amount: cs.monthly_amount,
      debit_day: cs.debit_day,
      isin: cs.isin,
      folio_number: cs.folio_number,
      investment_type: 'mf',
      account_id: cs.account_id || null,
    }));

  return {
    status: 'success',
    discovered_mandates: discoveredMandates,
    discovered_sips: standaloneCandidates,
    total_candidates: discoveredMandates.length + standaloneCandidates.length,
  };
}

/**
 * Bulk confirms and creates discovered mandates and SIPs from the review wizard.
 */
export function confirmDiscoveredSips(db, args = {}) {
  const mandates = Array.isArray(args.mandates) ? args.mandates : [];
  const sips = Array.isArray(args.sips) ? args.sips : [];
  const memberId = Number.parseInt(args.member_id ?? 1, 10) || 1;

  let createdMandates = 0;
  let createdSips = 0;

  // 1. Create Mandates and child splits
  for (const m of mandates) {
    const res = saveSipMandate(db, {
      member_id: memberId,
      name: m.name,
      mandate_type: m.mandate_type || 'nach',
      bank_account_id: m.bank_account_id,
      total_amount: m.total_amount,
      debit_day: m.debit_day,
      splits: m.splits || [],
    });
    if (res && res.status === 'success') createdMandates += 1;
  }

  // 2. Create Standalone SIPs
  for (const s of sips) {
    const res = saveSip(db, {
      member_id: memberId,
      scheme_name: s.scheme_name,
      monthly_amount: s.monthly_amount,
      debit_day: s.debit_day,
      investment_type: s.investment_type || 'mf',
      isin: s.isin,
      folio_number: s.folio_number,
      account_id: s.account_id,
    });
    if (res && res.status === 'success') createdSips += 1;
  }

  // Run initial reconcile on past transactions
  reconcileSips(db);

  return {
    status: 'success',
    created_mandates: createdMandates,
    created_sips: createdSips,
  };
}

/* ------------------------------------------------------------- reconcile */

/**
 * Background engine: Automatically links newly ingested bank debits (SMS)
 * and CAMS folio transactions to active SIPs and Mandates.
 */
export function reconcileSips(db, args = {}) {
  const curMonth = currentMonthKey();
  const prevMonth = isoDate(addMonths(parseISO(today()), -1)).slice(0, 7);
  const targetMonths = [prevMonth, curMonth];

  let reconciled = 0;

  db.transaction(() => {
    // Unlink any historical executions that accidentally linked stamp duty records
    db.run(`
      UPDATE sip_executions
      SET folio_transaction_id = NULL,
          allotment_date = NULL,
          allotment_units = NULL,
          allotment_nav = NULL,
          status = CASE WHEN transaction_id IS NOT NULL THEN 'debited' ELSE 'due' END
      WHERE folio_transaction_id IN (
        SELECT id FROM folio_transactions
        WHERE kind = 'STAMP_DUTY_TAX'
           OR kind LIKE '%stamp%'
           OR kind LIKE '%stt%'
           OR kind LIKE '%tax%'
           OR kind LIKE '%charge%'
           OR kind LIKE '%fee%'
           OR description LIKE '%stamp%'
           OR description LIKE '%stt%'
           OR description LIKE '%tax%'
           OR description LIKE '%charge%'
           OR description LIKE '%fee%'
      )
    `);
    db.run(`
      UPDATE sip_executions
      SET transaction_id = NULL,
          debit_date = NULL,
          debit_amount = NULL,
          status = CASE WHEN folio_transaction_id IS NOT NULL THEN 'allotted' ELSE 'due' END
      WHERE transaction_id IN (
        SELECT id FROM transactions
        WHERE merchant LIKE '%stamp duty%'
           OR merchant LIKE '%stamp%'
           OR description LIKE '%stamp duty%'
           OR description LIKE '%stamp%'
      )
    `);
    db.run(`
      UPDATE transactions
      SET sip_id = NULL, sip_mandate_id = NULL
      WHERE (merchant LIKE '%stamp duty%' OR merchant LIKE '%stamp%' OR description LIKE '%stamp duty%' OR description LIKE '%stamp%')
        AND (sip_id IS NOT NULL OR sip_mandate_id IS NOT NULL)
    `);

    const activeMandates = db.all('SELECT * FROM sip_mandates WHERE is_active = 1');
    const activeSips = db.all('SELECT * FROM sips WHERE is_active = 1');

    for (const monthKey of targetMonths) {
      const monthStart = `${monthKey}-01`;
      const monthEnd = `${monthKey}-31`;

      // 1. Reconcile Mandates with Bank Debits
      for (const mandate of activeMandates) {
        const childSips = activeSips.filter((s) => s.mandate_id === mandate.id);
        if (!childSips.length) continue;

        // Check if a bank transaction matches this mandate for this month
        const matchTx = db.get(
          'SELECT id, date, amount, account_id, merchant, description FROM transactions'
          + " WHERE date BETWEEN ? AND ? AND type != 'Income' AND type != 'Transfer'"
          + ' AND ABS(amount - ?) <= 1'
          + ' AND (sip_mandate_id = ? OR merchant_key = ? OR merchant LIKE ?)'
          + " AND (merchant IS NULL OR (merchant NOT LIKE '%stamp duty%' AND merchant NOT LIKE '%stamp%'))"
          + " AND (description IS NULL OR (description NOT LIKE '%stamp duty%' AND description NOT LIKE '%stamp%'))"
          + ' LIMIT 1',
          [monthStart, monthEnd, number(mandate.total_amount),
            mandate.id, mandate.linked_merchant_key, `%${mandate.name}%`],
        );

        if (matchTx && !isStampDutyTransaction(matchTx)) {
          db.run(
            'UPDATE transactions SET sip_mandate_id = ?, is_sip_split = 1 WHERE id = ?',
            [mandate.id, matchTx.id],
          );

          // For each child SIP, create/update execution record
          for (const cs of childSips) {
            db.run(
              'INSERT INTO sip_executions (sip_id, mandate_id, month_key, expected_amount, status,'
              + ' transaction_id, debit_date, debit_amount, created_at)'
              + " VALUES (?, ?, ?, ?, 'debited', ?, ?, ?, ?)"
              + ' ON CONFLICT(sip_id, month_key) DO UPDATE SET'
              + ' transaction_id = COALESCE(excluded.transaction_id, transaction_id),'
              + ' debit_date = COALESCE(excluded.debit_date, debit_date),'
              + ' debit_amount = COALESCE(excluded.debit_amount, debit_amount),'
              + " status = CASE WHEN folio_transaction_id IS NOT NULL THEN 'completed' ELSE 'debited' END",
              [cs.id, mandate.id, monthKey, number(cs.monthly_amount),
                matchTx.id, matchTx.date, number(cs.monthly_amount), today()],
            );
            reconciled += 1;
          }
        }
      }

      // 2. Reconcile Standalone SIPs with Bank Debits
      const standaloneSips = activeSips.filter((s) => !s.mandate_id);
      for (const sip of standaloneSips) {
        const matchTx = db.get(
          'SELECT id, date, amount, merchant, description FROM transactions'
          + " WHERE date BETWEEN ? AND ? AND type != 'Income' AND type != 'Transfer'"
          + ' AND ABS(amount - ?) <= 1'
          + ' AND (sip_id = ? OR merchant_key = ? OR merchant LIKE ?)'
          + " AND (merchant IS NULL OR (merchant NOT LIKE '%stamp duty%' AND merchant NOT LIKE '%stamp%'))"
          + " AND (description IS NULL OR (description NOT LIKE '%stamp duty%' AND description NOT LIKE '%stamp%'))"
          + ' LIMIT 1',
          [monthStart, monthEnd, number(sip.monthly_amount),
            sip.id, sip.linked_merchant_key, `%${normalizeScheme(sip.scheme_name)}%`],
        );

        if (matchTx && !isStampDutyTransaction(matchTx)) {
          db.run('UPDATE transactions SET sip_id = ? WHERE id = ?', [sip.id, matchTx.id]);
          db.run(
            'INSERT INTO sip_executions (sip_id, month_key, expected_amount, status,'
            + ' transaction_id, debit_date, debit_amount, created_at)'
            + " VALUES (?, ?, ?, 'debited', ?, ?, ?, ?)"
            + ' ON CONFLICT(sip_id, month_key) DO UPDATE SET'
            + ' transaction_id = COALESCE(excluded.transaction_id, transaction_id),'
            + ' debit_date = COALESCE(excluded.debit_date, debit_date),'
            + ' debit_amount = COALESCE(excluded.debit_amount, debit_amount),'
            + " status = CASE WHEN folio_transaction_id IS NOT NULL THEN 'completed' ELSE 'debited' END",
            [sip.id, monthKey, number(sip.monthly_amount),
              matchTx.id, matchTx.date, number(matchTx.amount), today()],
          );
          reconciled += 1;
        }
      }

      // 3. Reconcile CAMS Folio Purchases with active SIP executions
      for (const sip of activeSips) {
        if (!sip.isin && !sip.scheme_name) continue;

        const matchFt = db.get(
          'SELECT id, date, amount, units, nav, description, kind FROM folio_transactions'
          + ' WHERE date BETWEEN ? AND ? AND ABS(amount - ?) <= 1'
          + ' AND (isin = ? OR scheme_name LIKE ?)'
          + " AND (kind IS NULL OR (kind != 'STAMP_DUTY_TAX' AND kind NOT LIKE '%stamp%' AND kind NOT LIKE '%stt%' AND kind NOT LIKE '%tax%' AND kind NOT LIKE '%charge%' AND kind NOT LIKE '%fee%'))"
          + " AND (description IS NULL OR (description NOT LIKE '%stamp%' AND description NOT LIKE '%stt%' AND description NOT LIKE '%tax%' AND description NOT LIKE '%charge%' AND description NOT LIKE '%fee%'))"
          + ' LIMIT 1',
          [monthStart, monthEnd, number(sip.monthly_amount),
            sip.isin || '', `%${normalizeScheme(sip.scheme_name)}%`],
        );

        if (matchFt && !isStampDutyTransaction(matchFt)) {
          db.run(
            'INSERT INTO sip_executions (sip_id, mandate_id, month_key, expected_amount, status,'
            + ' folio_transaction_id, allotment_date, allotment_units, allotment_nav, created_at)'
            + " VALUES (?, ?, ?, ?, 'allotted', ?, ?, ?, ?, ?)"
            + ' ON CONFLICT(sip_id, month_key) DO UPDATE SET'
            + ' folio_transaction_id = COALESCE(excluded.folio_transaction_id, folio_transaction_id),'
            + ' allotment_date = COALESCE(excluded.allotment_date, allotment_date),'
            + ' allotment_units = COALESCE(excluded.allotment_units, allotment_units),'
            + ' allotment_nav = COALESCE(excluded.allotment_nav, allotment_nav),'
            + " status = CASE WHEN transaction_id IS NOT NULL THEN 'completed' ELSE 'allotted' END",
            [sip.id, sip.mandate_id || null, monthKey, number(sip.monthly_amount),
              matchFt.id, matchFt.date, number(matchFt.units), number(matchFt.nav), today()],
          );
          reconciled += 1;
        }
      }
    }
  });

  return { status: 'success', reconciled_count: reconciled };
}
