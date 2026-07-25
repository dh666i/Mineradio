'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const transition = require('../../public/js/core/audio-transition');

function queue() {
  return [
    { id: 101, name: 'First', artist: 'A', duration: 240 },
    { id: 102, name: 'Second', artist: 'B', duration: 260 },
    { id: 103, name: 'Third', artist: 'C', duration: 220 },
  ];
}

test('transition config normalization accepts persisted objects and compact choices', () => {
  assert.deepEqual(transition.normalizeTransitionConfig(null), { mode: 'gapless', durationSeconds: 0 });
  assert.deepEqual(transition.normalizeTransitionConfig('off'), { mode: 'off', durationSeconds: 0 });
  assert.deepEqual(transition.normalizeTransitionConfig('crossfade-3'), { mode: 'crossfade', durationSeconds: 3 });
  assert.deepEqual(transition.normalizeTransitionConfig(8), { mode: 'crossfade', durationSeconds: 8 });
  assert.deepEqual(transition.normalizeTransitionConfig({ mode: 'crossfade', durationSeconds: 5 }), { mode: 'crossfade', durationSeconds: 5 });
  assert.deepEqual(transition.normalizeTransitionConfig({ mode: 'crossfade', durationSeconds: 4 }), { mode: 'crossfade', durationSeconds: 5 });
  assert.deepEqual(transition.normalizeTransitionConfig({ mode: 'invalid', durationSeconds: 8 }), { mode: 'gapless', durationSeconds: 0 });
});

test('transitionFadeSeconds only returns a duration for crossfade mode', () => {
  assert.equal(transition.transitionFadeSeconds('off'), 0);
  assert.equal(transition.transitionFadeSeconds('gapless'), 0);
  assert.equal(transition.transitionFadeSeconds('crossfade-3'), 3);
  assert.equal(transition.transitionFadeSeconds({ mode: 'crossfade', durationSeconds: 8 }), 8);
});

test('resolveNaturalNextIndex follows only deterministic loop playback', () => {
  const songs = queue();
  assert.equal(transition.resolveNaturalNextIndex(songs, 0, 'loop'), 1);
  assert.equal(transition.resolveNaturalNextIndex(songs, 2, 'loop'), 0);
  assert.equal(transition.resolveNaturalNextIndex(songs.length, 1, 'loop'), 2);
  assert.equal(transition.resolveNaturalNextIndex(songs, 1, 'single'), -1);
  assert.equal(transition.resolveNaturalNextIndex(songs, 1, 'shuffle'), -1);
  assert.equal(transition.resolveNaturalNextIndex(songs, -1, 'loop'), -1);
  assert.equal(transition.resolveNaturalNextIndex([], 0, 'loop'), -1);
});

test('songStableKey is provider-aware and never depends on playback URLs', () => {
  assert.equal(transition.songStableKey({ id: 12, name: 'Song' }), 'song:12');
  assert.equal(transition.songStableKey({ provider: 'qq', mid: '003abc', id: 12 }), 'qq:003abc');
  assert.equal(transition.songStableKey({ type: 'podcast', programId: 45 }), 'podcast:45');
  assert.equal(transition.songStableKey({ source: 'local', localKey: 'file-key', localUrl: 'blob:one' }), 'local:file-key');
  assert.equal(transition.songStableKey({ name: '  Same  Song ', artist: ' A  B ', url: 'https://one' }), 'meta:Same Song|A B');
  assert.equal(transition.songStableKey({}), '');
});

test('podcast and local predicates cover both type and source variants', () => {
  assert.equal(transition.isPodcastSong({ type: 'podcast' }), true);
  assert.equal(transition.isPodcastSong({ source: 'podcast' }), true);
  assert.equal(transition.isPodcastSong({ type: 'podcast-radio' }), true);
  assert.equal(transition.isPodcastSong({ type: 'song' }), false);
  assert.equal(transition.isLocalSong({ type: 'local' }), true);
  assert.equal(transition.isLocalSong({ localUrl: 'blob:track' }), true);
  assert.equal(transition.isLocalSong({ id: 1 }), false);
});

test('eligible natural transitions expose stable runtime details', () => {
  const songs = queue();
  const gapless = transition.assessTransitionEligibility({
    transition: 'gapless',
    queue: songs,
    currentIndex: 0,
    playMode: 'loop',
  });
  assert.equal(gapless.eligible, true);
  assert.equal(gapless.reason, 'eligible');
  assert.equal(gapless.nextIndex, 1);
  assert.equal(gapless.currentKey, 'song:101');
  assert.equal(gapless.nextKey, 'song:102');
  assert.equal(gapless.fadeSeconds, 0);

  const crossfade = transition.assessTransitionEligibility({
    transition: 'crossfade-5',
    queue: songs,
    currentIndex: 1,
    playMode: 'loop',
    currentDurationSeconds: 260,
  });
  assert.equal(crossfade.eligible, true);
  assert.equal(crossfade.fadeSeconds, 5);
  assert.equal(crossfade.minimumDurationSeconds, 12);
});

test('mode, disabled transition, and stop-after-current prevent auto transition', () => {
  const songs = queue();
  const base = { transition: 'gapless', queue: songs, currentIndex: 0 };
  assert.equal(transition.assessTransitionEligibility({ ...base, transition: 'off', playMode: 'loop' }).reason, 'transition_off');
  assert.equal(transition.assessTransitionEligibility({ ...base, playMode: 'single' }).reason, 'single_mode');
  assert.equal(transition.assessTransitionEligibility({ ...base, playMode: 'shuffle' }).reason, 'shuffle_mode');
  assert.equal(transition.assessTransitionEligibility({ ...base, playMode: 'loop', sleepMode: 'track' }).reason, 'stop_after_current');
  assert.equal(transition.assessTransitionEligibility({ ...base, playMode: 'loop', stopAfterCurrent: true }).reason, 'stop_after_current');
});

test('podcast, local, duplicate, and missing songs are never transitioned', () => {
  const base = { transition: 'gapless', currentIndex: 0, playMode: 'loop' };
  assert.equal(transition.assessTransitionEligibility({ ...base, queue: [{ id: 1, type: 'podcast' }, { id: 2 }] }).reason, 'podcast_track');
  assert.equal(transition.assessTransitionEligibility({ ...base, queue: [{ id: 1 }, { id: 2, source: 'local' }] }).reason, 'local_track');
  assert.equal(transition.assessTransitionEligibility({ ...base, queue: [{ id: 1 }, { id: 1 }] }).reason, 'same_track');
  assert.equal(transition.assessTransitionEligibility({ ...base, queue: [] }).reason, 'missing_track');
  assert.equal(transition.canTransition({ ...base, queue: [{ id: 1 }, { id: 2 }] }), true);
});

test('crossfade rejects unknown and short durations while gapless remains eligible', () => {
  const songs = [{ id: 1 }, { id: 2 }];
  const base = { transition: 'crossfade-5', queue: songs, currentIndex: 0, playMode: 'loop' };
  assert.equal(transition.assessTransitionEligibility(base).reason, 'duration_unknown');
  assert.equal(transition.assessTransitionEligibility({ ...base, currentDurationSeconds: 11.99 }).reason, 'current_track_too_short');
  assert.equal(transition.assessTransitionEligibility({ ...base, currentDurationSeconds: 12 }).eligible, true);
  assert.equal(transition.assessTransitionEligibility({ ...base, currentDurationSeconds: 20, nextDurationSeconds: 5.9 }).reason, 'next_track_too_short');
  assert.equal(transition.assessTransitionEligibility({ ...base, currentDurationSeconds: 20, nextDurationSeconds: 6 }).eligible, true);
  assert.equal(transition.assessTransitionEligibility({ ...base, transition: 'gapless' }).eligible, true);
});

test('songDurationSeconds handles seconds and common millisecond metadata', () => {
  assert.equal(transition.songDurationSeconds({ durationSeconds: 123.5 }), 123.5);
  assert.equal(transition.songDurationSeconds({ durationMs: 245000 }), 245);
  assert.equal(transition.songDurationSeconds({ dt: 180000 }), 180);
  assert.equal(transition.songDurationSeconds({ duration: 240 }), 240);
  assert.equal(transition.songDurationSeconds({}), 0);
});

test('equal-power gains have exact endpoints and constant midpoint power', () => {
  assert.deepEqual(transition.equalPowerGains(0), { outgoing: 1, incoming: 0 });
  assert.deepEqual(transition.equalPowerGains(1), { outgoing: 0, incoming: 1 });
  assert.deepEqual(transition.equalPowerGains(-5), { outgoing: 1, incoming: 0 });
  assert.deepEqual(transition.equalPowerGains(9), { outgoing: 0, incoming: 1 });

  const midpoint = transition.equalPowerGains(0.5);
  assert.ok(Math.abs(midpoint.outgoing - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(midpoint.incoming - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(midpoint.outgoing ** 2 + midpoint.incoming ** 2 - 1) < 1e-12);
});
