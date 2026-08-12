/* Encrypted export and restore. */

import { icon, h, toast, sheet, confirmDialog, pickFile, saveFile } from '../ui.js';
import { todayISO } from '../formatters.js';

export async function renderBackup(container, app) {
  container.innerHTML = `
    <div class="card">
      <div class="card-title">Encrypted Backup</div>
      <p class="caption">
        AES-GCM encrypted database export using your custom password.
      </p>
    </div>

    <div class="card">
      <div class="card-title">Export</div>
      <p class="caption" style="margin-bottom:16px">
        Save an encrypted copy of your data file.
      </p>
      <button class="btn btn-filled btn-block" data-export>${icon('download')}Export backup</button>
    </div>

    <div class="card">
      <div class="card-title">Restore</div>
      <p class="caption" style="margin-bottom:16px">
        Restoring replaces existing data with backup file contents.
      </p>
      <button class="btn btn-outlined btn-block" data-import>${icon('upload_file')}Restore from backup</button>
    </div>

    <div class="card">
      <div class="card-title">Data Management</div>
      <p class="caption" style="margin-bottom:16px">
        Selectively clear record categories or factory reset the application.
      </p>
      <button class="btn btn-danger-text btn-block" data-open="delete-data">
        ${icon('delete_forever')}Delete data
      </button>
    </div>`;

  container.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => app.open(btn.dataset.open));
  });

  container.querySelector('[data-export]').addEventListener('click', async () => {
    const password = await askPassword('Encrypt this backup',
      'At least 8 characters. You will need it to restore.', 'Export');
    if (!password) return;

    const res = await app.db('export_backup', { password });
    if (!res) return;

    saveFile(`vitta-vriksha-${todayISO()}.vittavriksha`, res.backup_payload, 'application/octet-stream');
    toast(`Exported ${res.record_count} records.`, 'success');
  });

  container.querySelector('[data-import]').addEventListener('click', async () => {
    const confirmed = await confirmDialog('Replace everything?',
      'Restoring overwrites the records currently in the app.',
      { confirmLabel: 'Choose a file', danger: true });
    if (!confirmed) return;

    const file = await pickFile('.vittavriksha,.json');
    if (!file) return;

    const password = await askPassword('Backup password',
      `Enter the password used for ${file.name}.`, 'Restore');
    if (!password) return;

    const res = await app.db('import_backup', { backup_payload: file.text.trim(), password });
    if (!res) return;

    toast(`Restored ${res.restored} records.`, 'success');
    window.location.reload();
  });
}

function askPassword(title, body, confirmLabel) {
  return sheet(title, `
    <p class="caption">${h(body)}</p>
    <div class="field">
      <label class="field-label" for="backupPassword">Password</label>
      <input class="input" id="backupPassword" data-password type="password"
             autocomplete="off" placeholder="Backup password">
    </div>`, {
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-go>${h(confirmLabel)}</button>`,
    onMount(node, close) {
      const input = node.querySelector('[data-password]');
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      node.querySelector('[data-go]').addEventListener('click', () => close(input.value || null));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value || null); });
    },
  });
}
