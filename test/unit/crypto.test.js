import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, encryptJSON, decryptJSON, makeCheck, verifyCheck, randomSalt } from '../../src/crypto.js';

test('records round-trip through AES-GCM and are bound to their id', async () => {
  const salt = randomSalt();
  const key = await deriveKey('correct horse battery', salt, 100000);
  const rec = { id: 'abc', type: 'bp', values: { sys: 108, dia: 71, pulse: 101 }, tags: ['Morning'] };
  const box = await encryptJSON(key, rec, 'abc');
  assert.equal(box.v, 1);
  assert.ok(!JSON.stringify(box).includes('108'));
  assert.deepEqual(await decryptJSON(key, box, 'abc'), rec);
  await assert.rejects(decryptJSON(key, box, 'other-id')); // swapped record is detected
});

test('passphrase check detects a wrong passphrase', async () => {
  const salt = randomSalt();
  const right = await deriveKey('correct horse battery', salt, 100000);
  const wrong = await deriveKey('incorrect horse', salt, 100000);
  const check = await makeCheck(right);
  assert.equal(await verifyCheck(right, check), true);
  assert.equal(await verifyCheck(wrong, check), false);
});
