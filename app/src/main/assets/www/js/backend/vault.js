/*
 * The lock on the database file.
 *
 * Everything recorded is written encrypted. The PIN is not the key: a random key is, and
 * the PIN only encrypts that key, so changing the PIN rewrites ninety bytes rather than
 * every record. See crypto.js for why that matters.
 *
 * Three things live outside the encrypted file, because nothing can be read until they
 * are:
 *
 *   - the wrapped key, which is ciphertext and says nothing without the PIN
 *   - a note that a vault exists at all, so the app knows to ask
 *   - the configuration mirror, described below
 *
 * The mirror is deliberate. A PIN nobody remembers means records nobody can read, and
 * that is the honest cost of encrypting them. It should not also mean losing every SMS
 * rule and every merchant the app was taught, because none of that says what anybody owns
 * or did: it says how the app behaves. So it is kept in the clear, and starting again
 * after a forgotten PIN costs the ledger and not the machinery that rebuilds it.
 */

import {
  newDataKey, rewrapDataKey, unwrapDataKey, wrapDataKey, BackupDecryptError,
} from './crypto.js';
import {
  readAttempts, readConfigMirror, readVaultKey, writeAttempts, writeConfigMirror,
  writeVaultKey,
} from './native.js';

const NONCE_BYTES = 12;
// A file that starts with this is encrypted. A SQLite file starts with "SQLite format 3",
// so the two can never be mistaken for each other and an older plaintext database is
// recognised rather than fed to the decrypter as noise.
const MAGIC = new Uint8Array([0x56, 0x56, 0x31, 0x00]);

let dataKey = null;

function subtle() {
  const engine = globalThis.crypto && globalThis.crypto.subtle;
  if (!engine) throw new Error('This device has no WebCrypto, so nothing can be encrypted.');
  return engine;
}

/** Whether a vault has ever been made on this device. */
export function vaultExists() {
  return Boolean(readVaultKey());
}

/** Whether the key is in memory, which is to say whether the app is unlocked. */
export function isUnlocked() {
  return dataKey !== null;
}

/**
 * Makes a vault. Called once, when the PIN is chosen during setup.
 *
 * Refuses to replace one that already exists, because doing so would abandon a key that
 * every existing record is encrypted with.
 */
export async function createVault(pin) {
  if (vaultExists()) throw new Error('A vault already exists on this device.');
  const key = newDataKey();
  writeVaultKey(await wrapDataKey(key, pin));
  dataKey = key;
  return true;
}

/* ------------------------------------------------------------ wrong guesses */

/*
 * What a wrong PIN costs, growing each time.
 *
 * Four free tries, because people mistype. Then waits that make guessing pointless: a
 * four digit PIN is ten thousand possibilities, and at an hour a try past the ninth the
 * heat death of the sun arrives first. The tenth wrong guess shuts the app for a week.
 *
 * It does not erase anything. A bank wipes at this point because the records are on its
 * servers and the phone holds a copy; here the phone holds the only copy, so wiping would
 * punish the person who mistyped their own PIN far harder than the thief who never gets
 * in either way.
 */
/*
 * Indexed by how many wrong PINs have been tried, so the first four cost nothing and the
 * fifth starts the waits. The tenth falls off the end of the table and shuts the app for
 * a week.
 */
const PENALTIES = [0, 0, 0, 0, 0, 30_000, 60_000, 300_000, 900_000, 3_600_000];
const LOCKOUT = 7 * 24 * 3600_000;

/*
 * How long the app stays shut, in milliseconds, or nought when it is open.
 *
 * A deadline in wall-clock time is only as honest as the clock, and the clock belongs to
 * whoever is holding the phone. So the last time the app looked is written down beside
 * the deadline, and a clock that has gone backwards since then is taken as an attempt to
 * wait the penalty out by moving it: the deadline is pushed forward by however far the
 * clock jumped, which leaves the wait exactly as long as it was.
 *
 * This is friction and not the wall. Somebody willing to change the date can copy the
 * encrypted file instead and attack it on a desktop, where no counter of ours runs at
 * all. What costs them there is the six hundred thousand round derivation on every guess,
 * and the length of the PIN. That is the real defence; this only stops a person picking
 * up an unattended phone and trying birthdays.
 */
export function lockoutRemaining() {
  const state = readAttempts();
  const now = Date.now();
  const until = state.until || 0;
  const seen = state.seen || 0;

  if (seen && now < seen) {
    const moved = seen - now;
    const corrected = { ...state, until: until ? until - moved : 0, seen: now };
    writeAttempts(corrected);
    return Math.max(0, corrected.until - now);
  }

  if (now > seen) writeAttempts({ ...state, seen: now });
  return Math.max(0, until - now);
}

/** How many wrong PINs have been tried since the last right one. */
export function failedAttempts() {
  return readAttempts().failed || 0;
}

function recordFailure() {
  // The count only ever rises, and only a right PIN clears it. Winding the clock forward
  // to expire a penalty still leaves the next wrong guess costing more than this one did.
  const failed = failedAttempts() + 1;
  const penalty = failed >= PENALTIES.length ? LOCKOUT : PENALTIES[failed];
  const now = Date.now();
  writeAttempts({ failed, until: penalty ? now + penalty : 0, seen: now });
  return { failed, penalty };
}

/**
 * Opens the vault, or throws. The wrapping's own tag is what rejects a wrong PIN.
 *
 * Refuses outright while a penalty is running, so waiting it out is the only way through
 * and each wrong guess costs more than the last.
 */
export async function unlockVault(pin) {
  const waiting = lockoutRemaining();
  if (waiting > 0) {
    const error = new Error('Too many wrong tries.');
    error.lockedFor = waiting;
    throw error;
  }

  const envelope = readVaultKey();
  if (!envelope) throw new Error('There is no vault on this device.');

  let key;
  try {
    key = await unwrapDataKey(envelope, pin);
  } catch {
    const { failed, penalty } = recordFailure();
    const error = new Error('That is not your PIN.');
    error.failed = failed;
    error.lockedFor = penalty;
    throw error;
  }

  dataKey = key;
  // A right PIN clears the slate. Somebody who mistyped twice and then got it should not
  // carry the next wrong guess into a penalty.
  writeAttempts({ failed: 0, until: 0, seen: Date.now() });
  return true;
}

/** Forgets the key. The file on disk stays exactly as it is. */
export function lockVault() {
  dataKey = null;
}

/**
 * Moves the vault to a new PIN.
 *
 * Nothing recorded is touched: the key is the same key, only its wrapping changes. The
 * old PIN is checked before anything is written, so a wrong one leaves the vault as it
 * was rather than half changed.
 */
export async function changeVaultPin(oldPin, newPin) {
  const envelope = readVaultKey();
  if (!envelope) throw new Error('There is no vault on this device.');
  const moved = await rewrapDataKey(envelope, oldPin, newPin);
  writeVaultKey(moved);
  return true;
}

/** Encrypts the database file. */
export async function seal(bytes) {
  if (!dataKey) throw new Error('The app is locked, so nothing can be saved.');
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await subtle().importKey('raw', dataKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, bytes));

  const out = new Uint8Array(MAGIC.length + nonce.length + sealed.length);
  out.set(MAGIC, 0);
  out.set(nonce, MAGIC.length);
  out.set(sealed, MAGIC.length + nonce.length);
  return out;
}

/**
 * Decrypts the database file.
 *
 * A file without the marker is one an earlier build wrote in the clear. It is handed back
 * as it is rather than refused: refusing would make the app unopenable, and pretending it
 * was encrypted would be worse.
 */
export async function unseal(bytes) {
  if (!bytes || !bytes.length) return bytes;
  if (!looksSealed(bytes)) return bytes;
  if (!dataKey) throw new Error('The app is locked, so nothing can be read.');

  const nonce = bytes.slice(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const sealed = bytes.slice(MAGIC.length + NONCE_BYTES);
  const key = await subtle().importKey('raw', dataKey, { name: 'AES-GCM' }, false, ['decrypt']);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce }, key, sealed));
  } catch {
    // The key opened its wrapping but not the file, so the two do not belong together.
    throw new BackupDecryptError();
  }
}

/** Whether a stored file was written by this app's encryption rather than in the clear. */
export function looksSealed(bytes) {
  if (!bytes || bytes.length < MAGIC.length) return false;
  return MAGIC.every((byte, index) => bytes[index] === byte);
}

/* -------------------------------------------------------- the config mirror */

/*
 * What the app was taught, kept where a forgotten PIN cannot take it.
 *
 * Rules, learned merchants and categories only describe behaviour. That somebody files
 * Zomato under Dining is not a fact about their money. Keeping them readable is what makes
 * starting again after a lost PIN a morning's work rather than a year's.
 */
const MIRRORED = ['sms_rules', 'merchant_rules', 'custom_categories'];

/** The mirrored tables of a snapshot, in a fixed order, so two can be compared as text. */
function tablesOf(snapshot) {
  const tables = {};
  for (const table of MIRRORED) tables[table] = (snapshot && snapshot[table]) || [];
  return tables;
}

/**
 * Copies the behaviour tables out to the clear.
 *
 * Called after every action rather than after the ones that change a rule, because a list
 * of which actions those are is a list that goes out of date the first time somebody adds
 * one. Reading three small tables and comparing the result costs far less than the save it
 * sits in front of, and being unconditional is what makes it correct.
 *
 * Writes nothing when nothing changed, so the common case leaves storage untouched and the
 * timestamp keeps meaning the last time a rule actually moved.
 */
export function mirrorConfig(db) {
  try {
    const tables = {};
    for (const table of MIRRORED) tables[table] = db.all(`SELECT * FROM ${table}`);
    const body = JSON.stringify(tables);
    if (JSON.stringify(tablesOf(readMirroredConfig())) === body) return false;

    writeConfigMirror(JSON.stringify({ ...tables, saved_at: new Date().toISOString() }));
    return true;
  } catch {
    // A mirror that could not be written is not a reason to fail the thing that changed.
    return false;
  }
}

/** What the mirror holds, or nothing when there is none. */
export function readMirroredConfig() {
  try {
    const raw = readConfigMirror();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Puts the mirrored rules back into a fresh database.
 *
 * Used after a factory reset that followed a forgotten PIN: the records are gone and
 * nothing brings them back, but the app does not have to be taught everything twice.
 */
export function restoreMirroredConfig(db) {
  const snapshot = readMirroredConfig();
  if (!snapshot) return 0;

  let restored = 0;
  for (const table of MIRRORED) {
    for (const row of snapshot[table] || []) {
      const columns = Object.keys(row).filter((name) => name !== 'id');
      if (!columns.length) continue;
      try {
        db.run(
          `INSERT OR IGNORE INTO ${table} (${columns.join(', ')})`
          + ` VALUES (${columns.map(() => '?').join(', ')})`,
          columns.map((name) => row[name]),
        );
        restored += 1;
      } catch {
        // A column this build no longer has. The rest of the row set still goes back.
      }
    }
  }
  return restored;
}
