'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const transitionSource = fs.readFileSync(path.join(root, 'public', 'js', 'v153-transition.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('closed AudioContext rebuilds the current media element and graph', () => {
  const replacement = sourceBetween(indexSource, 'function replacePlaybackAudioAfterContextClose()', 'function initAudio()');
  const init = sourceBetween(indexSource, 'function initAudio()', 'function recoverClosedAudioContext');
  assert.match(replacement, /new Audio\(\)/);
  assert.match(replacement, /previous\.currentSrc \|\| previous\.src/);
  assert.match(replacement, /previous\.currentTime/);
  assert.match(replacement, /__mineradioQueueItemKey/);
  assert.match(replacement, /__mineradioTrackSwitchToken/);
  assert.match(replacement, /installQueueAudioEndedHandler\(replacement/);
  assert.match(replacement, /bindPlaybackProgressEvents\(replacement\)/);
  assert.match(init, /audioCtx\.state === 'closed'/);
  assert.match(init, /replacePlaybackAudioAfterContextClose\(\)/);
});

test('closed context recovery is single-flight and resumes only when appropriate', () => {
  const recovery = sourceBetween(indexSource, 'function recoverClosedAudioContext', 'function resumeAudioAnalysis');
  assert.match(recovery, /audioContextRecoveryPromise/);
  assert.match(recovery, /var shouldResume = !!resumePlayback \|\| audioContextResumeAfterReset/);
  assert.match(recovery, /await resumeAudioAnalysis\(\)/);
  assert.match(recovery, /if \(shouldResume && audio && audio\.src\)/);
  assert.match(indexSource, /audioCtx && audioCtx\.state === 'closed' && now - audioContextRecoveryLastAt > 2000/);
  assert.match(
    indexSource,
    /if \(audioCtx && audioCtx\.state === 'closed'\) \{\s*await recoverClosedAudioContext\(false\);\s*expectedMedia = audio;\s*\}/,
  );
});

test('transition module discards its old standby deck during graph recovery', () => {
  const reset = sourceBetween(transitionSource, 'function resetMediaPool', 'async function applyOutputToMedia');
  assert.match(reset, /cancelTransition/);
  assert.match(reset, /standbyMedia = null/);
  assert.match(reset, /discardMedia\(staleStandby\)/);
  assert.match(transitionSource, /resetMediaPool: resetMediaPool/);
});
