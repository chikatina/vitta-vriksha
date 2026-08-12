/* PIN, biometrics and the two optional Android permissions. */

import { Bridge } from '../bridge.js';
import { icon, h, toast, sheet, confirmDialog, promptDialog } from '../ui.js';

function permissionRow(key, glyph, title, body, granted) {
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
      ${granted
        ? `<span class="badge badge-income">${icon('check', 'icon-sm')}On</span>`
        : `<button class="btn btn-sm btn-tonal" data-permission="${key}">${blocked ? 'Settings' : 'Allow'}</button>`}
    </div>`;
}

export async function renderSecurity(container, app) {
  const pinSet = app.settings.pin_is_set === '1';
  const biometrics = Bridge.isBiometricAvailable();
  const smsGranted = Bridge.checkPermission('SMS');
  const notificationsGranted = Bridge.checkPermission('NOTIFICATIONS');

  container.innerHTML = `
    <div class="card">
      <div class="card-title">Unlock PIN</div>
      <p class="caption" style="margin-bottom:16px">
        Stored as a salted hash on-device.
      </p>
      <button class="btn ${pinSet ? 'btn-outlined' : 'btn-filled'} btn-block" data-pin>
        ${icon(pinSet ? 'key' : 'lock')}${pinSet ? 'Change PIN' : 'Set a PIN'}
      </button>
    </div>

    <div class="card">
      <div class="card-title">Biometrics</div>
      <p class="caption">
        Device encryption requires PIN entry. Biometric unlock is currently disabled.
      </p>
    </div>

    <div class="card">
      <div class="card-title">Permissions</div>

      ${permissionRow('SMS', 'sms', 'Bank SMS',
        'Auto-parse transactions from bank alerts', smsGranted)}
      ${permissionRow('NOTIFICATIONS', 'notifications', 'Notifications',
        'Reminders for SIPs, EMIs and renewals', notificationsGranted)}

      ${smsGranted ? `
        <button class="btn btn-tonal btn-block" data-rules style="margin-top:12px">
          ${icon('rule')}SMS rules
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
      app.refresh();
    });
  });

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
          toast('PIN saved.', 'success');
          close(true);
        }
      });
    },
  });

  if (saved) app.refresh();
}
