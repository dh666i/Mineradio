(function () {
  'use strict';

  var audioSettingsCore = window.MineradioCore && window.MineradioCore.audioSettings;
  if (!audioSettingsCore) {
    console.error('[AudioV150] audio-settings core was not loaded');
    return;
  }

  var STORAGE_KEY = 'mineradio-audio-settings-v1';
  var SOURCE_CACHE_TTL_MS = 90000;
  var settingsReadFailed = false;
  var settings = readSettings();
  var graph = null;
  var outputDevices = [];
  var outputLabelsAvailable = false;
  var outputApplySerial = 0;
  var outputStatus = { kind: 'idle', message: '使用系统默认输出' };
  var prefetchTimer = 0;
  var prefetchGeneration = 0;
  var prefetchMedia = null;
  var prefetchMediaTimer = 0;
  var sourceCache = new Map();

  function byId(id) {
    return document.getElementById(id);
  }

  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function readSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return audioSettingsCore.normalizeSettings(raw ? JSON.parse(raw) : null);
    } catch (error) {
      settingsReadFailed = true;
      console.warn('[AudioV150] settings read failed', error);
      return audioSettingsCore.defaultSettings();
    }
  }

  function saveSettings(options) {
    options = options || {};
    settings = audioSettingsCore.normalizeSettings(settings);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      return true;
    } catch (error) {
      console.warn('[AudioV150] settings save failed', error);
      setStatus('error', '音频设置保存失败，本次调整只在当前运行期间有效');
      if (!options.silent) toast('音频设置保存失败');
      return false;
    }
  }

  function notifyTransitionChange() {
    try {
      window.dispatchEvent(new CustomEvent('mineradio:audio-transition-change', {
        detail: Object.assign({}, settings.transition),
      }));
    } catch (_) {}
  }

  function toast(message) {
    if (typeof window.showToast === 'function') window.showToast(message);
  }

  function setStatus(kind, message) {
    outputStatus = { kind: kind || 'idle', message: String(message || '') };
    var node = byId('v150-audio-status');
    if (!node) return;
    node.className = 'v150-audio-status ' + outputStatus.kind;
    node.textContent = outputStatus.message;
  }

  function setParam(param, value, context, immediate) {
    if (!param) return;
    var now = context && isFinite(context.currentTime) ? context.currentTime : 0;
    try {
      param.cancelScheduledValues(now);
      if (immediate || typeof param.setTargetAtTime !== 'function') param.setValueAtTime(value, now);
      else param.setTargetAtTime(value, now, 0.025);
    } catch (error) {
      try { param.value = value; } catch (_) {}
    }
  }

  function disconnect(node, destination) {
    if (!node || typeof node.disconnect !== 'function') return;
    try {
      if (destination) node.disconnect(destination);
      else node.disconnect();
    } catch (_) {}
  }

  function releaseGraph() {
    if (!graph) return;
    disconnect(graph.analyser, graph.outputGain);
    disconnect(graph.analyser, graph.filters[0]);
    graph.filters.forEach(function (filter) { disconnect(filter); });
    disconnect(graph.preamp);
    disconnect(graph.limiter);
    graph = null;
  }

  function configureFilter(filter, frequency, index, count) {
    filter.type = index === 0 ? 'lowshelf' : (index === count - 1 ? 'highshelf' : 'peaking');
    filter.frequency.value = frequency;
    if (filter.Q && filter.type === 'peaking') filter.Q.value = 1.15;
    filter.gain.value = 0;
  }

  function setGraphProcessingPath(enabled) {
    if (!graph) return false;
    enabled = !!enabled;
    if (graph.processingEnabled === enabled) return true;

    disconnect(graph.analyser, graph.outputGain);
    disconnect(graph.analyser, graph.filters[0]);
    graph.filters.forEach(function (filter) { disconnect(filter); });
    disconnect(graph.preamp);
    disconnect(graph.limiter);

    try {
      if (!enabled) {
        graph.analyser.connect(graph.outputGain);
      } else {
        graph.analyser.connect(graph.filters[0]);
        for (var i = 0; i < graph.filters.length - 1; i++) graph.filters[i].connect(graph.filters[i + 1]);
        graph.filters[graph.filters.length - 1].connect(graph.preamp);
        graph.preamp.connect(graph.limiter);
        graph.limiter.connect(graph.outputGain);
      }
      graph.processingEnabled = enabled;
      return true;
    } catch (error) {
      disconnect(graph.analyser, graph.filters[0]);
      graph.filters.forEach(function (filter) { disconnect(filter); });
      disconnect(graph.preamp);
      disconnect(graph.limiter);
      try { graph.analyser.connect(graph.outputGain); } catch (_) {}
      graph.processingEnabled = false;
      console.warn('[AudioV150] graph routing failed', error);
      setStatus('error', '音频增强切换失败，已恢复基础播放链路');
      return false;
    }
  }

  function createAudioGraph() {
    if (!window.audioCtx || !window.analyser || !window.gainNode) return false;
    if (
      graph &&
      graph.context === window.audioCtx &&
      graph.analyser === window.analyser &&
      graph.outputGain === window.gainNode
    ) {
      return true;
    }

    releaseGraph();
    var context = window.audioCtx;
    var mainAnalyser = window.analyser;
    var outputGain = window.gainNode;
    var filters = [];
    var preamp = null;
    var limiter = null;
    var baseDisconnected = false;

    try {
      audioSettingsCore.EQ_FREQUENCIES.forEach(function (frequency, index, frequencies) {
        var filter = context.createBiquadFilter();
        configureFilter(filter, frequency, index, frequencies.length);
        filters.push(filter);
      });
      preamp = context.createGain();
      limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.16;

      disconnect(mainAnalyser, outputGain);
      baseDisconnected = true;
      graph = {
        context: context,
        analyser: mainAnalyser,
        outputGain: outputGain,
        filters: filters,
        preamp: preamp,
        limiter: limiter,
        processingEnabled: null,
      };
      applyGraphSettings(true);
      return true;
    } catch (error) {
      filters.forEach(function (filter) { disconnect(filter); });
      disconnect(preamp);
      disconnect(limiter);
      if (baseDisconnected) {
        try { mainAnalyser.connect(outputGain); } catch (_) {}
      }
      console.warn('[AudioV150] graph setup failed', error);
      setStatus('error', '音频增强初始化失败，已恢复基础播放链路');
      return false;
    }
  }

  function applyGraphSettings(immediate) {
    if (!graph) return false;
    var stage = audioSettingsCore.computeGainStage(settings);
    graph.filters.forEach(function (filter, index) {
      var gain = settings.eq.enabled ? settings.eq.gains[index] : 0;
      setParam(filter.gain, gain, graph.context, immediate);
    });
    setParam(graph.preamp.gain, stage.linearGain, graph.context, immediate);
    setParam(graph.limiter.threshold, stage.limiterThresholdDb, graph.context, true);
    setParam(graph.limiter.ratio, stage.limiterRatio, graph.context, true);
    var routed = setGraphProcessingPath(stage.processingEnabled);
    updateGainStageText(stage);
    return routed;
  }

  function applyAudioSettings() {
    if (createAudioGraph()) applyGraphSettings(false);
    syncUi();
  }

  function updateGainStageText(stage) {
    var node = byId('v150-gain-stage');
    if (!node) return;
    stage = stage || audioSettingsCore.computeGainStage(settings);
    var requested = stage.requestedPreampDb > 0 ? '+' + stage.requestedPreampDb : String(stage.requestedPreampDb);
    var effective = stage.effectivePreampDb > 0 ? '+' + stage.effectivePreampDb : String(stage.effectivePreampDb);
    node.textContent = '预增益 ' + requested + ' dB · EQ 余量 ' + stage.eqHeadroomDb + ' dB · 实际 ' + effective + ' dB';
  }

  function wrapAudioLifecycle() {
    var legacyInitAudio = window.initAudio;
    if (typeof legacyInitAudio === 'function' && !legacyInitAudio.__v150AudioWrapped) {
      var wrappedInitAudio = function () {
        var result = legacyInitAudio.apply(this, arguments);
        createAudioGraph();
        applyOutputDevice({ silent: true });
        return result;
      };
      wrappedInitAudio.__v150AudioWrapped = true;
      window.initAudio = wrappedInitAudio;
    }

    var legacyAttemptAudioPlay = window.attemptAudioPlay;
    if (typeof legacyAttemptAudioPlay === 'function' && !legacyAttemptAudioPlay.__v150AudioWrapped) {
      var wrappedAttemptAudioPlay = async function () {
        if (!window.audioReady && typeof window.initAudio === 'function') window.initAudio();
        createAudioGraph();
        await applyOutputDevice({ silent: true });
        return legacyAttemptAudioPlay.apply(this, arguments);
      };
      wrappedAttemptAudioPlay.__v150AudioWrapped = true;
      window.attemptAudioPlay = wrappedAttemptAudioPlay;
    }
  }

  function outputCapability() {
    var contextCanSwitch = !!(
      window.audioCtx && typeof window.audioCtx.setSinkId === 'function' ||
      window.AudioContext && window.AudioContext.prototype && typeof window.AudioContext.prototype.setSinkId === 'function' ||
      window.webkitAudioContext && window.webkitAudioContext.prototype && typeof window.webkitAudioContext.prototype.setSinkId === 'function'
    );
    var mediaCanSwitch = !!(
      window.audio && typeof window.audio.setSinkId === 'function' ||
      window.HTMLMediaElement && window.HTMLMediaElement.prototype && typeof window.HTMLMediaElement.prototype.setSinkId === 'function'
    );
    return {
      context: contextCanSwitch,
      media: mediaCanSwitch,
      supported: contextCanSwitch || mediaCanSwitch,
    };
  }

  function outputErrorMessage(error) {
    var name = error && error.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return '系统未授权切换音频输出';
    if (name === 'NotFoundError') return '所选音频设备已断开';
    if (name === 'AbortError') return '系统取消了音频设备切换';
    return '切换音频输出失败';
  }

  async function applyOutputDevice(options) {
    options = options || {};
    var serial = ++outputApplySerial;
    var capability = outputCapability();
    if (!capability.supported) {
      setStatus('unsupported', '当前系统不支持应用内切换输出，将使用系统默认设备');
      return { ok: false, reason: 'unsupported' };
    }

    var deviceId = settings.output.deviceId || 'default';
    var attempted = false;
    var errors = [];
    if (window.audioCtx && typeof window.audioCtx.setSinkId === 'function') {
      attempted = true;
      try {
        await window.audioCtx.setSinkId(deviceId);
        if (serial !== outputApplySerial) return { ok: false, reason: 'superseded' };
        setStatus('success', '音频输出已应用' + selectedOutputLabelSuffix(deviceId));
        return { ok: true, method: 'audio-context', deviceId: deviceId };
      } catch (error) {
        errors.push(error);
      }
    }
    if (window.audio && typeof window.audio.setSinkId === 'function') {
      attempted = true;
      try {
        await window.audio.setSinkId(deviceId);
        if (serial !== outputApplySerial) return { ok: false, reason: 'superseded' };
        setStatus('success', '音频输出已应用' + selectedOutputLabelSuffix(deviceId) + ' · 媒体元素兼容模式');
        return { ok: true, method: 'media-element', deviceId: deviceId };
      } catch (error) {
        errors.push(error);
      }
    }

    if (!attempted) {
      setStatus('pending', '输出设备将在开始播放后应用');
      return { ok: false, reason: 'not-ready' };
    }
    var message = outputErrorMessage(errors[errors.length - 1]);
    setStatus('error', message);
    if (!options.silent) toast(message);
    return { ok: false, reason: 'failed', error: errors[errors.length - 1] || null };
  }

  function selectedOutputLabelSuffix(deviceId) {
    var selected = outputDevices.find(function (device) { return device.deviceId === deviceId; });
    var label = selected && String(selected.label || '').trim();
    if (!label || deviceId === 'default') return deviceId === 'default' ? ' · 系统默认' : '';
    return ' · ' + label;
  }

  function renderOutputDevices() {
    var select = byId('v150-output-device');
    if (!select) return;
    select.innerHTML = '';
    if (!outputDevices.length) {
      var fallback = document.createElement('option');
      fallback.value = 'default';
      fallback.textContent = '系统默认输出';
      select.appendChild(fallback);
    } else {
      outputDevices.forEach(function (device, index) {
        var option = document.createElement('option');
        option.value = device.deviceId;
        var label = String(device.label || '').trim();
        option.textContent = label || (device.deviceId === 'default' ? '系统默认输出' : '音频输出 ' + (index + 1));
        select.appendChild(option);
      });
    }
    select.value = settings.output.deviceId;
    if (select.selectedIndex < 0) select.value = 'default';
  }

  async function refreshOutputDevices(options) {
    options = options || {};
    var mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') {
      outputDevices = [];
      renderOutputDevices();
      setStatus('unsupported', '当前系统无法枚举音频输出设备');
      return [];
    }
    setStatus('pending', '正在读取音频输出设备…');
    try {
      var devices = await mediaDevices.enumerateDevices();
      var choice = audioSettingsCore.chooseOutputDevice(devices, settings.output.deviceId);
      outputDevices = choice.devices;
      outputLabelsAvailable = choice.labelsAvailable;
      if (!choice.preferredAvailable && settings.output.deviceId !== choice.selectedId) {
        settings.output.deviceId = choice.selectedId;
        saveSettings({ silent: true });
      }
      renderOutputDevices();
      if (!outputDevices.length) {
        setStatus('error', '没有检测到可用的音频输出设备');
      } else if (!outputLabelsAvailable) {
        setStatus('permission', '系统未提供设备名称，可按编号选择或使用系统默认输出');
      } else {
        setStatus('ready', '已检测到 ' + outputDevices.length + ' 个音频输出');
      }
      if (options.apply !== false) await applyOutputDevice({ silent: !options.userInitiated });
      return outputDevices.slice();
    } catch (error) {
      var message = outputErrorMessage(error);
      setStatus('error', message);
      if (options.userInitiated) toast(message);
      return [];
    }
  }

  async function requestOutputPermission() {
    var mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.selectAudioOutput !== 'function') {
      setStatus('permission', '当前系统没有独立的输出授权窗口，可在系统声音设置中授权后刷新');
      return;
    }
    try {
      var selected = await mediaDevices.selectAudioOutput();
      if (selected && selected.deviceId) {
        settings.output.deviceId = selected.deviceId;
        saveSettings();
      }
      await refreshOutputDevices({ userInitiated: true, apply: true });
    } catch (error) {
      var message = outputErrorMessage(error);
      setStatus('permission', message);
      toast(message);
    }
  }

  function cloneSourcePayload(data) {
    if (!data || typeof data !== 'object') return data;
    return Object.assign({}, data);
  }

  function wrapSourceRequests() {
    var legacyApiJson = window.apiJson;
    if (typeof legacyApiJson !== 'function' || legacyApiJson.__v150SourcePrefetchWrapped) return;

    var wrappedApiJson = function (url, options) {
      var method = String(options && options.method || 'GET').toUpperCase();
      var key = String(url || '');
      var entry = method === 'GET' ? sourceCache.get(key) : null;
      if (entry && entry.expiresAt > Date.now()) {
        sourceCache.delete(key);
        return Promise.resolve(entry.promise).then(cloneSourcePayload);
      }
      if (entry) sourceCache.delete(key);
      return legacyApiJson.apply(this, arguments);
    };
    wrappedApiJson.__v150SourcePrefetchWrapped = true;
    wrappedApiJson.__v150LegacyApiJson = legacyApiJson;
    window.apiJson = wrappedApiJson;
  }

  function legacyApiJson() {
    var wrapped = window.apiJson;
    return wrapped && wrapped.__v150LegacyApiJson || wrapped;
  }

  function clearPrefetchMedia() {
    if (prefetchMediaTimer) {
      clearTimeout(prefetchMediaTimer);
      prefetchMediaTimer = 0;
    }
    if (!prefetchMedia) return;
    try {
      prefetchMedia.pause();
      prefetchMedia.removeAttribute('src');
      prefetchMedia.load();
    } catch (_) {}
    prefetchMedia = null;
  }

  function warmMediaMetadata(sourceUrl, generation) {
    if (!sourceUrl || generation !== prefetchGeneration || typeof window.Audio !== 'function') return;
    clearPrefetchMedia();
    try {
      var media = new Audio();
      prefetchMedia = media;
      media.preload = 'metadata';
      media.crossOrigin = 'anonymous';
      media.src = '/api/audio?url=' + encodeURIComponent(sourceUrl);
      var finish = function () {
        if (generation !== prefetchGeneration || prefetchMedia !== media) return;
        if (prefetchMediaTimer) clearTimeout(prefetchMediaTimer);
        prefetchMediaTimer = setTimeout(clearPrefetchMedia, 12000);
      };
      media.addEventListener('loadedmetadata', finish, { once: true });
      media.addEventListener('error', finish, { once: true });
      media.load();
      prefetchMediaTimer = setTimeout(clearPrefetchMedia, 15000);
    } catch (error) {
      clearPrefetchMedia();
    }
  }

  function clearSourcePrefetch() {
    prefetchGeneration++;
    if (prefetchTimer) {
      clearTimeout(prefetchTimer);
      prefetchTimer = 0;
    }
    clearPrefetchMedia();
    sourceCache.clear();
  }

  function hasNeteaseSvip() {
    if (typeof window.hasProviderSvip === 'function') return window.hasProviderSvip('netease', window.loginStatus);
    return !!(window.loginStatus && (window.loginStatus.isSvip || window.loginStatus.vipLevel === 'svip'));
  }

  function currentPlaybackQuality() {
    var quality = window.playbackQuality || 'hires';
    if (typeof window.normalizePlaybackQuality === 'function') quality = window.normalizePlaybackQuality(quality);
    return quality;
  }

  function prefetchNextSource() {
    if (!settings.prefetch.enabled || navigator.onLine === false) return;
    var index = audioSettingsCore.nextPrefetchIndex(window.currentIdx, window.playQueue && window.playQueue.length, window.playMode);
    if (index < 0) return;
    var song = window.playQueue[index];
    if (!song) return;
    if (typeof window.songProviderKey === 'function' && window.songProviderKey(song) !== 'netease') return;
    var request = audioSettingsCore.buildNeteaseSourceRequest(song, currentPlaybackQuality(), hasNeteaseSvip());
    if (!request) return;

    var generation = ++prefetchGeneration;
    var requestApi = legacyApiJson();
    if (typeof requestApi !== 'function') return;
    var entry = {
      expiresAt: Date.now() + SOURCE_CACHE_TTL_MS,
      promise: null,
    };
    entry.promise = Promise.resolve(requestApi(request.url, { timeoutMs: 12000 })).then(function (data) {
      if (generation !== prefetchGeneration || !settings.prefetch.enabled || !data || !data.url) {
        if (sourceCache.get(request.url) === entry) sourceCache.delete(request.url);
        return data;
      }
      warmMediaMetadata(data.url, generation);
      return data;
    }).catch(function (error) {
      if (sourceCache.get(request.url) === entry) sourceCache.delete(request.url);
      console.warn('[AudioV150] next source prefetch failed', error && (error.message || error));
      throw error;
    });
    entry.promise.catch(function () {});
    sourceCache.clear();
    sourceCache.set(request.url, entry);
  }

  function scheduleNextSourcePrefetch(delay) {
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = 0;
    if (!settings.prefetch.enabled) return;
    var generation = ++prefetchGeneration;
    prefetchTimer = setTimeout(function () {
      prefetchTimer = 0;
      if (generation !== prefetchGeneration) return;
      prefetchNextSource();
    }, Math.max(250, Number(delay) || 900));
  }

  function wrapQueuePlayback() {
    var legacyPlayQueueAt = window.playQueueAt;
    if (typeof legacyPlayQueueAt !== 'function' || legacyPlayQueueAt.__v150AudioWrapped) return;
    var wrappedPlayQueueAt = async function () {
      prefetchGeneration++;
      if (prefetchTimer) {
        clearTimeout(prefetchTimer);
        prefetchTimer = 0;
      }
      var result = await legacyPlayQueueAt.apply(this, arguments);
      await applyOutputDevice({ silent: true });
      scheduleNextSourcePrefetch(900);
      return result;
    };
    wrappedPlayQueueAt.__v150AudioWrapped = true;
    window.playQueueAt = wrappedPlayQueueAt;
  }

  function installStyles() {
    if (byId('v150-audio-styles')) return;
    var style = document.createElement('style');
    style.id = 'v150-audio-styles';
    style.textContent = [
      '.v150-audio-page{min-width:0;max-width:100%;letter-spacing:0}',
      '.v150-audio-intro{margin:-6px 0 12px!important;max-width:100%}',
      '.v150-audio-section{min-width:0;max-width:100%;padding:4px 0 12px;border-bottom:1px solid rgba(255,255,255,.065)}',
      '.v150-audio-section:last-of-type{border-bottom:0}',
      '.v150-audio-section-title{margin:16px 0 5px;font-size:11px;font-weight:700;color:rgba(255,255,255,.72)}',
      '.v150-eq-grid{width:100%;min-width:0;display:grid;grid-template-columns:repeat(10,minmax(28px,1fr));gap:5px;min-height:178px;padding:12px 0 6px}',
      '.v150-eq-band{display:grid;grid-template-rows:22px 110px 20px;justify-items:center;align-items:center;min-width:0}',
      '.v150-eq-band output{font:9px var(--font-mono);color:rgba(255,255,255,.48)}',
      '.v150-eq-band input{width:86px;height:18px;transform:rotate(-90deg);accent-color:var(--fc-accent);cursor:pointer}',
      '.v150-eq-band input:disabled{cursor:not-allowed;opacity:.34}',
      '.v150-eq-band span{font:9px var(--font-mono);color:rgba(255,255,255,.38)}',
      '.v150-range-field{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(120px,150px) 52px;align-items:center;gap:12px;min-height:66px;padding:13px 14px;border-bottom:1px solid rgba(255,255,255,.065)}',
      '.v150-range-field>span,.v150-device-field>span{min-width:0}',
      '.v150-range-field b,.v150-device-field b{display:block;font-size:12px;color:rgba(255,255,255,.88)}',
      '.v150-range-field small,.v150-device-field small{display:block;margin-top:4px;color:rgba(255,255,255,.38);font-size:10.5px}',
      '.v150-range-field input{width:100%;min-width:0;accent-color:var(--fc-accent)}',
      '.v150-range-field output{font:10px var(--font-mono);color:rgba(255,255,255,.66);text-align:right}',
      '.v150-device-field{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(170px,230px);align-items:center;gap:18px;min-height:70px;padding:13px 14px;border-bottom:1px solid rgba(255,255,255,.065)}',
      '.v150-device-field select{width:100%;min-width:0;max-width:100%;height:34px;border-radius:7px;border:1px solid rgba(255,255,255,.11);background:#13171c;color:#fff;padding:0 10px}',
      '.v150-device-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 14px 0}',
      '.v150-device-actions .modal-btn{min-width:104px}',
      '.v150-audio-status{min-height:18px;margin:10px 14px 0;font-size:10.5px;color:rgba(255,255,255,.42)}',
      '.v150-audio-status.success,.v150-audio-status.ready{color:#82dbc9}',
      '.v150-audio-status.error{color:#ff8ca0}',
      '.v150-audio-status.permission,.v150-audio-status.pending{color:#e5c178}',
      '.v150-gain-stage{margin:8px 14px 0;font:9.5px var(--font-mono);color:rgba(255,255,255,.34)}',
      '.v150-audio-reset{margin-top:18px}',
      '@container settings-content (max-width:560px){.v150-eq-grid{grid-template-columns:repeat(5,minmax(36px,1fr));row-gap:2px}.v150-range-field,.v150-device-field{grid-template-columns:1fr}.v150-range-field output{text-align:left}}',
      '@media(max-width:720px){.v150-eq-grid{grid-template-columns:repeat(5,minmax(36px,1fr));row-gap:2px}.v150-range-field,.v150-device-field{grid-template-columns:1fr}.v150-range-field output{text-align:left}}'
    ].join('');
    document.head.appendChild(style);
  }

  function settingsPageMarkup() {
    return [
      '<h3>音频增强</h3>',
      '<p class="v150-audio-intro">EQ、基础响度控制与输出设备均在本机生效，不依赖登录状态。</p>',
      '<div class="v150-audio-section">',
      '<div class="v150-audio-section-title">均衡器</div>',
      '<label class="settings-row"><span><b>启用 10 段 EQ</b><small>关闭时保留当前参数，但不改变声音</small></span><input id="v150-eq-enabled" type="checkbox"></label>',
      '<div class="settings-field"><span><b>EQ 预设</b><small>拖动任意频段后自动切换为自定义</small></span><select id="v150-eq-preset"><option value="flat">平直</option><option value="bass">低频增强</option><option value="warm">温暖</option><option value="vocal">人声</option><option value="treble">高频增强</option><option value="electronic">电子</option><option value="custom">自定义</option></select></div>',
      '<div id="v150-eq-bands" class="v150-eq-grid" aria-label="10 段均衡器"></div>',
      '</div>',
      '<div class="v150-audio-section">',
      '<div class="v150-audio-section-title">响度与峰值</div>',
      '<label class="settings-row"><span><b>基础响度均衡</b><small>固定预增益与峰值保护，不分析歌曲，也不读取 ReplayGain 标签</small></span><input id="v150-loudness-enabled" type="checkbox"></label>',
      '<label class="v150-range-field"><span><b>预增益</b><small>正值提升安静内容，峰值保护会限制过载</small></span><input id="v150-preamp" type="range" min="-12" max="6" step="0.5"><output id="v150-preamp-value">0 dB</output></label>',
      '<div id="v150-gain-stage" class="v150-gain-stage"></div>',
      '</div>',
      '<div class="v150-audio-section">',
      '<div class="v150-audio-section-title">音频输出</div>',
      '<label class="v150-device-field"><span><b>输出设备</b><small>优先使用 AudioContext，必要时回退到媒体元素兼容模式</small></span><select id="v150-output-device"></select></label>',
      '<div class="v150-device-actions"><button id="v150-output-refresh" class="modal-btn" type="button">刷新设备</button><button id="v150-output-authorize" class="modal-btn" type="button">授权选择</button></div>',
      '<div id="v150-audio-status" class="v150-audio-status" role="status" aria-live="polite"></div>',
      '</div>',
      '<div class="v150-audio-section">',
      '<div class="v150-audio-section-title">切歌准备</div>',
      '<div class="settings-field"><span><b>切歌过渡</b><small>无缝衔接会提前准备下一首；播客始终使用普通切歌</small></span><select id="v150-transition-mode"><option value="off">关闭</option><option value="gapless">无缝衔接</option><option value="crossfade-3">交叉淡化 3 秒</option><option value="crossfade-5">交叉淡化 5 秒</option><option value="crossfade-8">交叉淡化 8 秒</option></select></div>',
      '<label class="settings-row"><span><b>预取下一首</b><small>预取网易云播放地址和媒体元数据，减少切歌等待；不会下载整首</small></span><input id="v150-prefetch-enabled" type="checkbox"></label>',
      '</div>',
      '<button id="v150-audio-reset" class="modal-btn v150-audio-reset" type="button">恢复音频默认设置</button>'
    ].join('');
  }

  function renderEqBands() {
    var host = byId('v150-eq-bands');
    if (!host || host.childElementCount) return;
    audioSettingsCore.EQ_FREQUENCIES.forEach(function (frequency, index) {
      var label = audioSettingsCore.formatFrequency(frequency);
      var band = document.createElement('label');
      band.className = 'v150-eq-band';
      band.innerHTML =
        '<output id="v150-eq-value-' + index + '">0</output>' +
        '<input type="range" min="' + audioSettingsCore.EQ_MIN_DB + '" max="' + audioSettingsCore.EQ_MAX_DB + '" step="0.5" data-v150-eq-index="' + index + '" aria-label="' + label + 'Hz">' +
        '<span>' + label + '</span>';
      host.appendChild(band);
    });
  }

  function activateSettingsPage(name, focus) {
    var tabs = all('[data-settings-tab]');
    var pages = all('[data-settings-page]');
    tabs.forEach(function (tab) {
      var active = tab.getAttribute('data-settings-tab') === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });
    pages.forEach(function (page) {
      page.classList.toggle('active', page.getAttribute('data-settings-page') === name);
    });
  }

  function bindSettingsNavigation(nav) {
    if (!nav || nav.__v150AudioNavigationBound) return;
    nav.__v150AudioNavigationBound = true;
    nav.addEventListener('click', function (event) {
      var tab = event.target && event.target.closest && event.target.closest('[data-settings-tab]');
      if (tab && nav.contains(tab)) activateSettingsPage(tab.getAttribute('data-settings-tab'), false);
    });
    nav.addEventListener('keydown', function (event) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(event.key) < 0) return;
      var tab = event.target && event.target.closest && event.target.closest('[data-settings-tab]');
      if (!tab) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      var tabs = all('[data-settings-tab]', nav);
      var index = tabs.indexOf(tab);
      var direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      var next = tabs[(index + direction + tabs.length) % tabs.length];
      activateSettingsPage(next.getAttribute('data-settings-tab'), true);
    }, true);
  }

  function bindSettingsControls(page) {
    if (!page || page.__v150AudioControlsBound) return;
    page.__v150AudioControlsBound = true;
    byId('v150-eq-enabled').addEventListener('change', function (event) {
      settings.eq.enabled = !!event.target.checked;
      saveSettings();
      applyAudioSettings();
    });
    byId('v150-eq-preset').addEventListener('change', function (event) {
      if (event.target.value === 'custom') return;
      settings = audioSettingsCore.applyPreset(settings, event.target.value);
      saveSettings();
      applyAudioSettings();
    });
    byId('v150-eq-bands').addEventListener('input', function (event) {
      var input = event.target && event.target.closest && event.target.closest('[data-v150-eq-index]');
      if (!input) return;
      settings = audioSettingsCore.setBandGain(settings, input.getAttribute('data-v150-eq-index'), input.value);
      saveSettings({ silent: true });
      applyAudioSettings();
    });
    byId('v150-loudness-enabled').addEventListener('change', function (event) {
      settings.loudness.enabled = !!event.target.checked;
      saveSettings();
      applyAudioSettings();
    });
    byId('v150-preamp').addEventListener('input', function (event) {
      settings.loudness.preampDb = Number(event.target.value);
      settings = audioSettingsCore.normalizeSettings(settings);
      saveSettings({ silent: true });
      applyAudioSettings();
    });
    byId('v150-output-device').addEventListener('change', async function (event) {
      settings.output.deviceId = event.target.value || 'default';
      saveSettings();
      await applyOutputDevice({ silent: false });
    });
    byId('v150-output-refresh').addEventListener('click', function () {
      refreshOutputDevices({ userInitiated: true, apply: true });
    });
    byId('v150-output-authorize').addEventListener('click', requestOutputPermission);
    byId('v150-transition-mode').addEventListener('change', function (event) {
      settings = audioSettingsCore.applyTransitionChoice(settings, event.target.value);
      saveSettings();
      syncUi();
      notifyTransitionChange();
    });
    byId('v150-prefetch-enabled').addEventListener('change', function (event) {
      settings.prefetch.enabled = !!event.target.checked;
      saveSettings();
      if (settings.prefetch.enabled) scheduleNextSourcePrefetch(400);
      else clearSourcePrefetch();
      syncUi();
    });
    byId('v150-audio-reset').addEventListener('click', function () {
      settings = audioSettingsCore.defaultSettings();
      saveSettings();
      clearSourcePrefetch();
      applyAudioSettings();
      notifyTransitionChange();
      refreshOutputDevices({ apply: true });
      setStatus('success', '音频设置已恢复默认值');
      toast('已恢复音频默认设置');
    });
  }

  function installSettingsUi() {
    installStyles();
    var nav = document.querySelector('.settings-nav');
    var content = document.querySelector('.settings-content');
    if (!nav || !content) return false;
    var tab = byId('v150-audio-settings-tab');
    if (!tab) {
      tab = document.createElement('button');
      tab.id = 'v150-audio-settings-tab';
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', 'false');
      tab.setAttribute('data-settings-tab', 'audio');
      tab.tabIndex = -1;
      tab.textContent = '音频';
      var shortcuts = nav.querySelector('[data-settings-tab="shortcuts"]');
      nav.insertBefore(tab, shortcuts || null);
    }
    var page = byId('v150-audio-settings-page');
    if (!page) {
      page = document.createElement('section');
      page.id = 'v150-audio-settings-page';
      page.className = 'settings-page v150-audio-page';
      page.setAttribute('data-settings-page', 'audio');
      page.innerHTML = settingsPageMarkup();
      content.appendChild(page);
    }
    renderEqBands();
    bindSettingsNavigation(nav);
    bindSettingsControls(page);
    var authorize = byId('v150-output-authorize');
    if (authorize) {
      authorize.hidden = !(
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.selectAudioOutput === 'function'
      );
    }
    syncUi();
    return true;
  }

  function syncUi() {
    var eqEnabled = byId('v150-eq-enabled');
    var preset = byId('v150-eq-preset');
    var loudness = byId('v150-loudness-enabled');
    var preamp = byId('v150-preamp');
    var preampValue = byId('v150-preamp-value');
    var prefetch = byId('v150-prefetch-enabled');
    var transition = byId('v150-transition-mode');
    if (eqEnabled) eqEnabled.checked = settings.eq.enabled;
    if (preset) preset.value = settings.eq.preset;
    all('[data-v150-eq-index]').forEach(function (input) {
      var index = Number(input.getAttribute('data-v150-eq-index'));
      var value = settings.eq.gains[index] || 0;
      input.value = value;
      input.disabled = !settings.eq.enabled;
      var output = byId('v150-eq-value-' + index);
      if (output) output.textContent = (value > 0 ? '+' : '') + value;
    });
    if (loudness) loudness.checked = settings.loudness.enabled;
    if (preamp) {
      preamp.value = settings.loudness.preampDb;
      preamp.disabled = !settings.loudness.enabled;
    }
    if (preampValue) {
      preampValue.textContent = (settings.loudness.preampDb > 0 ? '+' : '') + settings.loudness.preampDb + ' dB';
    }
    if (prefetch) prefetch.checked = settings.prefetch.enabled;
    if (transition) transition.value = audioSettingsCore.transitionChoice(settings.transition);
    renderOutputDevices();
    updateGainStageText();
    var status = byId('v150-audio-status');
    if (status) {
      status.className = 'v150-audio-status ' + outputStatus.kind;
      status.textContent = outputStatus.message;
    }
  }

  function wrapSettingsOpen() {
    var legacyOpenSettings = window.openSettingsModal;
    if (typeof legacyOpenSettings !== 'function' || legacyOpenSettings.__v150AudioWrapped) return;
    var wrappedOpenSettings = function () {
      installSettingsUi();
      syncUi();
      var result = legacyOpenSettings.apply(this, arguments);
      refreshOutputDevices({ apply: true });
      return result;
    };
    wrappedOpenSettings.__v150AudioWrapped = true;
    window.openSettingsModal = wrappedOpenSettings;
  }

  function installDeviceChangeListener() {
    var mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.addEventListener !== 'function') return;
    mediaDevices.addEventListener('devicechange', function () {
      refreshOutputDevices({ apply: true });
    });
  }

  function exposeDiagnostics() {
    window.MineradioAudioV150 = {
      getSettings: function () {
        return audioSettingsCore.normalizeSettings(settings);
      },
      reset: function () {
        settings = audioSettingsCore.defaultSettings();
        saveSettings();
        clearSourcePrefetch();
        applyAudioSettings();
        notifyTransitionChange();
      },
      refreshOutputDevices: refreshOutputDevices,
      applyOutputDevice: applyOutputDevice,
      applyAudioSettings: applyAudioSettings,
      diagnostics: function () {
        return {
          graphConnected: !!graph,
          eqBands: graph ? graph.filters.length : 0,
          outputStatus: Object.assign({}, outputStatus),
          outputDeviceCount: outputDevices.length,
          outputLabelsAvailable: outputLabelsAvailable,
          outputCapability: outputCapability(),
          sourcePrefetchCached: sourceCache.size,
          transition: Object.assign({}, settings.transition),
        };
      },
    };
  }

  installSettingsUi();
  wrapAudioLifecycle();
  wrapSourceRequests();
  wrapQueuePlayback();
  wrapSettingsOpen();
  installDeviceChangeListener();
  exposeDiagnostics();
  if (window.audioReady) createAudioGraph();
  if (settingsReadFailed) setStatus('error', '音频设置读取失败，已使用安全默认值');
  else refreshOutputDevices({ apply: false });
  if (settings.prefetch.enabled && window.audio && !window.audio.paused) scheduleNextSourcePrefetch(1200);
  window.addEventListener('beforeunload', clearSourcePrefetch, { once: true });
})();
