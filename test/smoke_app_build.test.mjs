import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import fs from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  globalThis.history = globalThis.window.history;
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
      const fileUrl = pathToFileURL(file).href;
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

  it('app.open navigates to top-level tabs and sub-pages seamlessly', async () => {
    const appModule = await import(
      new URL('../app/src/main/assets/www/js/app.js', import.meta.url).href
    );
    // Instantiate or test App routing logic
    const app = new appModule.default();
    let rendered = false;
    app.render = () => { rendered = true; };

    // Navigate to top-level tab 'budgets'
    app.open('budgets');
    assert.equal(app.tab, 'budgets');
    assert.equal(app.page, null);
    assert.equal(rendered, true);

    // Navigate to sub-page 'cas'
    app.open('cas');
    assert.equal(app.tab, 'wealth');
    assert.equal(app.page, 'cas');

    // Navigate to top-level tab 'home'
    app.open('home');
    assert.equal(app.tab, 'home');
    assert.equal(app.page, null);
  });

  it('renders home page with onboarding checklist without initialization errors', async () => {
    const { Bridge } = await import(
      new URL('../app/src/main/assets/www/js/bridge.js', import.meta.url).href
    );
    const { renderHome } = await import(
      new URL('../app/src/main/assets/www/js/views/home.js', import.meta.url).href
    );
    const origDb = Bridge.db;
    Bridge.db = async (action) => {
      if (action === 'get_summary') {
        return { status: 'success', monthly_budget: 25000, total_assets: 100000, family_members: [] };
      }
      return { status: 'success' };
    };

    const mockContainer = {
      innerHTML: '',
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const mockApp = {
      settings: { onboarding_dismissed: '0' },
      pendingAlerts: [],
      memberFilter: 'all',
      db: Bridge.db,
    };

    try {
      await renderHome(mockContainer, mockApp);
      assert.ok(mockContainer.innerHTML.includes('Getting Started') || mockContainer.innerHTML.includes('Setup Complete!'), 'Must render onboarding card');
      assert.ok(mockContainer.innerHTML.includes('steps completed'), 'Must display completed steps without throwing ReferenceError');
    } finally {
      Bridge.db = origDb;
    }
  });

  it('verifies that every icon referenced in all JS files exists in ICON_CODEPOINTS', async () => {
    const { ICON_CODEPOINTS } = await import(
      new URL('../app/src/main/assets/www/js/icon-codepoints.js', import.meta.url).href
    );

    const jsFiles = [];
    function scanDir(dir) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) scanDir(full);
        else if (entry.endsWith('.js')) jsFiles.push(full);
      }
    }
    scanDir(ROOT_JS);

    const patterns = [
      /\bicon\(\s*['"]([a-zA-Z0-9_-]+)['"]/g,
      /\bglyph:\s*['"]([a-zA-Z0-9_-]+)['"]/g,
      /\bicon:\s*['"]([a-zA-Z0-9_-]+)['"]/g,
      /\bnavRow\([^,]+,\s*['"]([a-zA-Z0-9_-]+)['"]/g,
      /\bemptyState\(\s*['"]([a-zA-Z0-9_-]+)['"]/g,
    ];

    const missingIcons = new Map();

    for (const file of jsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const rel = relative(ROOT_JS, file);

      // Icon calls
      const iconMatches = content.matchAll(/\bicon\(\s*['"]([a-zA-Z0-9_-]+)['"]/g);
      for (const m of iconMatches) {
        const name = m[1];
        if (['icon-sm', 'icon-lg', 'icon-xl', 'true', 'false'].includes(name)) continue;
        if (!ICON_CODEPOINTS[name]) {
          if (!missingIcons.has(name)) missingIcons.set(name, []);
          missingIcons.get(name).push(`${rel} (icon('${name}'))`);
        }
      }

      // Glyph properties
      const glyphMatches = content.matchAll(/\bglyph:\s*['"]([a-zA-Z0-9_-]+)['"]/g);
      for (const m of glyphMatches) {
        const name = m[1];
        if (!ICON_CODEPOINTS[name]) {
          if (!missingIcons.has(name)) missingIcons.set(name, []);
          missingIcons.get(name).push(`${rel} (glyph: '${name}')`);
        }
      }

      // Icon properties
      const propMatches = content.matchAll(/\bicon:\s*['"]([a-zA-Z0-9_-]+)['"]/g);
      for (const m of propMatches) {
        const name = m[1];
        if (['icon-sm', 'icon-lg', 'icon-xl', 'text', 'number', 'select', 'date', 'switch', 'textarea'].includes(name)) continue;
        if (!ICON_CODEPOINTS[name]) {
          if (!missingIcons.has(name)) missingIcons.set(name, []);
          missingIcons.get(name).push(`${rel} (icon: '${name}')`);
        }
      }

      // navRow
      const navMatches = content.matchAll(/\bnavRow\([^,]+,\s*['"]([a-zA-Z0-9_-]+)['"]/g);
      for (const m of navMatches) {
        const name = m[1];
        if (!ICON_CODEPOINTS[name]) {
          if (!missingIcons.has(name)) missingIcons.set(name, []);
          missingIcons.get(name).push(`${rel} (navRow '${name}')`);
        }
      }

      // emptyState
      const emptyMatches = content.matchAll(/\bemptyState\(\s*['"]([a-zA-Z0-9_-]+)['"]/g);
      for (const m of emptyMatches) {
        const name = m[1];
        if (!ICON_CODEPOINTS[name]) {
          if (!missingIcons.has(name)) missingIcons.set(name, []);
          missingIcons.get(name).push(`${rel} (emptyState '${name}')`);
        }
      }
    }

    // Also check DEFAULT_CATEGORIES in database.js
    const dbContent = fs.readFileSync(join(ROOT_JS, 'backend/database.js'), 'utf-8');
    const catMatches = dbContent.matchAll(/\['[^']+',\s*'[^']+',\s*'#[0-9A-Fa-f]+',\s*'([^']+)'\]/g);
    for (const m of catMatches) {
      const name = m[1];
      if (!ICON_CODEPOINTS[name]) {
        if (!missingIcons.has(name)) missingIcons.set(name, []);
        missingIcons.get(name).push('backend/database.js (DEFAULT_CATEGORIES)');
      }
    }

    // Also check GOAL_PRESETS in records.js
    const recContent = fs.readFileSync(join(ROOT_JS, 'views/records.js'), 'utf-8');
    const goalMatches = recContent.matchAll(/icon:\s*'([^']+)'/g);
    for (const m of goalMatches) {
      const name = m[1];
      if (!ICON_CODEPOINTS[name]) {
        if (!missingIcons.has(name)) missingIcons.set(name, []);
        missingIcons.get(name).push('views/records.js (GOAL_PRESETS)');
      }
    }

    if (missingIcons.size > 0) {
      console.log('MISSING ICONS FOUND IN CODEBASE:', JSON.stringify(Object.fromEntries(missingIcons), null, 2));
    }

    assert.deepEqual(Object.fromEntries(missingIcons), {}, 'All UI icons must be present in ICON_CODEPOINTS');
  });
});
