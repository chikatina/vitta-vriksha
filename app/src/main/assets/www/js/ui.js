/*
 * Overlay primitives: toasts, dialogs and bottom sheets.
 *
 * Nothing in the app should call window.alert, window.confirm or window.prompt. Those
 * render Chrome's own dialogs inside the WebView, which look nothing like the app and
 * block the JS thread. Everything here is promise based and themed.
 */

import { ICON_CODEPOINTS } from './icon-codepoints.js';

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
        if (focusable) setTimeout(() => focusable.focus(), OVERLAY_MS);
      }
    });
  });
}

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
    return node;
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
 * @param {string} [spec.placeholder] shown when nothing is chosen
 */
export function selectField({
  key, label, value, options, half = false, placeholder = 'Choose', id = `field_${key}`,
}) {
  const normalised = normaliseOptions(options);
  const chosen = normalised.find((option) => String(option.value) === String(value ?? ''));

  return `
    <div class="field" style="${half ? 'flex:1;min-width:0;' : ''}">
      <label class="field-label" for="${h(id)}">${h(label)}</label>
      <button type="button" class="select-button" id="${h(id)}" data-field="${h(key)}"
              data-value="${h(chosen ? chosen.value : '')}"
              data-options="${h(JSON.stringify(normalised))}"
              data-label="${h(label)}" data-placeholder="${h(placeholder)}"
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

    // Below the field when it fits, above it when it does not.
    const height = menu.offsetHeight || 200;
    const below = window.innerHeight - box.bottom - margin;
    menu.style.top = height <= below || below >= box.top
      ? `${box.bottom + 4}px`
      : `${Math.max(margin, box.top - height - 4)}px`;
    menu.style.maxHeight = `${Math.max(160, Math.max(below, box.top) - margin)}px`;

    requestAnimationFrame(() => {
      menu.classList.add('open');
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
    }, 800);

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
 * Hands a generated file to the user. Inside the WebView this goes through the Android
 * download manager; in a desktop browser it is an ordinary anchor click.
 */
export function saveFile(filename, contents, mime = 'application/octet-stream') {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
