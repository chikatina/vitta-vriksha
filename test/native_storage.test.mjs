import test from 'node:test';
import assert from 'node:assert/strict';
import { readDatabase, writeDatabase, deleteDatabase } from '../app/src/main/assets/www/js/backend/native.js';

test('native storage: IndexedDB operations and legacy migration', async (t) => {
  // Simple in-memory mock of IndexedDB for Node.js
  const idbStore = new Map();
  const mockIdb = {
    open: () => {
      const req = {
        result: {
          close: () => {},
          objectStoreNames: { contains: () => true },
          createObjectStore: () => {},
          transaction: () => {
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore: () => ({
                get: (k) => {
                  const getReq = {};
                  setTimeout(() => {
                    getReq.result = idbStore.get(k);
                    if (getReq.onsuccess) getReq.onsuccess();
                    if (tx.oncomplete) tx.oncomplete();
                  }, 0);
                  return getReq;
                },
                put: (v, k) => {
                  const putReq = {};
                  setTimeout(() => {
                    idbStore.set(k, v);
                    if (putReq.onsuccess) putReq.onsuccess();
                    if (tx.oncomplete) tx.oncomplete();
                  }, 0);
                  return putReq;
                },
                delete: (k) => {
                  const delReq = {};
                  setTimeout(() => {
                    idbStore.delete(k);
                    if (delReq.onsuccess) delReq.onsuccess();
                    if (tx.oncomplete) tx.oncomplete();
                  }, 0);
                  return delReq;
                },
              }),
            };
            return tx;
          },
        },
      };
      setTimeout(() => {
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };

  const originalIdb = globalThis.indexedDB;
  const originalLocalStorage = globalThis.localStorage;

  const mockLs = new Map();
  globalThis.localStorage = {
    getItem: (k) => mockLs.get(k) || null,
    setItem: (k, v) => mockLs.set(k, String(v)),
    removeItem: (k) => mockLs.delete(k),
  };
  globalThis.indexedDB = mockIdb;

  t.after(() => {
    globalThis.indexedDB = originalIdb;
    globalThis.localStorage = originalLocalStorage;
  });

  await t.test('writes and reads bytes via IndexedDB', async () => {
    idbStore.clear();
    mockLs.clear();

    const sampleBytes = new Uint8Array([1, 2, 3, 4, 5, 255]);
    await writeDatabase(sampleBytes);

    assert.equal(mockLs.size, 0, 'Should not write to localStorage when IndexedDB is present');
    assert.ok(idbStore.has('database'), 'IndexedDB should contain the database');

    const read = await readDatabase();
    assert.deepEqual(read, sampleBytes);
  });

  await t.test('migrates legacy base64 from localStorage to IndexedDB', async () => {
    idbStore.clear();
    mockLs.clear();

    // Store legacy base64 in localStorage
    mockLs.set('vittavriksha.db', Buffer.from([10, 20, 30, 40]).toString('base64'));

    const read = await readDatabase();
    assert.deepEqual(read, new Uint8Array([10, 20, 30, 40]));

    // Should now be migrated into IndexedDB and cleaned from localStorage
    assert.equal(mockLs.has('vittavriksha.db'), false, 'Legacy localStorage key should be removed');
    assert.ok(idbStore.has('database'), 'Database should now reside in IndexedDB');
  });

  await t.test('deleteDatabase clears IndexedDB and localStorage', async () => {
    idbStore.set('database', new Uint8Array([1, 2, 3]));
    mockLs.set('vittavriksha.db', 'old');

    await deleteDatabase();
    assert.equal(idbStore.has('database'), false);
    assert.equal(mockLs.has('vittavriksha.db'), false);
  });

  await t.test('falls back to localStorage when IndexedDB write fails', async () => {
    idbStore.clear();
    mockLs.clear();

    // Temporarily cause put to fail (simulating QuotaExceededError)
    const originalOpen = globalThis.indexedDB.open;
    globalThis.indexedDB = {
      open: () => {
        const req = {};
        setTimeout(() => {
          if (req.onerror) {
            req.error = new Error('QuotaExceededError: The quota has been exceeded.');
            req.onerror();
          }
        }, 0);
        return req;
      },
    };

    const fallbackBytes = new Uint8Array([99, 88, 77]);
    await writeDatabase(fallbackBytes);

    // Should have fallen back to localStorage
    assert.ok(mockLs.has('vittavriksha.db'), 'Should save to localStorage when IndexedDB fails');
    const read = await readDatabase();
    assert.deepEqual(read, fallbackBytes);

    globalThis.indexedDB = mockIdb;
  });
});
