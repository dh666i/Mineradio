(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.MineradioCore = root.MineradioCore || {};
    root.MineradioCore.audioTransition = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TRANSITION_MODES = ['off', 'gapless', 'crossfade'];
  var CROSSFADE_DURATIONS = [3, 5, 8];
  var DEFAULT_TRANSITION = { mode: 'gapless', durationSeconds: 0 };
  var DEFAULT_CROSSFADE_SECONDS = 5;
  var CROSSFADE_HEADROOM_SECONDS = 2;

  function finiteNumber(value, fallback) {
    value = Number(value);
    return isFinite(value) ? value : fallback;
  }

  function integer(value, fallback) {
    value = finiteNumber(value, fallback);
    return isFinite(value) ? Math.trunc(value) : fallback;
  }

  function cleanText(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  }

  function normalizeTransitionConfig(value) {
    if (typeof value === 'string') {
      var choice = cleanText(value).toLowerCase();
      var choiceMatch = /^crossfade-(3|5|8)$/.exec(choice);
      value = choiceMatch
        ? { mode: 'crossfade', durationSeconds: Number(choiceMatch[1]) }
        : { mode: choice };
    } else if (CROSSFADE_DURATIONS.indexOf(Number(value)) >= 0) {
      value = { mode: 'crossfade', durationSeconds: Number(value) };
    }

    value = value && typeof value === 'object' ? value : {};
    var mode = cleanText(value.mode || DEFAULT_TRANSITION.mode).toLowerCase();
    if (TRANSITION_MODES.indexOf(mode) < 0) mode = DEFAULT_TRANSITION.mode;
    var durationSeconds = Number(value.durationSeconds);
    if (mode === 'crossfade') {
      if (CROSSFADE_DURATIONS.indexOf(durationSeconds) < 0) durationSeconds = DEFAULT_CROSSFADE_SECONDS;
    } else {
      durationSeconds = 0;
    }
    return { mode: mode, durationSeconds: durationSeconds };
  }

  function transitionFadeSeconds(value) {
    var config = normalizeTransitionConfig(value);
    return config.mode === 'crossfade' ? config.durationSeconds : 0;
  }

  function queueLength(queue) {
    if (Array.isArray(queue)) return queue.length;
    return Math.max(0, integer(queue, 0));
  }

  function resolveNaturalNextIndex(queue, currentIndex, playMode) {
    var length = queueLength(queue);
    currentIndex = integer(currentIndex, -1);
    playMode = cleanText(playMode || 'loop').toLowerCase();
    if (!length || currentIndex < 0 || currentIndex >= length) return -1;
    if (playMode === 'single' || playMode === 'shuffle') return -1;
    if (playMode !== 'loop') return -1;
    return (currentIndex + 1) % length;
  }

  function isPodcastSong(song) {
    if (!song || typeof song !== 'object') return false;
    var type = cleanText(song.type).toLowerCase();
    var source = cleanText(song.source).toLowerCase();
    return type === 'podcast' || type === 'podcast-radio' || source === 'podcast';
  }

  function isLocalSong(song) {
    if (!song || typeof song !== 'object') return false;
    return cleanText(song.type).toLowerCase() === 'local'
      || cleanText(song.source).toLowerCase() === 'local'
      || !!song.localKey
      || !!song.localUrl;
  }

  function songStableKey(song) {
    if (!song || typeof song !== 'object') return '';
    var type = cleanText(song.type).toLowerCase();
    var source = cleanText(song.source).toLowerCase();
    var provider = cleanText(song.provider).toLowerCase();
    var name = cleanText(song.name || song.title);
    var artist = cleanText(song.artist);

    if (provider === 'qq' || source === 'qq' || type === 'qq') {
      var qqId = cleanText(song.mid || song.songmid || song.id);
      return qqId ? 'qq:' + qqId : (name || artist ? 'qq:' + name + '|' + artist : '');
    }
    if (isPodcastSong(song)) {
      var podcastId = cleanText(song.programId || song.id);
      return podcastId ? 'podcast:' + podcastId : (name || artist ? 'podcast:' + name + '|' + artist : '');
    }
    if (isLocalSong(song)) {
      var localId = cleanText(song.localKey || song.filePath || song.persistentPath || song.path);
      return localId ? 'local:' + localId : (name || artist ? 'local:' + name + '|' + artist : '');
    }
    if (song.id != null && cleanText(song.id)) return 'song:' + cleanText(song.id);
    return name || artist ? 'meta:' + name + '|' + artist : '';
  }

  function minimumCrossfadeTrackSeconds(fadeSeconds) {
    fadeSeconds = Math.max(0, finiteNumber(fadeSeconds, 0));
    return fadeSeconds ? fadeSeconds * 2 + CROSSFADE_HEADROOM_SECONDS : 0;
  }

  function songDurationSeconds(song) {
    if (!song || typeof song !== 'object') return 0;
    var raw = finiteNumber(song.durationSeconds, NaN);
    if (isFinite(raw) && raw > 0) return raw;
    raw = finiteNumber(song.durationMs != null ? song.durationMs : (song.dt != null ? song.dt : song.duration), 0);
    if (!(raw > 0)) return 0;
    return raw > 1000 ? raw / 1000 : raw;
  }

  function resultFor(reason, details) {
    return Object.assign({ eligible: reason === 'eligible', reason: reason }, details || {});
  }

  function assessTransitionEligibility(options) {
    options = options && typeof options === 'object' ? options : {};
    var config = normalizeTransitionConfig(options.config || options.transition);
    var fadeSeconds = transitionFadeSeconds(config);
    var queue = Array.isArray(options.queue) ? options.queue : [];
    var playMode = cleanText(options.playMode || 'loop').toLowerCase();
    var currentIndex = integer(options.currentIndex, -1);
    var nextIndex = options.nextIndex == null
      ? resolveNaturalNextIndex(queue, currentIndex, playMode)
      : integer(options.nextIndex, -1);
    var currentSong = options.currentSong || queue[currentIndex] || null;
    var nextSong = options.nextSong || queue[nextIndex] || null;
    var currentKey = songStableKey(currentSong);
    var nextKey = songStableKey(nextSong);
    var details = {
      config: config,
      fadeSeconds: fadeSeconds,
      currentIndex: currentIndex,
      nextIndex: nextIndex,
      currentKey: currentKey,
      nextKey: nextKey,
    };

    if (config.mode === 'off') return resultFor('transition_off', details);
    if (playMode === 'single') return resultFor('single_mode', details);
    if (playMode === 'shuffle') return resultFor('shuffle_mode', details);
    if (playMode !== 'loop') return resultFor('unsupported_play_mode', details);
    if (options.stopAfterCurrent === true || cleanText(options.sleepMode).toLowerCase() === 'track') {
      return resultFor('stop_after_current', details);
    }
    if (currentIndex < 0 || currentIndex >= queue.length || nextIndex < 0 || nextIndex >= queue.length || !currentSong || !nextSong) {
      return resultFor('missing_track', details);
    }
    if (isPodcastSong(currentSong) || isPodcastSong(nextSong)) return resultFor('podcast_track', details);
    if (isLocalSong(currentSong) || isLocalSong(nextSong)) return resultFor('local_track', details);
    if (!currentKey || !nextKey) return resultFor('unstable_track_key', details);
    if (currentKey === nextKey) return resultFor('same_track', details);

    if (config.mode === 'crossfade') {
      var currentDuration = options.currentDurationSeconds == null
        ? songDurationSeconds(currentSong)
        : Math.max(0, finiteNumber(options.currentDurationSeconds, 0));
      var nextDuration = options.nextDurationSeconds == null
        ? songDurationSeconds(nextSong)
        : Math.max(0, finiteNumber(options.nextDurationSeconds, 0));
      details.currentDurationSeconds = currentDuration;
      details.nextDurationSeconds = nextDuration;
      details.minimumDurationSeconds = minimumCrossfadeTrackSeconds(fadeSeconds);
      if (!currentDuration) return resultFor('duration_unknown', details);
      if (currentDuration < details.minimumDurationSeconds) return resultFor('current_track_too_short', details);
      if (nextDuration && nextDuration < fadeSeconds + 1) return resultFor('next_track_too_short', details);
    }

    return resultFor('eligible', details);
  }

  function canTransition(options) {
    return assessTransitionEligibility(options).eligible;
  }

  function equalPowerGains(progress) {
    progress = Math.max(0, Math.min(1, finiteNumber(progress, 0)));
    if (progress === 0) return { outgoing: 1, incoming: 0 };
    if (progress === 1) return { outgoing: 0, incoming: 1 };
    var angle = progress * Math.PI / 2;
    return {
      outgoing: Math.cos(angle),
      incoming: Math.sin(angle),
    };
  }

  return {
    TRANSITION_MODES: TRANSITION_MODES.slice(),
    CROSSFADE_DURATIONS: CROSSFADE_DURATIONS.slice(),
    DEFAULT_CROSSFADE_SECONDS: DEFAULT_CROSSFADE_SECONDS,
    CROSSFADE_HEADROOM_SECONDS: CROSSFADE_HEADROOM_SECONDS,
    normalizeTransitionConfig: normalizeTransitionConfig,
    transitionFadeSeconds: transitionFadeSeconds,
    resolveNaturalNextIndex: resolveNaturalNextIndex,
    isPodcastSong: isPodcastSong,
    isLocalSong: isLocalSong,
    songStableKey: songStableKey,
    songDurationSeconds: songDurationSeconds,
    minimumCrossfadeTrackSeconds: minimumCrossfadeTrackSeconds,
    assessTransitionEligibility: assessTransitionEligibility,
    canTransition: canTransition,
    equalPowerGains: equalPowerGains,
  };
});
