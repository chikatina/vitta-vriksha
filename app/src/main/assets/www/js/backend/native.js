/*
 * The native surface, and what stands in for it in a browser.
 *
 * Everything that decides something now lives in JavaScript, so this is only the handful
 * of things a web page genuinely cannot do: durable storage that survives the app being
 * killed, the fingerprint prompt, the permission dialogs, and the alarm clock. Six calls
 * and one receiver, which is the whole point of the exercise: the same web layer runs
 * unchanged wherever a WebView does.
 *
 * Opened in a desktop browser there is no shell at all, so the database lives in
 * localStorage and the platform calls answer honestly that they are unavailable. That is
 * a development convenience, not a second implementation: the real backend is running
 * either way.
 */

const STORE_KEY = 'vittavriksha.db';

/** True when the Android shell is present. */
export function isAndroid() {
  const g = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
  return Boolean(g && typeof g.AndroidBridge !== 'undefined');
}

function bridge() {
  return typeof window !== 'undefined' ? window.AndroidBridge : globalThis.AndroidBridge;
}

/* ------------------------------------------------------------------ storage */

/** The database file as bytes, or null when there is not one yet. */
export async function readDatabase() {
  if (isAndroid()) {
    const encoded = bridge().readDatabase();
    return encoded ? decodeBase64(encoded) : null;
  }
  const stored = localStorage.getItem(STORE_KEY);
  return stored ? decodeBase64(stored) : null;
}

/**
 * Writes the database file.
 *
 * On device the shell writes to a temporary file and renames it, so a write interrupted
 * half way leaves the previous file intact rather than a truncated one.
 */
export async function writeDatabase(bytes) {
  const encoded = encodeBase64(bytes);
  if (isAndroid()) {
    const ok = bridge().writeDatabase(encoded);
    if (!ok) throw new Error('The database could not be saved.');
    return;
  }
  localStorage.setItem(STORE_KEY, encoded);
}

/*
 * The two things that live outside the encrypted file.
 *
 * Both are held in the WebView's own storage rather than in the database, because nothing
 * in the database can be read until the key has been unwrapped, and the key is one of
 * them. The wrapped key is ciphertext: reading it off the device tells you nothing without
 * the PIN. The mirror is deliberately readable, and holds only rules and categories.
 */
const VAULT_KEY = 'vv.vault.key';
const CONFIG_MIRROR = 'vv.config.mirror';

export function readVaultKey() {
  return localStorage.getItem(VAULT_KEY) || '';
}

export function writeVaultKey(envelope) {
  localStorage.setItem(VAULT_KEY, envelope);
}

const ATTEMPTS = 'vv.vault.attempts';

/*
 * How many wrong PINs have been tried, and until when the app is shut.
 *
 * Outside the database for the same reason as the key: it has to be readable while the
 * app is locked. Somebody with a debugger can clear it, which is worth knowing and not
 * worth much: the same person could copy the encrypted file and attack it at their
 * leisure, and what stops them there is the six hundred thousand round derivation, not a
 * counter.
 */
export function readAttempts() {
  try {
    return JSON.parse(localStorage.getItem(ATTEMPTS) || '') || {};
  } catch {
    return {};
  }
}

export function writeAttempts(state) {
  localStorage.setItem(ATTEMPTS, JSON.stringify(state));
}

export function readConfigMirror() {
  return localStorage.getItem(CONFIG_MIRROR) || '';
}

export function writeConfigMirror(json) {
  localStorage.setItem(CONFIG_MIRROR, json);
}

/**
 * Forgets the vault, which makes every stored record permanently unreadable.
 *
 * Only ever called alongside deleting the database itself. The mirror is left alone: it
 * carries no records, and keeping it is what lets a reset after a forgotten PIN come back
 * with its rules intact.
 */
export function deleteVaultKey() {
  localStorage.removeItem(VAULT_KEY);
}

/** Forgets the stored database. Used by the factory reset. */
export async function deleteDatabase() {
  if (isAndroid()) {
    bridge().deleteDatabase();
    return;
  }
  localStorage.removeItem(STORE_KEY);
}

/* ---------------------------------------------------------------- biometrics */

export function isBiometricAvailable() {
  return isAndroid() ? bridge().isBiometricAvailable() : false;
}

export function triggerBiometricAuth() {
  if (isAndroid()) {
    bridge().authenticateBiometric();
  } else if (typeof window !== 'undefined' && window.onBiometricAuthResult) {
    setTimeout(() => window.onBiometricAuthResult(false, 'Biometrics are not available here.'), 200);
  }
}

/**
 * Initiates a biometric prompt and resolves with { success: boolean, message: string|null }.
 * Used during biometric enablement to verify that the biometric sensor works and the user
 * successfully authenticates before enabling biometric unlock.
 */
export function verifyBiometric() {
  if (!isBiometricAvailable()) {
    return Promise.resolve({ success: false, message: 'Biometrics are not available on this device.' });
  }

  return new Promise((resolve) => {
    const previous = typeof window !== 'undefined' ? window.onBiometricAuthResult : null;
    let settled = false;

    const finish = (success, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof window !== 'undefined') {
        window.onBiometricAuthResult = previous;
      }
      resolve({ success: Boolean(success), message: message || null });
    };

    const timer = setTimeout(() => finish(false, 'Biometric prompt timed out.'), 60000);

    if (typeof window !== 'undefined') {
      window.onBiometricAuthResult = (success, message) => {
        finish(success, message);
      };
    }

    triggerBiometricAuth();
  });
}

/* --------------------------------------------------------------- permissions */

export function checkPermission(name) {
  return isAndroid() ? bridge().checkPermission(name) : false;
}

/**
 * True when the user has ticked "don't ask again". Asking again would do nothing, so the
 * UI points at system settings instead.
 */
export function permissionIsBlocked(name) {
  return isAndroid() && bridge().permissionIsBlocked
    ? bridge().permissionIsBlocked(name)
    : false;
}

export function openAppSettings() {
  if (isAndroid()) bridge().openAppSettings();
}

/**
 * Asks for a permission and resolves once Android has an answer.
 *
 * The system dialog outlives the call that opened it, so the answer arrives later through
 * a global callback. This bridges that back into a promise.
 */
export function requestPermission(name) {
  if (!isAndroid()) return Promise.resolve(false);

  return new Promise((resolve) => {
    const previous = window.onPermissionResult;
    let settled = false;

    const finish = (granted) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.onPermissionResult = previous;
      resolve(granted);
    };

    // If the dialog is dismissed in a way that never reports back, read the real state
    // rather than leaving the caller waiting for ever.
    const timer = setTimeout(() => finish(checkPermission(name)), 90000);

    window.onPermissionResult = (which, granted) => {
      if (previous) previous(which, granted);
      if (which === name) finish(granted);
    };

    bridge().requestPermission(name);
  });
}

/* ----------------------------------------------------------------- reminders */

/**
 * Asks the shell to raise a notification at a given moment.
 *
 * The alarm has to outlive the app, so it belongs to the platform. Everything about
 * *which* reminders exist and when they are due is decided in JavaScript; this only
 * carries the answer across.
 */
export function scheduleReminder(id, whenMillis, title, body) {
  if (!isAndroid() || !bridge().scheduleReminder) return false;
  return bridge().scheduleReminder(String(id), Number(whenMillis), String(title), String(body));
}

export function cancelReminder(id) {
  if (!isAndroid() || !bridge().cancelReminder) return false;
  return bridge().cancelReminder(String(id));
}

/** Whether the shell may raise a notification at an exact time. */
export function canScheduleExactAlarms() {
  if (!isAndroid() || !bridge().canScheduleExactAlarms) return false;
  return bridge().canScheduleExactAlarms();
}

/* ---------------------------------------------------------------- bank alerts */

const SMS_OPT_OUT_KEY = 'vv.sms.tracking_enabled';

/** Whether the user has opted in or opted out of SMS tracking. */
export function isSmsTrackingEnabled() {
  if (isAndroid() && bridge().isSmsTrackingEnabled) {
    return bridge().isSmsTrackingEnabled();
  }
  return localStorage.getItem(SMS_OPT_OUT_KEY) !== '0';
}

export function setSmsTrackingEnabled(enabled) {
  const boolVal = Boolean(enabled);
  if (isAndroid() && bridge().setSmsTrackingEnabled) {
    bridge().setSmsTrackingEnabled(boolVal);
  }
  localStorage.setItem(SMS_OPT_OUT_KEY, boolVal ? '1' : '0');
  return boolVal;
}

/**
 * Bank alerts the shell caught while the app was closed.
 *
 * The receiver that catches them has no WebView to classify them in, so it writes them
 * down and the app picks them up here. Reading the queue empties it, so nothing is
 * classified twice.
 */
export function takePendingAlerts() {
  if (!isSmsTrackingEnabled()) return [];
  if (!isAndroid() || !bridge().takePendingAlerts) return [];
  try {
    return JSON.parse(bridge().takePendingAlerts() || '[]');
  } catch {
    return [];
  }
}

/**
 * The bank alerts already sitting in the inbox.
 *
 * For somebody who turns the feature on after the fact: without this they would only ever
 * see what arrives from now on, and the months already recorded on their phone would be
 * invisible. Messages are filtered to the ones that look financial before they are read,
 * so an ordinary conversation never crosses over.
 */
export function readSmsInbox(days = 0) {
  if (!isAndroid() || !bridge().readSmsInbox) return [];
  try {
    const d = days === 'all' || !days || Number(days) <= 0 ? 0 : Number(days);
    return JSON.parse(bridge().readSmsInbox(d) || '[]');
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------------- files */

/**
 * Saves a file directly to the user's Downloads directory.
 *
 * Inside Android this calls through the native bridge to MediaStore.Downloads.
 * In a desktop browser this falls back to an ordinary download anchor.
 */
export function saveFile(name, mimeType, base64) {
  if (isAndroid() && bridge()?.saveFile) {
    const raw = bridge().saveFile(name, mimeType, base64);
    try {
      return JSON.parse(raw);
    } catch {
      return { success: Boolean(raw), filename: name, path: `Downloads/${name}` };
    }
  }
  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
    const blob = new Blob([decodeBase64(base64)], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { success: true, filename: name, path: name };
}

/**
 * Hands a file to the platform's share sheet, for the encrypted export.
 *
 * In a browser this falls back to an ordinary download, so the backup screen works the
 * same way in the preview.
 */
export function shareFile(name, mimeType, base64) {
  if (isAndroid() && bridge()?.shareFile) {
    return bridge().shareFile(name, mimeType, base64);
  }
  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
    const blob = new Blob([decodeBase64(base64)], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return true;
}

/* --------------------------------------------------------------------- base64 */

/**
 * Byte-exact base64, both ways.
 *
 * `btoa` works on a string of code points below 256, so the bytes are widened one by one
 * rather than through a text decoder, which would mangle anything that is not valid text.
 * The chunking keeps the argument list within what `String.fromCharCode` accepts.
 */
export function encodeBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 0x8000;
  const parts = [];
  for (let i = 0; i < view.length; i += chunkSize) {
    parts.push(String.fromCharCode.apply(null, view.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(''));
}

export function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Opens an email composer to the specified address. */
export function openEmail(email, subject = '', body = '') {
  if (isAndroid() && bridge().openEmail) {
    return bridge().openEmail(email, subject, body);
  }
  const url = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (typeof window !== 'undefined') {
    window.location.href = url;
  }
  return true;
}

/** Opens an external web URL in the system browser. */
export function openUrl(url) {
  if (isAndroid() && bridge().openUrl) {
    return bridge().openUrl(url);
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
  return false;
}

/** Reports whether the environment is a debug build / developer testing session. */
export function isDebug() {
  if (isAndroid() && typeof bridge()?.isDebug === 'function') {
    return Boolean(bridge().isDebug());
  }
  // In development environments / Node.js test runs / local browsers:
  if (typeof window === 'undefined' || !window.location) return true;
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}
