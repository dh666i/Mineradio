'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const v140Source = fs.readFileSync(path.join(root, 'public', 'js', 'v140.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(root, 'public', 'js', 'core', 'audio-transition.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(root, 'public', 'js', 'v153-transition.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('index loads the transition core before player code and runtime after audio settings', () => {
  const core = '<script src="js/core/audio-transition.js"></script>';
  const v150Audio = '<script src="js/v150-audio.js"></script>';
  const runtime = '<script src="js/v153-transition.js"></script>';
  const inlinePlayer = "<script>\n'use strict';";

  assert.match(indexSource, /<script src="js\/core\/audio-transition\.js"><\/script>/);
  assert.match(indexSource, /<script src="js\/v153-transition\.js"><\/script>/);
  assert.ok(indexSource.indexOf(core) < indexSource.indexOf(inlinePlayer));
  assert.ok(indexSource.indexOf(v150Audio) < indexSource.indexOf(runtime));
});

test('each playback deck joins the shared analyser and beat analyser graph', () => {
  const attach = sourceBetween(
    indexSource,
    'function attachPlaybackAudioElement',
    'function setPlaybackAudioDeckGain',
  );
  const init = sourceBetween(indexSource, 'function initAudio()', 'function resumeAudioAnalysis');

  assert.match(attach, /media\.__mineradioAudioContext === audioCtx[\s\S]*?media\.__mineradioDeckGain[\s\S]*?media\.__mineradioMediaSource/);
  assert.match(attach, /audioCtx\.createMediaElementSource\(media\)/);
  assert.match(attach, /audioCtx\.createGain\(\)/);
  assert.match(attach, /mediaSource\.connect\(deckGain\)/);
  assert.match(attach, /deckGain\.connect\(analyser\)/);
  assert.match(attach, /deckGain\.connect\(beatAnalyser\)/);
  assert.match(init, /analyser\.connect\(gainNode\)[\s\S]*?gainNode\.connect\(audioCtx\.destination\)/);
  assert.match(init, /attachPlaybackAudioElement\(audio, 1\)[\s\S]*?source = deck\.source/);
});

test('events from a retired deck cannot overwrite active playback state', () => {
  const binding = sourceBetween(
    indexSource,
    'function bindPlaybackProgressEvents',
    'function emitProgressDragParticles',
  );
  const activeDeckGuards = binding.match(/if \(audioEl !== audio\) return;/g) || [];

  assert.equal(activeDeckGuards.length, 2);
  assert.match(binding, /audioEl\.addEventListener\(name,[\s\S]*?updatePlaybackProgressUi\(\)/);
  assert.match(binding, /audioEl\.addEventListener\(name,[\s\S]*?syncPlaybackStateFromAudioEvent\(name\)/);
});

test('prepared transition adoption reuses the candidate without pausing or loading it', () => {
  const playback = sourceBetween(indexSource, 'async function playQueueAt', 'async function attemptAudioPlay');
  const preparedStart = sourceBetween(
    playback,
    "markPlayPhase('transition-audio-start');",
    "markPlayPhase('visual-prep');",
  );

  assert.match(playback, /preparedTransition\.oldAudio === audio/);
  assert.match(playback, /preparedTransition\.nextKey === preparedSongKey/);
  assert.match(playback, /if \(!preparedTransition\) pauseCurrentAudioForTrackSwitch\(\)/);
  assert.match(playback, /if \(preparedTransition\) \{\s*audio = preparedTransition\.media;[\s\S]*?attachPlaybackAudioElement\(audio, null\)/);
  assert.match(playback, /if \(!preparedTransition\) audio\.src = proxyAudioUrl/);
  assert.match(playback, /if \(!preparedTransition\) \{\s*scheduleAudioResumePosition\(audio, opts\.resumeAt, token\);\s*audio\.load\(\);\s*\}/);
  assert.match(preparedStart, /playbackStarted = !!\(audio && !audio\.paused && !audio\.ended\)/);
  assert.match(preparedStart, /preparedTransition\.onAdopted\(audio\)/);
  assert.doesNotMatch(preparedStart, /playAudio\(/);
  assert.match(playback, /notifyPreparedTransitionSettled\('committed'\)/);
  assert.doesNotMatch(playback, /preparedTransition\.media\.(?:pause|load)\(/);
});

test('runtime blocks unsafe content and validates sleep, output, and queue identity', () => {
  const assessment = sourceBetween(runtimeSource, 'function assessCurrentTransition', 'function deckGainParam');
  const coreEligibility = sourceBetween(coreSource, 'function assessTransitionEligibility', 'function canTransition');
  const sleep = sourceBetween(runtimeSource, 'function currentSleepMode', 'function providerKey');
  const output = sourceBetween(runtimeSource, 'async function applyOutputToMedia', 'function callOriginalEnded');
  const identity = sourceBetween(runtimeSource, 'function jobStillMatches', 'function bufferedSecondsFromStart');

  assert.match(assessment, /transitionCore\.assessTransitionEligibility\(\{/);
  assert.match(assessment, /queue: queue/);
  assert.match(assessment, /sleepMode: currentSleepMode\(\)/);
  assert.match(coreEligibility, /isPodcastSong\(currentSong\) \|\| isPodcastSong\(nextSong\)/);
  assert.match(assessment, /providerKey\(queue\[assessment\.currentIndex\]\) !== 'netease'/);
  assert.match(assessment, /media\.playbackRate !== 1/);
  assert.match(sleep, /window\.getMineradioSleepMode/);
  assert.match(v140Source, /window\.getMineradioSleepMode = function \(\) \{ return sleepState\.mode; \}/);
  assert.match(output, /settings\.output\.deviceId \|\| 'default'/);
  assert.match(output, /await media\.setSinkId\(deviceId\)/);
  assert.match(identity, /window\.audio !== job\.activeMedia/);
  assert.match(identity, /window\.currentIdx\) !== job\.currentIndex/);
  assert.match(identity, /songStableKey\(queue\[job\.currentIndex\]\) !== job\.currentKey/);
  assert.match(identity, /songStableKey\(queue\[job\.nextIndex\]\) !== job\.nextKey/);
  assert.match(identity, /currentSleepMode\(\) === 'track'/);
});

test('gapless mode takes over ended and restores the original handler on fallback', () => {
  const arm = sourceBetween(runtimeSource, 'function armGaplessTransition', 'function markCandidateReady');
  const start = sourceBetween(runtimeSource, 'async function startPreparedTransition', 'function armGaplessTransition');
  const restore = sourceBetween(runtimeSource, 'function restorePreparedEndedHandler', 'function cancelTransition');
  const prepare = sourceBetween(runtimeSource, 'async function prepareTransition', 'function bindPlaybackCancellation');

  assert.match(prepare, /originalEnded: activeMedia\.onended/);
  assert.match(arm, /job\.gaplessEndedHandler = function \(event\)/);
  assert.match(arm, /startPreparedTransition\(job, 'ended'\)/);
  assert.match(arm, /job\.activeMedia\.onended = job\.gaplessEndedHandler/);
  assert.match(start, /trigger === 'ended'[\s\S]*?callOriginalEnded\(job\)/);
  assert.match(start, /candidate-not-ready'[\s\S]*?callOriginalEnded\(job\)/);
  assert.match(restore, /job\.activeMedia\.onended = job\.originalEnded/);
});

test('equal-power automation and cancellation cover both decks and user actions', () => {
  const fade = sourceBetween(runtimeSource, 'function scheduleEqualPowerFade', 'function releaseMedia');
  const cancel = sourceBetween(runtimeSource, 'function cancelTransition', 'function finishTransition');
  const playbackCancellation = sourceBetween(runtimeSource, 'function bindPlaybackCancellation', 'function tickTransition');
  const wrapper = sourceBetween(runtimeSource, 'function wrapQueuePlayback', 'function diagnostics');

  assert.match(fade, /transitionCore\.equalPowerGains\(i \/ points\)/);
  assert.match(fade, /outgoingParam\.setValueCurveAtTime\(outgoingCurve, now, seconds\)/);
  assert.match(fade, /incomingParam\.setValueCurveAtTime\(incomingCurve, now, seconds\)/);
  assert.match(cancel, /restorePreparedEndedHandler\(job\)/);
  assert.match(cancel, /cancelDeckAutomation\(job\.activeMedia\)/);
  assert.match(cancel, /cancelDeckAutomation\(job\.media\)/);
  assert.match(playbackCancellation, /addEventListener\('pause'[\s\S]*?cancelTransition\('active-paused'\)/);
  assert.match(playbackCancellation, /addEventListener\('seeking'[\s\S]*?cancelTransition\('active-seeked'\)/);
  assert.match(wrapper, /if \(!options\.preparedTransition\) \{[\s\S]*?cancelTransition\('queue-switch'\)/);
  assert.match(wrapper, /cancelTransition\('queue-switch'\)[\s\S]*?clearTransitionMediaErrorHandler\(window\.audio\)/);
  assert.match(runtimeSource, /mineradio:audio-transition-change'[\s\S]*?cancelTransition\('settings-changed'\)/);
  assert.match(runtimeSource, /beforeunload'[\s\S]*?cancelTransition\('unload'\)/);
  assert.match(runtimeSource, /window\.MineradioTransitionV153 = \{[\s\S]*?cancel: cancelTransition/);
});

test('pause fade cancels an active track transition before scheduling audio pause', () => {
  const fadeOut = sourceBetween(indexSource, 'function fadeOutAndPauseAudio()', 'function applyVolumeToAudio');
  const transitionCancel = "window.MineradioTransitionV153.cancel('pause-intent');";
  const pauseTimer = 'audioFadeTimer = setTimeout(';

  assert.match(fadeOut, /window\.MineradioTransitionV153[\s\S]*?cancel\('pause-intent'\)/);
  assert.match(fadeOut, /audioFadeTimer = setTimeout\(/);
  assert.ok(fadeOut.indexOf(transitionCancel) < fadeOut.indexOf(pauseTimer));
});
