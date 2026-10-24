/*
 * Redacts personal identifiers from an SMS dump, filters personal numbers,
 * and exports clean canonical templates for LLM analysis.
 *
 * Usage:
 *   node scripts/redact-and-cluster.mjs [input_path]
 * Default input: messages-2026-09-29/messages.ndjson
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { notATransaction } from '../app/src/main/assets/www/js/backend/merchants.js';
import { extractTransactionAmount } from '../app/src/main/assets/www/js/backend/sms.js';

const inputPath = process.argv[2] || path.join('messages-2026-09-29', 'messages.ndjson');
const outputRedactedPath = path.join('messages-2026-09-29', 'messages_redacted.ndjson');
const outputSummaryPath = path.join('messages-2026-09-29', 'clusters_summary.json');
const outputLlmTemplatesPath = path.join('messages-2026-09-29', 'canonical_templates_for_llm.json');
const outputLoanCreditTemplatesPath = path.join('messages-2026-09-29', 'loan_and_credit_templates_for_llm.json');

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

// ------------------------------------------------------------- Sender Classifier

function isPersonalSender(sender) {
  const s = String(sender || '').trim();
  // 10-12 digit phone numbers with optional + or +91 prefix
  return /^(\+91|\+)?\d{10,12}$/.test(s) || /^\d{10}$/.test(s);
}

// ------------------------------------------------------------- Redaction Engine

// Load optional custom names dictionary if provided in scripts/custom-names.txt
let customNames = [];
const customNamesPath = path.join('scripts', 'custom-names.txt');
if (fs.existsSync(customNamesPath)) {
  customNames = fs.readFileSync(customNamesPath, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function redactText(raw) {
  let text = String(raw || '');

  // 1. Mask URLs
  text = text.replace(/https?:\/\/[^\s]+/gi, '<URL>');
  text = text.replace(/\b(?:bit\.ly|tinyurl\.com|1kx\.in|nc6\.in|fcr\.bz|hdfcbk\.io|ccybl\.in|rml\.lu|5fi\.in|ss7\.in)\/[^\s]+/gi, '<URL>');

  // 2. Custom names dictionary scrubbing (from optional scripts/custom-names.txt)
  if (customNames.length > 0) {
    const escaped = customNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    text = text.replace(new RegExp(`\\b(?:${escaped})\\b`, 'gi'), '<REDACTED_NAME>');
  }

  // 3. Name patterns in greetings and transfer narrations
  text = text.replace(/\b(from\s+(?:MR|MS|MRS|DR)?\s*)([A-Z][A-Z\s]{2,30}?)(?=[.,;\s]*(?:UPI|ref|on|dt|avl|$|[.;:]))/gi, '$1<REDACTED_NAME>');
  text = text.replace(/\b(transfer from\s+)([A-Z][A-Z\s]{2,30}?)(?=[.,;\s]*(?:ref|on|dt|avl|$|[.;:]))/gi, '$1<REDACTED_NAME>');
  text = text.replace(/\b(trf to\s+|transferred to\s+|paid to\s+)([A-Za-z\s]{3,35}?)(?=\s+(?:ref|on|dt|rrn|via|avl|$|[.;,]))/gi, '$1<REDACTED_NAME>');
  text = text.replace(/\bUPI-[A-Za-z0-9]+-(?:[A-Za-z\s.]+?)(?=\.\s+|\s+To\s+|\s+Call\s+|\s+SMS\s+|$|[.;])/gi, 'UPI-<REF>-<REDACTED_NAME>');
  text = text.replace(/\b(Hey|Hi|Hello|Dear)\s+([A-Za-z0-9_]{2,25})\b/gi, '$1 <REDACTED_NAME>');
  text = text.replace(/\b\d{1,2}\s+[A-Za-z]{3}\s+\d{1,2}:\d{2}\s+[A-Za-z\s]{3,30}\s+(\(\*\*\d{3,6}\))/gi, '<DATE> <TIME> <REDACTED_NAME> $1');
  text = text.replace(/\b[A-Za-z\s]{3,25}\s+has been successfully registered for Inter Bank Funds Transfer/gi, '<REDACTED_NAME> has been successfully registered for Inter Bank Funds Transfer');

  // 4. Transfer narrations (NEFT, IMPS, RTGS narrations naming employers/branches)
  text = text.replace(/\b(neft|imps|rtgs)(\s*(?:cr|dr)?[ -]+)[^,\n.]*/gi, '$1$2<REDACTED_NARRATION>');

  // 5. Mask UPI VPA and email handles
  text = text.replace(/[\w.\-]{2,}@[a-z]{2,}\b/gi, '<HANDLE>@upi');

  // 6. Balances and Limits
  text = text.replace(/\b((?:avl|available|total|clear|main|wallet)\s*(?:bal(?:ance)?|lmt|limit)[:\s]*(?:rs\.?|inr|₹)?\s*)[\d,]+(?:\.\d+)?/gi, '$1<BAL_XXXX>');

  // 7. Account, Card, Tag, Cust ID, Folio and Demat identifiers
  text = text.replace(/\b(a\/c|acct|account|card(?:\s+no)?\.?|tag|loan\s*(?:a\/c|no\.?)?|cust\s*id|customer\s*id)(\s*(?:no[.:]?)?\s*[*xX#]*\s*)\d{3,6}\b/gi, '$1$2<ACCT_XXXX>');
  text = text.replace(/\b(ending\s+(?:in|with\s+)?)[*xX#]*\s*\d{3,6}\b/gi, '$1<ACCT_XXXX>');
  text = text.replace(/\b[xX*#]{2,}\d{3,6}\b/g, '<ACCT_XXXX>');
  text = text.replace(/\b(?:folio|boid|uan)\s*(?:no\.?)?\s*[*xX#\d]{4,20}\b/gi, '<FOLIO_OR_BOID_XXXX>');

  // 8. OTPs and verification codes
  text = text.replace(/\b(?:otp|code|password)\s*(?:is|:)?\s*(\d{4,8})\b/gi, 'otp is <OTP>');

  // 9. Phone numbers and toll-free numbers
  text = text.replace(/(?:\+91[\-\s]?)?[6-9]\d{9}\b/g, '<PHONE>');
  text = text.replace(/\b1800\d{6,8}\b/g, '<TOLL_FREE>');
  text = text.replace(/\b0\d{2,4}[-\s]?\d{6,8}\b/g, '<LANDLINE>');

  // 10. Long reference / UTR / Transaction IDs (6+ digits/alphanumeric)
  text = text.replace(/\b(?:ref(?:no)?|rrn|utr|txn(?:\s*id)?|umrn)[:\s\/-]*[A-Za-z0-9]{6,24}\b/gi, 'ref: <REF>');
  text = text.replace(/\b[A-Z0-9]{12,24}\b/g, '<REF>');

  return text;
}

// -------------------------------------------------------- Template Normalizer

function toCanonicalTemplate(text) {
  return String(text || '')
    .replace(/<URL>/g, '<URL>')
    .replace(/https?:\/\/[^\s]+/gi, '<URL>')
    // Replace amounts
    .replace(/(?:rs\.?|inr|₹)\s*\.?\s*[\d,]+(?:\.\d+)?(?:\s*(?:lakh|lac|cr|crore))?/gi, '<AMT>')
    // Replace dates
    .replace(/\b\d{1,2}[-/](?:[A-Za-z]{3}|\d{1,2})[-/]\d{2,4}\b/g, '<DATE>')
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, '<DATE>')
    .replace(/\b\d{1,2}\s+[A-Za-z]{3}\b/g, '<DATE>')
    // Replace times
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?\b/g, '<TIME>')
    // Replace entities
    .replace(/<ACCT_XXXX>/g, '<ACCT>')
    .replace(/\b(a\/c|acct|account|card)\s*(?:no\.?)?\s*[*xX#\d]+\b/gi, '<ACCT>')
    .replace(/\b[*xX#]{2,}\d{3,6}\b/g, '<ACCT>')
    .replace(/<REDACTED_NAME>/g, '<NAME>')
    .replace(/<REDACTED_USER>/g, '<USER>')
    .replace(/<REDACTED_NARRATION>/g, '<NARRATION>')
    .replace(/<OTP>/g, '<OTP>')
    .replace(/<REF>/g, '<REF>')
    .replace(/<PHONE>/g, '<PHONE>')
    .replace(/<TOLL_FREE>/g, '<TOLL_FREE>')
    .replace(/<BAL_XXXX>/g, '<BAL>')
    .replace(/<FOLIO_OR_BOID_XXXX>/g, '<FOLIO>')
    .replace(/\b\d{6,}\b/g, '<NUM>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------- Category Heuristic Classifier

function classifyCategory(body, sender = '') {
  const lower = body.toLowerCase();

  // 1. OTP / Security
  if (/\botp\b|one[- ]time password|verification code|security code/i.test(lower)) {
    return 'OTP_OR_SECURITY';
  }

  // 2. Pre-Approved Loan Ads & Credit Limit Upgrades
  if (
    /\b(?:pre-?approved|instant|quick|easy)\s*(?:personal|business|gold|car|home|two[- ]wheeler)?\s*loan\b/i.test(lower)
    || /\bloan offer\b|\bavail (?:instant )?loan\b|\bcheck loan eligibility\b|\bapply for (?:instant )?loan\b/i.test(lower)
    || /\bloan (?:facility|account) has been enabled\b/i.test(lower)
    || /\bloan of up to\b|\bget instant cash\b|\bdata (?:ka )?loan\b/i.test(lower)
    || /\bcredit limit (?:has been |is )?(?:increased|enhanced|revised)\b/i.test(lower)
    || /\brevised credit limit\b|\blimit enhancement\b|\bupgrade your card\b/i.test(lower)
    || /\bcredit line of rs\b|\bpre-?approved credit limit\b/i.test(lower)
  ) {
    return 'LOAN_OR_CREDIT_PROMO';
  }

  // 3. Loan Repayments, Disbursals & Receipts
  if (
    /\b(?:received|deposited|received payment|thanks for depositing).*(?:towards|against).*loan\b/i.test(lower)
    || /\bdisbursed to your (?:savings|bank|a\/c)\b/i.test(lower)
    || /\bdisbursal of .* loan\b/i.test(lower)
    || /\bloan instalment\b|\bloan installment\b|\bhome loan emi\b|\bpersonal loan emi\b/i.test(lower)
  ) {
    return 'LOAN_REPAYMENT_OR_DISBURSAL';
  }

  // 4. EMI Conversion notices
  if (
    /\bconverted (?:in)?to (?:smart )?emi\b|\bconverted into \d+ emis\b|\bemi conversion\b/i.test(lower)
  ) {
    return 'EMI_CONVERSION';
  }

  // 5. Credit Card Bill Payments & Self Transfers
  if (
    /\bcredited to your (?:sbi|hdfc|icici|axis|yes|credit )?card\b/i.test(lower)
    || /\bcard.*payment received\b|\bpayment towards your.*card\b/i.test(lower)
    || /\bfastag.*recharge successful\b/i.test(lower)
  ) {
    return 'SELF_TRANSFER_OR_CARD_PAYMENT';
  }

  // 6. Reminders, Bills, Mandates
  if (
    /\b(?:bill|payment|emi|autopay|smartpay) reminder\b|\bpre-?debit (?:notification|alert)\b/i.test(lower)
    || /\b(?:is|are) due on\b|\bminimum amount due\b|\btotal amount due\b|\bpayment due\b/i.test(lower)
    || /\bmandate (?:has been |is )?(?:registered|created|setup|approved)\b/i.test(lower)
  ) {
    return 'REMINDER_OR_MANDATE';
  }

  // 7. Balance Updates
  if (/\bavailable balance is\b|\bavl bal\b|\bclear bal\b|\bbalance in a\/c\b/i.test(lower)) {
    return 'BALANCE_INQUIRY';
  }

  // 8. General Promos & Telecom Data Alerts
  if (
    /\bdata (?:pack|quota|limit) (?:is )?(?:exhausted|consumed|over)\b|\bcaller ?tune\b/i.test(lower)
    || /\bexclusive offer\b|\bdiscount\b|\buse code\b|\bcoupon\b|\bcashback up to\b/i.test(lower)
  ) {
    return 'GENERAL_PROMO_OR_SERVICE';
  }

  // 9. Standard Transactions (Debited or Credited)
  if (/\b(?:debited|spent|paid|withdrawn|charged)\b/i.test(lower)) {
    return 'TRANSACTION_DEBIT';
  }
  if (/\b(?:credited|deposited|received)\b/i.test(lower)) {
    return 'TRANSACTION_CREDIT';
  }

  return 'OTHER';
}

// ------------------------------------------------------------------ Processing

async function main() {
  console.log(`Starting processing of ${inputPath}...`);
  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath),
    crlfDelay: Infinity,
  });

  const outStream = fs.createWriteStream(outputRedactedPath, { encoding: 'utf8' });

  let totalLines = 0;
  let parsedCount = 0;
  let skippedPersonalCount = 0;
  let skippedNoBody = 0;

  const categoryCounts = new Map();
  const templateMap = new Map();
  const falsePositives = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    totalLines += 1;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    const rawBody = (msg.body || '').trim();
    if (!rawBody) {
      skippedNoBody += 1;
      continue;
    }

    const sender = (msg.address || 'UNKNOWN').trim().toUpperCase();

    // 1. Strict Personal Filter: Skip 10-12 digit phone senders
    if (isPersonalSender(sender)) {
      skippedPersonalCount += 1;
      continue;
    }

    parsedCount += 1;

    // 2. Strict Redaction of names, cards, phones, balances
    const redactedBody = redactText(rawBody);
    const template = toCanonicalTemplate(redactedBody);
    const detectedCategory = classifyCategory(rawBody, sender);

    categoryCounts.set(detectedCategory, (categoryCounts.get(detectedCategory) || 0) + 1);

    // 3. Test against current engine
    const engineRejection = notATransaction(rawBody);
    const isEngineTx = !engineRejection;
    const parsedAmt = isEngineTx ? extractTransactionAmount(rawBody) : 0;

    const isFalsePositive = isEngineTx
      && (detectedCategory === 'LOAN_OR_CREDIT_PROMO'
        || detectedCategory === 'EMI_CONVERSION'
        || (detectedCategory === 'GENERAL_PROMO_OR_SERVICE' && parsedAmt > 0));

    if (isFalsePositive) {
      falsePositives.push({
        sender,
        category: detectedCategory,
        parsedAmount: parsedAmt,
        redactedBody,
        template,
      });
    }

    // 4. Cluster template
    if (!templateMap.has(template)) {
      templateMap.set(template, {
        template,
        category: detectedCategory,
        count: 0,
        sampleSender: sender,
        engineSaysTx: isEngineTx,
        engineRejection: engineRejection || '',
        exampleRedacted: redactedBody,
      });
    }
    templateMap.get(template).count += 1;

    // 5. Write to redacted file
    const record = {
      _id: msg._id,
      sender,
      date: msg.date,
      category: detectedCategory,
      redacted_body: redactedBody,
      engine_status: isEngineTx ? 'transaction' : engineRejection,
      engine_amount: parsedAmt,
      is_false_positive: isFalsePositive,
    };
    outStream.write(`${JSON.stringify(record)}\n`);
  }

  outStream.end();

  console.log('\n======================================================');
  console.log('                 DUMP ANALYSIS COMPLETE               ');
  console.log('======================================================');
  console.log(`Total messages in file: ${totalLines}`);
  console.log(`Personal 10-digit messages skipped: ${skippedPersonalCount}`);
  console.log(`Valid banking / service messages processed: ${parsedCount}`);
  console.log(`Unique canonical templates discovered: ${templateMap.size}`);
  console.log(`Redacted dataset exported to: ${outputRedactedPath}`);

  // Group templates by category preserving ALL variations
  const templatesByCategory = {};
  for (const t of templateMap.values()) {
    if (!templatesByCategory[t.category]) {
      templatesByCategory[t.category] = [];
    }
    templatesByCategory[t.category].push({
      template: t.template,
      sample_sender: t.sampleSender,
      occurrences: t.count,
      sample_text: t.exampleRedacted,
      current_engine: {
        status: t.engineSaysTx ? 'transaction' : t.engineRejection,
        is_false_positive: t.engineSaysTx && (t.category === 'LOAN_OR_CREDIT_PROMO' || t.category === 'EMI_CONVERSION'),
      },
    });
  }

  // Sort templates within each category by frequency
  for (const cat of Object.keys(templatesByCategory)) {
    templatesByCategory[cat].sort((a, b) => b.occurrences - a.occurrences);
  }

  // Write out canonical_templates_for_llm.json (ALL templates across ALL categories)
  const llmExport = {
    metadata: {
      generated_at: new Date().toISOString(),
      source_messages: parsedCount,
      personal_messages_excluded: skippedPersonalCount,
      total_unique_templates: templateMap.size,
      false_positives_detected: falsePositives.length,
      note: 'All personal names, 10-digit personal phone numbers, account numbers, and balances have been scrubbed.',
    },
    categories: templatesByCategory,
  };

  fs.writeFileSync(outputLlmTemplatesPath, JSON.stringify(llmExport, null, 2), 'utf8');
  console.log(`Canonical templates for LLM saved to: ${outputLlmTemplatesPath}`);

  // Write out focused loan_and_credit_templates_for_llm.json
  const focusedLoanCreditExport = {
    metadata: {
      generated_at: new Date().toISOString(),
      total_loan_promo_templates: (templatesByCategory.LOAN_OR_CREDIT_PROMO || []).length,
      total_emi_conversion_templates: (templatesByCategory.EMI_CONVERSION || []).length,
      total_loan_repayment_templates: (templatesByCategory.LOAN_REPAYMENT_OR_DISBURSAL || []).length,
      total_card_payment_templates: (templatesByCategory.SELF_TRANSFER_OR_CARD_PAYMENT || []).length,
      false_positives_count: falsePositives.length,
    },
    loan_or_credit_promos: templatesByCategory.LOAN_OR_CREDIT_PROMO || [],
    emi_conversions: templatesByCategory.EMI_CONVERSION || [],
    loan_repayments_and_disbursals: templatesByCategory.LOAN_REPAYMENT_OR_DISBURSAL || [],
    card_payments_and_self_transfers: templatesByCategory.SELF_TRANSFER_OR_CARD_PAYMENT || [],
    sample_genuine_debit_templates: (templatesByCategory.TRANSACTION_DEBIT || []).slice(0, 30),
    sample_genuine_credit_templates: (templatesByCategory.TRANSACTION_CREDIT || []).slice(0, 30),
  };

  fs.writeFileSync(outputLoanCreditTemplatesPath, JSON.stringify(focusedLoanCreditExport, null, 2), 'utf8');
  console.log(`Focused Loan & Credit templates saved to: ${outputLoanCreditTemplatesPath}`);

  // Group false positives by template
  const fpTemplates = new Map();
  for (const fp of falsePositives) {
    if (!fpTemplates.has(fp.template)) {
      fpTemplates.set(fp.template, { ...fp, occurrences: 0 });
    }
    fpTemplates.get(fp.template).occurrences += 1;
  }
  const sortedFp = [...fpTemplates.values()].sort((a, b) => b.occurrences - a.occurrences);

  // Write cluster summary
  const summary = {
    total: parsedCount,
    personalSkipped: skippedPersonalCount,
    categories: Object.fromEntries(categoryCounts.entries()),
    totalFalsePositives: falsePositives.length,
    falsePositiveTemplates: sortedFp,
    topTemplates: [...templateMap.values()].sort((a, b) => b.count - a.count).slice(0, 60),
  };
  fs.writeFileSync(outputSummaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`Cluster summary saved to: ${outputSummaryPath}`);
}

main().catch(console.error);
