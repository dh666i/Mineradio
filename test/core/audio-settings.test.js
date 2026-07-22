'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const audioSettings = require('../../public/js/core/audio-settings');

test('default settings are conservative and enable next-track prefetch', () => {
  const settings = audioSettings.normalizeSettings(null);
  assert.equal(settings.eq.enabled, false);
  assert.equal(settings.eq.preset, 'flat');
  assert.deepEqual(settings.eq.gains, new Array(10).fill(0));
  assert.equal(settings.loudness.enabled, false);
  assert.equal(settings.output.deviceId, 'default');
  assert.equal(settings.prefetch.enabled, true);
  assert.deepEqual(settings.transition, { mode: 'gapless', durationSeconds: 0 });

  const stage = audioSettings.computeGainStage(settings);
  assert.equal(stage.processingEnabled, false);
  assert.equal(stage.limiterEnabled, false);
  assert.equal(stage.limiterThresholdDb, 0);
  assert.equal(stage.limiterRatio, 1);
  assert.equal(stage.linearGain, 1);
});

test('normalizeSettings clamps malformed values and keeps custom gains', () => {
  const settings = audioSettings.normalizeSettings({
    eq: { enabled: true, preset: 'custom', gains: [-99, 1.24, 99] },
    loudness: { enabled: true, preampDb: 42 },
    output: { deviceId: ' speakers ' },
    prefetch: { enabled: false },
  });
  assert.deepEqual(settings.eq.gains.slice(0, 4), [-12, 1.2, 12, 0]);
  assert.equal(settings.loudness.preampDb, 6);
  assert.equal(settings.output.deviceId, 'speakers');
  assert.equal(settings.prefetch.enabled, false);
  assert.deepEqual(settings.transition, { mode: 'gapless', durationSeconds: 0 });
});

test('transition settings normalize legacy, supported, and malformed values', () => {
  assert.deepEqual(audioSettings.normalizeTransition(null), { mode: 'gapless', durationSeconds: 0 });
  assert.deepEqual(audioSettings.normalizeTransition({ mode: 'off', durationSeconds: 8 }), { mode: 'off', durationSeconds: 0 });
  assert.deepEqual(audioSettings.normalizeTransition({ mode: 'gapless', durationSeconds: 5 }), { mode: 'gapless', durationSeconds: 0 });
  assert.deepEqual(audioSettings.normalizeTransition({ mode: 'crossfade', durationSeconds: 3 }), { mode: 'crossfade', durationSeconds: 3 });
  assert.deepEqual(audioSettings.normalizeTransition({ mode: 'crossfade', durationSeconds: 8 }), { mode: 'crossfade', durationSeconds: 8 });
  assert.deepEqual(audioSettings.normalizeTransition({ mode: 'crossfade', durationSeconds: 4 }), { mode: 'crossfade', durationSeconds: 5 });
  assert.deepEqual(audioSettings.normalizeTransition({ mode: 'invalid', durationSeconds: 8 }), { mode: 'gapless', durationSeconds: 0 });
});

test('transition choices round trip through persisted settings', () => {
  ['off', 'gapless', 'crossfade-3', 'crossfade-5', 'crossfade-8'].forEach((choice) => {
    const settings = audioSettings.applyTransitionChoice(audioSettings.defaultSettings(), choice);
    assert.equal(audioSettings.transitionChoice(settings.transition), choice);
    assert.deepEqual(audioSettings.normalizeSettings(settings).transition, settings.transition);
  });

  const invalid = audioSettings.applyTransitionChoice(audioSettings.defaultSettings(), 'crossfade-4');
  assert.deepEqual(invalid.transition, { mode: 'gapless', durationSeconds: 0 });
});

test('known preset replaces stale persisted gains', () => {
  const settings = audioSettings.normalizeSettings({
    eq: { enabled: true, preset: 'vocal', gains: new Array(10).fill(12) },
  });
  assert.deepEqual(settings.eq.gains, audioSettings.PRESET_GAINS.vocal);
});

test('applyPreset and setBandGain switch between preset and custom', () => {
  let settings = audioSettings.applyPreset(audioSettings.defaultSettings(), 'bass');
  assert.equal(settings.eq.preset, 'bass');
  settings = audioSettings.setBandGain(settings, 0, 4);
  assert.equal(settings.eq.preset, 'custom');
  settings = audioSettings.setBandGain(settings, 0, audioSettings.PRESET_GAINS.bass[0]);
  assert.equal(settings.eq.preset, 'bass');
});

test('computeGainStage reserves headroom for positive EQ bands', () => {
  const settings = audioSettings.normalizeSettings({
    eq: { enabled: true, preset: 'custom', gains: [6, 3, 0, 0, 0, 0, 0, 0, 0, 0] },
    loudness: { enabled: false, preampDb: 5 },
  });
  const stage = audioSettings.computeGainStage(settings);
  assert.equal(stage.requestedPreampDb, 0);
  assert.equal(stage.eqHeadroomDb, 6);
  assert.equal(stage.effectivePreampDb, -6);
  assert.ok(Math.abs(stage.linearGain - 0.501187) < 0.00001);
});

test('enabled loudness preamp is combined with EQ headroom', () => {
  const settings = audioSettings.normalizeSettings({
    eq: { enabled: true, preset: 'custom', gains: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    loudness: { enabled: true, preampDb: 2 },
  });
  const stage = audioSettings.computeGainStage(settings);
  assert.equal(stage.requestedPreampDb, 2);
  assert.equal(stage.eqHeadroomDb, 4);
  assert.equal(stage.effectivePreampDb, -2);
  assert.equal(stage.processingEnabled, true);
  assert.equal(stage.limiterEnabled, true);
  assert.equal(stage.limiterThresholdDb, -1);
  assert.equal(stage.limiterRatio, 20);
});

test('chooseOutputDevice honors an available preference', () => {
  const result = audioSettings.chooseOutputDevice([
    { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
    { kind: 'audiooutput', deviceId: 'default', label: 'Default' },
    { kind: 'audiooutput', deviceId: 'usb', label: 'USB DAC' },
  ], 'usb');
  assert.equal(result.selectedId, 'usb');
  assert.equal(result.preferredAvailable, true);
  assert.equal(result.devices.length, 2);
  assert.equal(result.labelsAvailable, true);
});

test('chooseOutputDevice falls back without exposing an invalid id', () => {
  const result = audioSettings.chooseOutputDevice([
    { kind: 'audiooutput', deviceId: 'default', label: '' },
  ], 'missing');
  assert.equal(result.selectedId, 'default');
  assert.equal(result.preferredAvailable, false);
  assert.equal(result.labelsAvailable, false);
});

test('nextPrefetchIndex only predicts deterministic sequential playback', () => {
  assert.equal(audioSettings.nextPrefetchIndex(1, 4, 'loop'), 2);
  assert.equal(audioSettings.nextPrefetchIndex(3, 4, 'loop'), 0);
  assert.equal(audioSettings.nextPrefetchIndex(1, 4, 'single'), -1);
  assert.equal(audioSettings.nextPrefetchIndex(1, 4, 'shuffle'), -1);
  assert.equal(audioSettings.nextPrefetchIndex(-1, 4, 'loop'), -1);
});

test('buildNeteaseSourceRequest validates songs and downgrades master quality without SVIP', () => {
  assert.deepEqual(audioSettings.buildNeteaseSourceRequest({ id: 123 }, 'jymaster', false), {
    id: '123',
    quality: 'hires',
    url: '/api/song/url?id=123&quality=hires',
  });
  assert.equal(audioSettings.buildNeteaseSourceRequest({ id: 'qq-mid' }, 'hires', true), null);
  assert.equal(audioSettings.buildNeteaseSourceRequest({ id: 123, type: 'podcast' }, 'hires', true), null);
});

test('formatFrequency uses compact labels for the ten EQ bands', () => {
  assert.equal(audioSettings.formatFrequency(31), '31');
  assert.equal(audioSettings.formatFrequency(1000), '1k');
  assert.equal(audioSettings.formatFrequency(16000), '16k');
});
