import { Bridge } from '../bridge.js';
import { icon, h, toast, sheet, confirmDialog, pickFile, saveFile, showProgressModal } from '../ui.js';
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
        Save an encrypted copy of your data file to Downloads, or share to another app.
      </p>
      <button class="btn btn-filled btn-block" data-export>${icon('download')}Export backup</button>
      <button class="btn btn-outlined btn-block" data-share-backup style="margin-top:8px">${icon('share')}Share backup</button>
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
        ${icon('delete')}Delete data
      </button>
    </div>`;

  container.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => app.open(btn.dataset.open));
  });

  container.querySelector('[data-export]').addEventListener('click', async () => {
    const password = await askPassword('Encrypt this backup',
      'At least 8 characters. You will need it to restore.', 'Export');
    if (!password) return;

    const progress = showProgressModal('Encrypting Backup', {
      message: 'Deriving key with PBKDF2 (100,000 iterations)...',
      initialPercent: 30,
      detail: 'Encrypting database vault with AES-256-GCM',
    });

    const res = await app.db('export_backup', { password });
    if (!res) {
      progress.fail('Export failed.');
      return;
    }

    progress.complete('Backup encrypted!', 300);

    const filename = `vitta-vriksha-${todayISO()}.vittavriksha`;
    const saveRes = saveFile(filename, res.backup_payload, 'application/octet-stream');
    if (saveRes && saveRes.success === false) {
      toast(saveRes.error || 'Could not save export file.', 'error');
    } else {
      toast(`Exported ${res.record_count} records to Downloads (${filename})`, 'success');
    }
  });

  container.querySelector('[data-share-backup]').addEventListener('click', async () => {
    const password = await askPassword('Encrypt this backup',
      'At least 8 characters. You will need it to restore.', 'Share');
    if (!password) return;

    const progress = showProgressModal('Preparing Backup', {
      message: 'Encrypting data payload...',
      initialPercent: 40,
    });

    const res = await app.db('export_backup', { password });
    if (!res) {
      progress.fail('Export failed.');
      return;
    }

    progress.complete('Ready to share', 250);

    const filename = `vitta-vriksha-${todayISO()}.vittavriksha`;
    const base64 = btoa(unescape(encodeURIComponent(res.backup_payload)));
    Bridge.shareFile(filename, 'application/octet-stream', base64);
  });

  container.querySelector('[data-import]').addEventListener('click', async () => {
    const confirmed = await confirmDialog('Replace everything?',
      'Restoring overwrites the records currently in the app.',
      { confirmLabel: 'Choose a file', danger: true });
    if (!confirmed) return;

    const file = await pickFile('*/*,.vittavriksha,.json,application/octet-stream,application/json');
    if (!file) return;

    const password = await askPassword('Backup password',
      `Enter the password used for ${file.name}.`, 'Restore');
    if (!password) return;

    const progress = showProgressModal('Restoring Backup', {
      message: 'Decrypting backup with AES-GCM...',
      initialPercent: 35,
      detail: 'Rebuilding accounts, transactions and folios',
    });

    const res = await app.db('import_backup', { backup_payload: file.text.trim(), password });
    if (!res) {
      progress.fail('Decryption or restore failed.');
      return;
    }

    progress.complete(`Restored ${res.restored} records!`, 400);

    toast(`Restored ${res.restored} records.`, 'success');
    setTimeout(() => window.location.reload(), 300);
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
