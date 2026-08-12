import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, ok, monthsAgo } from './_harness.mjs';
import { handleCasAction } from '../app/src/main/assets/www/js/backend/cas.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('cas.js statement parsing and error handling', () => {
  it('handles unknown action with coded error', async () => {
    const unknown = await handleCasAction({ action: 'unknown_cas_action' });
    assert.equal(unknown.status, 'error');
    assert.equal(unknown.code, 'UNKNOWN_ACTION');
  });

  it('rejects missing or invalid PDF input with coded error', async () => {
    const res = await handleCasAction({ action: 'parse_base64' });
    assert.equal(res.status, 'error');
    assert.equal(res.code, 'CAS_NO_FILE');

    const resInvalid = await handleCasAction({ action: 'parse_base64', pdf_base64: 'invalid' });
    assert.equal(resInvalid.status, 'error');
    assert.equal(resInvalid.code, 'CAS_NOT_PDF');
  });

  it('rejects diagnose with invalid payload', async () => {
    const res = await handleCasAction({ action: 'diagnose', pdf_base64: '' });
    assert.equal(res.status, 'error');
    assert.equal(res.code, 'CAS_NO_FILE');
  });
});
