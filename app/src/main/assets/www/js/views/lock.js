/* First run setup and the PIN lock screen. */

import { Bridge } from '../bridge.js';
import { confirmDialog, icon, h, toast, sheet } from '../ui.js';
import { brandMark } from '../brand-mark.js';

const PIN_LENGTH = 4;

function overlay(html) {
  document.querySelectorAll('.overlay-screen').forEach((node) => node.remove());
  const node = document.createElement('div');
  node.className = 'overlay-screen';
  node.innerHTML = html;
  document.body.appendChild(node);
  return node;
}

/*
 * Ten digits, a blank, and a delete.
 *
 * The blank is where a fingerprint key used to be. It is not there because a fingerprint
 * answers yes or no, and what this screen needs is the key the records are encrypted with.
 * See `renderLock`.
 */
function keypad(hasBiometrics = false) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', hasBiometrics ? 'bio' : '', '0', 'del'];
  return `<div class="keypad">${keys.map((key) => {
    if (!key) return '<span class="key key-blank"></span>';
    if (key === 'bio') return `<button class="key key-bio" data-key="bio" aria-label="Fingerprint unlock">${icon('fingerprint')}</button>`;
    if (key === 'del') return `<button class="key" data-key="del" aria-label="Delete">${icon('backspace')}</button>`;
    return `<button class="key" data-key="${key}">${key}</button>`;
  }).join('')}</div>`;
}

function dots(filled) {
  return Array.from({ length: PIN_LENGTH }, (_, i) =>
    `<span class="pin-dot ${i < filled ? 'filled' : ''}"></span>`).join('');
}

/**
 * Drives a keypad. onComplete receives the entered PIN and returns true to accept it,
 * false to shake and clear, or a string to shake with that message.
 */
function wireKeypad(node, { onComplete, onBioTap }) {
  let buffer = '';
  const dotHost = node.querySelector('.pin-dots');
  const errorHost = node.querySelector('[data-error]');

  const paint = () => { dotHost.innerHTML = dots(buffer.length); };

  const reject = (message) => {
    errorHost.textContent = message;
    dotHost.classList.add('shake');
    setTimeout(() => {
      dotHost.classList.remove('shake');
      buffer = '';
      paint();
    }, 420);
  };

  node.querySelectorAll('[data-key]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;

      if (key === 'bio') {
        if (onBioTap) onBioTap();
        return;
      }

      if (key === 'del') {
        buffer = buffer.slice(0, -1);
        errorHost.textContent = '';
        paint();
        return;
      }
      if (buffer.length >= PIN_LENGTH) return;

      buffer += key;
      paint();

      if (buffer.length === PIN_LENGTH) {
        const accepted = await onComplete(buffer);
        if (accepted === false) reject('That PIN did not match.');
        else if (typeof accepted === 'string') reject(accepted);
      }
    });
  });

  paint();
}

/* ------------------------------------------------------------------- lock */

export function renderLock(app) {
  // Ensure all tour elements, scrims and spotlights are completely destroyed upon entering lock screen
  if (typeof document !== 'undefined' && document.querySelectorAll) {
    document.querySelectorAll('.app-tour-scrim, .app-tour-container, .app-tour-spotlight').forEach((el) => el.remove());
    document.body?.classList?.remove('tour-active');
  }

  const bioAvailable = Bridge.isBiometricAvailable();
  const bioEnabled = bioAvailable && (localStorage.getItem('biometric_enabled') === '1' || Boolean(localStorage.getItem('bio_vault_pin')));

  const node = overlay(`
    <div class="lock-body">
      <div class="lock-mark">${brandMark()}</div>
      <div class="lock-title">
        <div class="headline">Vitta Vriksha</div>
        <div class="caption">${bioEnabled ? 'Confirm fingerprint or enter PIN' : 'Enter your PIN to continue'}</div>
      </div>
      <div class="pin-dots">${dots(0)}</div>
      <div class="caption lock-error" data-error></div>
    </div>
    ${keypad(bioEnabled)}
    <div class="lock-footer">
      <button class="btn btn-text" data-forgot>Forgot your PIN?</button>
    </div>`);

  let isPrompting = false;
  let isUnlocking = false;
  let lastPromptTime = 0;

  const cleanupListeners = () => {
    if (typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('visibilitychange', onFocusOrVisible);
    }
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('focus', onFocusOrVisible);
    }
  };

  const triggerBiometrics = (manual = false) => {
    if (!bioEnabled || isUnlocking) return;
    if (isPrompting && !manual) return;
    const now = Date.now();
    if (!manual && now - lastPromptTime < 1200) return;

    isPrompting = true;
    lastPromptTime = now;

    window.onBiometricAuthResult = async (success, message) => {
      isPrompting = false;
      if (!node.isConnected) return;

      if (success) {
        isUnlocking = true;
        cleanupListeners();

        const storedPin = localStorage.getItem('bio_vault_pin');
        if (storedPin) {
          try {
            const res = await Bridge.db('unlock_vault', { pin: storedPin });
            if (res && res.status === 'success') {
              await app.resume();
              document.querySelectorAll('.overlay-screen').forEach((el) => el.remove());
              return;
            } else {
              isUnlocking = false;
              const errorHost = node.querySelector('[data-error]');
              if (errorHost) {
                if (res?.locked_for_ms) {
                  errorHost.textContent = `${res.message} ${res.hint || ''}`.trim();
                } else {
                  errorHost.textContent = 'Biometric credentials out of sync. Please enter your PIN.';
                }
              }
              const dotHost = node.querySelector('.pin-dots');
              if (dotHost) {
                dotHost.classList.add('shake');
                setTimeout(() => dotHost.classList.remove('shake'), 420);
              }
              return;
            }
          } catch (err) {
            console.error('Error during biometric unlock_vault:', err);
            isUnlocking = false;
            const errorHost = node.querySelector('[data-error]');
            if (errorHost) errorHost.textContent = 'Unlock error. Please enter your PIN.';
            return;
          }
        } else {
          isUnlocking = false;
          const errorHost = node.querySelector('[data-error]');
          if (errorHost) {
            errorHost.textContent = 'Biometric PIN missing. Please enter your PIN.';
          }
          const dotHost = node.querySelector('.pin-dots');
          if (dotHost) {
            dotHost.classList.add('shake');
            setTimeout(() => dotHost.classList.remove('shake'), 420);
          }
          return;
        }
      }

      const errorHost = node.querySelector('[data-error]');
      if (errorHost) {
        if (message && typeof message === 'string' && message !== 'CANCELED' && !message.toLowerCase().includes('cancel')) {
          errorHost.textContent = message;
        } else {
          errorHost.textContent = '';
        }
      }
    };

    Bridge.triggerBiometricAuth();
  };

  // Automatically trigger biometrics whenever app regains focus or visibility while locked
  const onFocusOrVisible = () => {
    if (node.isConnected && bioEnabled && !isUnlocking && !isPrompting && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
      const now = Date.now();
      if (now - lastPromptTime > 1500) {
        setTimeout(() => {
          if (node.isConnected && !isUnlocking && !isPrompting) triggerBiometrics(false);
        }, 200);
      }
    }
  };

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', onFocusOrVisible);
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('focus', onFocusOrVisible);
  }

  wireKeypad(node, {
    async onComplete(pin) {
      isUnlocking = true;
      const res = await Bridge.db('unlock_vault', { pin });
      if (res && res.status === 'success') {
        if (localStorage.getItem('biometric_enabled') === '1' || Boolean(localStorage.getItem('bio_vault_pin'))) {
          localStorage.setItem('bio_vault_pin', pin);
        }
        cleanupListeners();
        await app.resume();
        document.querySelectorAll('.overlay-screen').forEach((el) => el.remove());
        return true;
      }

      isUnlocking = false;
      if (res && res.locked_for_ms) return `${res.message} ${res.hint || ''}`.trim();
      const left = res?.failed_attempts ? ` (${res.failed_attempts} wrong so far)` : '';
      return `That is not your PIN.${left}`;
    },
    onBioTap() {
      isPrompting = false;
      const errorHost = node.querySelector('[data-error]');
      if (errorHost) errorHost.textContent = '';
      triggerBiometrics(true);
    },
  });

  // Always automatically open biometric check on lock screen when enabled
  if (bioEnabled) {
    setTimeout(() => {
      if (node.isConnected && !isUnlocking) triggerBiometrics(false);
    }, 280);
  }

  node.querySelector('[data-forgot]').addEventListener('click', () => forgetPin(app));
  return node;
}

/**
 * What happens when the PIN is genuinely gone.
 *
 * There is nothing to recover. The key exists in exactly one place, wrapped in the PIN,
 * and no part of this app can open it without one. So the only honest offer is to start
 * again, and the only thing worth doing well is making sure nobody does it by accident:
 * the wording says what goes, what stays, and asks twice.
 */
async function forgetPin(app) {
  const warned = await confirmDialog(
    'Start again?',
    'Your PIN is what your records are encrypted with. Without it they cannot be read, '
    + 'by this app or by anything else, and there is no way to recover them.\n\n'
    + 'Starting again deletes every account, transaction and holding on this device. '
    + 'Your rules, categories and learned merchants are kept, so the app does not have to '
    + 'be taught them a second time.',
    { confirmLabel: 'Continue', danger: true },
  );
  if (!warned) return;

  const sure = await confirmDialog(
    'This cannot be undone',
    'Delete everything recorded on this device and set a new PIN?',
    { confirmLabel: 'Delete everything', danger: true },
  );
  if (!sure) return;

  const res = await Bridge.db('factory_reset');
  if (res.status !== 'success') {
    toast(res.message || 'That did not work.', 'error');
    return;
  }
  await app.restart();
}

/**
 * When the app cannot even ask whether it is locked.
 *
 * Reached only if the one action that works while locked fails, which means something is
 * wrong with the WebView's storage rather than with anything the user did. Showing the
 * home screen at that point would show a screen with no data on it and no explanation, so
 * this says what happened and offers the only two things that can help: try again, or
 * start over.
 */
export function renderStartupFailure(app, res) {
  const node = overlay(`
    <div class="lock-body">
      <div class="lock-mark">${brandMark()}</div>
      <div class="lock-title">
        <div class="headline">Something is wrong with the app's storage</div>
        <p class="body muted">
          Vitta Vriksha could not check whether your records are locked, so it has not
          opened them. Nothing has been changed or deleted.
        </p>
        <p class="caption">${h(res && res.code ? `${res.code}: ${res.message || ''}` : 'No reply from storage.')}</p>
      </div>
    </div>
    <div class="lock-footer">
      <button class="btn btn-filled" data-retry>Try again</button>
    </div>`);

  node.querySelector('[data-retry]').addEventListener('click', () => window.location.reload());
}

/* ------------------------------------------------------------------ setup */

const STEP_COUNT = 4;

export function renderSetup(app) {
  let step = 1;
  let chosenPin = '';

  const shell = (index, body, footer) => `
    <div class="setup">
      <div class="setup-top">
        ${index > 1
          ? `<button class="icon-button" data-back aria-label="Go back a step">${icon('arrow_back')}</button>`
          : '<span class="setup-top-spacer"></span>'}
        <div class="setup-steps">
          ${Array.from({ length: STEP_COUNT }, (_, i) =>
            `<span class="setup-step-dot ${i < index ? 'active' : ''}"></span>`).join('')}
        </div>
        <span class="setup-top-spacer"></span>
      </div>
      <div class="setup-content">${body}</div>
      <div class="setup-footer">${footer}</div>
    </div>`;

  const hero = (glyph, title, blurb) => `
    <div class="setup-hero">${glyph === 'brand' ? brandMark() : icon(glyph)}</div>
    <h1 class="headline">${h(title)}</h1>
    <p class="body muted" style="max-width:34ch">${blurb}</p>`;

  /*
   * Going back a step.
   *
   * Setup used to be one way, so the device's back gesture found nothing to pop and left
   * the app instead. Each step now pushes a history entry, which is what the gesture and
   * the button below both act on, so the two can never disagree about which step you are
   * on. Nothing before this point is written to the database, so stepping back only has
   * to undo what is held here.
   */
  const onPop = () => {
    if (step <= 1) return;
    step -= 1;
    chosenPin = '';
    paint();
  };
  window.addEventListener('popstate', onPop);

  const next = () => {
    step += 1;
    if (step > STEP_COUNT) {
      finish();
      return;
    }
    history.pushState({ setup: step }, '');
    paint();
  };

  const finish = async () => {
    window.removeEventListener('popstate', onPop);
    window.onAppResumed = null;
    await Bridge.db('update_setting', { key: 'setup_complete', value: '1' });
    // Through `resume` rather than straight to `unlock`, so the currency, the locale and
    // the theme are read the same way they are on every later start.
    await app.resume();

    const smsGranted = Bridge.checkPermission('SMS');
    if (smsGranted) {
      app.open('sms_ingest', { initialSetup: true });
    } else {
      app.open('home');
    }
  };

  const STEPS = {
    /* ------------------------------------------------------------ welcome */
    1() {
      const node = overlay(shell(1, hero('brand', 'Vitta Vriksha',
        'Track what you own, what you owe, and where the money actually goes.'), `
        <button class="btn btn-filled btn-block" data-next>Get started</button>`));

      node.querySelector('.setup-content').insertAdjacentHTML('beforeend', `
        <div class="card" style="width:100%;text-align:left;margin-top:8px">
          ${[
            ['cloud_off', 'Nothing leaves this device',
             'The app has no internet permission, so it cannot send your records anywhere.'],
            ['lock', 'Locked behind a PIN', 'Or your fingerprint, if the device has one.'],
            ['backup', 'Yours to export', 'One encrypted file, whenever you want it.'],
          ].map(([glyph, title, body]) => `
            <div class="row" style="align-items:flex-start;gap:12px;margin-bottom:14px">
              <span class="avatar avatar-sm" style="background:var(--accent-container);color:var(--on-accent-container)">
                ${icon(glyph)}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">${h(title)}</span>
                <span class="caption">${h(body)}</span>
              </span>
            </div>`).join('')}
        </div>`);

      node.querySelector('[data-next]').addEventListener('click', next);
    },

    /* ---------------------------------------------------------------- pin */
    2() {
      const isConfirm = Boolean(chosenPin);
      const node = overlay(shell(2, `
        <div class="setup-hero">${icon('lock')}</div>
        <h1 class="headline">${isConfirm ? 'Enter it once more' : 'Choose a PIN'}</h1>
        <p class="caption" style="max-width:32ch">
          ${isConfirm
    ? 'So we know it was not a slip.'
    : 'Four digits. This is what your records are locked with, so there is no way '
      + 'into them without it and no way to reset it.'}
        </p>
        <div class="pin-dots">${dots(0)}</div>
        <div class="caption" data-error style="color:var(--expense);min-height:18px"></div>
        ${keypad()}`, `
        <p class="caption">
          Write it down somewhere safe. It is not stored anywhere, so nobody can look it up
          for you, and forgetting it means starting again with an empty ledger.
        </p>`));

      wireKeypad(node, {
        async onComplete(pin) {
          if (!chosenPin) {
            chosenPin = pin;
            paint();
            return true;
          }
          if (pin !== chosenPin) {
            chosenPin = '';
            setTimeout(() => { paint(); }, 600);
            return 'PINs did not match. Please choose a PIN again.';
          }

          /*
           * The moment the key is made, and the first moment anything can be written.
           *
           * One call, not two. It makes the key, records the PIN, and saves, so there is
           * no window in which a database exists that no key can seal.
           */
          try {
            const res = await Bridge.db('create_vault', { new_pin: pin });
            if (!res || res.status !== 'success') {
              chosenPin = '';
              setTimeout(() => { paint(); }, 600);
              return (res && res.message) || 'That PIN was not accepted.';
            }
            app.settings.pin_is_set = '1';
            next();
            return true;
          } catch (err) {
            chosenPin = '';
            setTimeout(() => { paint(); }, 600);
            return err?.message || 'Failed to create vault.';
          }
        },
      });

      /*
       * No way past this step.
       *
       * It used to offer "Set one up later", which is the right offer when a PIN only
       * hides the screen. It is the wrong offer once the PIN is what the records are
       * encrypted with: an install that skipped it would have nothing to lock them with,
       * and turning encryption on afterwards would mean a database that was written in
       * the clear and can never honestly be described as having been private.
       */
    },

    /* -------------------------------------------------------- permissions */
    3() {
      const onDevice = Bridge.isAndroid();
      const hasBio = Bridge.isBiometricAvailable();

      const node = overlay(shell(3, `
        <div class="setup-hero" style="width:72px;height:72px;margin-bottom:var(--gap-2)">${icon('bolt')}</div>
        <h1 class="headline" style="margin-bottom:var(--gap-1)">Quick access & permissions</h1>
        <p class="body muted" style="max-width:34ch;font-size:12px;margin-bottom:var(--gap-2)">
          Optional features to automate your ledger and speed up access. You can change any of these later in Security.
        </p>`, `
        <button class="btn btn-filled btn-block" data-next>Continue</button>`));

      node.querySelector('.setup-content').insertAdjacentHTML('beforeend', `
        <div class="card-flat" style="width:100%;padding:var(--gap-2) var(--gap-4);border-radius:var(--radius-lg);margin-top:var(--gap-2);box-sizing:border-box;background:var(--surface-container-high);text-align:left">
          <div class="list" style="width:100%;background:transparent;box-shadow:none" data-permissions></div>
        </div>
        ${onDevice ? '' : `<p class="caption" style="margin-top:6px">Permissions can only be granted on a device.</p>`}`);

      const PERMISSIONS = [
        ...(hasBio ? [{
          key: 'BIOMETRICS',
          glyph: 'fingerprint',
          title: 'Fingerprint unlock',
          body: 'Unlock your records instantly with your biometric scanner.',
        }] : []),
        {
          key: 'SMS',
          glyph: 'sms',
          title: 'Read bank SMS',
          body: 'Turns "Rs 450 debited" into a transaction, without you typing it. '
            + 'Messages are matched on this device and never stored in full.',
        },
        {
          key: 'NOTIFICATIONS',
          glyph: 'notifications',
          title: 'Send reminders',
          body: 'A nudge before a SIP, an EMI or a subscription is due.',
        },
      ];

      const host = node.querySelector('[data-permissions]');

      const paintPermissions = () => {
        host.innerHTML = PERMISSIONS.map((permission) => {
          if (permission.key === 'BIOMETRICS') {
            const bioOn = localStorage.getItem('biometric_enabled') === '1';
            return `
              <div class="list-row" style="align-items:flex-start;padding:12px 0;background:transparent">
                <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface-variant);flex-shrink:0">
                  ${icon(permission.glyph)}
                </span>
                <span class="list-row-main" style="margin-left:8px">
                  <span class="list-row-title" style="font-size:13px">${h(permission.title)}</span>
                  <span class="caption" style="font-size:11.5px;line-height:1.35">${h(permission.body)}</span>
                </span>
                <button class="btn btn-sm ${bioOn ? 'btn-filled' : 'btn-tonal'}" data-toggle-bio style="flex-shrink:0;margin-left:8px">
                  ${bioOn ? `${icon('check', 'icon-sm')}On` : 'Enable'}
                </button>
              </div>`;
          }

          const granted = Bridge.checkPermission(permission.key);
          const blocked = !granted && Bridge.permissionIsBlocked(permission.key);

          return `
            <div class="list-row" style="align-items:flex-start;padding:12px 0;background:transparent">
              <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface-variant);flex-shrink:0">
                ${icon(permission.glyph)}
              </span>
              <span class="list-row-main" style="margin-left:8px">
                <span class="list-row-title" style="font-size:13px">${h(permission.title)}</span>
                <span class="caption" style="font-size:11.5px;line-height:1.35">${h(permission.body)}</span>
              </span>
              ${granted
                ? `<span class="badge badge-income" style="flex-shrink:0;margin-left:8px">${icon('check', 'icon-sm')}On</span>`
                : `<button class="btn btn-sm btn-tonal" data-grant="${permission.key}" style="flex-shrink:0;margin-left:8px"
                            ${onDevice ? '' : 'disabled'}>${blocked ? 'Settings' : 'Allow'}</button>`}
            </div>`;
        }).join('');

        const bioBtn = host.querySelector('[data-toggle-bio]');
        if (bioBtn) {
          bioBtn.addEventListener('click', async () => {
            const current = localStorage.getItem('biometric_enabled') === '1';
            if (current) {
              localStorage.removeItem('biometric_enabled');
              localStorage.removeItem('bio_vault_pin');
              toast('Fingerprint unlock disabled.', 'info');
              paintPermissions();
            } else {
              const pin = chosenPin || localStorage.getItem('bio_vault_pin');
              toast('Scan your fingerprint to verify...', 'info');
              const auth = await Bridge.verifyBiometric();
              if (auth.success) {
                localStorage.setItem('biometric_enabled', '1');
                if (pin) localStorage.setItem('bio_vault_pin', pin);
                toast('Fingerprint unlock verified and enabled!', 'success');
              } else {
                localStorage.removeItem('biometric_enabled');
                localStorage.removeItem('bio_vault_pin');
                if (auth.message && auth.message !== 'CANCELED' && !auth.message.toLowerCase().includes('cancel')) {
                  toast(auth.message, 'error');
                } else {
                  toast('Fingerprint verification cancelled.', 'info');
                }
              }
              paintPermissions();
            }
          });
        }

        host.querySelectorAll('[data-grant]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const key = btn.dataset.grant;
            if (Bridge.permissionIsBlocked(key)) {
              Bridge.openAppSettings();
              return;
            }
            btn.disabled = true;
            await Bridge.requestPermission(key);
            paintPermissions();
          });
        });
      };

      paintPermissions();
      // Coming back from system settings should show the new state.
      window.onAppResumed = paintPermissions;

      node.querySelector('[data-next]').addEventListener('click', () => {
        window.onAppResumed = null;
        next();
      });
    },

    /* ---------------------------------------------------------- household */
    4() {
      const node = overlay(shell(4, hero('group', 'Just you, or the household?',
        'Add profiles for the people whose money you track and see their totals separately '
        + 'or together.'), `
        <button class="btn btn-filled btn-block" data-next>Finish</button>`));

      node.querySelector('.setup-content').insertAdjacentHTML('beforeend', `
        <div class="card" style="width:100%">
          <label class="switch-row" style="padding:0;text-align:left">
            <span class="list-row-main">
              <span class="list-row-title">Track more than one person</span>
              <span class="list-row-sub">You can enable it later</span>
            </span>
            <input type="checkbox" class="switch" data-family>
          </label>
        </div>`);

      node.querySelector('[data-next]').addEventListener('click', async () => {
        const enabled = node.querySelector('[data-family]').checked ? '1' : '0';
        await Bridge.db('update_setting', { key: 'family_features_enabled', value: enabled });
        app.settings.family_features_enabled = enabled;
        next();
      });
    },
  };

  const paint = () => {
    STEPS[step]();
    const backButton = document.querySelector('[data-back]');
    // The button pops history rather than changing the step itself, so the gesture and
    // the button go through the same path and cannot drift apart.
    if (backButton) backButton.addEventListener('click', () => history.back());
  };

  paint();
}

function promptBiometricEnrollment(pin) {
  return sheet('Enable Fingerprint Unlock', `
    <div style="text-align:center;padding:var(--gap-3) 0">
      <div class="setup-hero" style="margin:0 auto var(--gap-3)">${icon('fingerprint')}</div>
      <p class="body" style="margin-bottom:var(--gap-2)">
        Unlock your records instantly with your fingerprint rather than typing your 4-digit PIN every time.
      </p>
      <p class="caption">
        Your PIN remains the master key for vault recovery and database decryption.
      </p>
    </div>`, {
    actions: `
      <button class="btn btn-outlined" data-skip>Maybe later</button>
      <button class="btn btn-filled" data-enable>${icon('check')}Enable fingerprint</button>`,
    onMount(node, close) {
      node.querySelector('[data-skip]').addEventListener('click', () => close(false));
      node.querySelector('[data-enable]').addEventListener('click', async () => {
        close(false);
        toast('Scan your fingerprint to verify...', 'info');
        const auth = await Bridge.verifyBiometric();
        if (auth.success) {
          localStorage.setItem('biometric_enabled', '1');
          localStorage.setItem('bio_vault_pin', pin);
          toast('Fingerprint unlock verified and enabled', 'success');
        } else {
          localStorage.removeItem('biometric_enabled');
          localStorage.removeItem('bio_vault_pin');
          if (auth.message && auth.message !== 'CANCELED' && !auth.message.toLowerCase().includes('cancel')) {
            toast(auth.message, 'error');
          } else {
            toast('Fingerprint verification cancelled.', 'info');
          }
        }
      });
    },
  });
}
