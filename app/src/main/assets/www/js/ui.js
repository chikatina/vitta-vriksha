/*
 * Overlay primitives: toasts, dialogs and bottom sheets.
 *
 * Nothing in the app should call window.alert, window.confirm or window.prompt. Those
 * render Chrome's own dialogs inside the WebView, which look nothing like the app and
 * block the JS thread. Everything here is promise based and themed.
 */

import { ICON_CODEPOINTS } from './icon-codepoints.js';
import { saveFile as nativeSaveFile, encodeBase64 } from './backend/native.js';

const OVERLAY_MS = 320;

/** Escapes a value for interpolation into a template literal. */
export function h(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders a Material Symbols glyph by name.
 *
 * The bundled font is subsetted by codepoint rather than shipped with its ligature
 * tables, so names are resolved through the generated map. An unknown name would
 * otherwise render as a blank box, which is easy to miss, so it warns instead.
 */
export function icon(name, className = '') {
  const glyph = ICON_CODEPOINTS[name];
  if (!glyph) {
    console.warn(`Icon "${name}" is not in the font subset. Add it to tools/subset-material-symbols.py.`);
    return `<span class="icon ${className}" aria-hidden="true">${ICON_CODEPOINTS.help || ''}</span>`;
  }
  return `<span class="icon ${className}" aria-hidden="true">${glyph}</span>`;
}

function host(id, className) {
  let node = document.getElementById(id);
  if (!node) {
    node = document.createElement('div');
    node.id = id;
    if (className) node.className = className;
    document.body.appendChild(node);
  }
  return node;
}

/* ------------------------------------------------------------------ toasts */

export function toast(message, variant = '') {
  const container = host('toastHost', 'toast-host');
  const node = document.createElement('div');
  node.className = `toast ${variant ? `toast-${variant}` : ''}`;
  const glyph = variant === 'error' ? 'error' : variant === 'success' ? 'check_circle' : 'info';
  node.innerHTML = `${icon(glyph, 'icon-sm')}<span>${h(message)}</span>`;
  container.appendChild(node);

  requestAnimationFrame(() => node.classList.add('open'));
  setTimeout(() => {
    node.classList.remove('open');
    setTimeout(() => node.remove(), OVERLAY_MS);
  }, 2600);
}

/* ----------------------------------------------------------------- dialogs */

function openOverlay(buildNode) {
  closeOpenMenus();
  document.querySelectorAll('.scrim, .dialog, .sheet').forEach((el) => el.remove());
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    document.body.appendChild(scrim);

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      scrim.classList.remove('open');
      node.classList.remove('open');
      setTimeout(() => {
        scrim.remove();
        node.remove();
        resolve(value);
      }, OVERLAY_MS);
    };

    const node = buildNode(close);
    document.body.appendChild(node);

    scrim.addEventListener('click', () => close(null));
    requestAnimationFrame(() => {
      scrim.classList.add('open');
      node.classList.add('open');
      /*
       * The keyboard only comes up where typing is the point of opening the thing.
       * A sheet that exists to show something, with an editable field somewhere in it,
       * would otherwise throw the keyboard over what the user opened it to read.
       */
      if (!node.hasAttribute('data-no-autofocus')) {
        const focusable = node.querySelector('input, textarea, select');
        if (focusable) {
          setTimeout(() => {
            focusable.focus();
            setTimeout(() => {
              try {
                focusable.scrollIntoView({ block: 'center', behavior: 'smooth' });
              } catch (_) {
                focusable.scrollIntoView(false);
              }
            }, 100);
          }, OVERLAY_MS);
        }
      }
    });
  });
}

/**
 * Keeps interactive input panels and focused form controls visible when the software keyboard appears.
 * Integrates native Android IME callbacks with universal VisualViewport fallback.
 */
function setupKeyboardHandling() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof document.addEventListener !== 'function' || typeof window.addEventListener !== 'function') return;

  // 1. Visual Viewport Listener (Universal Web fallback)
  if (window.visualViewport) {
    const handleViewportResize = () => {
      const vv = window.visualViewport;
      const diff = Math.max(0, window.innerHeight - Math.round(vv.height));
      const doc = document.documentElement;
      if (diff > 120) {
        doc.style.setProperty('--keyboard-inset', `${diff}px`);
        doc.classList.add('keyboard-open');
      } else if (!doc.hasAttribute('data-native-keyboard')) {
        doc.style.setProperty('--keyboard-inset', '0px');
        doc.classList.remove('keyboard-open');
      }
    };

    window.visualViewport.addEventListener('resize', handleViewportResize);
    window.visualViewport.addEventListener('scroll', handleViewportResize);
  }

  // 2. Custom native events dispatched from MainActivity.kt
  window.addEventListener('keyboardshow', (e) => {
    const height = e.detail?.height || 0;
    const doc = document.documentElement;
    doc.setAttribute('data-native-keyboard', 'true');
    doc.style.setProperty('--keyboard-inset', `${height}px`);
    doc.classList.add('keyboard-open');

    // Scroll active element into center of visible space above keyboard
    const active = document.activeElement;
    if (active && active.matches && active.matches('input, textarea, select')) {
      setTimeout(() => {
        try {
          active.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (_) {
          active.scrollIntoView(false);
        }
      }, 80);
    }
  });

  window.addEventListener('keyboardhide', () => {
    const doc = document.documentElement;
    doc.removeAttribute('data-native-keyboard');
    doc.style.setProperty('--keyboard-inset', '0px');
    doc.classList.remove('keyboard-open');
  });

  // 3. Global focusin handler: ensure focused field is visible above keyboard
  document.addEventListener('focusin', (e) => {
    const target = e.target;
    if (!target || !target.matches || !target.matches('input, textarea, select')) return;

    setTimeout(() => {
      try {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (_) {
        target.scrollIntoView(false);
      }
    }, 250);
  });
}

setupKeyboardHandling();

/**
 * A message with a single dismiss button. Resolves when it closes.
 */
export function alertDialog(title, body, confirmLabel = 'OK') {
  return openOverlay((close) => {
    const node = document.createElement('div');
    node.className = 'dialog';
    node.innerHTML = `
      <div class="dialog-title">${h(title)}</div>
      ${body ? `<div class="dialog-body">${h(body)}</div>` : ''}
      <div class="dialog-actions">
        <button class="btn btn-text" data-close>${h(confirmLabel)}</button>
      </div>`;
    node.querySelector('[data-close]').addEventListener('click', () => close(true));
    return node;
  });
}

/**
 * Resolves true when confirmed, false otherwise. Pass danger for destructive actions.
 */
export function confirmDialog(title, body, { confirmLabel = 'Confirm', danger = false } = {}) {
  return openOverlay((close) => {
    const node = document.createElement('div');
    node.className = 'dialog';
    node.innerHTML = `
      <div class="dialog-title">${h(title)}</div>
      ${body ? `<div class="dialog-body">${h(body)}</div>` : ''}
      <div class="dialog-actions">
        <button class="btn btn-text" data-cancel>Cancel</button>
        <button class="btn ${danger ? 'btn-danger-text' : 'btn-text'}" data-confirm>${h(confirmLabel)}</button>
      </div>`;
    node.querySelector('[data-cancel]').addEventListener('click', () => close(false));
    node.querySelector('[data-confirm]').addEventListener('click', () => close(true));
    return node;
  });
}

/**
 * Asks for a single value. Resolves to the string, or null if dismissed.
 */
export function promptDialog(title, {
  body = '', placeholder = '', type = 'text', confirmLabel = 'Save', value = '', inputMode,
} = {}) {
  return openOverlay((close) => {
    const node = document.createElement('div');
    node.className = 'dialog';
    node.innerHTML = `
      <div class="dialog-title">${h(title)}</div>
      ${body ? `<div class="dialog-body" style="margin-bottom:16px">${h(body)}</div>` : ''}
      <input class="input" type="${h(type)}" placeholder="${h(placeholder)}" value="${h(value)}"
             ${inputMode ? `inputmode="${h(inputMode)}"` : ''}>
      <div class="dialog-actions">
        <button class="btn btn-text" data-cancel>Cancel</button>
        <button class="btn btn-text" data-confirm>${h(confirmLabel)}</button>
      </div>`;

    const input = node.querySelector('input');
    const submit = () => close(input.value.trim() ? input.value : null);
    node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    node.querySelector('[data-confirm]').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    return node;
  });
}

/**
 * Displays an active progress modal for heavy background processing (CAS parsing, bulk SMS ingestion, CSV imports).
 * Returns a controller with .update({ percent, message, detail }), .complete(message, delayMs), .fail(message), and .close().
 */
export function showProgressModal(title, options = {}) {
  let modalTitle = title;
  let modalOptions = options;

  if (typeof title === 'object' && title !== null) {
    modalOptions = title;
    modalTitle = modalOptions.title || 'Processing';
  }

  const {
    message = modalOptions.subtitle || 'Processing...',
    initialPercent = 0,
    indeterminate = false,
    detail = '',
  } = modalOptions;

  closeOpenMenus();
  document.querySelectorAll('.scrim, .dialog, .sheet, .progress-dialog-overlay').forEach((el) => el.remove());

  const scrim = document.createElement('div');
  scrim.className = 'scrim progress-dialog-overlay open';
  document.body.appendChild(scrim);

  const node = document.createElement('div');
  node.className = 'dialog progress-dialog open';
  node.setAttribute('data-no-autofocus', '');

  let currentPercent = Math.max(0, Math.min(100, initialPercent));
  let isClosed = false;

  node.innerHTML = `
    <div class="progress-dialog-header">
      <span class="spinner"></span>
      <span class="progress-dialog-title">${h(modalTitle)}</span>
    </div>
    <div class="progress-dialog-status" data-progress-message>${h(message)}</div>
    <div class="progress" style="margin:4px 0">
      <div class="progress-bar ${indeterminate ? 'indeterminate' : ''}" data-progress-bar style="width:${indeterminate ? '100%' : `${currentPercent}%`}"></div>
    </div>
    <div class="progress-dialog-meta">
      <span data-progress-detail>${h(detail)}</span>
      <span data-progress-pct style="font-weight:600">${indeterminate ? '' : `${Math.round(currentPercent)}%`}</span>
    </div>
  `;

  document.body.appendChild(node);

  const msgEl = node.querySelector('[data-progress-message]');
  const barEl = node.querySelector('[data-progress-bar]');
  const detailEl = node.querySelector('[data-progress-detail]');
  const pctEl = node.querySelector('[data-progress-pct]');

  const close = () => {
    if (isClosed) return;
    isClosed = true;
    scrim.classList.remove('open');
    node.classList.remove('open');
    setTimeout(() => {
      scrim.remove();
      node.remove();
    }, OVERLAY_MS);
  };

  const update = ({ percent, message: nextMsg, detail: nextDetail, indeterminate: nextIndeterminate } = {}) => {
    if (isClosed) return;
    if (percent !== undefined) {
      currentPercent = Math.max(0, Math.min(100, Number(percent) || 0));
      barEl.style.width = `${currentPercent}%`;
      pctEl.textContent = `${Math.round(currentPercent)}%`;
    }
    if (nextIndeterminate !== undefined) {
      barEl.classList.toggle('indeterminate', Boolean(nextIndeterminate));
      if (nextIndeterminate) pctEl.textContent = '';
    }
    if (nextMsg !== undefined && msgEl) {
      msgEl.textContent = nextMsg;
    }
    if (nextDetail !== undefined && detailEl) {
      detailEl.textContent = nextDetail;
    }
  };

  const complete = (completionMessage = 'Done!', delayMs = 350) => {
    if (isClosed) return;
    update({ percent: 100, message: completionMessage, indeterminate: false });
    const spinner = node.querySelector('.spinner');
    if (spinner) {
      spinner.outerHTML = icon('check_circle', 'icon-sm');
    }
    setTimeout(close, delayMs);
  };

  const fail = (errorMessage = 'Processing failed.') => {
    if (isClosed) return;
    update({ message: errorMessage, indeterminate: false });
    const spinner = node.querySelector('.spinner');
    if (spinner) {
      spinner.outerHTML = icon('error', 'icon-sm');
    }
    barEl.style.background = 'var(--expense)';
    setTimeout(close, 2200);
  };

  return {
    update,
    complete,
    finish: (msg = 'Done!', delay = 350) => complete(msg, delay),
    fail,
    close,
  };
}

/* ------------------------------------------------------------------ sheets */

/**
 * A bottom sheet built from an HTML body.
 *
 * onMount receives the sheet element and a close(value) function, and wires up whatever
 * the body needs. Resolves with the value passed to close.
 */
export function sheet(title, bodyHtml, { onMount, actions, autofocus = true } = {}) {
  return openOverlay((close) => {
    const node = document.createElement('div');
    node.className = 'sheet';
    if (!autofocus) node.setAttribute('data-no-autofocus', '');
    node.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <div class="sheet-title">${h(title)}</div>
        <button class="icon-button" data-dismiss aria-label="Close">${icon('close')}</button>
      </div>
      <div class="sheet-body">${bodyHtml}</div>
      ${actions ? `<div class="sheet-actions">${actions}</div>` : ''}`;

    node.querySelector('[data-dismiss]').addEventListener('click', () => close(null));
    if (onMount) onMount(node, close);
    autoScrollChipScrollers(node);
    return node;
  });
}

/**
 * Automatically scrolls any selected chip, tab, or list item in horizontal/vertical scrollers into view.
 */
export function scrollSelectedIntoView(container, { behavior = 'smooth', block = 'center', inline = 'center' } = {}) {
  if (!container) return;
  const target = container.querySelector(
    '.is-selected, [aria-selected="true"]:not([aria-selected="false"]), .chip.active, .selected, .list-row[data-selected="true"]',
  );
  if (!target) return;

  const scroller = container.classList?.contains('chip-scroller') || container.hasAttribute?.('data-categories') || container.classList?.contains('menu')
    ? container
    : target.closest('.chip-scroller, .menu, [data-categories], .segmented, [data-filters], .list, [data-sub-filters], [data-classes], [data-dimensions], [data-charts]');

  if (scroller) {
    if (scroller.scrollWidth > scroller.clientWidth) {
      const targetLeft = target.offsetLeft;
      const targetWidth = target.offsetWidth;
      const scrollerWidth = scroller.clientWidth;
      const scrollTarget = Math.max(0, targetLeft - (scrollerWidth - targetWidth) / 2);
      try {
        scroller.scrollTo({ left: scrollTarget, behavior });
      } catch {
        scroller.scrollLeft = scrollTarget;
      }
    } else if (scroller.scrollHeight > scroller.clientHeight) {
      try {
        target.scrollIntoView({ behavior, block, inline });
      } catch {
        target.scrollIntoView();
      }
    }
  } else {
    try {
      target.scrollIntoView({ behavior, block, inline });
    } catch {
      target.scrollIntoView();
    }
  }
}

/**
 * Initializes automatic scrolling for all chip scrollers within `root`.
 * Automatically scrolls to the selected chip on initial mount and on every click.
 */
export function autoScrollChipScrollers(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  root.querySelectorAll('.chip-scroller, [data-categories], [data-filters], [data-sub-filters], [data-types], .segmented, [data-classes], [data-dimensions], [data-charts]').forEach((scroller) => {
    // Scroll selected chip on mount
    scrollSelectedIntoView(scroller, { behavior: 'instant' });
    setTimeout(() => scrollSelectedIntoView(scroller, { behavior: 'smooth' }), 60);

    if (!scroller.dataset.scrollBound) {
      scroller.dataset.scrollBound = '1';
      scroller.addEventListener('click', (e) => {
        const clickedChip = e.target.closest('.chip, button, [role="tab"]');
        if (clickedChip && scroller.contains(clickedChip)) {
          setTimeout(() => scrollSelectedIntoView(scroller, { behavior: 'smooth' }), 30);
        }
      });
    }
  });
}

/**
 * A sheet listing choices. Resolves with the chosen option's value.
 * Options: { value, label, icon, sub, danger }
 */
export function chooser(title, options) {
  const rows = options.map((opt, i) => `
    <button class="list-row" data-index="${i}">
      ${opt.icon ? `<span class="avatar avatar-sm" style="background:${h(opt.color || 'var(--surface-container-highest)')};color:${h(opt.color ? '#fff' : 'var(--on-surface-variant)')}">${icon(opt.icon)}</span>` : ''}
      <span class="list-row-main">
        <span class="list-row-title" ${opt.danger ? 'style="color:var(--expense)"' : ''}>${h(opt.label)}</span>
        ${opt.sub ? `<span class="list-row-sub">${h(opt.sub)}</span>` : ''}
      </span>
    </button>`).join('');

  return sheet(title, `<div class="list">${rows}</div>`, {
    onMount(node, close) {
      node.querySelectorAll('[data-index]').forEach((btn) => {
        btn.addEventListener('click', () => close(options[Number(btn.dataset.index)].value));
      });
    },
  });
}

/* ------------------------------------------------------------------- menus */

/**
 * A field that opens a menu, in place of a native dropdown.
 *
 * A `<select>` in a WebView hands the choice to the system, which draws it in its own
 * style, with its own type scale, ignoring the theme the rest of the app is painted in.
 * On some devices it is a full-screen list, on others a floating box, and on none of them
 * does it look like it belongs. This is the Material 3 exposed dropdown instead: the
 * closed state is the text field, and the open state is a menu anchored to it.
 *
 * The element it produces exposes `.value`, so anything reading a form the way it would
 * read an input keeps working.
 *
 * @param {object} spec
 * @param {string} spec.key the field name, used as `data-field`
 * @param {string} spec.label
 * @param {string|number} spec.value the current value
 * @param {Array<string|{value, label, sub}>} spec.options
 * @param {boolean} [spec.half] share a row with the next field
 * @param {boolean} [spec.compact] render without wrapper for toolbars/rows
 * @param {string} [spec.placeholder] shown when nothing is chosen
 */
export function selectField({
  key, label, value, options, half = false, compact = false, placeholder = 'Choose', id = `field_${key}`,
}) {
  const normalised = normaliseOptions(options);
  const chosen = normalised.find((option) => String(option.value) === String(value ?? ''));

  if (compact) {
    return `
      <button type="button" class="select-button select-compact" id="${h(id)}" data-field="${h(key)}"
              data-value="${h(chosen ? chosen.value : '')}"
              data-options="${h(JSON.stringify(normalised))}"
              data-label="${h(label || '')}" data-placeholder="${h(placeholder)}"
              aria-haspopup="listbox" aria-expanded="false">
        <span class="select-button-value ${chosen ? '' : 'is-empty'}">
          ${h(chosen ? chosen.label : placeholder)}
        </span>
        ${icon('expand_more', 'select-button-arrow')}
      </button>`;
  }

  return `
    <div class="field" style="${half ? 'flex:1;min-width:0;' : ''}">
      ${label ? `<label class="field-label" for="${h(id)}">${h(label)}</label>` : ''}
      <button type="button" class="select-button" id="${h(id)}" data-field="${h(key)}"
              data-value="${h(chosen ? chosen.value : '')}"
              data-options="${h(JSON.stringify(normalised))}"
              data-label="${h(label || '')}" data-placeholder="${h(placeholder)}"
              aria-haspopup="listbox" aria-expanded="false">
        <span class="select-button-value ${chosen ? '' : 'is-empty'}">
          ${h(chosen ? chosen.label : placeholder)}
        </span>
        ${icon('expand_more', 'select-button-arrow')}
      </button>
    </div>`;
}

function normaliseOptions(options) {
  return options.map((option) => (typeof option === 'object' && option !== null
    ? { value: String(option.value), label: String(option.label ?? option.value), sub: option.sub || '' }
    : { value: String(option), label: String(option), sub: '' }));
}

let activeMenuController = null;

/**
 * Closes any currently open dropdown menu across the entire application.
 * Enforces the Material Design guideline of having at most 1 dropdown open at a time.
 */
export function closeOpenMenus() {
  if (activeMenuController) {
    const { close } = activeMenuController;
    activeMenuController = null;
    close(null);
  }
  // Ensure any detached elements or lingering states are reset
  if (typeof document !== 'undefined') {
    document.querySelectorAll('.menu, .menu-scrim').forEach((el) => el.remove());
    document.querySelectorAll('.select-button[aria-expanded="true"]').forEach((btn) => {
      btn.setAttribute('aria-expanded', 'false');
    });
  }
}

/**
 * Wires up every menu field inside `root`.
 *
 * Called once after the markup is in the document. Each button gains a `value` property,
 * so the surrounding code reads it exactly as it read a native control, and setting that
 * property updates what is on screen.
 */
export function bindSelectFields(root = document) {
  root.querySelectorAll('.select-button:not([data-bound])').forEach((button) => {
    button.dataset.bound = '1';
    const options = JSON.parse(button.dataset.options || '[]');

    const paint = () => {
      const chosen = options.find((option) => option.value === button.dataset.value);
      const text = button.querySelector('.select-button-value');
      text.textContent = chosen ? chosen.label : button.dataset.placeholder;
      text.classList.toggle('is-empty', !chosen);
    };

    Object.defineProperty(button, 'value', {
      configurable: true,
      get: () => button.dataset.value,
      set(next) {
        button.dataset.value = next === null || next === undefined ? '' : String(next);
        paint();
      },
    });

    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      // If clicking the button of the already open menu, toggle it closed
      if (button.getAttribute('aria-expanded') === 'true') {
        closeOpenMenus();
        return;
      }
      const picked = await openMenu(button, options, button.dataset.value);
      if (picked === null) return;
      button.value = picked;
      button.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

/**
 * The open state: a surface anchored under the field, or above it when there is no room
 * below. Dismissing it resolves null, so a cancelled choice changes nothing.
 *
 * Follows Material Design 3 guidelines:
 * - Only 1 dropdown open at a time globally (closes any other active menu).
 * - Closes on outside tap, window resize, scroll, or Escape key.
 * - Supports keyboard navigation (ArrowUp / ArrowDown / Enter).
 */
export function openMenu(anchor, options, current) {
  // Always close any other open dropdown before opening this one
  closeOpenMenus();

  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'menu-scrim';

    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', anchor.dataset.label || 'Options');
    menu.innerHTML = options.map((option) => `
      <button type="button" class="menu-item ${option.value === current ? 'is-selected' : ''}"
              role="option" aria-selected="${option.value === current}"
              data-value="${h(option.value)}">
        <span class="menu-item-main">
          <span class="menu-item-label">${h(option.label)}</span>
          ${option.sub ? `<span class="menu-item-sub">${h(option.sub)}</span>` : ''}
        </span>
        ${option.value === current ? icon('check', 'menu-item-check') : ''}
      </button>`).join('');

    document.body.appendChild(scrim);
    document.body.appendChild(menu);
    anchor.setAttribute('aria-expanded', 'true');

    const box = anchor.getBoundingClientRect();
    const margin = 8;
    const minW = Math.max(box.width, 220);
    const calculatedWidth = Math.min(minW, window.innerWidth - margin * 2);
    menu.style.minWidth = `${calculatedWidth}px`;
    menu.style.maxWidth = `${window.innerWidth - margin * 2}px`;

    const leftOffset = Math.max(margin, Math.min(box.left + (box.width - calculatedWidth) / 2, window.innerWidth - calculatedWidth - margin));
    menu.style.left = `${leftOffset}px`;

    // Limit dropdown height to at most 5-6 options (~280px) and keep within screen bounds
    const maxMenuHeight = 280;
    const below = window.innerHeight - box.bottom - margin;
    const above = box.top - margin;
    const effectiveMaxHeight = Math.min(maxMenuHeight, Math.max(160, Math.max(below, above)));
    menu.style.maxHeight = `${effectiveMaxHeight}px`;

    // Below the field when it fits, above it when it does not.
    const height = Math.min(menu.offsetHeight || maxMenuHeight, effectiveMaxHeight);
    menu.style.top = height <= below || below >= box.top
      ? `${box.bottom + 4}px`
      : `${Math.max(margin, box.top - height - 4)}px`;

    requestAnimationFrame(() => {
      menu.classList.add('open');
      const selectedItem = menu.querySelector('.menu-item.is-selected');
      if (selectedItem) {
        try {
          selectedItem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch {
          selectedItem.scrollIntoView();
        }
      }
    });

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      if (activeMenuController?.close === close) activeMenuController = null;
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleDismiss);
      anchor.setAttribute('aria-expanded', 'false');
      menu.classList.remove('open');
      scrim.remove();
      setTimeout(() => {
        menu.remove();
        resolve(value);
      }, 140);
    };

    const handleDismiss = () => close(null);

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...menu.querySelectorAll('.menu-item')];
        const currentIndex = items.indexOf(document.activeElement);
        const nextIndex = e.key === 'ArrowDown'
          ? (currentIndex + 1) % items.length
          : (currentIndex - 1 + items.length) % items.length;
        items[nextIndex]?.focus();
      }
    };

    activeMenuController = { close, anchor };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleDismiss, { once: true });

    scrim.addEventListener('click', handleDismiss);
    menu.querySelectorAll('[data-value]').forEach((item) => {
      item.addEventListener('click', () => close(item.dataset.value));
    });

    requestAnimationFrame(() => {
      menu.classList.add('open');
      const selected = menu.querySelector('.is-selected');
      if (selected) {
        selected.scrollIntoView({ block: 'nearest' });
      }
    });
  });
}

/**
 * Asks for a file. Resolves { name, size, text } for text, or { name, size, base64 } when
 * `binary` is set. Resolves null if the picker was dismissed.
 *
 * Binary files are read straight to base64. Calling .text() on a PDF decodes its bytes as
 * UTF-8 and quietly corrupts them, which is not obvious until the parser rejects the file.
 */
export function pickFile(accept, { binary = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    // A display:none input is not reliably clickable in every WebView, so keep it in the
    // layout and hide it off-screen instead.
    input.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0';
    document.body.appendChild(input);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      window.removeEventListener('focus', onReturn);
      resolve(value);
    };

    // Cancelling the system picker fires no change event, so a dismissal is detected by
    // the window regaining focus with nothing selected.
    const onReturn = () => setTimeout(() => {
      if (!settled && !(input.files && input.files.length)) finish(null);
    }, 2000);

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) {
        finish(null);
        return;
      }

      try {
        const payload = { name: file.name, size: file.size, file };
        if (binary) payload.base64 = await readAsBase64(file);
        else payload.text = await file.text();
        finish(payload);
      } catch (error) {
        console.error('Could not read the chosen file', error);
        toast('That file could not be read.', 'error');
        finish(null);
      }
    });

    window.addEventListener('focus', onReturn);
    input.click();
  });
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Hands a generated file to the user. Inside the WebView this saves directly to the device's
 * public Downloads directory; in a desktop browser it is an ordinary anchor download.
 */
export function saveFile(filename, contents, mime = 'application/octet-stream') {
  let base64;
  if (typeof contents === 'string') {
    base64 = encodeBase64(new TextEncoder().encode(contents));
  } else if (contents instanceof Uint8Array || contents instanceof ArrayBuffer) {
    base64 = encodeBase64(contents);
  } else {
    base64 = encodeBase64(new TextEncoder().encode(String(contents ?? '')));
  }
  return nativeSaveFile(filename, mime, base64);
}

/**
 * Renders a failed backend reply.
 *
 * The message says what happened, the hint says what to do about it, and the code is
 * shown small so it can be quoted in a bug report. Codes are stable across wording
 * changes; see js/backend/errors.js.
 */
export function errorBlock(res, { compact = false } = {}) {
  if (!res) return '';
  const code = res.code ? `<span class="error-code">${h(res.code)}</span>` : '';

  if (compact) {
    return `<div class="caption expense">${h(res.message || 'That did not work.')} ${code}</div>`;
  }

  return `
    <div class="error-panel">
      <div class="row" style="gap:10px;align-items:flex-start">
        ${icon('error')}
        <div class="banner-main">
          <div class="banner-title">${h(res.message || 'That did not work.')}</div>
          ${res.hint ? `<div class="caption" style="margin-top:6px">${h(res.hint)}</div>` : ''}
        </div>
      </div>
      ${res.code || res.detail ? `
        <div class="error-meta">
          ${code}
          ${res.detail ? `<span class="error-detail">${h(res.detail)}</span>` : ''}
        </div>` : ''}
    </div>`;
}

/** Empty state block for a list that has nothing in it yet. */
export function emptyState(glyph, title, body, actionHtml = '') {
  return `
    <div class="empty">
      ${icon(glyph)}
      <div class="empty-title">${h(title)}</div>
      ${body ? `<div class="empty-body">${h(body)}</div>` : ''}
      ${actionHtml}
    </div>`;
}

/**
 * Prominent, bold and unmissable disclaimer card for tax calculations and capital gains.
 */
export function taxDisclaimerCard({ compact = false, customText = '' } = {}) {
  const defaultText = 'Vitta Vriksha is an offline personal productivity tool and NOT a financial institution, SEBI-registered advisor, or Chartered Accountant. All capital gains, holding periods, grandfathering values, and tax projections are estimates generated strictly for personal tracking based on user-provided data and statutory formulas. Always verify calculations with a certified Chartered Accountant (CA) or broker statements before filing Income Tax Returns.';
  const text = customText || defaultText;

  if (compact) {
    return `
      <div class="tax-disclaimer-compact" role="note">
        <span style="color:var(--warning);display:flex;flex-shrink:0;margin-top:1px">${icon('warning', 'icon-sm')}</span>
        <div>
          <strong class="banner-title">Productivity Tool Only — No Financial or Tax Advice:</strong>
          <span class="banner-body"> ${h(text)}</span>
        </div>
      </div>`;
  }

  return `
    <div class="tax-disclaimer" role="note">
      <div class="tax-disclaimer-header">
        <span style="color:var(--warning);display:flex;flex-shrink:0">${icon('warning', 'icon-sm')}</span>
        <span class="tax-disclaimer-title">Notice: Estimator & Productivity Tool Only — No Tax Advice</span>
      </div>
      <div class="tax-disclaimer-text">
        ${h(text)}
      </div>
    </div>`;
}

