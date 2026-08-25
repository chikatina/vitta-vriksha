import { Bridge } from '../bridge.js';
import {
  icon, h, sheet, toast, errorBlock, selectField, bindSelectFields, confirmDialog,
} from '../ui.js';
import { formatMonthKey, todayISO } from '../formatters.js';
import { memberChips, bindMemberChips } from './shared.js';
import {
  WIDGETS, availableWidgets, readLayout, saveLayout, loadWidgetData, defaultOptions,
  DEFAULT_LAYOUT,
} from './widgets.js';
import { openOnboardingTour } from './onboarding-tour.js';
import { renderAlertTooltip, bindAlertTooltip } from './alert-tooltip.js';

export async function renderHome(container, app) {
  const layout = readLayout(app);
  const [data, categoryRes] = await Promise.all([
    loadWidgetData(app, layout),
    (app.pendingAlerts && app.pendingAlerts.length > 0) ? Bridge.db('get_categories') : Promise.resolve({ categories: [] }),
  ]);

  if (data.summary && data.summary.status !== 'success') {
    container.innerHTML = errorBlock(data.summary);
    return;
  }

  const categories = categoryRes.categories || [];
  const members = data.summary?.family_members || [];

  /*
   * A panel is an instance, so the same widget can appear more than once with different
   * settings. The uid is what tells two of them apart when the handlers are wired, which is
   * why it and not the widget name is what goes in the attribute.
   *
   * A widget returns an empty string when it has nothing worth showing, so the dashboard
   * does not fill up with placeholder cards on a fresh install.
   */
  const panels = layout.map((entry) => {
    const widget = WIDGETS[entry.id];
    if (!widget) return '';
    try {
      const html = widget.render(data, app, entry.options || {});
      return html ? `<div data-panel="${h(entry.uid)}" data-widget="${h(entry.id)}">${html}</div>` : '';
    } catch (error) {
      console.error(`Widget "${entry.id}" failed to render`, error);
      return '';
    }
  });

  const waiting = (app.pendingAlerts || []).length;
  const memberHtml = memberChips(app, members);

  const showOnboarding = app.settings.onboarding_dismissed !== '1';
  const smsGranted = Bridge.checkPermission('SMS');
  const hasBudget = Number(data.summary?.monthly_budget || 0) > 0;
  const hasInvestments = (data.summary?.asset_totals?.MF || 0) > 0 || (data.summary?.asset_totals?.Demat || 0) > 0 || (data.summary?.asset_totals?.NPS || 0) > 0;
  const hasAccounts = (data.summary?.total_assets || 0) > 0;
  const completedSteps = 1 + (smsGranted ? 1 : 0) + (hasInvestments ? 1 : 0) + (hasBudget ? 1 : 0) + (hasAccounts ? 1 : 0);
  const allStepsDone = completedSteps >= 5;

  const onboardingHtml = showOnboarding ? `
    <div class="card" style="position:relative;background:linear-gradient(135deg, var(--surface-container-low), var(--surface-container));border:1px solid var(--outline-variant);margin-bottom:var(--gap-3)" data-onboarding-card data-all-done="${allStepsDone ? '1' : '0'}">
      <div class="row-between" style="align-items:center;margin-bottom:var(--gap-2)">
        <div class="row" style="gap:10px;align-items:center">
          <span class="avatar avatar-sm" style="background:${allStepsDone ? 'var(--income-container)' : 'var(--accent-container)'};color:${allStepsDone ? 'var(--income)' : 'var(--on-accent-container)'}">
            ${icon(allStepsDone ? 'check_circle' : 'rocket_launch', 'icon-sm')}
          </span>
          <span class="list-row-main">
            <span class="card-title" style="margin-bottom:0">${allStepsDone ? 'Setup Complete' : 'Getting Started'}</span>
            <span class="caption">${allStepsDone ? 'All 5 steps completed' : `${completedSteps} of 5 steps completed`}</span>
          </span>
        </div>
        <button class="icon-button" data-dismiss-onboarding aria-label="Dismiss checklist" style="margin-right:-4px">
          ${icon('close', 'icon-sm')}
        </button>
      </div>

      <div class="progress" style="height:6px;margin-bottom:var(--gap-3)">
        <div class="progress-bar" style="width:${(completedSteps / 5) * 100}%;background:${allStepsDone ? 'var(--income)' : 'var(--accent)'}"></div>
      </div>

      <button class="btn btn-filled btn-block" data-take-tour style="display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 14px;font-size:13px;font-weight:650;margin-bottom:var(--gap-3)">
        ${icon('rocket_launch', 'icon-sm')}Start Step-by-Step Guided Tour
      </button>

      <div class="list" style="margin-bottom:2px;background:var(--surface-container-high);padding:var(--gap-1) var(--gap-3);border-radius:var(--radius-md);box-shadow:none">
        <div class="list-row" style="padding:10px 0;background:transparent">
          <span class="badge badge-income" style="width:22px;height:22px;border-radius:50%;padding:0;display:grid;place-items:center">
            ${icon('check', 'icon-sm')}
          </span>
          <span class="list-row-main" style="margin-left:8px">
            <span class="list-row-title" style="font-size:13px">4-digit Master PIN</span>
            <span class="caption">Vault encryption enabled</span>
          </span>
        </div>

        <div class="list-row" data-onboarding-sms style="padding:10px 0;background:transparent">
          <span class="badge ${smsGranted ? 'badge-income' : 'badge-tonal'}" style="width:22px;height:22px;border-radius:50%;padding:0;display:grid;place-items:center">
            ${icon(smsGranted ? 'check' : 'sms', 'icon-sm')}
          </span>
          <span class="list-row-main" style="margin-left:8px">
            <span class="list-row-title" style="font-size:13px">Bank SMS Tracking</span>
            <span class="caption">${smsGranted ? 'Active on this device' : 'Auto-track daily debits & credits'}</span>
          </span>
          ${!smsGranted ? `<button class="btn btn-sm btn-tonal" data-action-sms>Enable</button>` : ''}
        </div>

        <div class="list-row" data-onboarding-cas style="padding:10px 0;background:transparent">
          <span class="badge ${hasInvestments ? 'badge-income' : 'badge-tonal'}" style="width:22px;height:22px;border-radius:50%;padding:0;display:grid;place-items:center">
            ${icon(hasInvestments ? 'check' : 'savings', 'icon-sm')}
          </span>
          <span class="list-row-main" style="margin-left:8px">
            <span class="list-row-title" style="font-size:13px">Mutual Funds & Demat</span>
            <span class="caption">${hasInvestments ? 'Holdings imported' : 'Upload CAMS / CDSL statement PDF'}</span>
          </span>
          ${!hasInvestments ? `<button class="btn btn-sm btn-tonal" data-action-cas>Upload</button>` : ''}
        </div>

        <div class="list-row" data-onboarding-budget style="padding:10px 0;background:transparent">
          <span class="badge ${hasBudget ? 'badge-income' : 'badge-tonal'}" style="width:22px;height:22px;border-radius:50%;padding:0;display:grid;place-items:center">
            ${icon(hasBudget ? 'check' : 'donut_small', 'icon-sm')}
          </span>
          <span class="list-row-main" style="margin-left:8px">
            <span class="list-row-title" style="font-size:13px">Monthly Spending Budget</span>
            <span class="caption">${hasBudget ? 'Budget configured' : 'Set a target spending limit'}</span>
          </span>
          ${!hasBudget ? `<button class="btn btn-sm btn-tonal" data-action-budget>Set</button>` : ''}
        </div>

        <div class="list-row" data-onboarding-accounts style="padding:10px 0;background:transparent">
          <span class="badge ${hasAccounts ? 'badge-income' : 'badge-tonal'}" style="width:22px;height:22px;border-radius:50%;padding:0;display:grid;place-items:center">
            ${icon(hasAccounts ? 'check' : 'account_balance', 'icon-sm')}
          </span>
          <span class="list-row-main" style="margin-left:8px">
            <span class="list-row-title" style="font-size:13px">Bank Accounts & Cards</span>
            <span class="caption">${hasAccounts ? 'Accounts recorded' : 'Track savings, FDs & credit cards'}</span>
          </span>
          ${!hasAccounts ? `<button class="btn btn-sm btn-tonal" data-action-accounts>Add</button>` : ''}
        </div>
      </div>
    </div>` : '';

  container.innerHTML = `
    <div class="home-top-bar">
      <div class="home-title-group">
        <span class="home-title">Home</span>
        <span class="home-subtitle">${h(formatMonthKey(todayISO().slice(0, 7)))}</span>
      </div>
      <button class="btn btn-tonal btn-sm" data-customise aria-label="Customise home">
        ${icon('tune', 'icon-sm')} Customise
      </button>
    </div>
    ${waiting ? renderAlertTooltip(app.pendingAlerts, categories, app) : ''}
    ${onboardingHtml}
    ${memberHtml ? `<div class="sticky-header">${memberHtml}</div>` : ''}
    ${panels.join('')}
    <button class="btn btn-text btn-block" data-customise-bottom style="margin-top:8px">
      ${icon('tune')}Customise layout
    </button>`;

  bindMemberChips(container, app);

  if (waiting) {
    bindAlertTooltip(container, app, { categories });
  }

  const onboardingCard = container.querySelector('[data-onboarding-card]');
  if (onboardingCard) {
    // If all 5 steps are completed, celebrate and auto-dismiss after 1.2 seconds with smooth animation
    if (allStepsDone) {
      setTimeout(async () => {
        if (!onboardingCard.isConnected) return;
        onboardingCard.classList.add('auto-dismissing');
        await Bridge.db('update_setting', { key: 'onboarding_dismissed', value: '1' });
        app.settings.onboarding_dismissed = '1';
        setTimeout(() => {
          onboardingCard.remove();
          toast('Setup complete. Welcome to Vitta Vriksha.', 'success');
        }, 460);
      }, 1200);
    }

    const dismissBtn = onboardingCard.querySelector('[data-dismiss-onboarding]');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', async () => {
        onboardingCard.classList.add('auto-dismissing');
        await Bridge.db('update_setting', { key: 'onboarding_dismissed', value: '1' });
        app.settings.onboarding_dismissed = '1';
        setTimeout(() => onboardingCard.remove(), 460);
      });
    }
  }

  const tourBtn = container.querySelector('[data-take-tour]');
  if (tourBtn) tourBtn.addEventListener('click', () => openOnboardingTour(app));

  const smsAction = container.querySelector('[data-action-sms]');
  if (smsAction) {
    smsAction.addEventListener('click', async () => {
      const granted = Bridge.checkPermission('SMS');
      if (granted) {
        app.open('sms_ingest');
        return;
      }

      if (Bridge.permissionIsBlocked('SMS')) {
        const goSettings = await confirmDialog(
          'SMS Permission Required',
          'Bank SMS tracking requires SMS permission to detect debit and credit alerts on this device. Please enable SMS permission in app settings.',
          { confirmLabel: 'Open Settings' },
        );
        if (goSettings) Bridge.openAppSettings();
        return;
      }

      smsAction.disabled = true;
      await Bridge.requestPermission('SMS');
      const nowGranted = Bridge.checkPermission('SMS');
      if (nowGranted) {
        Bridge.setSmsTrackingEnabled(true);
        toast('SMS permission granted.', 'success');
        app.open('sms_ingest');
      } else {
        toast('SMS permission is required to enable Bank SMS tracking.', 'info');
        renderHome(container, app);
      }
    });
  }

  const casAction = container.querySelector('[data-action-cas]');
  if (casAction) casAction.addEventListener('click', () => app.open('cas'));

  const budgetAction = container.querySelector('[data-action-budget]');
  if (budgetAction) budgetAction.addEventListener('click', () => app.open('budgets'));

  const accountsAction = container.querySelector('[data-action-accounts]');
  if (accountsAction) accountsAction.addEventListener('click', () => app.open('accounts'));

  // Widgets that need event handlers get them after the markup is in the document.
  layout.forEach((entry) => {
    const widget = WIDGETS[entry.id];
    const node = container.querySelector(`[data-panel="${entry.uid}"]`);
    if (widget?.bind && node) widget.bind(node, data, app, entry.options || {});
  });

  container.querySelectorAll('[data-customise], [data-customise-bottom]').forEach((btn) => {
    btn.addEventListener('click', () => openEditor(app));
  });
}

/**
 * Layout editor: which panels appear, in what order, and how each is set up.
 *
 * The settings button is the part that makes the dashboard the user's rather than the
 * app's. A panel with options can be added twice and pointed at two different questions,
 * and the editor is where that is done, so nothing on Home itself has to carry a control.
 */
async function openEditor(app) {
  const catalogue = availableWidgets(app);
  let layout = readLayout(app);
  let sequence = layout.length;

  const saved = await sheet('Customise home', '<div data-editor></div>', {
    autofocus: false,
    actions: `
      <button class="btn btn-outlined" data-reset>Reset</button>
      <button class="btn btn-filled" data-save>Done</button>`,
    onMount(node, close) {
      const host = node.querySelector('[data-editor]');

      const paint = () => {
        const chosen = layout.filter((entry) => WIDGETS[entry.id]);
        // A repeatable panel stays on offer once it is in the layout; the rest do not, so
        // nobody ends up with two identical net worth cards.
        const rest = catalogue.filter((widget) => widget.repeatable
          || !layout.some((entry) => entry.id === widget.id));

        host.innerHTML = `
          <p class="caption" style="margin-bottom:12px">
            Arrange and configure home dashboard cards.
          </p>

          <div class="list" style="margin-bottom:16px">
            ${chosen.map((entry, index) => {
    const widget = WIDGETS[entry.id];
    return `
                <div class="list-row">
                  <span class="avatar avatar-sm" style="background:var(--accent-container);color:var(--on-accent-container)">
                    ${icon(widget.icon || 'dashboard')}
                  </span>
                  <span class="list-row-main">
                    <span class="list-row-title">${h(widget.label)}</span>
                    <span class="list-row-sub">${h(describeOptions(widget, entry.options) || widget.description)}</span>
                  </span>
                  <span class="row" style="gap:2px">
                    ${widget.options ? `
                      <button class="icon-button" data-settings="${index}" aria-label="Settings">
                        ${icon('tune')}
                      </button>` : ''}
                    <button class="icon-button" data-up="${index}" aria-label="Move up"
                            ${index === 0 ? 'disabled style="opacity:.3"' : ''}>
                      ${icon('expand_less')}
                    </button>
                    <button class="icon-button" data-down="${index}" aria-label="Move down"
                            ${index === chosen.length - 1 ? 'disabled style="opacity:.3"' : ''}>
                      ${icon('expand_more')}
                    </button>
                    ${widget.pinned
    ? ''
    : `<button class="icon-button" data-remove="${h(entry.uid)}" aria-label="Remove">
                           ${icon('close')}
                         </button>`}
                  </span>
                </div>`;
  }).join('')}
          </div>

          ${rest.length ? `
            <div class="label" style="margin-bottom:8px">Add a panel</div>
            <div class="list">
              ${rest.map((widget) => `
                <button class="list-row" data-add="${widget.id}">
                  <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface-variant)">
                    ${icon(widget.icon || 'dashboard')}
                  </span>
                  <span class="list-row-main">
                    <span class="list-row-title">${h(widget.label)}</span>
                    <span class="list-row-sub">${h(widget.description)}</span>
                  </span>
                  ${icon('add')}
                </button>`).join('')}
            </div>` : ''}`;

        host.querySelectorAll('[data-up]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const i = Number(btn.dataset.up);
            [layout[i - 1], layout[i]] = [layout[i], layout[i - 1]];
            paint();
          });
        });

        host.querySelectorAll('[data-down]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const i = Number(btn.dataset.down);
            [layout[i + 1], layout[i]] = [layout[i], layout[i + 1]];
            paint();
          });
        });

        host.querySelectorAll('[data-remove]').forEach((btn) => {
          btn.addEventListener('click', () => {
            layout = layout.filter((entry) => entry.uid !== btn.dataset.remove);
            paint();
          });
        });

        host.querySelectorAll('[data-add]').forEach((btn) => {
          btn.addEventListener('click', () => {
            sequence += 1;
            layout = [...layout, {
              id: btn.dataset.add,
              uid: `${btn.dataset.add}-${sequence}`,
              options: defaultOptions(btn.dataset.add),
            }];
            paint();
          });
        });

        host.querySelectorAll('[data-settings]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const entry = layout[Number(btn.dataset.settings)];
            const next = await openPanelSettings(entry);
            if (next) {
              entry.options = next;
              paint();
            }
          });
        });
      };

      paint();

      node.querySelector('[data-reset]').addEventListener('click', () => {
        layout = DEFAULT_LAYOUT
          .filter((id) => WIDGETS[id] && (!WIDGETS[id].needsFamily || app.familyEnabled))
          .map((id, index) => ({ id, uid: `${id}-${index}`, options: defaultOptions(id) }));
        paint();
      });

      node.querySelector('[data-save]').addEventListener('click', async () => {
        if (!layout.length) {
          toast('Keep at least one panel.', 'error');
          return;
        }
        const res = await saveLayout(app, layout);
        if (res) close(true);
      });
    },
  });

  if (saved) app.refresh();
}

/** One panel's options, as menu fields. Resolves to the new options, or null if dismissed. */
function openPanelSettings(entry) {
  const widget = WIDGETS[entry.id];
  const current = { ...defaultOptions(entry.id), ...entry.options };

  const body = widget.options.map((option) => selectField({
    key: option.key,
    label: option.label,
    id: `option_${option.key}`,
    value: String(current[option.key] ?? option.default),
    options: option.choices,
  })).join('');

  return sheet(widget.label, body, {
    autofocus: false,
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-apply>Apply</button>`,
    onMount(node, close) {
      bindSelectFields(node);
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      node.querySelector('[data-apply]').addEventListener('click', () => {
        const next = {};
        widget.options.forEach((option) => {
          const field = node.querySelector(`#option_${option.key}`);
          next[option.key] = field ? field.value : current[option.key];
        });
        close(next);
      });
    },
  });
}

/** How a configured panel reads in the editor list, so its settings are visible there. */
function describeOptions(widget, options = {}) {
  if (!widget.options) return '';
  return widget.options
    .map((option) => {
      const value = String(options[option.key] ?? option.default);
      const choice = option.choices.find((entry) => entry.value === value);
      return choice ? choice.label : '';
    })
    .filter(Boolean)
    .join(' · ');
}
