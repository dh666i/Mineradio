'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseDirectReference,
  providerForHost,
  resolveSharedPlaylist,
} = require('../../lib/shared-playlist-resolver');

test('canonical playlist links resolve for all five supported providers', async () => {
  const fixtures = [
    ['netease', '123456789', 'https://music.163.com/#/playlist?id=123456789'],
    ['qq', '7167576049', 'https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=7167576049'],
    ['kugou', '123456', 'https://m.kugou.com/songlist/123456/'],
    ['qishui', '987654321', 'https://music.douyin.com/qishui/share/playlist?playlist_id=987654321'],
    ['spotify', '37i9dQZF1DXcBWIGoYBM5M', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
  ];
  for (const fixture of fixtures) {
    const result = await resolveSharedPlaylist(fixture[2]);
    assert.equal(result.provider, fixture[0]);
    assert.equal(result.id, fixture[1]);
  }
});

test('provider host allowlist rejects unrelated domains', () => {
  assert.equal(providerForHost('music.163.com'), 'netease');
  assert.equal(providerForHost('i2.y.qq.com'), 'qq');
  assert.equal(providerForHost('evil.example'), '');
  assert.equal(parseDirectReference('https://evil.example/playlist?id=123456'), null);
});

test('short links follow a bounded same-provider redirect', async () => {
  const calls = [];
  const result = await resolveSharedPlaylist('https://spotify.link/demo', {
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        status: 302,
        headers: { get(name) { return name.toLowerCase() === 'location' ? 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' : ''; } },
      };
    },
  });
  assert.equal(result.provider, 'spotify');
  assert.equal(result.id, '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(result.redirected, true);
  assert.equal(calls.length, 1);
});

test('cross-provider and arbitrary redirects are blocked', async () => {
  await assert.rejects(
    resolveSharedPlaylist('https://spotify.link/demo', {
      fetchImpl: async () => ({
        status: 302,
        headers: { get() { return 'http://127.0.0.1/private'; } },
      }),
    }),
    error => error && error.code === 'SHARED_PLAYLIST_REDIRECT_BLOCKED',
  );
});
