'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const experience = require(path.join(root, 'public', 'js', 'core', 'netease-experience.js'));

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const artistActionSource = sourceBetween(
  indexSource,
  'function syncArtistDetailActions',
  'function collectArtistDetailSong',
);

function makeSongs(start, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: start + index,
    name: `Song ${start + index}`,
    artist: 'Artist',
    provider: 'netease',
  }));
}

function createHarness(apiJson) {
  const elements = {
    'artist-detail-play-all': {
      disabled: false,
      setAttribute(name, value) { this[name] = value; },
    },
    'artist-detail-play-all-label': { textContent: '' },
    'artist-detail-song-count': { textContent: '' },
  };
  const calls = {
    closed: 0,
    played: [],
    queueRendered: 0,
    shelfRebuilt: 0,
    toasts: [],
  };
  const initialSongs = makeSongs(1, 36);
  const context = vm.createContext({
    console,
    document: {
      getElementById(id) { return elements[id] || null; },
    },
    window: {
      MineradioCore: { neteaseExperience: experience },
    },
    CustomEvent: function CustomEvent(type, options) {
      this.type = type;
      this.detail = options && options.detail;
    },
    trackDetailSeq: 7,
    detailArtistSongs: initialSongs,
    ARTIST_DETAIL_PLAY_LIMIT: 100,
    artistDetailState: {
      provider: 'netease',
      artistId: '501',
      artistMid: '',
      total: 300,
      nextOffset: 36,
      hasMore: true,
      loading: false,
      playAllBusy: false,
      progressCount: 0,
      token: 7,
    },
    playQueue: [],
    currentIdx: -1,
    cloneSong(song) { return { ...song }; },
    queueItemKey(song) { return `${song.provider || 'netease'}:${song.id}`; },
    songCoverSrc() { return ''; },
    escHtml(value) { return String(value || ''); },
    artistCollectTrayIconSvg() { return ''; },
    artistNextPlusIconSvg() { return ''; },
    songDurationLabel() { return ''; },
    safeRenderQueuePanel() { calls.queueRendered += 1; },
    safeShelfRebuild() { calls.shelfRebuilt += 1; },
    closeTrackDetailModal() { calls.closed += 1; },
    playQueueAt(index) {
      calls.played.push(index);
      return Promise.resolve();
    },
    showToast(message) { calls.toasts.push(message); },
    apiJson,
  });
  vm.runInContext(artistActionSource, context);
  return { calls, context, elements, initialSongs };
}

test('artist play-all caps a large artist catalog at the first 100 hot songs', async () => {
  const requests = [];
  const harness = createHarness(async url => {
    const parsed = new URL(url, 'http://127.0.0.1');
    const offset = Number(parsed.searchParams.get('offset'));
    const limit = Number(parsed.searchParams.get('limit'));
    requests.push({ offset, limit });
    return {
      songs: makeSongs(37, 64),
      total: 300,
      offset,
      limit,
      nextOffset: 100,
      hasMore: true,
    };
  });

  await harness.context.playArtistDetailAll();

  assert.deepEqual(requests, [{ offset: 36, limit: 64 }]);
  assert.equal(harness.context.playQueue.length, 100);
  assert.equal(new Set(harness.context.playQueue.map(song => song.id)).size, 100);
  assert.equal(harness.context.currentIdx, 0);
  assert.deepEqual(harness.calls.played, [0]);
  assert.equal(harness.calls.closed, 1);
  assert.match(harness.calls.toasts.at(-1), /热门歌曲 100 首/);
});

test('artist play-all keeps and plays the loaded first page when a later page fails', async () => {
  const harness = createHarness(async () => {
    throw new Error('upstream unavailable');
  });

  await harness.context.playArtistDetailAll();

  assert.equal(harness.context.playQueue.length, 36);
  assert.deepEqual(harness.calls.played, [0]);
  assert.equal(harness.calls.closed, 1);
  assert.match(harness.calls.toasts.at(-1), /加载中断，播放已获取的 36 首/);
});

test('artist play-all does not start playback after the detail view is invalidated', async () => {
  let harness;
  harness = createHarness(async url => {
    harness.context.trackDetailSeq += 1;
    const parsed = new URL(url, 'http://127.0.0.1');
    const offset = Number(parsed.searchParams.get('offset'));
    return {
      songs: makeSongs(37, 10),
      total: 46,
      offset,
      limit: 80,
      nextOffset: 46,
      hasMore: false,
    };
  });

  await harness.context.playArtistDetailAll();

  assert.deepEqual(harness.calls.played, []);
  assert.equal(harness.calls.closed, 0);
  assert.deepEqual(harness.context.playQueue, []);
});
