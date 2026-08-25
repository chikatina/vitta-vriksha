/*
 * Delete data: Granular data deletion and factory reset.
 *
 * Placed in Data & Family so that data management (Export, Restore, Erase)
 * lives together with clear warnings and safeguards.
 */

import { icon, h, toast, confirmDialog, promptDialog } from '../ui.js';

/** What can be deleted, and how much it hurts. */
export const ERASABLE = [
  ['transactions', 'Transactions', 'Ledger entries, splits, and scanned SMS history'],
  ['accounts', 'Accounts', 'Balances and manual holdings'],
  ['holdings', 'Imported holdings', 'Mutual funds, demat, pension, stock trades'],
  ['goals', 'Goals', 'Savings targets'],
  ['budgets', 'Budgets', 'Monthly category limits'],
  ['loans', 'Loans', 'Borrowed and lent amounts'],
  ['cards', 'Credit cards', 'Card limits and balances'],
  ['subscriptions', 'Subscriptions', 'Tracked services and price history'],
  ['sips', 'SIPs', 'Recurring fund mandates'],
  ['events', 'Events', 'Dated reminders'],
  ['categories', 'Categories', 'Reset to defaults'],
  ['rules', 'SMS & merchant rules', 'Reset to defaults'],
  ['alerts', 'SMS alerts cache', 'Ignored alerts and pending SMS queue'],
];

export async function renderDeleteData(container, app) {
  container.innerHTML = `
    <div class="card">
      <div class="card-title">Delete data</div>
      <p class="caption" style="margin-bottom:14px">
        Irreversible. Export an encrypted backup first if you might need this data later.
      </p>
      <div class="list">
        ${ERASABLE.map(([kind, title, sub]) => `
          <button class="list-row" data-erase="${h(kind)}">
            <span class="list-row-main">
              <span class="list-row-title">${h(title)}</span>
              ${sub ? `<span class="list-row-sub">${h(sub)}</span>` : ''}
            </span>
            ${icon('delete', 'icon-sm')}
          </button>`).join('')}
      </div>
      <button class="btn btn-danger-text btn-block" data-erase-all style="margin-top:16px">
        ${icon('warning')}Delete everything
      </button>
    </div>`;

  bindErase(container, app);
}

export function bindErase(container, app) {
  container.querySelectorAll('[data-erase]').forEach((row) => {
    row.addEventListener('click', async () => {
      const kind = row.dataset.erase;
      const titleElem = row.querySelector('.list-row-title');
      const label = titleElem ? titleElem.textContent.trim() : kind;

      const confirmed = await confirmDialog(
        `Delete every one of your ${label.toLowerCase()}?`,
        'This cannot be undone.',
        { confirmLabel: 'Delete', danger: true },
      );
      if (!confirmed) return;

      const result = await app.db('clear_data', { kinds: [kind] });
      if (!result) return;
      toast(
        result.cleared ? `Deleted ${result.cleared} records.` : 'There was nothing to delete.',
        'success',
      );
      app.refresh();
    });
  });

  const eraseAll = container.querySelector('[data-erase-all]');
  if (eraseAll) {
    eraseAll.addEventListener('click', async () => {
      const confirmed = await confirmDialog(
        'Delete everything?',
        'Every transaction, account, holding, goal and setting. The app goes back to how it '
        + 'was on the day you installed it. This cannot be undone.',
        { confirmLabel: 'Delete everything', danger: true },
      );
      if (!confirmed) return;

      const typed = await promptDialog('Type DELETE to confirm', {
        body: 'A deliberate second step, because there is no way back from this one.',
        placeholder: 'DELETE',
        confirmLabel: 'Confirm',
      });
      if (String(typed).trim().toUpperCase() !== 'DELETE') {
        toast('Nothing was deleted.');
        return;
      }

      const result = await app.db('factory_reset');
      if (!result) return;
      try {
        localStorage.clear();
      } catch {
        // Ignored
      }
      toast('Everything has been deleted.', 'success');
      await app.restart();
    });
  }
}
