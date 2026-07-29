'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lyricCore = require('../../public/js/core/lyrics');

const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'public', 'js', 'v140.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function createSearchRuntime(apiJsonV140) {
  const searchSource = sourceBetween(
    'var MUSIC_SEARCH_PROVIDERS =',
    '  function searchOverflowMarkup',
  );
  const sandbox = {
    window: {},
    apiJsonV140,
    escHtml(value) {
      return String(value);
    },
    finite(value, fallback) {
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    },
    platformStatus() {
      return { loggedIn: true, reauthRequired: false };
    },
    musicSearchProviderUrl(provider, query, limit, offset) {
      return `/${provider}?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
    },
    mergeSongSearchResults(netease, qq, kugou, qishui, spotify, limit) {
      return [].concat(netease, qq, kugou, qishui, spotify).slice(0, limit);
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(`${searchSource}\nwindow.__fetchSearchPage = fetchSearchPage;`, sandbox);
  return sandbox;
}

function requestParts(url) {
  const parsed = new URL(url, 'https://mineradio.local');
  return {
    provider: parsed.pathname.slice(1),
    limit: Number(parsed.searchParams.get('limit')),
    offset: Number(parsed.searchParams.get('offset')),
  };
}

test('combined provider paging preserves every result returned by the page', async () => {
  const runtime = createSearchRuntime(async (url) => {
    const { provider, limit, offset } = requestParts(url);
    return {
      songs: Array.from({ length: limit }, (_, index) => ({
        provider,
        id: `${provider}-${offset + index}`,
        name: `${provider} song ${offset + index}`,
      })),
      nextOffset: offset + limit,
      total: 500,
      hasMore: true,
    };
  });

  const page = await runtime.window.__fetchSearchPage('test', 'song', { providerPages: {} });

  assert.equal(page.songs.length, 64);
  assert.deepEqual(
    Array.from(page.songs.reduce((counts, song) => {
      counts.set(song.provider, (counts.get(song.provider) || 0) + 1);
      return counts;
    }, new Map()).entries()),
    [
      ['netease', 18],
      ['qq', 12],
      ['kugou', 12],
      ['qishui', 12],
      ['spotify', 10],
    ],
  );
});

test('failed provider paging retries from the same offset and clears failure after success', async () => {
  let qishuiFails = true;
  const requests = [];
  const runtime = createSearchRuntime(async (url) => {
    const request = requestParts(url);
    requests.push(request);
    if (request.provider === 'qishui' && qishuiFails) {
      throw new Error('temporary qishui failure');
    }
    return {
      songs: [{
        provider: request.provider,
        id: `${request.provider}-${request.offset}`,
        name: `${request.provider} song`,
      }],
      nextOffset: request.offset + 1,
      total: 1,
      hasMore: false,
    };
  });

  const firstPage = await runtime.window.__fetchSearchPage('retry', 'song', { providerPages: {} });

  assert.equal(firstPage.providerPages.qishui.offset, 0);
  assert.equal(firstPage.providerPages.qishui.nextOffset, 0);
  assert.equal(firstPage.providerPages.qishui.hasMore, true);
  assert.equal(firstPage.providerPages.qishui.failed, true);
  assert.deepEqual(Array.from(firstPage.partialFailures), ['汽水音乐']);
  assert.equal(firstPage.hasMore, true);

  qishuiFails = false;
  const secondPage = await runtime.window.__fetchSearchPage('retry', 'song', {
    providerPages: firstPage.providerPages,
  });
  const qishuiRequests = requests.filter((request) => request.provider === 'qishui');

  assert.deepEqual(qishuiRequests.map((request) => request.offset), [0, 0]);
  assert.equal(secondPage.providerPages.qishui.nextOffset, 1);
  assert.equal(secondPage.providerPages.qishui.hasMore, false);
  assert.equal(secondPage.providerPages.qishui.failed, false);
  assert.deepEqual(Array.from(secondPage.partialFailures), []);
});

test('final lyric override routes all providers and keeps translated lyric variants', async () => {
  const lyricSource = sourceBetween(
    'window.fetchLyric = async function',
    '  // Artist detail keeps hot songs',
  );
  const endpoints = [];
  let renderedLines = [];
  const sandbox = {
    window: {},
    trackSwitchToken: 9,
    lyricCore,
    songProviderKey(song) {
      return song && song.provider || 'netease';
    },
    playbackDurationFromSong() {
      return 245;
    },
    apiJson: async (endpoint) => {
      endpoints.push(endpoint);
      return {
        lyric: '[00:01.00]Original',
        tlyric: '[00:01.00]Translated',
        roma: '[00:01.00]Romanized',
      };
    },
    parseYrcText() {
      return [];
    },
    parseLyricText: lyricCore.parseLrc,
    cloneLyricLine(line) {
      return { ...line };
    },
    withLyricFallback(lines) {
      return lines;
    },
    setOriginalLyricsState(lines) {
      renderedLines = lines;
    },
    applyPreferredLyricsForCurrent() {},
    updateLyricDisplayButton() {},
    encodeURIComponent,
  };

  vm.createContext(sandbox);
  vm.runInContext(lyricSource, sandbox);

  await sandbox.window.fetchLyric('netease-id', 9);
  await sandbox.window.fetchLyric({ provider: 'qq', mid: 'qq mid', id: '123' }, 9);
  await sandbox.window.fetchLyric({
    provider: 'kugou',
    hash: 'hash/value',
    albumAudioId: 'album audio',
  }, 9);
  await sandbox.window.fetchLyric({ provider: 'qishui', providerSongId: 'qishui/id' }, 9);
  await sandbox.window.fetchLyric({ provider: 'spotify', spotifyId: 'spotify:id' }, 9);

  assert.deepEqual(endpoints, [
    '/api/lyric?id=netease-id',
    '/api/qq/lyric?mid=qq%20mid&id=123',
    '/api/kugou/lyric?hash=hash%2Fvalue&albumAudioId=album%20audio&duration=245',
    '/api/qishui/lyric?id=qishui%2Fid',
    '/api/spotify/lyric?id=spotify%3Aid',
  ]);
  assert.equal(renderedLines[0].text, 'Original');
  assert.equal(renderedLines[0].translation, 'Translated');
  assert.equal(renderedLines[0].romanization, 'Romanized');
});
