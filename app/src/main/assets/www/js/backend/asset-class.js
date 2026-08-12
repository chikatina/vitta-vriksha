/*
 * What kind of thing a holding is.
 *
 * A statement says what it is only loosely: a depository prints "equities" for anything
 * with an equity ISIN, which puts an index fund, a gold fund and a bank share in one
 * heap. The ISIN carries the real answer for the structural question, and the name
 * carries it for the exposure question, so both are read, name first.
 *
 * ISIN prefixes, for Indian instruments:
 *   INE...    a company, so a share
 *   INF...    a mutual fund scheme, which includes anything traded as a fund
 *   IN0020..  issued by the Government of India, so a dated security or a gold bond
 *   IN[1-9].. a state development loan or another government issuer
 */

export const ASSET_CLASSES = [
  'Stocks',
  'Mutual funds',
  'ETF',
  'Government securities',
  'Commodities',
  'Bonds',
  'NPS',
  'Other',
];

// Gold and silver, however they are wrapped. A sovereign gold bond is legally a
// government security and economically a lump of gold, and somebody looking at their
// portfolio wants to see the metal, so exposure wins over the legal form here.
const COMMODITY = /\b(gold|silver|bullion|sgb|sovereign gold)\b/i;

// A fund that trades on an exchange. "Exchange traded" is spelled several ways and the
// bare "ETF" is often glued to the fund house's name.
const EXCHANGE_TRADED = /\betf\b|exchange[ -]?traded|\bbees\b|\bindex fund\b/i;

const GOVERNMENT = /\b(g[- ]?sec|gsec|govt|government|sovereign|treasury|\d{1,2}\.\d{1,2}% gs|sdl)\b/i;

/**
 * The class of one holding.
 *
 * `source` says which table it came from, and is trusted for the two cases a name and an
 * ISIN cannot settle: a pension account, and a bond a depository has already told us is a
 * bond rather than a government security.
 */
export function classifyAsset({
  isin = '', name = '', kind = '', source = '',
} = {}) {
  if (source === 'nps') return 'NPS';

  const code = String(isin || '').toUpperCase().trim();
  const title = String(name || '');

  // Exposure first. A gold ETF and a gold bond both belong with the metal.
  if (COMMODITY.test(title)) return 'Commodities';

  const government = code.startsWith('IN0020') || /^IN[1-9]/.test(code) || GOVERNMENT.test(title);
  if (government) return 'Government securities';

  if (EXCHANGE_TRADED.test(title)) return 'ETF';

  if (code.startsWith('INF')) return 'Mutual funds';
  if (code.startsWith('INE')) return kind === 'bond' ? 'Bonds' : 'Stocks';

  // Nothing in the code or the name settled it, so fall back on where it came from.
  if (kind === 'bond') return 'Bonds';
  if (kind === 'equity') return 'Stocks';
  if (source === 'folio') return 'Mutual funds';
  return 'Other';
}
