/* Home: a dashboard the user assembles from the widget catalogue. */

import {
  icon, h, sheet, toast, errorBlock, selectField, bindSelectFields,
} from '../ui.js';
import { formatMonthKey, todayISO } from '../formatters.js';
import { memberChips, bindMemberChips } from './shared.js';
import {
  WIDGETS, availableWidgets, readLayout, saveLayout, loadWidgetData, defaultOptions,
  DEFAULT_LAYOUT,
} from './widgets.js';

export async function renderHome(container, app) {
  const layout = readLayout(app);
  const data = await loadWidgetData(app, layout);

  if (data.summary && data.summary.status !== 'success') {
    container.innerHTML = errorBlock(data.summary);
    return;
  }

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
      return html ? `<div data-panel="${h(entry.uid)}">${html}</div>` : '';
    } catch (error) {
      console.error(`Widget "${entry.id}" failed to render`, error);
      return '';
    }
  });

  const waiting = (app.pendingAlerts || []).length;
  const memberHtml = memberChips(app, members);

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
    ${waiting ? `
      <div class="banner">
        ${icon('sms')}
        <span class="banner-main">
          <span class="banner-title">
            ${waiting} bank alert${waiting === 1 ? '' : 's'} to review
          </span>
          <span class="banner-body">
            Pending transactions from bank SMS.
          </span>
        </span>
        <button class="btn btn-tonal" data-review>Review</button>
      </div>` : ''}
    ${memberHtml ? `<div class="sticky-header">${memberHtml}</div>` : ''}
    ${panels.join('')}
    <button class="btn btn-text btn-block" data-customise-bottom style="margin-top:8px">
      ${icon('tune')}Customise layout
    </button>`;

  bindMemberChips(container, app);

  const review = container.querySelector('[data-review]');
  if (review) review.addEventListener('click', () => app.reviewNextAlert());

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
