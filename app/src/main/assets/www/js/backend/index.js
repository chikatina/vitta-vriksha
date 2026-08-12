/*
 * The backend's front door.
 *
 * Everything the UI can ask for arrives here as a module name and a plain object, and
 * leaves as a plain object. That was the shape when the work happened in another language
 * behind a bridge, and keeping it means the views did not have to change when the work
 * moved into the same process as they run in.
 *
 * Nothing here throws at the caller. A failure comes back as a reply with a code, because
 * a screen that has to render something is better served by an error it can display than
 * by an exception it has to catch.
 */

import { fail } from './errors.js';
import { handleDbAction } from './database.js';
import { handleFireAction } from './fire.js';
import { handleLoanAction } from './loan.js';
import { handleSmsAction } from './sms.js';
import { handleCasAction } from './cas.js';
import { handleReminderAction } from './reminders.js';
import { isAvailable } from './sqlite.js';

/**
 * The modules, under the names the views already use. The names are the ones the Python
 * layer had; they cost nothing to keep and changing them would have meant touching every
 * screen for no benefit.
 */
const MODULES = {
  database_manager: handleDbAction,
  fire_calculator: handleFireAction,
  loan_optimizer: handleLoanAction,
  sms_rule_engine: handleSmsAction,
  cas_parser_bridge: handleCasAction,
  reminder_engine: handleReminderAction,

  // The plainer names, for anything written from here on.
  database: handleDbAction,
  fire: handleFireAction,
  loan: handleLoanAction,
  sms: handleSmsAction,
  cas: handleCasAction,
  reminders: handleReminderAction,
};

let engineChecked = false;
let engineAvailable = false;

/**
 * Runs one action.
 *
 * The engine check happens once, on the first call, and is a real check rather than a
 * feature-detection guess: if WebAssembly will not start in this WebView then nothing
 * else will work, and saying so plainly beats failing somewhere further in.
 */
export async function invoke(moduleName, args = {}) {
  const handler = MODULES[moduleName];
  if (!handler) return fail('UNKNOWN_ACTION', `Unknown module: ${moduleName}`);

  if (!engineChecked) {
    engineAvailable = await isAvailable();
    engineChecked = true;
  }
  if (!engineAvailable) {
    return fail('DATABASE_UNAVAILABLE',
      'This app needs a newer WebView than the one on this device.',
      'Update Android System WebView, or Chrome, from the Play Store and reopen the app.');
  }

  try {
    return await handler(args);
  } catch (error) {
    return fail('INTERNAL', `${error.name}: ${error.message}`);
  }
}

/** Shorthand for the database module, which handles most actions. */
export function db(action, args = {}) {
  return invoke('database_manager', { action, ...args });
}

export { ERROR_CODES } from './errors.js';
