import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openEmail } from '../app/src/main/assets/www/js/backend/native.js';
import { Bridge } from '../app/src/main/assets/www/js/bridge.js';

describe('Support & Email Integration', () => {
  it('invokes bridge.openEmail when available', () => {
    let captured = null;
    globalThis.window = {
      AndroidBridge: {
        openEmail: (email, subject, body) => {
          captured = { email, subject, body };
          return true;
        },
      },
    };

    const res = openEmail('help@chikatistudio.com', 'Bug report', 'Details here');
    assert.equal(res, true);
    assert.deepEqual(captured, {
      email: 'help@chikatistudio.com',
      subject: 'Bug report',
      body: 'Details here',
    });

    const bridgeRes = Bridge.openEmail('help@chikatistudio.com', 'Help request', 'Need help');
    assert.equal(bridgeRes, true);
    assert.deepEqual(captured, {
      email: 'help@chikatistudio.com',
      subject: 'Help request',
      body: 'Need help',
    });

    delete globalThis.window;
  });

  it('falls back to mailto url when on web/desktop', () => {
    globalThis.window = {
      location: { href: '' },
    };

    const res = openEmail('help@chikatistudio.com', 'Test Subject', 'Test Body');
    assert.equal(res, true);
    assert.ok(globalThis.window.location.href.startsWith('mailto:help%40chikatistudio.com'));

    delete globalThis.window;
  });
});
