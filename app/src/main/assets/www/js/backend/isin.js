/*
 * The scheme reference database.
 *
 * A statement does not print everything the app needs. A registrar prints a scheme's name
 * and its own internal code but not the ISIN, the AMFI code, or whether the scheme is
 * equity or debt. A depository prints the ISIN and nothing else, not even a ticker. This
 * closes both gaps, and carries the 31 January 2018 values that the grandfathering rule
 * for long-term equity gains needs.
 *
 * It ships as a second SQLite database, opened read-only and never written back. Keeping
 * it out of the user's own file matters: a save rewrites the whole file, and five
 * megabytes of reference data on every write would make that expensive for no reason. It
 * is also loaded lazily, because most of what the app does never needs it.
 *
 * Rebuild it with tools/build-isin-db.py when a newer one is published.
 */

import { SqlIsinDb } from '../../vendor/casparser/isin-db.js';
import { setIsinProvider } from '../../vendor/casparser/isin.js';
import { Database } from './sqlite.js';

const DATABASE_URL = new URL('../../vendor/isin/isin.db', import.meta.url);

let loading = null;
let reference = null;

/**
 * Loads the reference database and registers it with the parser.
 *
 * Called once, before a statement is parsed or gains are computed. Everything still works
 * without it: the fields it would have filled in come back empty and nothing else
 * changes, which is the behaviour a build that dropped the asset should have.
 */
export async function loadIsinDatabase() {
  if (reference) return reference;
  if (loading) return loading;

  loading = (async () => {
    try {
      const response = await fetch(DATABASE_URL);
      if (!response.ok) throw new Error(`the reference database is missing (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());

      const database = await Database.openReadOnly(bytes);
      reference = {
        database,
        version: versionOf(database),
        provider: new SqlIsinDb({ query: (sql, params) => database.all(sql, params) }),
      };
      setIsinProvider(reference.provider);
      return reference;
    } catch (error) {
      // Not fatal. A statement still parses; it just arrives without the codes.
      console.warn('The scheme reference database could not be loaded.', error);
      reference = null;
      return null;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

/**
 * The scheme or security a code stands for.
 *
 * A depository prints the ISIN and the fund house, never the scheme, so twelve different
 * schemes from one AMC all arrive called "ICICI Prudential Mutual Fund". The name has to
 * come from here or a holdings table cannot be read at all. Schemes are looked up first
 * because a fund ISIN appears in both tables and the scheme table is the one that knows
 * the plan and the option.
 *
 * Returns an empty string when the code is unknown or the database never loaded, which is
 * the same as it has always behaved without the asset: the caller keeps what it had.
 */
export function nameForIsin(isin) {
  const code = String(isin || '').trim().toUpperCase();
  if (!code || !reference) return '';

  try {
    const scheme = reference.database.get('SELECT name FROM scheme WHERE isin = ?', [code]);
    if (scheme && scheme.name) return String(scheme.name).trim();
    const security = reference.database.get('SELECT name FROM isin WHERE isin = ?', [code]);
    if (security && security.name) return String(security.name).trim();
  } catch {
    // A reference database from another build may not have these tables. Not fatal.
  }
  return '';
}

function versionOf(database) {
  try {
    const row = database.get("SELECT value FROM meta WHERE key = 'version'");
    return row ? row.value : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** What the About screen reports. */
export function isinDatabaseVersion() {
  return reference ? reference.version : null;
}

/** Releases it. The data is read-only, so this only frees memory. */
export function unloadIsinDatabase() {
  if (!reference) return;
  setIsinProvider(null);
  reference.database.close();
  reference = null;
}
