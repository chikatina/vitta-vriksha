import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import fs from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_JS = fileURLToPath(new URL('../app/src/main/assets/www/js', import.meta.url));
const WASM_PATH = fileURLToPath(new URL('../app/src/main/assets/www/vendor/sqlite/sqlite3.wasm', import.meta.url));

function mockElement(tag = 'div', id = '') {
  const listeners = new Map();
  const classes = new Set();
  const children = [];
  const attributes = new Map();

  const elem = {
    tagName: tag.toUpperCase(),
    id,
    className: '',
    innerHTML: '',
    textContent: '',
    scrollTop: 0,
    style: {},
    dataset: {},
    classList: {
      add(c) { classes.add(c); elem.className = [...classes].join(' '); },
      remove(c) { classes.delete(c); elem.className = [...classes].join(' '); },
      toggle(c, force) {
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c); else classes.add(c);
        } else if (force) classes.add(c); else classes.delete(c);
        elem.className = [...classes].join(' ');
      },
      contains(c) { return classes.has(c); },
    },
    setAttribute(k, v) { attributes.set(k, String(v)); },
    getAttribute(k) { return attributes.get(k) || null; },
    hasAttribute(k) { return attributes.has(k); },
    removeAttribute(k) { attributes.delete(k); },
    appendChild(child) { children.push(child); return child; },
    remove() {},
    querySelectorAll(sel) {
      if (sel === '[data-tab]') {
        return [
          mockElement('button'), mockElement('button'), mockElement('button'),
          mockElement('button'), mockElement('button'),
        ];
      }
      return [mockElement('div')];
    },
    querySelector() { return mockElement('div'); },
    addEventListener(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    removeEventListener(evt, fn) {
      if (!listeners.has(evt)) return;
      listeners.set(evt, listeners.get(evt).filter((f) => f !== fn));
    },
    insertAdjacentHTML(pos, html) {
      elem.innerHTML += html;
    },
  };
  return elem;
}

function setupMockDom() {
  const elements = new Map([
    ['view', mockElement('main', 'view')],
    ['appBar', mockElement('header', 'appBar')],
    ['appBarTitle', mockElement('h1', 'appBarTitle')],
    ['backButton', mockElement('button', 'backButton')],
    ['lockButton', mockElement('button', 'lockButton')],
    ['fab', mockElement('button', 'fab')],
    ['navBar', mockElement('nav', 'navBar')],
  ]);

  const storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };

  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => mockElement(tag),
    body: mockElement('body'),
    documentElement: mockElement('html'),
  };

  globalThis.window = {
    localStorage: globalThis.localStorage,
    document: globalThis.document,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    history: { pushState: () => {} },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
  };
}

function findJsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findJsFiles(full));
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      results.push(full);
    }
  }
  return results;
}

describe('Build & Runtime integrity: all application files import cleanly', () => {
  before(async () => {
    setupMockDom();
    const { configureRuntime } = await import(
      new URL('../app/src/main/assets/www/js/backend/sqlite.js', import.meta.url).href
    );
    configureRuntime({
      wasmBinary: fs.readFileSync(WASM_PATH),
    });
  });

  const allFiles = findJsFiles(ROOT_JS);

  it('finds all frontend and backend JS source files', () => {
    assert.ok(allFiles.length >= 25, `Found ${allFiles.length} files`);
  });

  for (const file of allFiles) {
    const rel = relative(ROOT_JS, file).replace(/\\/g, '/');
    it(`imports and parses ${rel} without syntax or resolution errors`, async () => {
      const fileUrl = new URL(`file://${file.replace(/\\/g, '/')}`).href;
      const mod = await import(fileUrl);
      assert.ok(mod, `Module ${rel} must export an object`);
    });
  }
});

describe('Lock screen and Setup smoke test', () => {
  it('renders lock screen with visible Forgot PIN button in lock-footer', async () => {
    const { renderLock } = await import(
      new URL('../app/src/main/assets/www/js/views/lock.js', import.meta.url).href
    );
    const mockApp = {
      resume: async () => {},
      restart: async () => {},
    };

    const node = renderLock(mockApp);
    const html = node?.innerHTML || '';

    assert.ok(html.includes('lock-footer'), 'Lock screen must contain lock-footer container');
    assert.ok(html.includes('data-forgot'), 'Lock footer must contain data-forgot button');
    assert.ok(html.includes('Forgot your PIN?'), 'Lock screen must display "Forgot your PIN?" message');
  });
});
