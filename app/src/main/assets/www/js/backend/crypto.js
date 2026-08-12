/*
 * PIN hashing and backup encryption, on the platform's own cryptography.
 *
 * The formats are unchanged from the Python layer this replaces, byte for byte, so a
 * backup exported before the change still restores and a PIN set before it still unlocks:
 *
 *   backup   base64( salt[16] || nonce[12] || AES-256-GCM ciphertext with its tag )
 *            key derived by PBKDF2-HMAC-SHA256, 600,000 iterations
 *   PIN      base64( salt[16] || 32-byte derived key )
 *            same derivation, 120,000 iterations
 *
 * WebCrypto does this in native code with hardware acceleration behind it, so it is
 * faster than the Python path was, not slower.
 */

import { decodeBase64, encodeBase64 } from './native.js';

const BACKUP_ITERATIONS = 600000;
const PIN_ITERATIONS = 120000;

const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BITS = 256;

/** A backup that would not decrypt, almost always a wrong password. */
export class BackupDecryptError extends Error {
  constructor(message = 'Could not read that backup. Check the password and try again.') {
    super(message);
    this.name = 'BackupDecryptError';
  }
}

function subtle() {
  const engine = globalThis.crypto && globalThis.crypto.subtle;
  if (!engine) throw new Error('This WebView has no WebCrypto, so nothing can be encrypted.');
  return engine;
}

function randomBytes(count) {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

async function deriveBits(password, salt, iterations) {
  const material = await subtle().importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, KEY_BITS,
  );
  return new Uint8Array(bits);
}

async function deriveKey(password, salt, iterations, usages) {
  const raw = await deriveBits(password, salt, iterations);
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
}

/** Encrypts text with a password, in the layout above. */
export async function encryptData(text, password) {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveKey(password, salt, BACKUP_ITERATIONS, ['encrypt']);
  const ciphertext = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(text),
  ));

  const payload = new Uint8Array(salt.length + nonce.length + ciphertext.length);
  payload.set(salt, 0);
  payload.set(nonce, salt.length);
  payload.set(ciphertext, salt.length + nonce.length);
  return encodeBase64(payload);
}

/** Decrypts what `encryptData` produced. Anything wrong reads as a wrong password. */
export async function decryptData(encoded, password) {
  try {
    const raw = decodeBase64(encoded);
    const salt = raw.slice(0, SALT_BYTES);
    const nonce = raw.slice(SALT_BYTES, SALT_BYTES + NONCE_BYTES);
    const ciphertext = raw.slice(SALT_BYTES + NONCE_BYTES);
    const key = await deriveKey(password, salt, BACKUP_ITERATIONS, ['decrypt']);
    const plaintext = await subtle().decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new BackupDecryptError();
  }
}

/* ------------------------------------------------------------- the data key */

/*
 * The key the records are encrypted with, and the envelope the PIN locks it in.
 *
 * The PIN does not encrypt the database. A random key does, and the PIN only encrypts that
 * key. The difference is the whole design:
 *
 *   - Changing the PIN re-wraps ninety-odd bytes. Encrypting with the PIN directly would
 *     mean rewriting the entire database on every PIN change, and an interruption during
 *     that rewrite is the one moment years of records could be lost.
 *   - The same key can be wrapped a second time by something else, a hardware backed key
 *     in the platform's keystore, so a fingerprint opens the app without the PIN and
 *     neither wrapping is the only way in.
 *
 * This is what a bank does, give or take: the credential unlocks a key, it is never the
 * key itself.
 */
const KEY_BYTES = 32;

/** A new random data key, as raw bytes. Generated once and then only ever re-wrapped. */
export function newDataKey() {
  return randomBytes(KEY_BYTES);
}

/** Locks a data key inside an envelope only this PIN opens. */
export async function wrapDataKey(dataKey, pin) {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveKey(pin, salt, BACKUP_ITERATIONS, ['encrypt']);
  const sealed = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce }, key, dataKey,
  ));

  const payload = new Uint8Array(salt.length + nonce.length + sealed.length);
  payload.set(salt, 0);
  payload.set(nonce, salt.length);
  payload.set(sealed, salt.length + nonce.length);
  return encodeBase64(payload);
}

/**
 * Opens the envelope. A wrong PIN reads as a wrong PIN and nothing else.
 *
 * The tag on the envelope is what verifies the PIN, so there is no separate hash to check
 * and nothing to compare in a way that could leak which byte was wrong.
 */
export async function unwrapDataKey(envelope, pin) {
  try {
    const raw = decodeBase64(envelope);
    const salt = raw.slice(0, SALT_BYTES);
    const nonce = raw.slice(SALT_BYTES, SALT_BYTES + NONCE_BYTES);
    const sealed = raw.slice(SALT_BYTES + NONCE_BYTES);
    const key = await deriveKey(pin, salt, BACKUP_ITERATIONS, ['decrypt']);
    return new Uint8Array(await subtle().decrypt(
      { name: 'AES-GCM', iv: nonce }, key, sealed,
    ));
  } catch {
    throw new BackupDecryptError();
  }
}

/**
 * Moves the data key to a new PIN without touching a single record.
 *
 * Throws on the old PIN before it writes anything, so a failed attempt leaves the envelope
 * exactly as it was.
 */
export async function rewrapDataKey(envelope, oldPin, newPin) {
  const dataKey = await unwrapDataKey(envelope, oldPin);
  return wrapDataKey(dataKey, newPin);
}

/** A salted hash of a PIN. Two calls on the same PIN give different results. */
export async function hashPin(pin) {
  const salt = randomBytes(SALT_BYTES);
  const derived = await deriveBits(pin, salt, PIN_ITERATIONS);
  const payload = new Uint8Array(salt.length + derived.length);
  payload.set(salt, 0);
  payload.set(derived, salt.length);
  return encodeBase64(payload);
}

/**
 * Whether a PIN matches a stored hash.
 *
 * The comparison takes the same time whichever byte differs, so an attacker with the
 * stored hash learns nothing from how long a wrong guess took.
 */
export async function pinMatches(pin, stored) {
  try {
    const raw = decodeBase64(stored);
    const salt = raw.slice(0, SALT_BYTES);
    const expected = raw.slice(SALT_BYTES);
    const derived = await deriveBits(pin, salt, PIN_ITERATIONS);
    if (derived.length !== expected.length) return false;

    let difference = 0;
    for (let i = 0; i < derived.length; i += 1) difference |= derived[i] ^ expected[i];
    return difference === 0;
  } catch {
    return false;
  }
}
