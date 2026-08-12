/*
 * SQLite, compiled to WebAssembly, holding the database in memory and persisting the file
 * through the shell.
 *
 * Why in memory rather than in a browser-managed store: the file stays where it already
 * is, in app-private storage, with the backup exclusions that are already on it, and the
 * durability guarantee stays with the platform rather than with a store the system may
 * evict. The Origin Private File System would avoid the copy but is not available in
 * every WebView this has to run in.
 *
 * The cost is that a save rewrites the whole file. At the size a household's ledger
 * reaches that is a millisecond of export and a small write, so saves are debounced and
 * happen after a write rather than on a timer. If it ever stops being cheap, the escape
 * hatch is the file system, decided then.
 */

import { readDatabase, writeDatabase } from './native.js';
import { isUnlocked, seal, unseal } from './vault.js';

const SQLITE_MODULE = '../../vendor/sqlite/sqlite3.mjs';

/**
 * How long to wait after the last write before saving.
 *
 * An action waits for its save before it returns, so this is felt: it is the pause
 * between tapping save and the sheet closing. Long enough to coalesce the several writes
 * one action makes, short enough not to be noticed.
 */
const SAVE_DEBOUNCE_MS = 120;

let sqlite3 = null;
let runtimeOptions = {};

/**
 * Options for the WebAssembly module.
 *
 * In a WebView the module fetches its own payload over the asset loader, which is the
 * shipping path and needs no configuration. Under a test runner there is no fetch that
 * understands a file path, so the payload is handed over directly. Same engine either
 * way: what the tests run is what runs on the device.
 */
export function configureRuntime(options) {
  runtimeOptions = options || {};
  sqlite3 = null;
}

/**
 * The engine's own warning about the Origin Private File System, which it tries to
 * install and cannot.
 *
 * It cannot because that store needs cross-origin isolation headers, and the asset loader
 * cannot set them. This app was never going to use it: the database is persisted through
 * the shell precisely so it stays in app-private storage with the backup exclusions
 * already on it. The warning is therefore expected on every single launch, and a log line
 * that is always there is a log line nobody reads. Everything else the engine says gets
 * through.
 */
const EXPECTED_WARNING = 'Ignoring inability to install OPFS';

/** Loads and starts the WebAssembly module, once. */
async function runtime() {
  if (sqlite3) return sqlite3;
  const module = await import(SQLITE_MODULE);

  globalThis.sqlite3ApiConfig = {
    ...(globalThis.sqlite3ApiConfig || {}),
    warn: (...parts) => {
      if (String(parts[0] ?? '').startsWith(EXPECTED_WARNING)) return;
      console.warn(...parts);
    },
  };

  sqlite3 = await module.default(runtimeOptions);
  return sqlite3;
}

/** Whether this runtime can run the database at all. */
export async function isAvailable() {
  try {
    await runtime();
    return true;
  } catch {
    return false;
  }
}

/**
 * Named parameters arrive here as ordinary object keys; SQLite's binder wants them with
 * the marker still attached.
 */
function bindable(params) {
  if (params === undefined || params === null) return undefined;
  if (Array.isArray(params)) return params.length ? params : undefined;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    out[key.startsWith(':') || key.startsWith('$') || key.startsWith('@') ? key : `:${key}`] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export class Database {
  constructor(handle, api) {
    this.handle = handle;
    this.api = api;
    this._saveTimer = null;
    this._savePromise = null;
    this._dirty = false;
    this.persist = true;
  }

  /**
   * Opens a database.
   *
   * With bytes, the file is handed to SQLite as it stands: the format has not changed, so
   * a database written by any other SQLite opens directly. Without, a new empty one.
   */
  static async open(bytes = null) {
    const api = await runtime();
    const handle = new api.oo1.DB();

    if (bytes && bytes.length) {
      const pointer = api.wasm.allocFromTypedArray(bytes);
      const rc = api.capi.sqlite3_deserialize(
        handle.pointer, 'main', pointer, bytes.length, bytes.length,
        api.capi.SQLITE_DESERIALIZE_FREEONCLOSE | api.capi.SQLITE_DESERIALIZE_RESIZEABLE,
      );
      handle.checkRc(rc);
    }
    handle.exec('PRAGMA foreign_keys = ON');
    return new Database(handle, api);
  }

  /** Opens the app's database from wherever the shell keeps it. */
  /*
   * Opens the stored database, decrypting it on the way in.
   *
   * The key has to be in memory already, which is why the PIN is asked for before this is
   * called rather than after. A file an earlier build wrote in the clear opens as it is,
   * and is written back encrypted the first time anything changes.
   */
  static async openStored() {
    const stored = await readDatabase();
    const database = await Database.open(stored ? await unseal(stored) : null);
    return database;
  }

  /** Opens a read-only database from bytes, one that is never written back. */
  static async openReadOnly(bytes) {
    const database = await Database.open(bytes);
    database.persist = false;
    return database;
  }

  /** Runs one statement. */
  run(sql, params) {
    this.handle.exec({ sql, bind: bindable(params) });
    this._dirty = true;
    return {
      changes: this.handle.changes(),
      lastInsertRowid: Number(this.api.capi.sqlite3_last_insert_rowid(this.handle.pointer)),
    };
  }

  /** Runs a script of several statements. */
  exec(sql) {
    this.handle.exec(sql);
    this._dirty = true;
  }

  /** Every row a query returns, as plain objects. */
  all(sql, params) {
    return this.handle.exec({
      sql, bind: bindable(params), rowMode: 'object', returnValue: 'resultRows',
    });
  }

  /** The first row, or null. */
  get(sql, params) {
    const rows = this.all(sql, params);
    return rows.length ? rows[0] : null;
  }

  /** The first column of the first row, or undefined. */
  value(sql, params) {
    const row = this.get(sql, params);
    if (!row) return undefined;
    return row[Object.keys(row)[0]];
  }

  /** Runs `work` inside a transaction, rolling back if it throws. */
  transaction(work) {
    this.handle.exec('BEGIN');
    try {
      const result = work();
      this.handle.exec('COMMIT');
      this._dirty = true;
      return result;
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK');
      } catch {
        // A rollback that fails because the transaction already ended is not news.
      }
      throw error;
    }
  }

  /** The whole database as bytes. */
  export() {
    return this.api.capi.sqlite3_js_db_export(this.handle.pointer);
  }

  /**
   * Saves after a short pause, so a burst of writes costs one write rather than one each.
   * Returns a promise that settles when the save has happened.
   *
   * Every caller waiting on a save waits on the *same* promise, and re-scheduling pushes
   * the deadline back rather than replacing it. An earlier version made a new promise per
   * call and cancelled the timer that was the only thing able to settle the previous one,
   * so two actions running at once left the first awaiting a promise nothing would ever
   * resolve. Every screen fetches more than one thing at a time, so every screen hung.
   *
   * A read changes nothing, so it settles at once rather than rewriting the file.
   */
  schedulePersist() {
    if (!this.persist || !this._dirty) return Promise.resolve();

    if (!this._savePromise) {
      this._savePromise = new Promise((resolve, reject) => {
        this._saveSettle = { resolve, reject };
      });
    }
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._runPendingSave();
    }, SAVE_DEBOUNCE_MS);

    return this._savePromise;
  }

  /** Performs the pending save and settles everyone waiting on it. */
  async _runPendingSave() {
    const settle = this._saveSettle;
    this._savePromise = null;
    this._saveSettle = null;
    try {
      await this.persistNow();
      if (settle) settle.resolve();
    } catch (error) {
      if (settle) settle.reject(error);
      else throw error;
    }
  }

  /** Saves immediately. */
  async persistNow() {
    if (!this.persist) return;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    /*
     * Sealed on the way out, always, with no path that writes in the clear.
     *
     * There is a moment during setup, before a PIN has been chosen, when there is no key
     * to seal with. Writing the file unencrypted just then would be defensible for about
     * a second and wrong for as long as the file survived: it would sit on the device
     * readable until something happened to overwrite it, and nothing guarantees anything
     * ever does. So that write does not happen. The database stays dirty, and the first
     * save after the PIN exists writes all of it, encrypted.
     *
     * Nothing is lost by waiting. The only thing recorded before a PIN is the empty schema
     * and its defaults, which the next start would build again anyway.
     */
    if (!isUnlocked()) return;

    await writeDatabase(await seal(this.export()));
    this._dirty = false;
  }

  /**
   * Leaves nothing unwritten.
   *
   * A scheduled save is brought forward rather than sitting out the pause. Anything
   * written with no save scheduled yet, which is what creating the schema does, is written
   * too: the name promises there is nothing outstanding afterwards, and a caller reaching
   * for this is usually about to be suspended or closed.
   */
  async flush() {
    if (this._savePromise) {
      const waiting = this._savePromise;
      if (this._saveTimer) this._runPendingSave();
      await waiting;
      return;
    }
    if (this._dirty) await this.persistNow();
  }

  close() {
    this.handle.close();
  }
}
