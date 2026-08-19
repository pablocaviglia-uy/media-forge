import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPersistentId } from '../src/storage/ids.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

test('persistent ids use randomUUID and retain a readable record prefix', () => {
  let calls = 0;
  const cryptoObject = {
    randomUUID() {
      calls += 1;
      return UUID;
    },
  };

  assert.equal(createPersistentId('job', cryptoObject), `job-${UUID}`);
  assert.equal(calls, 1);
});

test('older Web Crypto implementations produce an RFC 4122 UUID fallback', () => {
  const cryptoObject = {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
      return bytes;
    },
  };

  assert.equal(
    createPersistentId('merge-clip', cryptoObject),
    'merge-clip-00010203-0405-4607-8809-0a0b0c0d0e0f',
  );
});

test('a throwing randomUUID falls through to random bytes', () => {
  const cryptoObject = {
    randomUUID() {
      throw new Error('not available in this context');
    },
    getRandomValues(bytes) {
      bytes.fill(0xab);
      return bytes;
    },
  };

  assert.equal(
    createPersistentId('asset', cryptoObject),
    'asset-abababab-abab-4bab-abab-abababababab',
  );
});

test('the no-crypto fallback remains unique within a page lifecycle', () => {
  const first = createPersistentId('job', null);
  const second = createPersistentId('job', null);

  assert.match(first, /^job-legacy-[a-z0-9-]+$/);
  assert.match(second, /^job-legacy-[a-z0-9-]+$/);
  assert.notEqual(first, second);
});

test('persistent ids reject empty or unsafe prefixes', () => {
  assert.throws(() => createPersistentId('', null), /readable prefix/);
  assert.throws(() => createPersistentId('job id', null), /readable prefix/);
});
