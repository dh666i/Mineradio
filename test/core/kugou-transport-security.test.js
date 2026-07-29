'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const kugouApi = require('../../kugou-api');

test('Kugou API endpoints carrying account state use HTTPS', () => {
  const endpoints = kugouApi._test.apiEndpoints;
  assert.deepEqual(Object.keys(endpoints).sort(), ['mobilePlayback', 'playlistSearch', 'search']);
  Object.values(endpoints).forEach((endpoint) => {
    assert.equal(new URL(endpoint).protocol, 'https:', endpoint);
  });

  assert.equal(new URL(endpoints.playlistSearch).hostname, 'mobiles.kugou.com');
});

test('Kugou request transport rejects plaintext HTTP before sending credentials', () => {
  assert.throws(
    () => kugouApi._test.requireSecureKugouUrl('http://songsearch.kugou.com/song_search_v2?token=secret'),
    (error) => error && error.code === 'KUGOU_INSECURE_TRANSPORT'
  );

  const accepted = kugouApi._test.requireSecureKugouUrl('https://gateway.kugou.com/v2/search/song');
  assert.equal(accepted.protocol, 'https:');
});

test('Kugou API implementation has no plaintext HTTP client fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'kugou-api.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]http['"]\)/);
  assert.doesNotMatch(source, /http:\/\//i);
  assert.match(source, /const req = https\.request\(u,/);
});
