import { Bridge } from '../bridge.js';
import {
  icon, h, toast, sheet, confirmDialog, promptDialog, selectField, bindSelectFields,
} from '../ui.js';

function permissionRow(key, glyph, title, body, granted, extraAction = null) {
  const blocked = !granted && Bridge.permissionIsBlocked(key);

  return `
    <div class="list-row" style="padding-left:0;padding-right:0;align-items:flex-start">
      <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface-variant)">
        ${icon(glyph)}
      </span>
      <span class="list-row-main">
        <span class="list-row-title">${h(title)}</span>
        <span class="caption">${h(body)}</span>
        ${blocked ? '<span class="caption" style="color:var(--warning)">Blocked, change it in system settings</span>' : ''}
      </span>
      ${extraAction || (granted
    ? `<span class="badge badge-income">${icon('check', 'icon-sm')}On</span>`
    : `<button class="btn btn-sm btn-tonal" data-permission="${key}">${blocked ? 'Settings' : 'Allow'}</button>`)}
    </div>`;
}

const TIMEOUT_OPTIONS = [
  { value: '0', label: 'Immediately' },
  { value: '30000', label: 'After 30 seconds' },
  { value: '60000', label: 'After 1 minute' },
  { value: '120000', label: 'After 2 minutes (Default)' },
  { value: '300000', label: 'After 5 minutes' },
  { value: '900000', label: 'After 15 minutes' },
  { value: '-1', label: 'Never during session' },
];

export async function renderSecurity(container, app) {
  const pinSet = app.settings.pin_is_set === '1';
  const biometrics = Bridge.isBiometricAvailable();
  const bioEnabled = localStorage.getItem('biometric_enabled') === '1' && Boolean(localStorage.getItem('bio_vault_pin'));
  const currentTimeout = localStorage.getItem('app_lock_timeout_ms') || app.settings?.app_lock_timeout_ms || '120000';
  const smsGranted = Bridge.checkPermission('SMS');
  const smsTrackingActive = smsGranted && Bridge.isSmsTrackingEnabled();
  const notificationsGranted = Bridge.checkPermission('NOTIFICATIONS');

  const smsActionHtml = smsGranted
    ? `<button class="btn btn-sm ${smsTrackingActive ? 'btn-filled' : 'btn-outlined'}" data-toggle-sms-sec>${smsTrackingActive ? `${icon('check', 'icon-sm')}Active` : 'Paused'}</button>`
    : null;

  container.innerHTML = `
    <div class="card">
      <div class="card-title">Unlock PIN</div>
      <p class="caption" style="margin-bottom:16px">
        Your financial data is encrypted on-device with this PIN.
      </p>
      <button class="btn ${pinSet ? 'btn-outlined' : 'btn-filled'} btn-block" data-pin>
        ${icon(pinSet ? 'key' : 'lock')}${pinSet ? 'Change PIN' : 'Set a PIN'}
      </button>
    </div>

    ${biometrics ? `
      <div class="card">
        <div class="row-between">
          <div style="flex:1;padding-right:12px">
            <div class="card-title" style="margin-bottom:2px">Fingerprint / Biometrics</div>
            <p class="caption" style="margin-bottom:0">
              Unlock instantly with your fingerprint without typing your PIN every time.
            </p>
          </div>
          <button class="btn btn-sm ${bioEnabled ? 'btn-filled' : 'btn-tonal'}" data-toggle-bio>
            ${bioEnabled ? `${icon('fingerprint', 'icon-sm')}Enabled` : 'Enable'}
          </button>
        </div>
      </div>` : `
      <div class="card">
        <div class="card-title">Biometrics</div>
        <p class="caption">Biometrics are not supported on this device.</p>
      </div>`}

    <div class="card">
      <div class="card-title">Auto-Lock on App Switch</div>
      <p class="caption" style="margin-bottom:12px">
        Choose how long before the app locks when switching to another app.
      </p>
      ${selectField({
    id: 'autoLockTimeout',
    name: 'auto_lock_timeout',
    label: 'Auto-Lock Grace Period',
    value: currentTimeout,
    options: TIMEOUT_OPTIONS,
  })}
    </div>

    <div class="card">
      <div class="card-title">Permissions & Privacy</div>

      ${permissionRow('SMS', 'sms', 'Bank SMS Tracking',
    smsTrackingActive ? 'Auto-parsing transactions from bank alerts' : (smsGranted ? 'Tracking is paused (messages ignored)' : 'Auto-parse transactions from bank alerts'),
    smsGranted, smsActionHtml)}
      ${!smsTrackingActive ? `
        <div class="caption" style="margin-top:4px;margin-bottom:8px;color:var(--on-surface-variant)">
          ${icon('schedule', 'icon-sm')} Evening spend review reminder is set for ${app.settings.daily_review_reminder_time || '21:00'}.
        </div>` : ''}
      ${permissionRow('NOTIFICATIONS', 'notifications', 'Notifications',
    'Reminders for SIPs, EMIs and renewals', notificationsGranted)}

      ${smsGranted ? `
        <button class="btn btn-tonal btn-block" data-rules style="margin-top:12px">
          ${icon('rule')}SMS rules & history
        </button>` : ''}
    </div>

    <div class="card-danger">
      <div class="card-title" style="color:var(--expense)">Erase everything</div>
      <p class="caption" style="margin-bottom:16px">
        Permanently deletes all data and settings on this device.
      </p>
      <button class="btn btn-danger btn-block" data-reset>${icon('delete')}Erase all data</button>
    </div>`;

  container.querySelector('[data-pin]').addEventListener('click', () => changePin(app, pinSet));

  const toggleBio = container.querySelector('[data-toggle-bio]');
  if (toggleBio) {
    toggleBio.addEventListener('click', async () => {
      if (bioEnabled) {
        localStorage.removeItem('biometric_enabled');
        localStorage.removeItem('bio_vault_pin');
        toast('Fingerprint unlock disabled');
        app.refresh();
      } else {
        const body = `
          <div class="field">
            <label class="field-label" for="bioPin">Enter your 4-digit PIN to enable fingerprint</label>
            <input class="input numeric" id="bioPin" type="password" inputmode="numeric" maxlength="8" placeholder="••••" autofocus>
          </div>`;
        await sheet('Enable Fingerprint', body, {
          actions: `
            <button class="btn btn-outlined" data-cancel>Cancel</button>
            <button class="btn btn-filled" data-confirm>Continue</button>`,
          onMount(node, close) {
            node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
            node.querySelector('[data-confirm]').addEventListener('click', async () => {
              const pin = node.querySelector('#bioPin').value;
              if (!pin) return;
              const res = await Bridge.db('verify_pin', { pin });
              if (res && res.status === 'success') {
                close(null);
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
                app.refresh();
              } else {
                toast('Invalid PIN. Please try again.');
              }
            });
          },
        });
      }
    });
  }

  bindSelectFields(container, (field, value) => {
    if (field.dataset.name === 'auto_lock_timeout') {
      localStorage.setItem('app_lock_timeout_ms', value);
      app.settings.app_lock_timeout_ms = value;
      app.db('update_setting', { key: 'app_lock_timeout_ms', value });
      toast('Auto-lock timeout updated');
    }
  });

  container.querySelectorAll('[data-permission]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.permission;

      // Asking again does nothing once "don't ask again" is ticked, so send them to the
      // one place that can still change it.
      if (Bridge.permissionIsBlocked(name)) {
        Bridge.openAppSettings();
        return;
      }

      btn.disabled = true;
      await Bridge.requestPermission(name);
      Bridge.call('reminders', { action: 'sync' }).catch(() => {});
      app.refresh();
    });
  });

  const toggleSmsSec = container.querySelector('[data-toggle-sms-sec]');
  if (toggleSmsSec) {
    toggleSmsSec.addEventListener('click', () => {
      const newState = !smsTrackingActive;
      Bridge.setSmsTrackingEnabled(newState);
      Bridge.call('reminders', { action: 'sync' }).catch(() => {});
      toast(newState ? 'Bank SMS tracking enabled' : 'Bank SMS tracking paused');
      app.refresh();
    });
  }

  const rulesButton = container.querySelector('[data-rules]');
  if (rulesButton) rulesButton.addEventListener('click', () => app.open('rules'));

  container.querySelector('[data-reset]').addEventListener('click', async () => {
    const confirmed = await confirmDialog('Erase everything?',
      'Every record on this device is deleted. This cannot be undone.',
      { confirmLabel: 'Erase', danger: true });
    if (!confirmed) return;

    const typed = await promptDialog('Type ERASE to confirm', {
      placeholder: 'ERASE', confirmLabel: 'Erase everything',
    });
    if (typed !== 'ERASE') {
      if (typed !== null) toast('That did not match. Nothing was erased.');
      return;
    }

    const res = await app.db('factory_reset');
    if (res) {
      localStorage.clear();
      window.location.reload();
    }
  });
}

async function changePin(app, pinSet) {
  const body = `
    ${pinSet ? `
    <div class="field">
      <label class="field-label" for="currentPin">Current PIN</label>
      <input class="input numeric" id="currentPin" data-current type="password"
             inputmode="numeric" maxlength="8" placeholder="••••">
    </div>` : ''}
    <div class="field">
      <label class="field-label" for="newPin">New PIN</label>
      <input class="input numeric" id="newPin" data-new type="password"
             inputmode="numeric" maxlength="8" placeholder="At least 4 digits">
    </div>
    <div class="field">
      <label class="field-label" for="confirmPin">Confirm new PIN</label>
      <input class="input numeric" id="confirmPin" data-confirm type="password"
             inputmode="numeric" maxlength="8" placeholder="Type it again">
    </div>`;

  const saved = await sheet(pinSet ? 'Change PIN' : 'Set a PIN', body, {
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>Save</button>`,
    onMount(node, close) {
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      node.querySelector('[data-save]').addEventListener('click', async () => {
        const next = node.querySelector('[data-new]').value;
        const confirm = node.querySelector('[data-confirm]').value;

        if (next !== confirm) {
          toast('The two PINs do not match.', 'error');
          return;
        }

        const res = await app.db('set_pin', {
          new_pin: next,
          current_pin: node.querySelector('[data-current]')?.value || '',
        });
        if (res) {
          app.settings.pin_is_set = '1';
          if (localStorage.getItem('biometric_enabled') === '1' || localStorage.getItem('bio_vault_pin')) {
            localStorage.setItem('bio_vault_pin', next);
          }
          toast('PIN saved.', 'success');
          close(true);
        }
      });
    },
  });

  if (saved) app.refresh();
}
