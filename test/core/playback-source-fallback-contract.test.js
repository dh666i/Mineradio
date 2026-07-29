'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const ui = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const fallbackStart = ui.indexOf('function normalizeMatchText');
const fallbackEnd = ui.indexOf('function handlePlaybackUnavailable', fallbackStart);

assert.notEqual(fallbackStart, -1, 'fallback helpers should exist');
assert.notEqual(fallbackEnd, -1, 'fallback helper boundary should exist');

const fallbackSource = ui.slice(fallbackStart, fallbackEnd);

function createAudio() {
  return {
    src: 'https://old.invalid/audio',
    paused: false,
    onended() {},
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() {},
  };
}

function createSandbox(queue, statuses) {
  const notices = [];
  const providerStatuses = Object.assign({
    netease: { loggedIn: true },
    qq: { loggedIn: false, playbackKeyReady: false },
  }, statuses || {});
  const sandbox = {
    console,
    Promise,
    Date,
    Object,
    Array,
    Math,
    Number,
    String,
    setTimeout,
    clearTimeout,
    playQueue: queue,
    currentIdx: 0,
    trackSwitchToken: 1,
    activeRadioContext: null,
    homePersonalFmAdvancePromise: null,
    miniQueueOpen: false,
    playToggleBusy: true,
    playing: true,
    audioFadeSerial: 0,
    audio: createAudio(),
    window: {
      MineradioTransitionV153: {
        cancel() { sandbox.transitionCancelled = true; },
      },
    },
    document: { getElementById() { return null; } },
    songProviderKey(song) { return song && song.provider === 'qq' ? 'qq' : 'netease'; },
    playbackProviderLabel(song) { return song && song.provider === 'qq' ? 'QQ 音乐' : '网易云'; },
    platformMeta(provider) {
      const labels = {
        netease: '网易云音乐',
        qq: 'QQ 音乐',
        kugou: '酷狗音乐',
        qishui: '汽水音乐',
        spotify: 'Spotify',
      };
      return { key: provider, label: labels[provider] || provider };
    },
    platformStatus(provider) { return providerStatuses[provider] || { loggedIn: false }; },
    queueItemKey(song) {
      return [song && song.provider || 'netease', song && (song.id || song.mid) || ''].join(':');
    },
    cloneSong(song) { return Object.assign({}, song); },
    hydrateCustomCover(song) { return song; },
    apiJson: async function() { return { songs: [] }; },
    safeRenderQueuePanel() {},
    safeShelfRebuild() {},
    updateControlTrackInfo() {},
    hideLoading() {},
    forcePlaybackControlsInteractive() {},
    clearAudioFadeTimers() {},
    setPlayIcon(value) { sandbox.iconPlaying = value; },
    syncPlaybackStateFromAudioEvent() {},
    showSourceFallbackNotice(title, body) { notices.push({ title, body }); },
    advancePersonalFmTrack() {},
    notices,
  };
  sandbox.playQueueAt = async function() { return false; };
  vm.runInNewContext(fallbackSource, sandbox, { filename: 'provider-fallback.inline.js' });
  sandbox.showSourceFallbackNotice = function(title, body) { notices.push({ title, body }); };
  return sandbox;
}

test('source recovery advances at most two queue entries and settles once', async () => {
  const queue = Array.from({ length: 12 }, (_, index) => ({
    provider: 'netease',
    id: `song-${index}`,
    name: `Song ${index}`,
    artist: `Artist ${index}`,
  }));
  const sandbox = createSandbox(queue);
  let childCalls = 0;
  let recovery;
  sandbox.playQueueAt = async function(index, options) {
    childCalls += 1;
    recovery = recovery || options.sourceFallbackRecovery;
    sandbox.currentIdx = index;
    sandbox.trackSwitchToken += 1;
    return sandbox.tryAutoPlaybackFallback(
      sandbox.playQueue[index],
      { reason: 'url_unavailable' },
      index,
      sandbox.trackSwitchToken,
      options,
    );
  };

  const result = await sandbox.tryAutoPlaybackFallback(
    queue[0],
    { reason: 'url_unavailable' },
    0,
    1,
    {},
  );

  assert.equal(result, false);
  assert.equal(childCalls, 2);
  assert.equal(recovery.queueAdvances, 2);
  assert.equal(recovery.terminal, true);
  assert.equal(sandbox.activeSourceFallbackRecovery, null);
  assert.equal(sandbox.audio.src, '');
  assert.equal(sandbox.transitionCancelled, true);
  assert.equal(
    sandbox.notices.filter(item => item.title === '当前没有可用音源').length,
    1,
  );
});

test('QQ participates in fallback only with a complete playback session', () => {
  const song = { provider: 'netease', id: 'ne-1', name: 'A', artist: 'B' };
  const incomplete = createSandbox([song], {
    qq: { loggedIn: true, playbackKeyReady: false },
  });
  const ready = createSandbox([song], {
    qq: { loggedIn: true, playbackKeyReady: true },
  });

  assert.deepEqual(Array.from(incomplete.alternatePlaybackProviders(song)), []);
  assert.deepEqual(Array.from(ready.alternatePlaybackProviders(song)), ['qq']);
});

test('failed provisional provider result is rolled back', async () => {
  const original = { provider: 'netease', id: 'ne-1', name: 'Same Song', artist: 'Same Artist' };
  const sandbox = createSandbox([original], {
    qq: { loggedIn: true, playbackKeyReady: true },
  });
  let searchCalls = 0;
  sandbox.apiJson = async function() {
    searchCalls += 1;
    return {
      songs: [{ provider: 'qq', id: 'qq-1', mid: 'qq-1', name: original.name, artist: original.artist }],
    };
  };
  sandbox.playQueueAt = async function(index) {
    sandbox.currentIdx = index;
    sandbox.trackSwitchToken += 1;
    return false;
  };

  const result = await sandbox.tryAutoPlaybackFallback(
    original,
    { reason: 'url_unavailable' },
    0,
    1,
    {},
  );

  assert.equal(result, false);
  assert.equal(searchCalls, 1);
  assert.equal(sandbox.playQueue[0].provider, 'netease');
  assert.equal(sandbox.playQueue[0].id, 'ne-1');
});

test('late search completion cannot restart playback after manual supersession', async () => {
  const original = { provider: 'netease', id: 'ne-late', name: 'Late Song', artist: 'Late Artist' };
  const sandbox = createSandbox([original], {
    qq: { loggedIn: true, playbackKeyReady: true },
  });
  let resolveSearch;
  let playbackCalls = 0;
  sandbox.apiJson = function() {
    return new Promise(resolve => { resolveSearch = resolve; });
  };
  sandbox.playQueueAt = async function() {
    playbackCalls += 1;
    return true;
  };

  const pending = sandbox.tryAutoPlaybackFallback(
    original,
    { reason: 'url_unavailable' },
    0,
    1,
    {},
  );
  await Promise.resolve();
  sandbox.cancelSourceFallbackRecovery('manual-playback');
  sandbox.trackSwitchToken += 1;
  resolveSearch({
    songs: [{ provider: 'qq', id: 'qq-late', name: original.name, artist: original.artist }],
  });

  assert.equal(await pending, false);
  assert.equal(playbackCalls, 0);
  assert.equal(sandbox.playQueue[0], original);
});

test('media events and successful playback are tied to the current queue owner', () => {
  assert.match(ui, /audio\.__mineradioQueueItemKey\s*=\s*queueItemKey\(song\)/);
  assert.match(ui, /audio\.__mineradioTrackSwitchToken\s*=\s*token/);
  assert.match(ui, /function playbackMediaOwnedByCurrentTrack\(media\)/);
  assert.match(ui, /Number\(media\.__mineradioTrackSwitchToken\)\s*===\s*Number\(trackSwitchToken\)/);
  assert.match(ui, /if \(!playbackMediaOwnedByCurrentTrack\(audioEl\)\) return/);
  assert.match(ui, /notifyPreparedTransitionSettled\('committed'\);\s*return true/);
});

test('stalled playback refreshes a URL at most once under the current media owner', () => {
  assert.match(ui, /freshUrlAttemptCount:\s*0/);
  assert.match(ui, /freshUrlAttemptCount\)\s*\|\|\s*0\)\s*>=\s*1/);
  assert.match(ui, /function playbackStallRecoveryOwnerStillCurrent\(media, src, token, serial, queueKey\)/);
  assert.match(ui, /token !== trackSwitchToken \|\| serial !== playbackResumeRecovery\.serial/);
  assert.match(ui, /String\(media\.__mineradioQueueItemKey \|\| ''\) !== queueKey/);
  assert.match(ui, /return playbackMediaMatchesCurrentQueueItem\(media\)/);
  assert.match(ui, /\['error', 'stalled'\]\.forEach/);
  assert.match(ui, /ownerToken:\s*Number\(audioEl\.__mineradioTrackSwitchToken\)/);
  assert.match(ui, /resumeRecovery:\s*true,\s*sourceFallbackRecovery:\s*recovery/);
  assert.match(ui, /if \(recovered === true\) \{\s*if \(sourceFallbackRecoveryIdentityActive\(recovery\)\) completeSourceFallbackRecovery\(recovery\)/);
});

test('source fallback deadline is checked between asynchronous playback phases', () => {
  const deadlineChecks = ui.match(/invocationRecovery && !sourceFallbackRecoveryCanContinue\(invocationRecovery\)/g) || [];
  assert.ok(deadlineChecks.length >= 3);
  assert.match(ui, /settleExpiredSourceFallbackPlayback\(idx, token, opts\)/);
  assert.match(ui, /clearPlaybackResumeWatchdogs\(\)/);
  assert.match(ui, /playbackResumeRecovery\.serial = \(Number\(playbackResumeRecovery\.serial\) \|\| 0\) \+ 1/);
});
