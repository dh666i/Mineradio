(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.MineradioCore = root.MineradioCore || {};
    root.MineradioCore.audioSettings = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  var EQ_MIN_DB = -12;
  var EQ_MAX_DB = 12;
  var PREAMP_MIN_DB = -12;
  var PREAMP_MAX_DB = 6;
  var PRESET_GAINS = {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [6, 5, 3.5, 2, 0.5, -0.5, -1, -0.5, 0, 0],
    warm: [3.5, 2.5, 1.5, 0.5, 0, 0, 0.5, 1, 0.5, 0],
    vocal: [-2.5, -1.5, -0.5, 1.5, 3, 3.5, 2.5, 1, 0, -1],
    treble: [-1.5, -1, -0.5, 0, 0, 0.5, 1.5, 3, 4.5, 5],
    electronic: [4.5, 3, 0.5, -1, -0.5, 1, 2, 1, 3.5, 4.5],
  };
  var PRESET_NAMES = Object.keys(PRESET_GAINS);

  function finite(value, fallback) {
    value = Number(value);
    return isFinite(value) ? value : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, finite(value, min)));
  }

  function round(value, places) {
    var scale = Math.pow(10, places == null ? 2 : places);
    return Math.round(finite(value, 0) * scale) / scale;
  }

  function clonePreset(name) {
    var gains = PRESET_GAINS[name] || PRESET_GAINS.flat;
    return gains.slice();
  }

  function defaultSettings() {
    return {
      version: 1,
      eq: {
        enabled: false,
        preset: 'flat',
        gains: clonePreset('flat'),
      },
      loudness: {
        enabled: false,
        preampDb: 0,
      },
      output: {
        deviceId: 'default',
      },
      prefetch: {
        enabled: true,
      },
    };
  }

  function normalizeDeviceId(value) {
    value = String(value == null ? '' : value).trim();
    if (!value || value.length > 512) return 'default';
    return value;
  }

  function normalizeGains(values, fallback) {
    values = Array.isArray(values) ? values : [];
    fallback = Array.isArray(fallback) ? fallback : PRESET_GAINS.flat;
    return EQ_FREQUENCIES.map(function (_, index) {
      var raw = Number(values[index]);
      if (!isFinite(raw)) raw = finite(fallback[index], 0);
      return round(clamp(raw, EQ_MIN_DB, EQ_MAX_DB), 1);
    });
  }

  function gainsMatch(left, right, tolerance) {
    tolerance = Math.max(0, finite(tolerance, 0.05));
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== EQ_FREQUENCIES.length || right.length !== EQ_FREQUENCIES.length) {
      return false;
    }
    return left.every(function (gain, index) {
      return Math.abs(finite(gain, 0) - finite(right[index], 0)) <= tolerance;
    });
  }

  function detectPreset(gains) {
    for (var i = 0; i < PRESET_NAMES.length; i++) {
      var name = PRESET_NAMES[i];
      if (gainsMatch(gains, PRESET_GAINS[name])) return name;
    }
    return 'custom';
  }

  function normalizeSettings(value) {
    var defaults = defaultSettings();
    value = value && typeof value === 'object' ? value : {};
    var eq = value.eq && typeof value.eq === 'object' ? value.eq : {};
    var loudness = value.loudness && typeof value.loudness === 'object' ? value.loudness : {};
    var output = value.output && typeof value.output === 'object' ? value.output : {};
    var prefetch = value.prefetch && typeof value.prefetch === 'object' ? value.prefetch : {};
    var preset = String(eq.preset || defaults.eq.preset).toLowerCase();
    if (PRESET_NAMES.indexOf(preset) < 0 && preset !== 'custom') preset = defaults.eq.preset;
    var gains = preset === 'custom'
      ? normalizeGains(eq.gains, defaults.eq.gains)
      : clonePreset(preset);

    return {
      version: 1,
      eq: {
        enabled: eq.enabled === true,
        preset: preset,
        gains: gains,
      },
      loudness: {
        enabled: loudness.enabled === true,
        preampDb: round(clamp(finite(loudness.preampDb, defaults.loudness.preampDb), PREAMP_MIN_DB, PREAMP_MAX_DB), 1),
      },
      output: {
        deviceId: normalizeDeviceId(output.deviceId),
      },
      prefetch: {
        enabled: prefetch.enabled !== false,
      },
    };
  }

  function applyPreset(settings, name) {
    var next = normalizeSettings(settings);
    name = String(name || '').toLowerCase();
    if (PRESET_NAMES.indexOf(name) < 0) name = 'flat';
    next.eq.preset = name;
    next.eq.gains = clonePreset(name);
    return next;
  }

  function setBandGain(settings, index, gainDb) {
    var next = normalizeSettings(settings);
    index = Math.floor(finite(index, -1));
    if (index < 0 || index >= EQ_FREQUENCIES.length) return next;
    next.eq.gains[index] = round(clamp(gainDb, EQ_MIN_DB, EQ_MAX_DB), 1);
    next.eq.preset = detectPreset(next.eq.gains);
    return next;
  }

  function computeGainStage(settings) {
    settings = normalizeSettings(settings);
    var processingEnabled = settings.eq.enabled || settings.loudness.enabled;
    var eqHeadroomDb = settings.eq.enabled
      ? Math.max.apply(Math, [0].concat(settings.eq.gains.map(function (gain) { return finite(gain, 0); })))
      : 0;
    var requestedPreampDb = settings.loudness.enabled ? settings.loudness.preampDb : 0;
    var effectivePreampDb = clamp(requestedPreampDb - eqHeadroomDb, -24, PREAMP_MAX_DB);
    return {
      requestedPreampDb: round(requestedPreampDb, 1),
      eqHeadroomDb: round(eqHeadroomDb, 1),
      effectivePreampDb: round(effectivePreampDb, 1),
      linearGain: dbToGain(effectivePreampDb),
      processingEnabled: processingEnabled,
      limiterEnabled: processingEnabled,
      limiterThresholdDb: processingEnabled ? -1 : 0,
      limiterRatio: processingEnabled ? 20 : 1,
    };
  }

  function dbToGain(db) {
    return Math.pow(10, finite(db, 0) / 20);
  }

  function formatFrequency(frequency) {
    frequency = Math.max(0, finite(frequency, 0));
    if (frequency >= 1000) {
      var khz = frequency / 1000;
      return (khz % 1 ? khz.toFixed(1) : khz.toFixed(0)) + 'k';
    }
    return String(Math.round(frequency));
  }

  function chooseOutputDevice(devices, preferredId) {
    devices = Array.isArray(devices) ? devices.filter(function (device) {
      return device && device.kind === 'audiooutput' && typeof device.deviceId === 'string';
    }) : [];
    preferredId = normalizeDeviceId(preferredId);
    var preferred = devices.find(function (device) { return device.deviceId === preferredId; });
    var systemDefault = devices.find(function (device) { return device.deviceId === 'default'; });
    var selected = preferred || systemDefault || devices[0] || null;
    return {
      devices: devices,
      selectedId: selected ? selected.deviceId : 'default',
      preferredAvailable: !!preferred,
      labelsAvailable: devices.some(function (device) { return !!String(device.label || '').trim(); }),
    };
  }

  function nextPrefetchIndex(currentIndex, queueLength, playMode) {
    currentIndex = Math.floor(finite(currentIndex, -1));
    queueLength = Math.floor(Math.max(0, finite(queueLength, 0)));
    if (!queueLength || currentIndex < 0 || currentIndex >= queueLength) return -1;
    if (String(playMode || 'loop') === 'single' || String(playMode || 'loop') === 'shuffle') return -1;
    return (currentIndex + 1) % queueLength;
  }

  function buildNeteaseSourceRequest(song, quality, hasSvip) {
    if (!song || song.type === 'local' || song.type === 'podcast' || song.source === 'podcast') return null;
    var id = String(song.id == null ? '' : song.id);
    if (!/^\d+$/.test(id)) return null;
    quality = String(quality || 'hires').toLowerCase();
    if (['jymaster', 'hires', 'lossless', 'exhigh', 'standard'].indexOf(quality) < 0) quality = 'hires';
    if (quality === 'jymaster' && !hasSvip) quality = 'hires';
    return {
      id: id,
      quality: quality,
      url: '/api/song/url?id=' + encodeURIComponent(id) + '&quality=' + encodeURIComponent(quality),
    };
  }

  return {
    EQ_FREQUENCIES: EQ_FREQUENCIES.slice(),
    EQ_MIN_DB: EQ_MIN_DB,
    EQ_MAX_DB: EQ_MAX_DB,
    PREAMP_MIN_DB: PREAMP_MIN_DB,
    PREAMP_MAX_DB: PREAMP_MAX_DB,
    PRESET_NAMES: PRESET_NAMES.slice(),
    PRESET_GAINS: PRESET_NAMES.reduce(function (result, name) {
      result[name] = clonePreset(name);
      return result;
    }, {}),
    defaultSettings: defaultSettings,
    normalizeSettings: normalizeSettings,
    normalizeDeviceId: normalizeDeviceId,
    normalizeGains: normalizeGains,
    gainsMatch: gainsMatch,
    detectPreset: detectPreset,
    applyPreset: applyPreset,
    setBandGain: setBandGain,
    computeGainStage: computeGainStage,
    dbToGain: dbToGain,
    formatFrequency: formatFrequency,
    chooseOutputDevice: chooseOutputDevice,
    nextPrefetchIndex: nextPrefetchIndex,
    buildNeteaseSourceRequest: buildNeteaseSourceRequest,
  };
});
