(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.MineradioCore = root.MineradioCore || {};
    root.MineradioCore.queueSession = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var DEFAULT_MAX_ITEMS = 500;
  var DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  var DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
  var BLOCKED_KEYS = {
    url: true,
    audiourl: true,
    songurl: true,
    localurl: true,
    streamurl: true,
    playurl: true,
    objecturl: true,
    customcover: true,
    file: true,
    blob: true,
    buffer: true,
    arraybuffer: true,
  };

  function finiteNumber(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function integer(value, fallback) {
    var number = finiteNumber(value, fallback);
    return isFinite(number) ? Math.trunc(number) : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function queueItemKey(song) {
    if (!song) return '';
    if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') {
      var qqId = song.mid || song.songmid || song.id || '';
      if (qqId) return 'qq:' + qqId;
      var qqName = String(song.name || song.title || '').trim();
      var qqArtist = String(song.artist || '').trim();
      return qqName || qqArtist ? 'qq:' + qqName + '|' + qqArtist : '';
    }
    if (song.type === 'podcast' && song.programId) return 'podcast:' + song.programId;
    if (song.localKey) return 'local:' + song.localKey;
    if (song.id != null && song.id !== '') return 'song:' + song.id;
    var name = String(song.name || song.title || '').trim();
    var artist = String(song.artist || '').trim();
    return name || artist ? name + '|' + artist : '';
  }

  function isBlockedKey(key) {
    if (!key) return false;
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return true;
    if (key.charAt(0) === '_') return true;
    if (BLOCKED_KEYS[String(key).toLowerCase()]) return true;
    return /cookie|token|secret|password|authorization|authkey|sessionid/i.test(key);
  }

  function sanitizeValue(value, key, depth) {
    if (isBlockedKey(key)) return undefined;
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
      if (/^(blob:|data:)/i.test(value)) return undefined;
      return value.length > 4096 ? value.slice(0, 4096) : value;
    }
    if (typeof value !== 'object' || depth >= 4) return undefined;

    if (Array.isArray(value)) {
      return value.slice(0, 64).map(function (item) {
        return sanitizeValue(item, '', depth + 1);
      }).filter(function (item) { return item !== undefined; });
    }

    var clean = {};
    Object.keys(value).slice(0, 96).forEach(function (childKey) {
      var child = sanitizeValue(value[childKey], childKey, depth + 1);
      if (child !== undefined) clean[childKey] = child;
    });
    return clean;
  }

  function isRestorableSong(song) {
    if (!song || typeof song !== 'object') return false;
    var local = song.type === 'local' || !!song.localKey;
    if (local && !(song.filePath || song.persistentPath || song.path)) return false;
    return !!queueItemKey(song);
  }

  function sanitizeSong(song) {
    if (!isRestorableSong(song)) return null;
    var clean = sanitizeValue(song, '', 0);
    if (!clean || !queueItemKey(clean)) return null;
    return clean;
  }

  function normalizePlayMode(value) {
    return value === 'shuffle' || value === 'single' ? value : 'loop';
  }

  function normalizePosition(position, duration) {
    position = Math.max(0, finiteNumber(position, 0));
    duration = Math.max(0, finiteNumber(duration, 0));
    if (!duration) return position;
    if (position >= Math.max(0, duration - 1.5)) return 0;
    return clamp(position, 0, duration);
  }

  function createQueueSnapshot(input, options) {
    input = input || {};
    options = options || {};
    var rawQueue = Array.isArray(input.queue) ? input.queue : (Array.isArray(input.playQueue) ? input.playQueue : []);
    var maxItems = Math.max(1, integer(options.maxItems, DEFAULT_MAX_ITEMS));
    var requestedIndex = integer(input.currentIndex != null ? input.currentIndex : input.currentIdx, -1);
    var requestedKey = String(input.currentKey || queueItemKey(input.activePlaybackSong) || queueItemKey(rawQueue[requestedIndex]) || '');
    var indexMap = {};
    var queue = [];

    for (var i = 0; i < rawQueue.length && queue.length < maxItems; i++) {
      var song = sanitizeSong(rawQueue[i]);
      if (!song) continue;
      indexMap[i] = queue.length;
      queue.push(song);
    }

    var currentIndex = Object.prototype.hasOwnProperty.call(indexMap, requestedIndex) ? indexMap[requestedIndex] : -1;
    if (currentIndex >= 0 && requestedKey && queueItemKey(queue[currentIndex]) !== requestedKey) currentIndex = -1;
    if (currentIndex < 0 && requestedKey) {
      for (var j = 0; j < queue.length; j++) {
        if (queueItemKey(queue[j]) === requestedKey) {
          currentIndex = j;
          break;
        }
      }
    }
    if (currentIndex < 0 && queue.length && requestedIndex >= 0) currentIndex = 0;

    var durationSeconds = Math.max(0, finiteNumber(input.durationSeconds != null ? input.durationSeconds : input.duration, 0));
    var positionSeconds = normalizePosition(
      input.positionSeconds != null ? input.positionSeconds : (input.currentTime != null ? input.currentTime : input.resumeAt),
      durationSeconds
    );
    var now = Math.max(0, finiteNumber(options.now, Date.now()));

    return {
      schemaVersion: SCHEMA_VERSION,
      savedAt: now,
      queue: queue,
      currentIndex: currentIndex,
      currentKey: currentIndex >= 0 ? queueItemKey(queue[currentIndex]) : '',
      positionSeconds: currentIndex >= 0 ? positionSeconds : 0,
      durationSeconds: currentIndex >= 0 ? durationSeconds : 0,
      playMode: normalizePlayMode(input.playMode),
      wasPlaying: !!(input.wasPlaying != null ? input.wasPlaying : input.playing),
      context: sanitizeValue(input.context || input.activeRadioContext || null, 'context', 0) || null,
    };
  }

  function serializeQueueSnapshot(input, options) {
    return JSON.stringify(createQueueSnapshot(input, options));
  }

  function parseSnapshotInput(raw) {
    if (typeof raw !== 'string') return raw;
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  }

  function migrateQueueSnapshot(raw, options) {
    options = options || {};
    var data;
    try {
      data = parseSnapshotInput(raw);
    } catch (error) {
      return { ok: false, reason: 'malformed_json', warnings: [] };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: 'invalid_snapshot', warnings: [] };
    }

    var hasVersion = data.schemaVersion != null || data.version != null;
    var fromVersion = hasVersion ? integer(data.schemaVersion != null ? data.schemaVersion : data.version, -1) : 0;
    if (fromVersion < 0 || fromVersion > SCHEMA_VERSION) {
      return { ok: false, reason: 'unsupported_schema', fromVersion: fromVersion, warnings: [] };
    }

    var legacy = fromVersion === 0;
    var source = legacy ? {
      queue: data.playQueue || data.queue,
      currentIndex: data.currentIdx != null ? data.currentIdx : data.currentIndex,
      currentKey: data.currentKey,
      positionSeconds: data.currentTime != null ? data.currentTime : data.positionSeconds,
      durationSeconds: data.duration != null ? data.duration : data.durationSeconds,
      playMode: data.playMode,
      wasPlaying: data.playing != null ? data.playing : data.wasPlaying,
      context: data.activeRadioContext || data.context,
    } : data;

    var warnings = [];
    var savedAt = Math.max(0, finiteNumber(data.savedAt, 0));
    if (!savedAt) {
      savedAt = Math.max(0, finiteNumber(options.now, Date.now()));
      warnings.push('missing_saved_at');
    }
    var snapshot = createQueueSnapshot(source, {
      now: savedAt,
      maxItems: options.maxItems,
    });
    if (snapshot.queue.length < (Array.isArray(source.queue) ? source.queue.length : 0)) warnings.push('items_sanitized');

    return {
      ok: true,
      snapshot: snapshot,
      fromVersion: fromVersion,
      migrated: fromVersion !== SCHEMA_VERSION,
      warnings: warnings,
    };
  }

  function restoreQueueSnapshot(raw, options) {
    options = options || {};
    var migrated = migrateQueueSnapshot(raw, options);
    if (!migrated.ok) return migrated;

    var snapshot = migrated.snapshot;
    if (!snapshot.queue.length) {
      return {
        ok: false,
        reason: 'empty_queue',
        migrated: migrated.migrated,
        warnings: migrated.warnings,
      };
    }

    var now = Math.max(0, finiteNumber(options.now, Date.now()));
    var maxAgeMs = options.maxAgeMs == null ? DEFAULT_MAX_AGE_MS : Math.max(0, finiteNumber(options.maxAgeMs, 0));
    var maxFutureSkewMs = options.maxFutureSkewMs == null
      ? DEFAULT_MAX_FUTURE_SKEW_MS
      : Math.max(0, finiteNumber(options.maxFutureSkewMs, 0));
    if (snapshot.savedAt > now + maxFutureSkewMs) {
      return {
        ok: false,
        reason: 'future_timestamp',
        migrated: migrated.migrated,
        warnings: migrated.warnings,
      };
    }
    if (maxAgeMs && snapshot.savedAt && now > snapshot.savedAt && now - snapshot.savedAt > maxAgeMs) {
      return {
        ok: false,
        reason: 'expired',
        migrated: migrated.migrated,
        warnings: migrated.warnings,
      };
    }

    return {
      ok: true,
      state: {
        queue: snapshot.queue,
        currentIndex: snapshot.currentIndex,
        currentKey: snapshot.currentKey,
        positionSeconds: snapshot.positionSeconds,
        durationSeconds: snapshot.durationSeconds,
        playMode: snapshot.playMode,
        wasPlaying: snapshot.wasPlaying,
        savedAt: snapshot.savedAt,
        context: snapshot.context,
      },
      migrated: migrated.migrated,
      warnings: migrated.warnings,
    };
  }

  function removeQueueItem(state, index, options) {
    state = state || {};
    options = options || {};
    var queue = Array.isArray(state.queue) ? state.queue.slice() : [];
    index = integer(index, -1);
    if (index < 0 || index >= queue.length) {
      return { changed: false, state: Object.assign({}, state, { queue: queue }), reason: 'invalid_index' };
    }

    var currentIndex = integer(state.currentIndex, -1);
    var removedCurrent = index === currentIndex;
    var removed = queue.splice(index, 1)[0];
    var nextAction = 'none';
    var next = Object.assign({}, state, { queue: queue });

    if (!queue.length) {
      next.currentIndex = -1;
      next.currentKey = '';
      next.positionSeconds = 0;
      next.durationSeconds = 0;
      next.wasPlaying = false;
      nextAction = removedCurrent ? 'stop' : 'none';
    } else if (removedCurrent) {
      var policy = options.onRemoveCurrent || 'advance';
      if (policy === 'detach') {
        next.currentIndex = -1;
        next.currentKey = queueItemKey(removed);
        nextAction = 'keep-playing-detached';
      } else if (policy === 'stop') {
        next.currentIndex = -1;
        next.currentKey = '';
        next.positionSeconds = 0;
        next.durationSeconds = 0;
        next.wasPlaying = false;
        nextAction = 'stop';
      } else {
        next.currentIndex = Math.min(index, queue.length - 1);
        next.currentKey = queueItemKey(queue[next.currentIndex]);
        next.positionSeconds = 0;
        next.durationSeconds = 0;
        nextAction = state.wasPlaying ? 'play-current' : 'load-current';
      }
    } else {
      if (index < currentIndex) currentIndex -= 1;
      next.currentIndex = currentIndex >= 0 && currentIndex < queue.length ? currentIndex : -1;
      next.currentKey = next.currentIndex >= 0 ? queueItemKey(queue[next.currentIndex]) : '';
    }

    return {
      changed: true,
      removed: removed,
      removedCurrent: removedCurrent,
      nextAction: nextAction,
      state: next,
    };
  }

  function moveQueueItem(state, fromIndex, toIndex) {
    state = state || {};
    var queue = Array.isArray(state.queue) ? state.queue.slice() : [];
    fromIndex = integer(fromIndex, -1);
    toIndex = integer(toIndex, -1);
    if (fromIndex < 0 || fromIndex >= queue.length || toIndex < 0 || toIndex >= queue.length) {
      return { changed: false, state: Object.assign({}, state, { queue: queue }), reason: 'invalid_index' };
    }
    if (fromIndex === toIndex) return { changed: false, state: Object.assign({}, state, { queue: queue }) };

    var currentIndex = integer(state.currentIndex, -1);
    var currentSong = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;
    var item = queue.splice(fromIndex, 1)[0];
    queue.splice(toIndex, 0, item);
    currentIndex = currentSong ? queue.indexOf(currentSong) : -1;

    return {
      changed: true,
      state: Object.assign({}, state, {
        queue: queue,
        currentIndex: currentIndex,
        currentKey: currentIndex >= 0 ? queueItemKey(queue[currentIndex]) : '',
      }),
    };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DEFAULT_MAX_AGE_MS: DEFAULT_MAX_AGE_MS,
    queueItemKey: queueItemKey,
    sanitizeSong: sanitizeSong,
    createQueueSnapshot: createQueueSnapshot,
    serializeQueueSnapshot: serializeQueueSnapshot,
    migrateQueueSnapshot: migrateQueueSnapshot,
    restoreQueueSnapshot: restoreQueueSnapshot,
    removeQueueItem: removeQueueItem,
    moveQueueItem: moveQueueItem,
  };
});
