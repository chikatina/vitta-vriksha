/*
 * What two statements say about the same holding.
 *
 * A depository statement and a registrar statement both report the units a household
 * holds with an AMC. The depository masks the folio number, so the same holding arrives
 * under two different keys and is counted twice. Units held in demat are a different
 * thing that only the depository reports, and merging those would be just as wrong as
 * double counting the others.
 *
 * This says which ISINs appear in both, and with what units, so the difference between
 * "the same holding twice" and "two real holdings" is a number rather than an opinion.
 *
 * Only ISIN prefixes, counts and totals are printed. No holding is named.
 *
 *   node scripts/verify-overlap.mjs nsdl.pdf --password A cams.pdf --password B
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readCasPdf } from '../../casparser-js/src/parsers/index.js';
import { createPdfjsBackend } from '../../casparser-js/src/pdf/pdfjs.js';
import { setPdfBackend } from '../../casparser-js/src/pdf/backend.js';

const num = (value) => Number(value ?? 0);
const money = (value) => value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Enough of a code to line two statements up, not enough to look anything up.
const short = (isin) => `${String(isin || '').slice(0, 6)}...`;

/** Every fund a statement reports, tagged with where the units actually sit. */
function fundsOf(data) {
  const out = [];

  // A registrar statement has folios and no demat accounts at all.
  for (const folio of data.folios || []) {
    for (const scheme of folio.schemes || []) {
      out.push({
        isin: scheme.isin || '',
        units: num(scheme.balance ?? scheme.close),
        value: num(scheme.valuation && scheme.valuation.value),
        where: 'with the AMC',
      });
    }
  }

  for (const account of data.accounts || []) {
    const isFolios = /folio/i.test(account.name || '') || /folio/i.test(account.type || '');
    for (const fund of account.mutual_funds || []) {
      out.push({
        isin: fund.isin || '',
        units: num(fund.balance),
        value: num(fund.value),
        where: isFolios ? 'with the AMC' : 'in demat',
      });
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const jobs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--password') continue;
    if (args[i - 1] === '--password') continue;
    const passwordAt = args.indexOf('--password', i);
    jobs.push({ file: args[i], password: passwordAt >= 0 ? args[passwordAt + 1] : '' });
  }
  if (jobs.length < 2) {
    console.error('usage: node scripts/verify-overlap.mjs a.pdf --password A b.pdf --password B');
    process.exit(2);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.resolve(here, '..', '..', 'casparser-js', 'node_modules', 'pdfjs-dist');
  const pdfjsLib = await import(pathToFileURL(path.join(dist, 'legacy', 'build', 'pdf.mjs')).href)
    .catch(() => null);
  if (!pdfjsLib) {
    console.error(`pdf.js not found under ${dist}.`);
    process.exit(2);
  }
  const asUrl = (...parts) => `${path.resolve(...parts).replace(/\\/g, '/')}/`;
  setPdfBackend(createPdfjsBackend(pdfjsLib, {
    documentOptions: {
      standardFontDataUrl: asUrl(dist, 'standard_fonts'),
      cMapUrl: asUrl(dist, 'cmaps'),
      cMapPacked: true,
    },
  }));

  const seen = new Map();
  const byName = new Map();
  for (const [index, job] of jobs.entries()) {
    const data = await readCasPdf(new Uint8Array(fs.readFileSync(job.file)), job.password);
    const label = `${data.file_type || 'statement'} ${index + 1}`;
    const funds = fundsOf(data);
    const withAmc = funds.filter((f) => f.where === 'with the AMC');
    const blank = funds.filter((f) => !f.isin);

    console.log(`${label.padEnd(16)} ${String(funds.length).padStart(3)} fund holdings, `
      + `${money(funds.reduce((sum, f) => sum + f.value, 0))}`);
    console.log(`${' '.repeat(16)} ${String(withAmc.length).padStart(3)} of them held with the AMC, `
      + `${money(withAmc.reduce((sum, f) => sum + f.value, 0))}`);
    /*
     * A holding with no ISIN cannot be matched against the other statement, so it would
     * be reported as no overlap whether or not it overlaps. Counting them is the only
     * thing standing between a clean result and a false one.
     */
    console.log(`${' '.repeat(16)} ${String(blank.length).padStart(3)} with no ISIN, `
      + `${money(blank.reduce((sum, f) => sum + f.value, 0))}`
      + `${blank.length ? '   <- cannot be matched by code' : ''}`);

    for (const fund of funds) {
      if (fund.isin) {
        const entry = seen.get(fund.isin) || [];
        entry.push({ ...fund, label });
        seen.set(fund.isin, entry);
      }
      // A second way in, for the rows the first way cannot see.
      const key = String(fund.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (key) {
        const entry = byName.get(key) || [];
        entry.push({ ...fund, label });
        byName.set(key, entry);
      }
    }
  }

  const shared = [...seen.entries()].filter(([, rows]) => new Set(rows.map((r) => r.label)).size > 1);

  console.log(`\nISINs reported by more than one statement: ${shared.length}`);
  console.log('-'.repeat(74));
  let sameHolding = 0;
  let bothPlaces = 0;
  let duplicatedValue = 0;

  for (const [isin, rows] of shared) {
    const places = new Set(rows.map((r) => r.where));
    // Same units in the same place is one holding reported twice. Different places is two
    // real holdings that only look alike.
    const units = [...new Set(rows.map((r) => r.units.toFixed(3)))];
    const duplicate = places.size === 1 && units.length === 1;
    if (duplicate) {
      sameHolding += 1;
      duplicatedValue += rows.slice(1).reduce((sum, r) => sum + r.value, 0);
    } else if (places.size > 1) {
      bothPlaces += 1;
    }
    console.log(`  ${short(isin)}  ${rows.length} rows  ${[...places].join(' + ').padEnd(24)}`
      + `${duplicate ? 'SAME HOLDING TWICE' : (places.size > 1 ? 'two real holdings' : 'same place, units differ')}`);
  }

  console.log('-'.repeat(74));
  console.log(`  the same holding reported twice : ${sameHolding}`);
  console.log(`  genuinely held in both places   : ${bothPlaces}`);
  console.log(`\nvalue that would be counted twice: ${money(duplicatedValue)}`);
  console.log(shared.length
    ? '\nImporting both statements as things stand would add that twice.'
    : '\nNo overlap. Importing both is safe as things stand.');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
