/*
 * SMS Rule Tester View & UI Integration Test Suite.
 *
 * Verifies that the interactive SMS Rule Tester renders correctly,
 * parses messages without "That did not work" errors, correctly displays
 * transaction attributes, handles OTP/non-transaction filtering, clear actions,
 * and rule creation triggers.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { freshBackend, ok } from './_harness.mjs';

function setupMockDom() {
  const elements = new Map();

  function makeElem(tag = 'div', id = '') {
    const listeners = new Map();
    const classes = new Set();
    const children = [];
    const attributes = new Map();

    const elem = {
      tagName: tag.toUpperCase(),
      tag,
      id,
      className: '',
      innerHTML: '',
      textContent: '',
      value: '',
      type: '',
      checked: false,
      style: {},
      dataset: {},
      classList: {
        add(...cs) { cs.forEach((c) => classes.add(c)); elem.className = [...classes].join(' '); },
        remove(...cs) { cs.forEach((c) => classes.delete(c)); elem.className = [...classes].join(' '); },
        contains(c) { return classes.has(c); },
      },
      setAttribute(k, v) { attributes.set(k, String(v)); },
      getAttribute(k) { return attributes.get(k) || null; },
      appendChild(child) { children.push(child); return child; },
      removeChild(child) {
        const idx = children.indexOf(child);
        if (idx >= 0) children.splice(idx, 1);
      },
      remove() {},
      addEventListener(evt, fn) {
        if (!listeners.has(evt)) listeners.set(evt, []);
        listeners.get(evt).push(fn);
      },
      removeEventListener(evt, fn) {
        if (!listeners.has(evt)) return;
        listeners.set(evt, listeners.get(evt).filter((f) => f !== fn));
      },
      dispatchEvent(evt) {
        const name = typeof evt === 'string' ? evt : evt.type;
        const list = listeners.get(name) || [];
        list.forEach((fn) => fn({ type: name, target: elem, currentTarget: elem, preventDefault: () => {} }));
      },
      click() { elem.dispatchEvent('click'); },
      querySelector(sel) {
        return elements.get(sel) || makeElem('div');
      },
      querySelectorAll() {
        return [];
      },
      registerNamed(sel, el) {
        elements.set(sel, el);
      },
      lookupNamed(sel) {
        return elements.get(sel);
      },
    };
    return elem;
  }

  if (!globalThis.document) {
    globalThis.document = {
      getElementById: (id) => elements.get(id) || makeElem('div', id),
      querySelector: (sel) => elements.get(sel) || makeElem('div'),
      querySelectorAll: () => [],
      createElement: (tag) => makeElem(tag),
      body: makeElem('body'),
      documentElement: makeElem('html'),
    };
  }

  return { makeElem };
}

describe('SMS Rule Tester View Integration', () => {
  let db;
  let RulesView;

  before(async () => {
    db = await freshBackend();
    RulesView = await import('../app/src/main/assets/www/js/views/rules.js');
  });

  it('renders rule tester and correctly classifies SMS without "That did not work" error', async () => {
    const { makeElem } = setupMockDom();
    const container = makeElem('div', 'container');

    const testInput = makeElem('textarea');
    const testSender = makeElem('input');
    const runBtn = makeElem('button');
    const clearBtn = makeElem('button');
    const resultDiv = makeElem('div');

    container.registerNamed('[data-test]', testInput);
    container.registerNamed('[data-test-sender]', testSender);
    container.registerNamed('[data-run]', runBtn);
    container.registerNamed('[data-clear-test]', clearBtn);
    container.registerNamed('[data-result]', resultDiv);

    const mockApp = {
      tab: 'more',
      page: 'rules',
      currency: 'INR',
      locale: 'en-IN',
      settings: { currency: 'INR' },
      go: () => {},
      refresh: () => {},
      openSheet: () => {},
    };

    await RulesView.renderRules(container, mockApp);

    // 1. Enter dividend SMS into test input
    testInput.value = 'ICICI Bank Account XX486 credited:Rs. 25.00 on 10-Jul-26. Info ACH*TATAPOWERDIV10072026*245. Available Balance is Rs. 13,807.86.';
    testSender.value = 'ICICIB';

    // 2. Click "Test it"
    runBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // 3. Assert result output
    assert.ok(!resultDiv.innerHTML.includes('That did not work'), 'Must not show "That did not work" error');
    assert.ok(resultDiv.innerHTML.includes('₹25'), 'Must show detected amount ₹25');
    assert.ok(resultDiv.innerHTML.includes('Income'), 'Must show type Income');
    assert.ok(resultDiv.innerHTML.includes('TATAPOWER'), 'Must show detected merchant TATAPOWER');
    assert.ok(resultDiv.innerHTML.includes('Interest &amp; Dividends'), 'Must categorize as Interest & Dividends');
    assert.ok(resultDiv.innerHTML.includes('Create Rule from this Alert'), 'Must offer 1-tap rule creation button');

    // 4. Test Clear button
    clearBtn.click();
    assert.equal(testInput.value, '');
    assert.equal(testSender.value, '');
    assert.equal(resultDiv.innerHTML, '');

    // 5. Test Non-transaction / OTP Alert
    testInput.value = 'Your OTP for ICICI Bank transaction is 654321. Do not share it with anyone.';
    runBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.ok(!resultDiv.innerHTML.includes('That did not work'));
    assert.ok(resultDiv.innerHTML.includes('Non-Transaction'));
    assert.ok(resultDiv.innerHTML.includes('OTP'));
  });
});
