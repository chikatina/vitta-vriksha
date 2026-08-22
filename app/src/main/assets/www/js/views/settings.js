/*
 * Settings: every switch in the app, in one place, plus what to do about the data behind
 * them.
 *
 * The toggles used to be spread over three screens, which meant hunting for the one you
 * wanted. They are all here now, grouped by what they change: how the app looks, how it
 * counts, who it counts for, and what it is allowed to read. Below that is the part
 * nobody wants until they want it badly: deleting things, and getting the messages
 * already on the phone read in.
 */

import { Bridge } from '../bridge.js';
import {
  icon, h, toast, confirmDialog, selectField, bindSelectFields, sheet, showProgressModal,
} from '../ui.js';
import { setAmountsMasked } from '../formatters.js';

const APPEARANCES = [
  { id: 'system', label: 'System', glyph: 'contrast' },
  { id: 'light', label: 'Light', glyph: 'light_mode' },
  { id: 'dark', label: 'Dark', glyph: 'dark_mode' },
  { id: 'oled', label: 'OLED', glyph: 'dark_mode' },
];

const ACCENTS = [
  { id: 'olive', label: 'Olive', color: '#88A838' },
  { id: 'ochre', label: 'Ochre Gold', color: '#F8C828' },
  { id: 'bronze', label: 'Olive Bronze', color: '#988818' },
  { id: 'forest', label: 'Deep Forest', color: '#083828' },
  { id: 'amber', label: 'Warm Amber', color: '#96601C' },
  { id: 'indigo', label: 'Indigo', color: '#4338CA' },
  { id: 'rose', label: 'Rose', color: '#B32350' },
];

/**
 * The rupee, and only the rupee.
 *
 * The app is built for Indian households and nothing in it converts between currencies.
 * Offering a list of them implied a conversion that was never going to happen: pick
 * dollars and every rupee already recorded would silently relabel itself. The column is
 * still there and every row still carries the currency it was written in, so adding a
 * second one later is a matter of doing the conversion honestly rather than of undoing
 * this.
 */
const CURRENCIES = [
  { code: 'INR', label: 'Indian rupee' },
];

const REMINDER_TIMES = [
  { value: '19:30', label: '7:30 PM' },
  { value: '20:00', label: '8:00 PM' },
  { value: '20:30', label: '8:30 PM' },
  { value: '21:00', label: '9:00 PM (Default)' },
  { value: '21:30', label: '9:30 PM' },
  { value: '22:00', label: '10:00 PM' },
  { value: '22:30', label: '10:30 PM' },
  { value: '23:00', label: '11:00 PM' },
];

/**
 * Every switch, with the setting it writes and what it means. Keeping them in a table
 * rather than in the markup is what makes them one thing rather than nine.
 */
const TOGGLES = [
  {
    key: 'family_features_enabled',
    title: 'Multi-member tracking',
    sub: 'Profile filter across the app',
  },
  {
    key: 'exclude_investments_from_expenses',
    title: 'Separate investments from spending',
    sub: 'Exclude investment outflows from expenses',
  },
  {
    key: 'mask_amounts',
    title: 'Hide amounts',
    sub: 'Mask figures across the app',
  },
];

export async function renderSettings(container, app) {
  const smsGranted = Bridge.checkPermission('SMS');

  container.innerHTML = `
    <div class="card">
      <div class="card-title">Theme</div>
      <div class="segmented">
        ${APPEARANCES.map((appearance) => `
          <button data-appearance-value="${appearance.id}"
                  aria-selected="${appearance.id === app.appearance}">
            ${icon(appearance.glyph, 'icon-sm')} ${h(appearance.label)}
          </button>`).join('')}
      </div>

      <div class="card-title" style="margin-top:20px">Accent</div>
      <div class="swatch-grid">
        ${ACCENTS.map((accent) => `
          <button class="swatch" data-accent-value="${accent.id}" style="background:${accent.color}"
                  aria-selected="${accent.id === app.accent}" aria-label="${h(accent.label)}">
            ${icon('check', 'icon-sm')}
          </button>`).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Money</div>
      ${selectField({
    key: 'currency',
    label: 'Currency',
    value: app.currency,
    options: CURRENCIES.map((currency) => ({
      value: currency.code, label: currency.label, sub: currency.code,
    })),
  })}

      <div class="field" style="margin-top:16px">
        <label class="field-label" for="monthlyBudget">Monthly budget</label>
        <input class="input numeric" id="monthlyBudget" data-budget type="number"
               inputmode="decimal" step="any"
               value="${h(app.settings.monthly_budget || '')}" placeholder="0">
      </div>
    </div>

    <div class="card">
      <div class="card-title">Behaviour</div>
      ${TOGGLES.map((toggle) => `
        <label class="switch-row" style="padding:10px 0">
          <span class="list-row-main">
            <span class="list-row-title">${h(toggle.title)}</span>
            <span class="list-row-sub">${h(toggle.sub)}</span>
          </span>
          <input type="checkbox" class="switch" data-toggle="${h(toggle.key)}"
                 ${app.settings[toggle.key] === '1' ? 'checked' : ''}>
        </label>`).join('')}
    </div>

    <div class="card">
      <div class="card-title">Daily review reminder</div>
      <p class="caption" style="margin-bottom:12px">
        A quiet evening nudge to review or record today's expenses.
      </p>
      <label class="switch-row" style="padding:10px 0">
        <span class="list-row-main">
          <span class="list-row-title">Evening reminder</span>
          <span class="list-row-sub">Send reminder at scheduled time</span>
        </span>
        <input type="checkbox" class="switch" data-toggle="daily_review_reminder_enabled"
               ${app.settings.daily_review_reminder_enabled !== '0' ? 'checked' : ''}>
      </label>
      <div style="margin-top:12px">
        ${selectField({
    key: 'daily_review_reminder_time',
    label: 'Reminder time',
    value: app.settings.daily_review_reminder_time || '21:00',
    options: REMINDER_TIMES.map((t) => ({ value: t.value, label: t.label, sub: t.value })),
  })}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Import bank messages</div>
      <p class="caption" style="margin-bottom:14px">
        Scan past SMS alerts to import past transactions.
      </p>
      <button class="btn btn-filled btn-block" data-reimport>
        ${icon('history')}Import past messages
      </button>
      <div class="caption" data-reimport-result style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="card-title">Help & Support</div>
      <div class="list">
        <button class="list-row" data-open="guide">
          <span class="list-row-main">
            <span class="list-row-title">Guide & FAQ</span>
            <span class="list-row-sub">App guide and frequently asked questions</span>
          </span>
          ${icon('chevron_right', 'icon-sm')}
        </button>
        <button class="list-row" data-open="support">
          <span class="list-row-main">
            <span class="list-row-title">Help & Support</span>
            <span class="list-row-sub">Contact us at help@chikatistudio.com</span>
          </span>
          ${icon('chevron_right', 'icon-sm')}
        </button>
        <button class="list-row" data-open="about">
          <span class="list-row-main">
            <span class="list-row-title">About</span>
            <span class="list-row-sub">Version & credits</span>
          </span>
          ${icon('chevron_right', 'icon-sm')}
        </button>
      </div>
    </div>

    ${Bridge.isDebug() ? `
      <div class="card" data-debug-sample-card>
        <div class="row-between" style="align-items:center;margin-bottom:6px">
          <div class="card-title" style="margin-bottom:0">Sample Data</div>
          <span class="badge" style="background:var(--surface-container-highest);color:var(--on-surface-variant);font-size:11px">Debug Only</span>
        </div>
        <p class="caption" style="margin-bottom:var(--gap-3)">
          Populate realistic sample accounts, mutual funds, budgets and transactions for internal testing and demo screenshots.
        </p>
        <button type="button" class="btn btn-tonal btn-block" data-seed-demo>
          ${icon('science')}Load Sample Data
        </button>
      </div>` : ''}`;

  bindSelectFields(container);
  bindAppearance(container, app);
  bindMoney(container, app);
  bindToggles(container, app);
  bindReminders(container, app);
  bindReimport(container, app);

  const seedBtn = container.querySelector('[data-seed-demo]');
  if (seedBtn) {
    seedBtn.addEventListener('click', async () => {
      seedBtn.disabled = true;
      if (window.seedDemoData) {
        await window.seedDemoData();
      }
      seedBtn.disabled = false;
      if (app?.refresh) await app.refresh();
    });
  }

  container.querySelectorAll('[data-open]').forEach((row) => {
    row.addEventListener('click', () => app.open(row.dataset.open));
  });
}

function bindAppearance(container, app) {
  // The controls carry their own attributes rather than being found through a parent.
  // A selector like '[data-accent] button' would match every button on the page, because
  // the document element itself carries data-accent and the ancestor half of a selector
  // is matched against the whole document rather than the container's subtree.
  container.querySelectorAll('[data-appearance-value]').forEach((button) => {
    button.addEventListener('click', async () => {
      await app.saveAppearance(button.dataset.appearanceValue, app.accent);
      app.refresh();
    });
  });

  container.querySelectorAll('[data-accent-value]').forEach((button) => {
    button.addEventListener('click', async () => {
      await app.saveAppearance(app.appearance, button.dataset.accentValue);
      app.refresh();
    });
  });
}

function bindMoney(container, app) {
  container.querySelector('[data-field="currency"]').addEventListener('change', async (event) => {
    const value = event.target.value;
    const result = await app.db('update_setting', { key: 'currency', value });
    if (!result) return;
    app.currency = value;
    app.settings.currency = value;
    toast('Currency updated.', 'success');
    app.refresh();
  });

  const budget = container.querySelector('[data-budget]');
  budget.addEventListener('change', async () => {
    const value = String(Number(budget.value) || 0);
    const result = await app.db('update_setting', { key: 'monthly_budget', value });
    if (!result) return;
    app.settings.monthly_budget = value;
    toast('Budget updated.', 'success');
  });
}

function bindToggles(container, app) {
  container.querySelectorAll('[data-toggle]').forEach((input) => {
    input.addEventListener('change', async () => {
      const key = input.dataset.toggle;
      const value = input.checked ? '1' : '0';
      const result = await app.db('update_setting', { key, value });
      if (!result) {
        input.checked = !input.checked;
        return;
      }
      app.settings[key] = value;
      // Turning household tracking off leaves a per-person filter no way to be changed
      // back, so the filter goes with it.
      if (key === 'family_features_enabled' && value === '0') app.memberFilter = 'all';

      // Masking is about what is on the screen right now, so it takes effect on the screen
      // right now rather than the next time something happens to be redrawn.
      if (key === 'mask_amounts') {
        setAmountsMasked(value === '1');
        toast(value === '1' ? 'Amounts are hidden.' : 'Amounts are showing.', 'success');
        await app.render();
        return;
      }

      if (key === 'daily_review_reminder_enabled') {
        Bridge.call('reminders', { action: 'sync' }).catch(() => {});
      }

      toast('Saved.', 'success');
    });
  });
}

function bindReminders(container, app) {
  const reminderTimeField = container.querySelector('[data-field="daily_review_reminder_time"]');
  if (reminderTimeField) {
    reminderTimeField.addEventListener('change', async (event) => {
      const value = event.target.value;
      const result = await app.db('update_setting', { key: 'daily_review_reminder_time', value });
      if (!result) return;
      app.settings.daily_review_reminder_time = value;
      Bridge.call('reminders', { action: 'sync' }).catch(() => {});
      toast('Reminder time updated.', 'success');
    });
  }
}

function bindReimport(container, app) {
  const button = container.querySelector('[data-reimport]');
  if (!button) return;

  button.addEventListener('click', async () => {
    // Ask here rather than sending the user to another screen to grant it and come back.
    // A button that is visible but does nothing is worse than one that explains itself.
    if (!Bridge.checkPermission('SMS')) {
      if (Bridge.permissionIsBlocked('SMS')) {
        const open = await confirmDialog(
          'Permission is blocked',
          'Reading messages was refused with "don\'t ask again", so the request no longer '
          + 'appears. It can be turned back on in system settings, under Permissions.',
          { confirmLabel: 'Open settings' },
        );
        if (open) Bridge.openAppSettings();
        return;
      }

      const granted = await Bridge.requestPermission('SMS');
      if (!granted) {
        toast('Without that permission there is nothing to read.');
        return;
      }
      app.refresh();
    }

    const range = await sheet('Import bank messages', `
      <div class="field">
        <label class="field-label">How far back would you like to scan?</label>
        <div class="list" style="margin-top:var(--gap-3)">
          <button type="button" class="list-row" data-range="0">
            <span class="avatar avatar-sm" style="background:var(--accent-container);color:var(--on-accent-container)">
              ${icon('history', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">All time</span>
              <span class="list-row-sub">Scan your entire SMS history from day one</span>
            </span>
            ${icon('chevron_right', 'icon-sm')}
          </button>
          <button type="button" class="list-row" data-range="365">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
              ${icon('calendar_month', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">Last 1 year</span>
              <span class="list-row-sub">Past 365 days</span>
            </span>
            ${icon('chevron_right', 'icon-sm')}
          </button>
          <button type="button" class="list-row" data-range="180">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
              ${icon('event', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">Last 6 months</span>
              <span class="list-row-sub">Past 180 days</span>
            </span>
            ${icon('chevron_right', 'icon-sm')}
          </button>
          <button type="button" class="list-row" data-range="90">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
              ${icon('schedule', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">Last 90 days</span>
              <span class="list-row-sub">Past 3 months</span>
            </span>
            ${icon('chevron_right', 'icon-sm')}
          </button>
          <button type="button" class="list-row" data-range="30">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
              ${icon('today', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">Last 30 days</span>
              <span class="list-row-sub">Past month</span>
            </span>
            ${icon('chevron_right', 'icon-sm')}
          </button>
        </div>
      </div>`, {
      onMount(node, close) {
        node.querySelectorAll('[data-range]').forEach((btn) => {
          btn.addEventListener('click', () => close(Number(btn.dataset.range)));
        });
      },
    });

    if (range === null || range === undefined) return;

    const rangeLabel = range === 0 ? 'all time' : `the last ${range} days`;
    const progress = showProgressModal('Scanning SMS Inbox', {
      message: `Reading messages from ${rangeLabel}...`,
      initialPercent: 20,
      detail: 'Scanning bank alerts and UPI messages',
    });

    const stepTimer1 = setTimeout(() => {
      progress.update({
        percent: 55,
        message: 'Filtering financial debits and credits...',
        detail: 'Ignoring non-financial alerts and OTPs',
      });
    }, 400);

    const stepTimer2 = setTimeout(() => {
      progress.update({
        percent: 85,
        message: 'Applying categorization & merchant rules...',
        detail: 'Classifying transactions into categories',
      });
    }, 1100);

    button.disabled = true;
    button.textContent = 'Reading';

    let result;
    try {
      result = await Bridge.call('sms', {
        action: 'reimport',
        days: range,
        member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter),
      });
    } catch (err) {
      result = { status: 'error', message: err.message || 'SMS import failed.' };
    } finally {
      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);
      button.disabled = false;
      button.innerHTML = `${icon('history')}Import past messages`;
    }

    const output = container.querySelector('[data-reimport-result]');
    if (result.status !== 'success') {
      progress.fail(result.message || 'Import failed.');
      output.textContent = result.message || 'That did not work.';
      return;
    }

    progress.complete(`Filed ${result.imported} transactions!`, 400);

    output.textContent = `Read ${result.read} messages from ${rangeLabel}, filed ${result.imported}. `
      + `${result.skipped} were already recorded, and ${result.unmatched} matched no rule.`;
    if (result.imported) {
      toast(`Filed ${result.imported} transactions.`, 'success');
      app.refresh();
    }
  });
}
