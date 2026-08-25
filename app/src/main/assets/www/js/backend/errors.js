/*
 * Stable error codes for everything the UI can be told went wrong.
 *
 * A message is written for a person and may be reworded at any time. A code is written
 * for the app and for a bug report, and does not change. Every error reply carries both,
 * plus an optional hint saying what to do about it:
 *
 *     {"status": "error", "code": "CAS_UNREADABLE_LAYOUT",
 *      "message": "...", "hint": "..."}
 *
 * Add a code here before using it. The registry is what the tests check against, so a
 * typo at a call site fails the suite rather than reaching a user as a blank code.
 */

/** Grouped by the area a failure comes from. */
export const ERROR_CODES = {
  // Generic
  UNKNOWN_ACTION: 'The UI asked for an action the backend does not have.',
  BAD_REQUEST: 'The arguments were missing or the wrong shape.',
  INTERNAL: 'An unexpected exception escaped a handler.',
  DATABASE_UNAVAILABLE: 'The database engine could not start in this WebView.',

  // PIN and settings
  PIN_TOO_SHORT: 'A PIN must be at least four digits.',
  PIN_NOT_NUMERIC: 'A PIN must be digits only.',
  PIN_WRONG: 'The current PIN did not match.',
  PIN_REQUIRED: 'The PIN is what the records are locked with and cannot be removed.',
  LOCKED: 'The app is locked, so the records cannot be read.',
  SETTING_PRIVATE: 'That setting cannot be written from the UI.',

  // Records
  RECORD_TYPE_UNKNOWN: 'No such record type.',
  RECORD_NOT_FOUND: 'The requested record was not found.',
  CARD_NOT_FOUND: 'The specified credit card could not be found.',
  ACCOUNT_NOT_FOUND: 'The specified bank account could not be found.',
  RECORD_EMPTY: 'Nothing in the payload maps to a writable column.',
  AMOUNT_INVALID: 'An amount was zero, negative or not a number.',
  NAME_REQUIRED: 'A name or title was blank.',
  CATEGORY_DUPLICATE: 'A category with that name already exists.',
  MEMBER_PRIMARY: 'The primary household profile cannot be removed.',
  METRIC_UNKNOWN: 'No such chart metric.',
  GRANULARITY_UNKNOWN: 'A chart was asked for buckets that are not days, weeks or months.',
  DIMENSION_UNKNOWN: 'No such breakdown dimension.',
  RANGE_INVALID: 'The date range was missing, backwards or unreadable.',
  MERCHANT_UNKNOWN: 'The message names no counterparty to learn a rule from.',
  MERCHANT_CATEGORY_REQUIRED: 'A category is needed to teach the app anything.',

  // Backup
  BACKUP_PASSWORD_WEAK: 'The export password was shorter than eight characters.',
  BACKUP_PASSWORD_MISSING: 'No password was supplied.',
  BACKUP_DECRYPT_FAILED: 'The backup could not be decrypted, usually a wrong password.',
  BACKUP_MALFORMED: 'The file decrypted but is not a Vitta Vriksha backup.',
  BACKUP_EMPTY: 'The backup held no records for any known table.',
  BACKUP_VERSION_NEWER: 'The backup was created with a newer version of the app than the one running.',

  // Statement import
  CAS_NO_FILE: 'No file reached the parser.',
  CAS_DECODE_FAILED: 'The file could not be base64 decoded.',
  CAS_NOT_PDF: 'The file is not a PDF.',
  CAS_WRONG_PASSWORD: 'The PDF password was rejected.',
  CAS_ENCRYPTED: 'The PDF needs a password that was not supplied.',
  CAS_FILE_UNREADABLE: 'The PDF is damaged or not a real PDF.',
  CAS_NO_TEXT_LAYER: 'The PDF has no extractable text, so it is a scan or an image.',
  CAS_UNKNOWN_TYPE: 'The PDF is not a statement this parser recognises.',
  CAS_UNREADABLE_LAYOUT: 'The PDF opened but the statement was not laid out as expected.',
  CAS_HEADER_UNREADABLE: 'The statement header could not be read.',
  CAS_SUMMARY_ONLY: 'A summary statement was supplied where a detailed one is needed.',
  CAS_NO_HOLDINGS: 'The statement parsed but contained no holdings.',

  // Tradebook CSV import
  CSV_EMPTY: 'The CSV file contains no transaction rows.',
  CSV_UNKNOWN_HEADER: 'Could not identify tradebook headers in the CSV file.',
  CSV_MISSING_COLUMNS: 'CSV is missing essential trade columns.',
};

/** Builds an error reply. An unregistered code is surfaced rather than hidden. */
export function fail(code, message, hint = null, extra = {}) {
  let resolved = code;
  let text = message;
  if (!Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) {
    // Better a loud wrong code than a silent blank one.
    resolved = 'INTERNAL';
    text = `${message} (unregistered error code)`;
  }

  const reply = { status: 'error', code: resolved, message: text };
  if (hint) reply.hint = hint;
  return { ...reply, ...extra };
}

/** True when a reply is one of the above. */
export function isError(reply) {
  return Boolean(reply) && reply.status === 'error';
}
