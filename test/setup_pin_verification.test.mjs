/*
 * PIN Setup and 2nd Verification Stage Verification Test Suite.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, ok } from './_harness.mjs';
import { handleDbAction } from '../app/src/main/assets/www/js/backend/database.js';

let t;

beforeEach(async () => {
  t = await freshBackend();
});

describe('Setup 2nd Stage PIN Verification & Vault Creation', () => {
  it('creates a fresh vault and sets PIN successfully', async () => {
    const res = await handleDbAction({ action: 'create_vault', new_pin: '4321' });
    assert.equal(res.status, 'success');
    assert.equal(res.created, true);

    const unlockRes = await handleDbAction({ action: 'unlock_vault', pin: '4321' });
    assert.equal(unlockRes.status, 'success');
    assert.equal(unlockRes.unlocked, true);
  });

  it('rejects short or non-numeric PINs gracefully', async () => {
    const shortRes = await handleDbAction({ action: 'create_vault', new_pin: '12' });
    assert.equal(shortRes.status, 'error');
    assert.equal(shortRes.code, 'PIN_TOO_SHORT');

    const nonNumRes = await handleDbAction({ action: 'create_vault', new_pin: 'abcd' });
    assert.equal(nonNumRes.status, 'error');
    assert.equal(nonNumRes.code, 'PIN_NOT_NUMERIC');
  });

  it('can recreate vault repeatedly during re-setup without getting blocked by stale files', async () => {
    const res1 = await handleDbAction({ action: 'create_vault', new_pin: '1111' });
    assert.equal(res1.status, 'success');

    // Simulate second setup / PIN recreation
    const res2 = await handleDbAction({ action: 'create_vault', new_pin: '2222' });
    assert.equal(res2.status, 'success');

    const unlockRes = await handleDbAction({ action: 'unlock_vault', pin: '2222' });
    assert.equal(unlockRes.status, 'success');
  });
});
