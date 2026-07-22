'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const transitionCore = require('../../public/js/core/audio-transition');
const audioSettingsCore = require('../../public/js/core/audio-settings');
const runtimeSource = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'public', 'js', 'v153-transition.js'),
  'utf8',
);

class FakeAudioParam {
  constructor(value = 1) {
    this.value = value;
    this.curves = [];
    this.cancelCount = 0;
  }

  cancelScheduledValues() {
    this.cancelCount += 1;
  }

  cancelAndHoldAtTime() {
    this.cancelCount += 1;
  }

  setValueAtTime(value) {
    this.value = Number(value);
  }

  setValueCurveAtTime(curve, startTime, duration) {
    this.curves.push({ curve: Array.from(curve), startTime, duration });
  }
}

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.now = 0;
    this.tasks = new Map();
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    const normalizedDelay = Math.max(0, Number(delay) || 0);
    this.tasks.set(id, {
      callback,
      delay: normalizedDelay,
      dueAt: this.now + normalizedDelay,
      interval: false,
    });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  setInterval(callback, delay) {
    const id = this.nextId++;
    const normalizedDelay = Math.max(0, Number(delay) || 0);
    this.tasks.set(id, {
      callback,
      delay: normalizedDelay,
      dueAt: this.now + normalizedDelay,
      interval: true,
    });
    return id;
  }

  clearInterval(id) {
    this.tasks.delete(id);
  }

  runTimeouts() {
    const pending = Array.from(this.tasks.values()).filter((task) => !task.interval);
    const finalDueAt = pending.reduce((latest, task) => Math.max(latest, task.dueAt), this.now);
    this.runTimeoutsThrough(finalDueAt);
  }

  runTimeoutsThrough(targetTime) {
    const target = Math.max(this.now, Number(targetTime) || 0);
    while (true) {
      const pending = Array.from(this.tasks.entries())
        .filter(([, task]) => !task.interval && task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0]);
      if (!pending.length) break;
      const [id, task] = pending[0];
      if (!this.tasks.has(id)) continue;
      this.tasks.delete(id);
      this.now = task.dueAt;
      task.callback();
    }
    this.now = target;
  }
}

function createHarness(options = {}) {
  const timers = new FakeTimers();
  const mediaInstances = [];
  const windowListeners = new Map();
  const calls = {
    preparedAdoptions: 0,
    forwardPreparedAdoptions: 0,
    rollbackPreparedAdoptions: 0,
    rollbackPayload: null,
    manualQueueSwitches: 0,
    normalQueueCalls: [],
    originalEnded: 0,
    apiRequests: 0,
    apiRequestUrls: [],
  };
  const deferredApiRequests = [];
  let resolveForwardAdoptionPromise = null;
  let forwardPreparedTransition = null;
  const forwardAdoptionPromise = options.deferForwardAdoption
    ? new Promise((resolve) => { resolveForwardAdoptionPromise = resolve; })
    : null;
  let resolveRollbackSettlementPromise = null;
  let rollbackPreparedTransition = null;
  const rollbackSettlementPromise = options.deferRollbackSettlement
    ? new Promise((resolve) => { resolveRollbackSettlementPromise = resolve; })
    : null;
  let resolveCandidatePlay = null;
  const candidatePlayPromise = options.deferCandidatePlay
    ? new Promise((resolve) => { resolveCandidatePlay = resolve; })
    : null;
  let resolveFirstCandidatePlay = null;
  const firstCandidatePlayPromise = options.deferFirstCandidatePlay
    ? new Promise((resolve) => { resolveFirstCandidatePlay = resolve; })
    : null;
  let candidatePlayInvocations = 0;
  let sleepMode = 'off';

  class FakeAudio {
    constructor(init = {}) {
      this.src = init.src || '';
      this.currentTime = init.currentTime || 0;
      this.duration = init.duration || 240;
      this.readyState = this.src ? 4 : 0;
      this.paused = init.paused !== false;
      this.ended = false;
      this.playbackRate = 1;
      this.volume = 1;
      this.muted = false;
      this.preload = '';
      this.crossOrigin = '';
      this.onended = null;
      this.playCount = 0;
      this.pauseCount = 0;
      this.listeners = new Map();
      this.rejectPlay = !init.active && options.candidatePlayReject === true;
      this.pendingPlay = !init.active && options.candidatePlayPending === true;
      this.__mineradioDeckGain = { gain: new FakeAudioParam(init.deckGain == null ? 0 : init.deckGain) };
      mediaInstances.push(this);
    }

    get buffered() {
      const self = this;
      return {
        length: self.src && self.readyState >= 3 ? 1 : 0,
        start() { return 0; },
        end() { return self.duration; },
      };
    }

    addEventListener(name, callback, eventOptions) {
      const entries = this.listeners.get(name) || [];
      entries.push({ callback, once: !!(eventOptions && eventOptions.once) });
      this.listeners.set(name, entries);
    }

    removeEventListener(name, callback) {
      const entries = this.listeners.get(name) || [];
      this.listeners.set(name, entries.filter((entry) => entry.callback !== callback));
    }

    emit(name, event = {}) {
      const entries = (this.listeners.get(name) || []).slice();
      this.listeners.set(name, entries.filter((entry) => !entry.once));
      entries.forEach((entry) => entry.callback.call(this, Object.assign({ type: name, target: this }, event)));
    }

    play() {
      this.playCount += 1;
      const candidateInvocation = this !== activeMedia ? ++candidatePlayInvocations : 0;
      if (this.rejectPlay) return Promise.reject(new Error('candidate play failed'));
      this.paused = false;
      this.ended = false;
      if (this.pendingPlay) return new Promise(() => {});
      if (candidateInvocation === 1 && firstCandidatePlayPromise) return firstCandidatePlayPromise;
      if (!this.rejectPlay && candidatePlayPromise && this !== activeMedia) return candidatePlayPromise;
      return Promise.resolve();
    }

    pause() {
      this.pauseCount += 1;
      this.paused = true;
    }

    load() {
      if (!this.src) {
        this.readyState = 0;
        return;
      }
      this.readyState = 4;
      this.emit('canplay');
      if (!options.deferCandidateCanPlayThrough) this.emit('canplaythrough');
    }

    removeAttribute(name) {
      if (name === 'src') this.src = '';
    }

    setSinkId(deviceId) {
      this.sinkId = deviceId;
      return Promise.resolve();
    }
  }

  const activeMedia = new FakeAudio({
    active: true,
    src: '/api/audio?url=active',
    currentTime: 80,
    duration: 100,
    paused: false,
    deckGain: 1,
  });
  activeMedia.onended = function () { calls.originalEnded += 1; };

  const settings = audioSettingsCore.defaultSettings();
  settings.transition = options.transition || { mode: 'gapless', durationSeconds: 0 };
  settings.output.deviceId = 'fake-output';

  const fakeWindow = {
    MineradioCore: {
      audioTransition: transitionCore,
      audioSettings: audioSettingsCore,
    },
    MineradioAudioV150: {
      getSettings() { return settings; },
    },
    Audio: FakeAudio,
    audio: activeMedia,
    audioCtx: { currentTime: 10 },
    gainNode: {},
    targetVolume: 0.7,
    playQueue: [
      { id: 101, name: 'Current', artist: 'One', duration: 100 },
      { id: 102, name: 'Next', artist: 'Two', duration: 200 },
    ],
    currentIdx: 0,
    playMode: 'loop',
    activeRadioContext: null,
    playbackQuality: 'hires',
    loginStatus: { isSvip: false, vipLevel: 'none' },
    navigator: { onLine: true },
    getMineradioSleepMode() { return sleepMode; },
    songProviderKey() { return 'netease'; },
    normalizePlaybackQuality(value) { return value; },
    hasProviderSvip() { return false; },
    resumeAudioAnalysis() { return Promise.resolve(); },
    apiJson(url) {
      calls.apiRequests += 1;
      calls.apiRequestUrls.push(url);
      if (options.deferApiRequests) {
        return new Promise((resolve, reject) => {
          deferredApiRequests.push({ resolve, reject, url });
        });
      }
      return Promise.resolve({ url: 'https://media.example/next.mp3', level: 'hires' });
    },
    attachPlaybackAudioElement(media, initialGain) {
      if (!media.__mineradioDeckGain) media.__mineradioDeckGain = { gain: new FakeAudioParam(0) };
      if (initialGain != null) media.__mineradioDeckGain.gain.setValueAtTime(initialGain, 0);
      return { source: {}, gain: media.__mineradioDeckGain };
    },
    setPlaybackAudioDeckGain(media, value) {
      if (!media || !media.__mineradioDeckGain) return false;
      const param = media.__mineradioDeckGain.gain;
      param.cancelScheduledValues(0);
      param.setValueAtTime(Math.max(0, Math.min(1, Number(value) || 0)), 0);
      return true;
    },
    addEventListener(name, callback) {
      const entries = windowListeners.get(name) || [];
      entries.push(callback);
      windowListeners.set(name, entries);
    },
  };

  fakeWindow.playQueueAt = async function basePlayQueueAt(index, playbackOptions = {}) {
    if (playbackOptions.preparedTransition) {
      const prepared = playbackOptions.preparedTransition;
      const isRollback = playbackOptions.transitionRollback === true || prepared.mode === 'rollback';
      calls.preparedAdoptions += 1;
      if (isRollback) {
        calls.rollbackPreparedAdoptions += 1;
        calls.rollbackPayload = { index, options: playbackOptions, preparedTransition: prepared };
      } else {
        calls.forwardPreparedAdoptions += 1;
      }
      fakeWindow.currentIdx = index;
      fakeWindow.audio = prepared.media;
      fakeWindow.audio.onended = function () {};
      if (isRollback) {
        fakeWindow.audio.paused = false;
        fakeWindow.audio.ended = false;
      }
      if (isRollback && rollbackSettlementPromise) {
        rollbackPreparedTransition = prepared;
        return rollbackSettlementPromise;
      }
      prepared.onAdopted(fakeWindow.audio);
      if (!isRollback && forwardAdoptionPromise) {
        forwardPreparedTransition = prepared;
        return forwardAdoptionPromise;
      }
      if (typeof prepared.onCoreSettled === 'function') prepared.onCoreSettled('committed');
      return true;
    }
    calls.manualQueueSwitches += 1;
    calls.normalQueueCalls.push({ index, options: playbackOptions });
    fakeWindow.currentIdx = index;
    return true;
  };
  fakeWindow.window = fakeWindow;

  const context = vm.createContext({
    window: fakeWindow,
    navigator: fakeWindow.navigator,
    Audio: FakeAudio,
    Float32Array,
    Promise,
    Date,
    console: {
      error() {},
      warn() {},
      info() {},
      log() {},
    },
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    setInterval: timers.setInterval.bind(timers),
    clearInterval: timers.clearInterval.bind(timers),
    encodeURIComponent,
    isFinite,
  });
  vm.runInContext(runtimeSource, context, { filename: 'public/js/v153-transition.js' });

  return {
    window: fakeWindow,
    activeMedia,
    settings,
    calls,
    timers,
    mediaInstances,
    runtime: fakeWindow.MineradioTransitionV153,
    resolveForwardAdoption(value = true) {
      assert.equal(typeof resolveForwardAdoptionPromise, 'function');
      assert.ok(forwardPreparedTransition);
      const resolve = resolveForwardAdoptionPromise;
      resolveForwardAdoptionPromise = null;
      if (typeof forwardPreparedTransition.onCoreSettled === 'function') {
        forwardPreparedTransition.onCoreSettled('committed');
      }
      forwardPreparedTransition = null;
      resolve(value);
    },
    resolveCandidatePlay(value) {
      assert.equal(typeof resolveCandidatePlay, 'function');
      const resolve = resolveCandidatePlay;
      resolveCandidatePlay = null;
      resolve(value);
    },
    resolveFirstCandidatePlay(value) {
      assert.equal(typeof resolveFirstCandidatePlay, 'function');
      const resolve = resolveFirstCandidatePlay;
      resolveFirstCandidatePlay = null;
      resolve(value);
    },
    resolveApiRequest(index, data) {
      const request = deferredApiRequests[index];
      assert.ok(request);
      request.resolve(data || {
        url: `https://media.example/deferred-${index}.mp3`,
        level: 'hires',
      });
    },
    rejectRollback(reason = 'rollback-rejected') {
      assert.ok(rollbackPreparedTransition);
      assert.equal(typeof resolveRollbackSettlementPromise, 'function');
      const prepared = rollbackPreparedTransition;
      const resolve = resolveRollbackSettlementPromise;
      rollbackPreparedTransition = null;
      resolveRollbackSettlementPromise = null;
      prepared.onRejected(reason);
      resolve(false);
    },
    setSleepMode(value) {
      sleepMode = value;
    },
  };
}

async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function prepareCandidate(harness) {
  harness.runtime.tick();
  await settle();
  assert.equal(harness.calls.apiRequests, 1);
  assert.equal(harness.mediaInstances.length, 2);
  return harness.mediaInstances[1];
}

test('gapless preparation takes over ended and adopts the candidate exactly once', async () => {
  const harness = createHarness({ transition: { mode: 'gapless', durationSeconds: 0 } });
  const candidate = await prepareCandidate(harness);
  const interceptedEnded = harness.activeMedia.onended;

  assert.notEqual(interceptedEnded, null);
  assert.equal(harness.calls.originalEnded, 0);
  harness.activeMedia.ended = true;
  harness.activeMedia.paused = true;
  interceptedEnded({ type: 'ended' });
  await settle();

  assert.equal(candidate.playCount, 1);
  assert.equal(harness.calls.preparedAdoptions, 1);
  assert.equal(harness.calls.originalEnded, 0);
  assert.equal(harness.window.currentIdx, 1);
  assert.equal(harness.window.audio, candidate);
  assert.equal(harness.runtime.diagnostics().state, 'idle');

  interceptedEnded({ type: 'ended' });
  await settle();
  assert.equal(candidate.playCount, 1);
  assert.equal(harness.calls.preparedAdoptions, 1);
});

test('failed gapless candidate calls the original ended handler once and retains current audio', async () => {
  const harness = createHarness({
    transition: { mode: 'gapless', durationSeconds: 0 },
    candidatePlayReject: true,
  });
  const candidate = await prepareCandidate(harness);
  const interceptedEnded = harness.activeMedia.onended;
  const originalSource = harness.activeMedia.src;

  harness.activeMedia.ended = true;
  harness.activeMedia.paused = true;
  interceptedEnded({ type: 'ended' });
  await settle();

  assert.equal(candidate.playCount, 1);
  assert.equal(harness.calls.preparedAdoptions, 0);
  assert.equal(harness.calls.originalEnded, 1);
  assert.equal(harness.window.audio, harness.activeMedia);
  assert.equal(harness.activeMedia.src, originalSource);
  assert.equal(candidate.src, '');
  assert.equal(harness.runtime.diagnostics().state, 'idle');
});

test('gapless candidate play timeout falls back once after 1800ms and retains current audio', async () => {
  const harness = createHarness({
    transition: { mode: 'gapless', durationSeconds: 0 },
    candidatePlayPending: true,
  });
  const candidate = await prepareCandidate(harness);
  const interceptedEnded = harness.activeMedia.onended;
  const originalSource = harness.activeMedia.src;

  harness.activeMedia.ended = true;
  harness.activeMedia.paused = true;
  interceptedEnded({ type: 'ended' });
  await settle();

  assert.equal(candidate.playCount, 1);
  assert.equal(harness.runtime.diagnostics().state, 'starting');
  assert.equal(harness.calls.originalEnded, 0);

  harness.timers.runTimeoutsThrough(1799);
  await settle();
  assert.equal(harness.runtime.diagnostics().state, 'starting');
  assert.equal(harness.calls.originalEnded, 0);

  harness.timers.runTimeoutsThrough(1800);
  await settle();
  assert.equal(harness.calls.originalEnded, 1);
  assert.equal(harness.calls.preparedAdoptions, 0);
  assert.equal(harness.runtime.diagnostics().state, 'idle');
  assert.equal(harness.window.currentIdx, 0);
  assert.equal(harness.window.audio, harness.activeMedia);
  assert.equal(harness.activeMedia.src, originalSource);
  assert.equal(candidate.paused, true);
  assert.equal(candidate.src, '');

  harness.timers.runTimeoutsThrough(5000);
  await settle();
  assert.equal(harness.calls.originalEnded, 1);
});

test('stop-after-current enabled during crossfade startup lets the outgoing ended guard run once', async () => {
  const harness = createHarness({
    transition: { mode: 'crossfade', durationSeconds: 3 },
    deferCandidatePlay: true,
  });
  const candidate = await prepareCandidate(harness);
  const originalSource = harness.activeMedia.src;

  harness.activeMedia.currentTime = 97;
  harness.runtime.tick();
  await settle();

  assert.equal(harness.runtime.diagnostics().state, 'starting');
  assert.equal(candidate.playCount, 1);
  harness.setSleepMode('track');
  harness.activeMedia.ended = true;
  harness.activeMedia.paused = true;
  harness.activeMedia.onended({ type: 'ended' });
  await settle();
  assert.equal(harness.calls.originalEnded, 0);
  assert.equal(harness.runtime.diagnostics().state, 'starting');

  harness.resolveCandidatePlay();
  await settle(24);

  assert.equal(harness.calls.originalEnded, 1);
  assert.equal(harness.calls.preparedAdoptions, 0);
  assert.equal(harness.runtime.diagnostics().state, 'idle');
  assert.equal(harness.window.currentIdx, 0);
  assert.equal(harness.window.audio, harness.activeMedia);
  assert.equal(harness.activeMedia.src, originalSource);
  assert.equal(harness.activeMedia.__mineradioDeckGain.gain.value, 1);
  assert.equal(candidate.paused, true);
  assert.equal(candidate.src, '');

  harness.timers.runTimeoutsThrough(5000);
  await settle();
  assert.equal(harness.calls.originalEnded, 1);
});

test('crossfade schedules equal-power curves and queue cancellation keeps only the active deck', async () => {
  const harness = createHarness({ transition: { mode: 'crossfade', durationSeconds: 3 } });
  const candidate = await prepareCandidate(harness);

  harness.activeMedia.currentTime = 97;
  harness.runtime.tick();
  await settle();

  const outgoingParam = harness.activeMedia.__mineradioDeckGain.gain;
  const incomingParam = candidate.__mineradioDeckGain.gain;
  assert.equal(candidate.playCount, 1);
  assert.equal(harness.calls.preparedAdoptions, 1);
  assert.equal(outgoingParam.curves.length, 1);
  assert.equal(incomingParam.curves.length, 1);
  assert.equal(outgoingParam.curves[0].duration, 3);
  assert.equal(incomingParam.curves[0].duration, 3);
  assert.equal(outgoingParam.curves[0].curve[0], 1);
  assert.equal(outgoingParam.curves[0].curve.at(-1), 0);
  assert.equal(incomingParam.curves[0].curve[0], 0);
  assert.equal(incomingParam.curves[0].curve.at(-1), 1);

  await harness.window.playQueueAt(0, { manual: true });
  harness.timers.runTimeouts();
  await settle();

  assert.equal(harness.calls.manualQueueSwitches, 1);
  assert.equal(harness.runtime.diagnostics().state, 'idle');
  assert.equal(harness.window.audio, candidate);
  assert.equal(candidate.paused, false);
  assert.notEqual(candidate.src, '');
  assert.equal(candidate.__mineradioDeckGain.gain.value, 1);
  assert.equal(harness.activeMedia.paused, true);
  assert.equal(harness.activeMedia.src, '');
  assert.deepEqual(
    harness.mediaInstances.filter((media) => media.src && !media.paused),
    [candidate],
  );
});

test('crossfade candidate error rolls adoption back to the still-playing outgoing deck', async () => {
  const harness = createHarness({
    transition: { mode: 'crossfade', durationSeconds: 3 },
    deferForwardAdoption: true,
    deferCandidateCanPlayThrough: true,
  });
  const candidate = await prepareCandidate(harness);
  const originalSource = harness.activeMedia.src;

  harness.activeMedia.currentTime = 97;
  harness.runtime.tick();
  await settle();

  assert.equal(harness.calls.forwardPreparedAdoptions, 1);
  assert.equal(harness.calls.rollbackPreparedAdoptions, 0);
  assert.equal(harness.window.currentIdx, 1);
  assert.equal(harness.window.audio, candidate);
  assert.equal(harness.runtime.diagnostics().state, 'transitioning');

  candidate.emit('error');
  await settle();

  assert.equal(harness.runtime.diagnostics().state, 'recovering');
  assert.equal(harness.calls.rollbackPreparedAdoptions, 0);
  assert.equal(candidate.paused, true);
  assert.equal(harness.activeMedia.paused, false);

  harness.runtime.tick();
  candidate.emit('canplaythrough');
  await settle();

  assert.equal(harness.runtime.diagnostics().state, 'recovering');
  assert.equal(harness.calls.rollbackPreparedAdoptions, 0);
  assert.equal(harness.window.audio, candidate);
  assert.equal(harness.activeMedia.src, originalSource);
  assert.equal(harness.activeMedia.paused, false);
  assert.notEqual(candidate.src, '');

  harness.resolveForwardAdoption();
  await settle(24);

  assert.equal(harness.calls.preparedAdoptions, 2);
  assert.equal(harness.calls.rollbackPreparedAdoptions, 1);
  assert.equal(harness.calls.rollbackPayload.index, 0);
  assert.equal(harness.calls.rollbackPayload.options.transitionRollback, true);
  assert.equal(harness.calls.rollbackPayload.preparedTransition.mode, 'rollback');
  assert.equal(harness.calls.rollbackPayload.preparedTransition.media, harness.activeMedia);
  assert.equal(harness.calls.rollbackPayload.preparedTransition.oldAudio, candidate);
  assert.equal(harness.window.currentIdx, 0);
  assert.equal(harness.window.audio, harness.activeMedia);
  assert.equal(harness.activeMedia.src, originalSource);
  assert.equal(harness.activeMedia.paused, false);
  assert.equal(harness.activeMedia.__mineradioDeckGain.gain.value, 1);
  assert.equal(candidate.paused, true);
  assert.equal(candidate.src, '');
  assert.equal(harness.runtime.diagnostics().state, 'idle');
  assert.deepEqual(
    harness.mediaInstances.filter((media) => media.src && !media.paused),
    [harness.activeMedia],
  );
});

test('crossfade recovery follows stable song keys after the queue is reordered', async () => {
  const rollbackHarness = createHarness({
    transition: { mode: 'crossfade', durationSeconds: 3 },
    deferForwardAdoption: true,
  });
  const rollbackCandidate = await prepareCandidate(rollbackHarness);
  const rollbackCurrentSong = rollbackHarness.window.playQueue[0];
  const rollbackNextSong = rollbackHarness.window.playQueue[1];
  const unrelatedSong = { id: 999, name: 'Unrelated', artist: 'Three', duration: 180 };

  rollbackHarness.activeMedia.currentTime = 97;
  rollbackHarness.runtime.tick();
  await settle();
  rollbackHarness.window.playQueue = [rollbackNextSong, unrelatedSong, rollbackCurrentSong];
  rollbackHarness.window.currentIdx = 0;

  rollbackCandidate.emit('error');
  await settle();
  rollbackHarness.resolveForwardAdoption();
  await settle(24);

  assert.equal(rollbackHarness.calls.rollbackPreparedAdoptions, 1);
  assert.equal(rollbackHarness.calls.rollbackPayload.index, 2);
  assert.equal(rollbackHarness.calls.rollbackPayload.preparedTransition.nextIndex, 2);
  assert.equal(
    rollbackHarness.calls.rollbackPayload.preparedTransition.nextKey,
    transitionCore.songStableKey(rollbackCurrentSong),
  );
  assert.equal(rollbackHarness.window.currentIdx, 2);
  assert.equal(rollbackHarness.window.playQueue[rollbackHarness.window.currentIdx], rollbackCurrentSong);
  assert.equal(rollbackHarness.window.audio, rollbackHarness.activeMedia);
  assert.equal(rollbackHarness.calls.normalQueueCalls.length, 0);

  const reloadHarness = createHarness({
    transition: { mode: 'crossfade', durationSeconds: 3 },
    deferForwardAdoption: true,
  });
  const reloadCandidate = await prepareCandidate(reloadHarness);
  const reloadCurrentSong = reloadHarness.window.playQueue[0];
  const reloadNextSong = reloadHarness.window.playQueue[1];

  reloadHarness.activeMedia.currentTime = 97;
  reloadHarness.runtime.tick();
  await settle();
  reloadHarness.window.playQueue = [reloadNextSong, unrelatedSong, reloadCurrentSong];
  reloadHarness.window.currentIdx = 0;
  reloadHarness.activeMedia.ended = true;
  reloadHarness.activeMedia.paused = true;

  reloadCandidate.emit('error');
  await settle();
  reloadHarness.resolveForwardAdoption();
  await settle(24);
  reloadHarness.timers.runTimeoutsThrough(0);
  await settle();

  assert.equal(reloadHarness.runtime.diagnostics().state, 'idle');
  assert.equal(reloadHarness.calls.rollbackPreparedAdoptions, 0);
  assert.equal(reloadHarness.calls.normalQueueCalls.length, 1);
  assert.equal(reloadHarness.calls.normalQueueCalls[0].index, 0);
  assert.equal(reloadHarness.calls.normalQueueCalls[0].options.transitionRecovery, true);
  assert.equal(
    transitionCore.songStableKey(reloadHarness.window.playQueue[reloadHarness.calls.normalQueueCalls[0].index]),
    transitionCore.songStableKey(reloadNextSong),
  );
  assert.notEqual(reloadHarness.calls.normalQueueCalls[0].index, 1);
});

test('rollback rejection after the outgoing deck ends reloads the incoming key exactly once', async () => {
  const harness = createHarness({
    transition: { mode: 'crossfade', durationSeconds: 3 },
    deferForwardAdoption: true,
    deferRollbackSettlement: true,
  });
  const candidate = await prepareCandidate(harness);
  const nextSong = harness.window.playQueue[1];

  harness.activeMedia.currentTime = 97;
  harness.runtime.tick();
  await settle();
  candidate.emit('error');
  await settle();
  harness.resolveForwardAdoption();
  await settle(24);

  assert.equal(harness.runtime.diagnostics().state, 'rollback');
  assert.equal(harness.calls.rollbackPreparedAdoptions, 1);
  assert.equal(harness.window.audio, harness.activeMedia);

  harness.activeMedia.ended = true;
  harness.activeMedia.paused = true;
  if (typeof harness.activeMedia.onended === 'function') {
    harness.activeMedia.onended({ type: 'ended', target: harness.activeMedia });
  }
  harness.rejectRollback();
  await settle(24);
  harness.timers.runTimeoutsThrough(0);
  await settle();

  assert.equal(harness.calls.originalEnded, 0);
  assert.equal(harness.runtime.diagnostics().state, 'idle');
  assert.equal(harness.calls.normalQueueCalls.length, 1);
  assert.equal(harness.calls.normalQueueCalls[0].options.transitionRecovery, true);
  assert.equal(
    transitionCore.songStableKey(harness.window.playQueue[harness.calls.normalQueueCalls[0].index]),
    transitionCore.songStableKey(nextSong),
  );

  harness.timers.runTimeoutsThrough(5000);
  await settle();
  assert.equal(harness.calls.originalEnded, 0);
  assert.equal(harness.calls.normalQueueCalls.length, 1);
});

test('missing outgoing key never rolls recovery back to an unrelated replacement slot', async () => {
  const harness = createHarness({
    transition: { mode: 'crossfade', durationSeconds: 3 },
    deferForwardAdoption: true,
  });
  const candidate = await prepareCandidate(harness);
  const nextSong = harness.window.playQueue[1];
  const unrelatedSong = { id: 999, name: 'Unrelated', artist: 'Three', duration: 180 };

  harness.activeMedia.currentTime = 97;
  harness.runtime.tick();
  await settle();
  harness.window.playQueue = [unrelatedSong, nextSong];
  harness.window.currentIdx = 1;

  candidate.emit('error');
  await settle();
  harness.resolveForwardAdoption();
  await settle(24);
  harness.timers.runTimeoutsThrough(0);
  await settle();

  assert.equal(harness.runtime.diagnostics().state, 'idle');
  assert.equal(harness.calls.rollbackPreparedAdoptions, 0);
  assert.equal(harness.calls.normalQueueCalls.length, 1);
  assert.equal(harness.calls.normalQueueCalls[0].index, 1);
  assert.equal(harness.calls.normalQueueCalls[0].options.transitionRecovery, true);
  assert.equal(harness.window.playQueue[harness.calls.normalQueueCalls[0].index], nextSong);
  assert.notEqual(harness.calls.normalQueueCalls[0].index, 0);
});

test('outgoing ended during crossfade immediately finishes on the adopted candidate', async () => {
  const harness = createHarness({ transition: { mode: 'crossfade', durationSeconds: 3 } });
  const candidate = await prepareCandidate(harness);

  harness.activeMedia.currentTime = 97;
  harness.runtime.tick();
  await settle();

  assert.equal(harness.runtime.diagnostics().state, 'transitioning');
  assert.equal(harness.window.audio, candidate);
  assert.equal((harness.activeMedia.listeners.get('ended') || []).length, 1);
  assert.equal((harness.activeMedia.listeners.get('error') || []).length, 1);

  harness.activeMedia.ended = true;
  harness.activeMedia.paused = true;
  harness.activeMedia.emit('ended');

  assert.equal(harness.runtime.diagnostics().state, 'idle');
  assert.equal(harness.window.audio, candidate);
  assert.equal(candidate.paused, false);
  assert.equal(candidate.__mineradioDeckGain.gain.value, 1);
  assert.equal(harness.activeMedia.paused, true);
  assert.equal(harness.activeMedia.src, '');
  assert.equal(harness.activeMedia.__mineradioDeckGain.gain.value, 0);
  assert.equal((harness.activeMedia.listeners.get('ended') || []).length, 0);
  assert.equal((harness.activeMedia.listeners.get('error') || []).length, 0);
  assert.equal(harness.calls.originalEnded, 0);
  assert.equal(harness.calls.preparedAdoptions, 1);
  assert.equal(harness.calls.normalQueueCalls.length, 0);

  harness.activeMedia.emit('ended');
  harness.activeMedia.emit('error');
  harness.timers.runTimeoutsThrough(5000);
  await settle();
  assert.equal(harness.calls.preparedAdoptions, 1);
  assert.equal(harness.calls.normalQueueCalls.length, 0);
});

test('late source response from a cancelled preparation cannot cancel its replacement job', async () => {
  const harness = createHarness({
    transition: { mode: 'gapless', durationSeconds: 0 },
    deferApiRequests: true,
  });

  harness.runtime.tick();
  await settle();
  assert.equal(harness.calls.apiRequests, 1);
  assert.equal(harness.runtime.diagnostics().state, 'preparing');
  const reusedCandidate = harness.mediaInstances[1];

  harness.runtime.cancel('test-replace-preparation');
  assert.equal(harness.runtime.diagnostics().state, 'idle');
  harness.runtime.tick();
  await settle();

  assert.equal(harness.calls.apiRequests, 2);
  assert.equal(harness.mediaInstances.length, 2);
  assert.equal(harness.mediaInstances[1], reusedCandidate);
  assert.equal(harness.runtime.diagnostics().state, 'preparing');

  harness.resolveApiRequest(0, { url: 'https://media.example/stale.mp3', level: 'hires' });
  await settle(24);

  assert.equal(harness.calls.apiRequests, 2);
  assert.equal(harness.runtime.diagnostics().state, 'preparing');
  assert.equal(harness.runtime.diagnostics().nextIndex, 1);
  assert.equal(reusedCandidate.src, '');

  harness.resolveApiRequest(1, { url: 'https://media.example/replacement.mp3', level: 'hires' });
  await settle(24);

  assert.equal(harness.runtime.diagnostics().state, 'ready');
  assert.match(reusedCandidate.src, /replacement\.mp3/);
  assert.doesNotMatch(reusedCandidate.src, /stale\.mp3/);
});

test('late play resolution from a cancelled job cannot pause a reused active candidate deck', async () => {
  const harness = createHarness({
    transition: { mode: 'crossfade', durationSeconds: 3 },
    deferFirstCandidatePlay: true,
  });
  const candidate = await prepareCandidate(harness);

  harness.activeMedia.currentTime = 97;
  harness.runtime.tick();
  await settle();
  assert.equal(harness.runtime.diagnostics().state, 'starting');
  assert.equal(candidate.playCount, 1);

  harness.runtime.cancel('test-reuse-candidate');
  assert.equal(harness.runtime.diagnostics().state, 'idle');
  assert.equal(candidate.src, '');

  harness.runtime.tick();
  await settle(24);
  assert.equal(harness.calls.apiRequests, 2);
  assert.equal(harness.mediaInstances.length, 2);
  assert.equal(harness.mediaInstances[1], candidate);
  assert.equal(harness.runtime.diagnostics().state, 'ready');

  harness.runtime.tick();
  await settle(24);
  assert.equal(candidate.playCount, 2);
  assert.equal(harness.calls.preparedAdoptions, 1);
  assert.equal(harness.runtime.diagnostics().state, 'transitioning');
  assert.equal(harness.window.audio, candidate);
  assert.equal(candidate.paused, false);
  const adoptedSource = candidate.src;
  const pauseCountBeforeLateResolution = candidate.pauseCount;

  harness.resolveFirstCandidatePlay();
  await settle(24);

  assert.equal(harness.window.audio, candidate);
  assert.equal(harness.window.currentIdx, 1);
  assert.equal(harness.runtime.diagnostics().state, 'transitioning');
  assert.equal(candidate.paused, false);
  assert.equal(candidate.pauseCount, pauseCountBeforeLateResolution);
  assert.equal(candidate.src, adoptedSource);
  assert.equal(harness.calls.preparedAdoptions, 1);
  assert.equal(harness.calls.normalQueueCalls.length, 0);
});

test('failed crossfade candidate is not prepared again during the failure throttle window', async () => {
  const harness = createHarness({
    transition: { mode: 'crossfade', durationSeconds: 3 },
    candidatePlayReject: true,
  });
  const candidate = await prepareCandidate(harness);

  harness.activeMedia.currentTime = 97;
  harness.runtime.tick();
  await settle(24);

  assert.equal(candidate.playCount, 1);
  assert.equal(harness.calls.apiRequests, 1);
  assert.equal(harness.runtime.diagnostics().state, 'idle');
  assert.equal(candidate.src, '');

  harness.runtime.tick();
  harness.runtime.tick();
  await settle(24);

  assert.equal(harness.calls.apiRequests, 1);
  assert.equal(harness.mediaInstances.length, 2);
  assert.equal(harness.runtime.diagnostics().state, 'idle');
});
