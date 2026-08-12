import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  encryptData, decryptData, BackupDecryptError,
  newDataKey, wrapDataKey, unwrapDataKey, rewrapDataKey,
  hashPin, pinMatches,
} from '../app/src/main/assets/www/js/backend/crypto.js';

describe('crypto.js encryption, PIN and vault envelope operations', () => {
  it('encrypts and decrypts arbitrary text payload', async () => {
    const secret = 'This is a super secret payload with UTF-8: ₹, ₹1,00,000, 🚀';
    const password = 'StrongPassword#123';
    const encrypted = await encryptData(secret, password);
    assert.equal(typeof encrypted, 'string');
    assert.notEqual(encrypted, secret);

    const decrypted = await decryptData(encrypted, password);
    assert.equal(decrypted, secret);
  });

  it('throws BackupDecryptError on wrong password or corrupted payload', async () => {
    const encrypted = await encryptData('some data', 'correctPassword');
    await assert.rejects(
      async () => decryptData(encrypted, 'wrongPassword'),
      BackupDecryptError,
    );
    await assert.rejects(
      async () => decryptData('invalid base64 payload @#$', 'correctPassword'),
      BackupDecryptError,
    );
  });

  it('generates random data key and wraps / unwraps / rewraps key', async () => {
    const dataKey = newDataKey();
    assert.equal(dataKey instanceof Uint8Array, true);
    assert.equal(dataKey.length, 32);

    const pin1 = '1234';
    const pin2 = '5678';
    const envelope = await wrapDataKey(dataKey, pin1);
    assert.equal(typeof envelope, 'string');

    const unwrapped = await unwrapDataKey(envelope, pin1);
    assert.deepEqual(unwrapped, dataKey);

    await assert.rejects(
      async () => unwrapDataKey(envelope, 'wrongPin'),
      BackupDecryptError,
    );

    const rewrapped = await rewrapDataKey(envelope, pin1, pin2);
    const unwrapped2 = await unwrapDataKey(rewrapped, pin2);
    assert.deepEqual(unwrapped2, dataKey);
  });

  it('hashes PIN with salt and verifies matching vs wrong PIN', async () => {
    const pin = '4321';
    const hash1 = await hashPin(pin);
    const hash2 = await hashPin(pin);
    assert.notEqual(hash1, hash2, 'two hashes of same PIN must differ due to random salt');

    assert.equal(await pinMatches(pin, hash1), true);
    assert.equal(await pinMatches(pin, hash2), true);
    assert.equal(await pinMatches('9999', hash1), false);
    assert.equal(await pinMatches(pin, 'corrupted_hash'), false);
  });
});
