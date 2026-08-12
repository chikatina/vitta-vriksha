/*
 * What the backend tests run against.
 *
 * The same modules the app ships, including the same WebAssembly build of SQLite: the
 * only thing that changes is where the engine gets its payload from, because a test
 * runner has no fetch that understands a file path. Every test gets its own database,
 * held in memory and never written anywhere, so nothing here can touch a real install.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = path.join(ROOT, 'app', 'src', 'main', 'assets', 'www');

export const BACKEND = path.join(WWW, 'js', 'backend');

/*
 * A web storage the tests own.
 *
 * The backend keeps three things outside the encrypted database, in the storage the
 * WebView provides: the wrapped key, the count of wrong PINs, and the mirror of the rules.
 * Node has a localStorage of its own, but it is experimental, it wants a file on the
 * command line, and it is missing parts of the interface. Tests that lean on it fail for
 * reasons that have nothing to do with this app, so the harness installs its own: a plain
 * object, complete, and empty at the start of every run.
 */
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => store.set(String(key), String(value)),
    removeItem: (key) => store.delete(String(key)),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  },
});

const { configureRuntime, Database } = await import(
  pathToUrl(path.join(BACKEND, 'sqlite.js'))
);

configureRuntime({
  wasmBinary: fs.readFileSync(path.join(WWW, 'vendor', 'sqlite', 'sqlite3.wasm')),
});

export const database = await import(pathToUrl(path.join(BACKEND, 'database.js')));
export const errors = await import(pathToUrl(path.join(BACKEND, 'errors.js')));
export const crypto = await import(pathToUrl(path.join(BACKEND, 'crypto.js')));
export const fire = await import(pathToUrl(path.join(BACKEND, 'fire.js')));
export const loan = await import(pathToUrl(path.join(BACKEND, 'loan.js')));
export const sms = await import(pathToUrl(path.join(BACKEND, 'sms.js')));
export const reminders = await import(pathToUrl(path.join(BACKEND, 'reminders.js')));
export const cas = await import(pathToUrl(path.join(BACKEND, 'cas.js')));
export const vault = await import(pathToUrl(path.join(BACKEND, 'vault.js')));

function pathToUrl(file) {
  return new URL(`file://${file.replace(/\\/g, '/')}`).href;
}

/**
 * A backend with an empty database behind it.
 *
 * Saving is turned off: the database is in memory and there is nothing on the other side
 * of the write, which is exactly what a test wants.
 */
export async function freshBackend() {
  /*
   * Storage is part of the state a test starts from, not a place to leave things.
   *
   * A vault left behind by an earlier test is a vault the dispatcher finds, and it refuses
   * every action against a vault it cannot open. That failure would surface as an unrelated
   * test breaking for reasons nothing in it explains, and only when the runner happened to
   * order them that way.
   */
  localStorage.clear();
  vault.lockVault();

  const db = await Database.open();
  db.persist = false;
  database.useDatabase(db);
  database.initDb(db, true);
  return db;
}

/**
 * A backend that really does save, with the write captured rather than performed.
 *
 * Most tests turn saving off, because they are about what the actions do. This one exists
 * because turning it off also turned off the thing that broke: every screen fetches more
 * than one thing at once, and a bug in how saves were scheduled left the first of them
 * waiting on a promise nothing would settle.
 */
export async function persistingBackend() {
  const db = await Database.open();
  const writes = [];
  db.persist = true;
  // Stand in for the shell's file write, so nothing touches a disk.
  db.persistNow = async () => {
    writes.push(db.export().length);
    db._dirty = false;
  };
  database.useDatabase(db);
  database.initDb(db, true);
  return { db, writes };
}

/** Runs one action and returns its reply. */
export function call(action, args = {}) {
  return database.handleDbAction({ action, ...args });
}

/** Runs an action and fails the test if it did not succeed. */
export async function ok(t, action, args = {}) {
  const result = await call(action, args);
  if (result.status !== 'success') {
    throw new Error(`${action} failed: ${result.code} ${result.message}`);
  }
  return result;
}

/** A date `months` back, on the fifteenth, which is never a month-end edge case. */
export function monthsAgo(months) {
  const now = new Date();
  let month = now.getMonth() + 1 - months;
  let year = now.getFullYear();
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, '0')}-15`;
}

export { Database };
