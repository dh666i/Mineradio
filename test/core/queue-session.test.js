'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const queueSession = require('../../public/js/core/queue-session');

function song(id, extra) {
  return Object.assign({
    id,
    name: `Song ${id}`,
    artist: 'Artist',
    cover: `https://img.example/${id}.jpg`,
  }, extra || {});
}

test('sanitizeSong removes volatile and sensitive playback data', () => {
  const clean = queueSession.sanitizeSong(song(1, {
    url: 'https://stream.example/1.mp3',
    audioUrl: 'https://stream.example/1.flac',
    streamURL: 'https://stream.example/1.aac',
    customCover: 'data:image/png;base64,large',
    cookie: 'secret',
    accessToken: 'secret',
    _lastPlaybackFailAt: 123,
    privilege: { fee: 0 },
  }));

  assert.equal(clean.url, undefined);
  assert.equal(clean.audioUrl, undefined);
  assert.equal(clean.streamURL, undefined);
  assert.equal(clean.customCover, undefined);
  assert.equal(clean.cookie, undefined);
  assert.equal(clean.accessToken, undefined);
  assert.equal(clean._lastPlaybackFailAt, undefined);
  assert.equal(clean.cover, 'https://img.example/1.jpg');
  assert.deepEqual(clean.privilege, { fee: 0 });
});

test('browser File tracks are omitted until they have a persistent path', () => {
  assert.equal(queueSession.sanitizeSong({
    type: 'local',
    localKey: 'demo.mp3:10:20',
    name: 'Demo',
    localUrl: 'blob:temporary',
  }), null);

  assert.equal(queueSession.sanitizeSong({
    type: 'local',
    localKey: 'demo.mp3:10:20',
    name: 'Demo',
    filePath: 'D:\\Music\\demo.mp3',
  }).filePath, 'D:\\Music\\demo.mp3');
});

test('invalid provider placeholders are not persisted as songs', () => {
  assert.equal(queueSession.queueItemKey({ provider: 'qq' }), '');
  assert.equal(queueSession.sanitizeSong({ provider: 'qq' }), null);
});

test('createQueueSnapshot remaps the current index after sanitizing items', () => {
  const snapshot = queueSession.createQueueSnapshot({
    queue: [
      { type: 'local', localKey: 'temp', name: 'Temporary', localUrl: 'blob:temporary' },
      song(2),
      song(3),
    ],
    currentIndex: 2,
    currentTime: 31,
    duration: 200,
    playMode: 'shuffle',
    playing: true,
  }, { now: 1000 });

  assert.deepEqual(snapshot.queue.map((item) => item.id), [2, 3]);
  assert.equal(snapshot.currentIndex, 1);
  assert.equal(snapshot.currentKey, 'song:3');
  assert.equal(snapshot.positionSeconds, 31);
  assert.equal(snapshot.playMode, 'shuffle');
  assert.equal(snapshot.wasPlaying, true);
});

test('createQueueSnapshot uses currentKey to repair a stale index', () => {
  const snapshot = queueSession.createQueueSnapshot({
    queue: [song(1), song(2)],
    currentIndex: 0,
    currentKey: 'song:2',
  });

  assert.equal(snapshot.currentIndex, 1);
  assert.equal(snapshot.currentKey, 'song:2');
});

test('a position at the track end is reset before persistence', () => {
  const snapshot = queueSession.createQueueSnapshot({
    queue: [song(1)],
    currentIndex: 0,
    positionSeconds: 199.5,
    durationSeconds: 200,
  });

  assert.equal(snapshot.positionSeconds, 0);
});

test('serializeQueueSnapshot produces JSON without stream URLs', () => {
  const serialized = queueSession.serializeQueueSnapshot({
    queue: [song(1, { url: 'https://stream.example/1' })],
    currentIndex: 0,
  }, { now: 1000 });
  const parsed = JSON.parse(serialized);

  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.queue[0].url, undefined);
});

test('restoreQueueSnapshot migrates a legacy v0 session', () => {
  const restored = queueSession.restoreQueueSnapshot({
    playQueue: [song(1), song(2)],
    currentIdx: 1,
    currentTime: 25,
    duration: 180,
    playMode: 'single',
    playing: true,
    savedAt: 1000,
  }, { now: 2000 });

  assert.equal(restored.ok, true);
  assert.equal(restored.migrated, true);
  assert.equal(restored.state.currentIndex, 1);
  assert.equal(restored.state.positionSeconds, 25);
  assert.equal(restored.state.playMode, 'single');
  assert.equal(restored.state.wasPlaying, true);
});

test('restoreQueueSnapshot rejects malformed, future, empty, and expired data', () => {
  assert.equal(queueSession.restoreQueueSnapshot('{bad json').reason, 'malformed_json');
  assert.equal(queueSession.restoreQueueSnapshot({ schemaVersion: 99 }).reason, 'unsupported_schema');
  assert.equal(queueSession.restoreQueueSnapshot({ schemaVersion: 1, queue: [] }).reason, 'empty_queue');
  assert.equal(queueSession.restoreQueueSnapshot({
    schemaVersion: 1,
    savedAt: 1000,
    queue: [song(1)],
    currentIndex: 0,
  }, { now: 5000, maxAgeMs: 1000 }).reason, 'expired');
  assert.equal(queueSession.restoreQueueSnapshot({
    schemaVersion: 1,
    savedAt: 5000,
    queue: [song(1)],
    currentIndex: 0,
  }, { now: 1000, maxFutureSkewMs: 1000 }).reason, 'future_timestamp');
});

test('removeQueueItem advances playback when the current item is removed', () => {
  const result = queueSession.removeQueueItem({
    queue: [song(1), song(2), song(3)],
    currentIndex: 1,
    currentKey: 'song:2',
    positionSeconds: 42,
    wasPlaying: true,
  }, 1);

  assert.equal(result.changed, true);
  assert.equal(result.removedCurrent, true);
  assert.equal(result.nextAction, 'play-current');
  assert.deepEqual(result.state.queue.map((item) => item.id), [1, 3]);
  assert.equal(result.state.currentIndex, 1);
  assert.equal(result.state.currentKey, 'song:3');
  assert.equal(result.state.positionSeconds, 0);
});

test('removeQueueItem keeps a paused queue paused when the current item is removed', () => {
  const result = queueSession.removeQueueItem({
    queue: [song(1), song(2)],
    currentIndex: 0,
    currentKey: 'song:1',
    wasPlaying: false,
  }, 0);

  assert.equal(result.nextAction, 'load-current');
  assert.equal(result.state.wasPlaying, false);
  assert.equal(result.state.currentKey, 'song:2');
});

test('removeQueueItem preserves the active song when an earlier item is removed', () => {
  const result = queueSession.removeQueueItem({
    queue: [song(1), song(2), song(3)],
    currentIndex: 2,
    currentKey: 'song:3',
  }, 0);

  assert.equal(result.state.currentIndex, 1);
  assert.equal(result.state.currentKey, 'song:3');
});

test('moveQueueItem preserves the active song identity', () => {
  const result = queueSession.moveQueueItem({
    queue: [song(1), song(2), song(3)],
    currentIndex: 1,
    currentKey: 'song:2',
  }, 1, 2);

  assert.deepEqual(result.state.queue.map((item) => item.id), [1, 3, 2]);
  assert.equal(result.state.currentIndex, 2);
  assert.equal(result.state.currentKey, 'song:2');
});
