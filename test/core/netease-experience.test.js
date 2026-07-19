'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  collectPaged,
  itemIdentity,
  mergeUnique,
  pageItems,
  shouldInvalidateSession,
} = require('../../public/js/core/netease-experience');

test('exposes the paging helpers through the browser core namespace', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../public/js/core/netease-experience.js'),
    'utf8',
  );
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'netease-experience.js' });
  assert.equal(typeof context.MineradioCore.neteaseExperience.collectPaged, 'function');
  assert.equal(typeof context.MineradioCore.neteaseExperience.mergeUnique, 'function');
});

test('merges Netease entities without repeating ids', () => {
  const merged = mergeUnique(
    [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
    [{ id: 2, name: 'B duplicate' }, { id: 3, name: 'C' }],
  );
  assert.deepEqual(merged.map((item) => item.id), [1, 2, 3]);
  assert.equal(itemIdentity({ id: 42, provider: 'netease' }), 'netease:42');
});

test('reads result arrays from top-level and nested API payloads', () => {
  assert.deepEqual(pageItems({ albums: [{ id: 1 }] }, ['albums']), [{ id: 1 }]);
  assert.deepEqual(pageItems({ result: { artists: [{ id: 2 }] } }, ['artists']), [{ id: 2 }]);
});

test('successful public responses still invalidate an expired active login', () => {
  assert.equal(shouldInvalidateSession({ ok: true, authExpired: true, loggedIn: false }, true), true);
  assert.equal(shouldInvalidateSession({ ok: true, loggedIn: false }, true), true);
  assert.equal(shouldInvalidateSession({ ok: true, loggedIn: false }, false), false);
  assert.equal(shouldInvalidateSession({ ok: true, loggedIn: null, authExpired: false }, true), false);
});

test('collects every page using server offsets and removes overlaps', async () => {
  const offsets = [];
  const pages = {
    0: { songs: [{ id: 1 }, { id: 2 }], total: 5, limit: 2, offset: 0, hasMore: true },
    2: { songs: [{ id: 2 }, { id: 3 }], total: 5, limit: 2, offset: 2, hasMore: true },
    4: { songs: [{ id: 4 }, { id: 5 }], total: 5, limit: 2, offset: 4, hasMore: false },
  };
  const progress = [];
  const result = await collectPaged(
    async ({ offset }) => {
      offsets.push(offset);
      return pages[offset];
    },
    {
      limit: 2,
      keys: ['songs'],
      onPage: ({ items }) => progress.push(items.length),
    },
  );

  assert.deepEqual(offsets, [0, 2, 4]);
  assert.deepEqual(result.items.map((item) => item.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(progress, [2, 3, 5]);
  assert.equal(result.complete, true);
});

test('honors an explicit nextOffset when a response contains fewer usable items than its page size', async () => {
  const offsets = [];
  const result = await collectPaged(
    async ({ offset }) => {
      offsets.push(offset);
      if (offset === 0) {
        return {
          songs: [{ id: 1 }, { id: 2 }],
          total: 5,
          limit: 3,
          offset: 0,
          nextOffset: 3,
          hasMore: true,
        };
      }
      return {
        songs: [{ id: 4 }, { id: 5 }],
        total: 5,
        limit: 3,
        offset: 3,
        nextOffset: 5,
        hasMore: false,
      };
    },
    { limit: 3, keys: ['songs'] },
  );

  assert.deepEqual(offsets, [0, 3]);
  assert.deepEqual(result.items.map((item) => item.id), [1, 2, 4, 5]);
  assert.equal(result.nextOffset, 5);
  assert.equal(result.complete, true);
});

test('continues past an empty mapped page when the server cursor advances', async () => {
  const offsets = [];
  const result = await collectPaged(async ({ offset }) => {
    offsets.push(offset);
    if (offset === 0) {
      return { songs: [], total: 4, limit: 2, offset: 0, nextOffset: 2, hasMore: true };
    }
    return { songs: [{ id: 3 }, { id: 4 }], total: 4, limit: 2, offset: 2, nextOffset: 4, hasMore: false };
  }, { limit: 2, keys: ['songs'] });

  assert.deepEqual(offsets, [0, 2]);
  assert.deepEqual(result.items.map((item) => item.id), [3, 4]);
  assert.equal(result.complete, true);
});

test('attaches safely playable partial results when a later page fails', async () => {
  await assert.rejects(
    collectPaged(
      async ({ offset }) => {
        if (offset === 2) throw new Error('network failed');
        return { tracks: [{ id: 1 }, { id: 2 }], total: 4, limit: 2, offset, hasMore: true };
      },
      { limit: 2, keys: ['tracks'] },
    ),
    (error) => {
      assert.equal(error.message, 'network failed');
      assert.deepEqual(error.partialResult.items.map((item) => item.id), [1, 2]);
      assert.equal(error.partialResult.nextOffset, 2);
      return true;
    },
  );
});
