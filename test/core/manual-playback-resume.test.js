'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const attemptSource = sourceBetween(
  indexSource,
  'async function attemptAudioPlay',
  'async function playAudio',
);

test('manual playback resumes AudioContext before calling media play', () => {
  const resumeAt = attemptSource.indexOf('await resumeAudioAnalysis()');
  const playAt = attemptSource.indexOf('await expectedMedia.play()');

  assert.notEqual(resumeAt, -1);
  assert.notEqual(playAt, -1);
  assert.ok(resumeAt < playAt);
});

test('manual playback waits for a suspended AudioContext to resume', async () => {
  const events = [];
  let releaseResume;
  let suspended = true;
  const context = vm.createContext({
    audio: {
      play() {
        events.push('play');
        return Promise.resolve();
      },
    },
    audioCtx: { state: 'suspended' },
    audioReady: true,
    playing: false,
    trackSwitchToken: 7,
    initAudio() { events.push('init'); },
    preparePlaybackFadeIn() { events.push('prepare-fade'); },
    playbackAttemptStillCurrent(media, token) {
      return !!media && token === 7;
    },
    resumeAudioAnalysis() {
      if (!suspended) {
        events.push('resume-check');
        return Promise.resolve();
      }
      events.push('resume-request');
      return new Promise(resolve => {
        releaseResume = () => {
          suspended = false;
          events.push('resume-complete');
          resolve();
        };
      });
    },
    switchPlaybackVisualToEmily() { events.push('visual'); },
    setPlayIcon(value) { events.push('icon:' + String(value)); },
    startPlaybackFadeIn() { events.push('fade-in'); },
    restorePlaybackGain() { events.push('restore-gain'); },
    schedulePlaybackStallRecovery() { events.push('stall-watch'); },
    forcePlaybackControlsInteractive() { events.push('controls'); },
    hideLoading() { events.push('hide-loading'); },
    showToast() { events.push('toast'); },
    console: { warn() {} },
  });
  vm.runInContext(attemptSource, context, { filename: 'manual-playback-resume.js' });

  const playback = context.attemptAudioPlay({ manual: true, fade: false, silent: true });
  await Promise.resolve();
  assert.deepEqual(events, ['resume-request']);

  releaseResume();
  assert.equal(await playback, true);
  assert.ok(events.indexOf('resume-complete') < events.indexOf('play'));
  assert.equal(events.includes('toast'), false);
});
