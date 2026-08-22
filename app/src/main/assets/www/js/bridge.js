/*
 * The one seam between the screens and everything behind them.
 *
 * It used to be a bridge in the real sense: calls crossed into Kotlin and then into an
 * embedded Python runtime, and a hand-written mock stood in for all of it when the UI was
 * opened in a desktop browser. Now the backend is JavaScript in this same process, so
 * there is nothing to cross and nothing to mock. What remains is a thin routing layer and
 * the handful of calls that genuinely need the platform.
 *
 * Keeping the shape means every screen was left alone: `Bridge.db(action, args)` still
 * takes what it took and returns what it returned.
 */

import { db, invoke } from './backend/index.js';
import {
  checkPermission, isAndroid, isBiometricAvailable, openAppSettings, permissionIsBlocked,
  requestPermission, saveFile, shareFile, triggerBiometricAuth, verifyBiometric, openEmail, isSmsTrackingEnabled, setSmsTrackingEnabled,
  isDebug,
} from './backend/native.js';

export const Bridge = {
  /** Whether the Android shell is present. Screens use this to hide what it provides. */
  isAndroid,

  /** Whether the app is running in a debug / developer testing environment. */
  isDebug,

  /** Runs an action against one of the backend modules. */
  call(moduleName, args = {}) {
    return invoke(moduleName, args);
  },

  /** Shorthand for the database module, which handles most actions. */
  db,

  triggerBiometricAuth,
  verifyBiometric,
  isBiometricAvailable,
  checkPermission,
  permissionIsBlocked,
  openAppSettings,
  requestPermission,
  saveFile,
  shareFile,
  openEmail,
  isSmsTrackingEnabled,
  setSmsTrackingEnabled,
};

export default Bridge;
