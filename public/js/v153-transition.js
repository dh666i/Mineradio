(function () {
  'use strict';

  var transitionCore = window.MineradioCore && window.MineradioCore.audioTransition;
  var audioSettingsCore = window.MineradioCore && window.MineradioCore.audioSettings;
  var audioSettingsApi = window.MineradioAudioV150;
  if (!transitionCore || !audioSettingsCore || !audioSettingsApi) {
    console.error('[AudioTransition] required audio modules were not loaded');
    return;
  }

  var TICK_INTERVAL_MS = 160;
  var PREPARE_LEAD_SECONDS = 25;
  var FAILURE_RETRY_MS = 7000;
  var PLAY_START_TIMEOUT_MS = 1800;
  var CORE_SETTLE_TIMEOUT_MS = 2200;
  var transitionGeneration = 0;
  var transitionJob = null;
  var standbyMedia = null;
  var lastFailureAt = 0;
  var lastFailureKey = '';
  var ticker = 0;
  var transitionGraphUnavailable = false;

  function currentSettings() {
    var settings = audioSettingsApi.getSettings();
    return settings && settings.transition
      ? transitionCore.normalizeTransitionConfig(settings.transition)
      : transitionCore.normalizeTransitionConfig(null);
  }

  function currentSleepMode() {
    return typeof window.getMineradioSleepMode === 'function'
      ? window.getMineradioSleepMode()
      : 'off';
  }

  function providerKey(song) {
    if (typeof window.songProviderKey === 'function') return window.songProviderKey(song);
    if (song && (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq')) return 'qq';
    return 'netease';
  }

  function queueIndexForKey(key, fallback) {
    var queue = Array.isArray(window.playQueue) ? window.playQueue : [];
    for (var i = 0; i < queue.length; i++) {
      if (transitionCore.songStableKey(queue[i]) === key) return i;
    }
    if (key) return -1;
    fallback = Number(fallback);
    return fallback >= 0 && fallback < queue.length ? fallback : -1;
  }

  function currentQueueFallbackIndex() {
    var queue = Array.isArray(window.playQueue) ? window.playQueue : [];
    var index = Number(window.currentIdx);
    return index >= 0 && index < queue.length ? index : -1;
  }

  function mediaHasCurrentOwner(media) {
    if (!media) return false;
    if (media === window.audio) return true;
    return !!(transitionJob && (transitionJob.activeMedia === media || transitionJob.media === media));
  }

  function currentQuality() {
    var quality = window.playbackQuality || 'hires';
    if (typeof window.normalizePlaybackQuality === 'function') quality = window.normalizePlaybackQuality(quality);
    return quality;
  }

  function recordFailure(key) {
    lastFailureAt = Date.now();
    lastFailureKey = String(key || '');
  }

  function hasNeteaseSvip() {
    if (typeof window.hasProviderSvip === 'function') return window.hasProviderSvip('netease', window.loginStatus);
    return !!(window.loginStatus && (window.loginStatus.isSvip || window.loginStatus.vipLevel === 'svip'));
  }

  function activeRadioTransitionBlocked() {
    return !!(window.activeRadioContext && window.activeRadioContext.type);
  }

  function assessCurrentTransition() {
    var queue = Array.isArray(window.playQueue) ? window.playQueue : [];
    var media = window.audio;
    var assessment = transitionCore.assessTransitionEligibility({
      transition: currentSettings(),
      queue: queue,
      currentIndex: window.currentIdx,
      playMode: window.playMode,
      sleepMode: currentSleepMode(),
      currentDurationSeconds: media && isFinite(media.duration) ? media.duration : 0,
    });
    if (!assessment.eligible) return assessment;
    if (transitionGraphUnavailable) return Object.assign({}, assessment, { eligible: false, reason: 'audio_graph_unavailable' });
    if (activeRadioTransitionBlocked()) return Object.assign({}, assessment, { eligible: false, reason: 'radio_context' });
    if (providerKey(queue[assessment.currentIndex]) !== 'netease' || providerKey(queue[assessment.nextIndex]) !== 'netease') {
      return Object.assign({}, assessment, { eligible: false, reason: 'unsupported_provider' });
    }
    if (!media || !media.src || media.paused || media.ended || media.playbackRate !== 1) {
      return Object.assign({}, assessment, { eligible: false, reason: 'inactive_media' });
    }
    return assessment;
  }

  function deckGainParam(media) {
    return media && media.__mineradioDeckGain && media.__mineradioDeckGain.gain || null;
  }

  function setDeckGain(media, value) {
    if (typeof window.setPlaybackAudioDeckGain === 'function') {
      return window.setPlaybackAudioDeckGain(media, value);
    }
    var param = deckGainParam(media);
    if (!param) return false;
    try { param.value = Math.max(0, Math.min(1, Number(value) || 0)); return true; } catch (_) {}
    return false;
  }

  function cancelDeckAutomation(media) {
    var param = deckGainParam(media);
    var context = window.audioCtx;
    if (!param || !context) return;
    var now = context.currentTime || 0;
    try {
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
      else {
        var value = Number(param.value) || 0;
        param.cancelScheduledValues(now);
        param.setValueAtTime(value, now);
      }
    } catch (_) {}
  }

  function scheduleEqualPowerFade(outgoing, incoming, seconds) {
    var context = window.audioCtx;
    var outgoingParam = deckGainParam(outgoing);
    var incomingParam = deckGainParam(incoming);
    seconds = Math.max(0, Number(seconds) || 0);
    if (!context || !outgoingParam || !incomingParam || seconds <= 0) {
      setDeckGain(outgoing, 0);
      setDeckGain(incoming, 1);
      return false;
    }
    var points = Math.max(64, Math.round(seconds * 24));
    var outgoingCurve = new Float32Array(points + 1);
    var incomingCurve = new Float32Array(points + 1);
    for (var i = 0; i <= points; i++) {
      var gains = transitionCore.equalPowerGains(i / points);
      outgoingCurve[i] = gains.outgoing;
      incomingCurve[i] = gains.incoming;
    }
    var now = context.currentTime || 0;
    try {
      outgoingParam.cancelScheduledValues(now);
      incomingParam.cancelScheduledValues(now);
      outgoingParam.setValueAtTime(1, now);
      incomingParam.setValueAtTime(0, now);
      outgoingParam.setValueCurveAtTime(outgoingCurve, now, seconds);
      incomingParam.setValueCurveAtTime(incomingCurve, now, seconds);
      return true;
    } catch (error) {
      console.warn('[AudioTransition] gain automation failed', error);
      setDeckGain(outgoing, 0);
      setDeckGain(incoming, 1);
      return false;
    }
  }

  function clearTransitionMediaErrorHandler(media) {
    if (!media || !media.__mineradioTransitionErrorHandler) return;
    if (typeof media.removeEventListener === 'function') {
      try { media.removeEventListener('error', media.__mineradioTransitionErrorHandler); } catch (_) {}
    }
    media.__mineradioTransitionErrorHandler = null;
  }

  function clearOutgoingTransitionHandler(job) {
    var media = job && job.activeMedia;
    var handler = job && job.outgoingTransitionHandler;
    if (!media || !handler || typeof media.removeEventListener !== 'function') return;
    try { media.removeEventListener('ended', handler); } catch (_) {}
    try { media.removeEventListener('error', handler); } catch (_) {}
    job.outgoingTransitionHandler = null;
  }

  function installOutgoingTransitionHandler(job) {
    if (!job || !job.activeMedia || typeof job.activeMedia.addEventListener !== 'function') return;
    clearOutgoingTransitionHandler(job);
    var handler = function () {
      if (transitionJob !== job || job.status !== 'transitioning') return;
      cancelDeckAutomation(job.activeMedia);
      cancelDeckAutomation(job.media);
      setDeckGain(job.activeMedia, 0);
      setDeckGain(job.media, 1);
      finishTransition(job);
    };
    job.outgoingTransitionHandler = handler;
    job.activeMedia.addEventListener('ended', handler);
    job.activeMedia.addEventListener('error', handler);
  }

  function retryActiveTransitionMedia(job) {
    var media = job && job.media;
    if (!media || media !== window.audio) return;
    var index = queueIndexForKey(job.nextKey, -1);
    if (index < 0) return;
    var generation = transitionGeneration;
    clearTransitionMediaErrorHandler(media);
    setTimeout(function () {
      if (window.audio !== media || generation !== transitionGeneration) return;
      index = queueIndexForKey(job.nextKey, -1);
      if (index < 0) return;
      window.playQueueAt(index, { transitionRecovery: true });
    }, 0);
  }

  function installTransitionMediaErrorHandler(job) {
    var media = job && job.media;
    if (!media) return;
    clearTransitionMediaErrorHandler(media);
    var handler = function () {
      if (transitionJob === job) {
        if (job.status === 'starting') {
          job.candidateErrorDuringStart = true;
          return;
        }
        if (job.status === 'transitioning') {
          recoverIncomingFailure(job, 'candidate-media-error');
          return;
        }
        if (job.status === 'recovering' || job.status === 'rollback') return;
        recordFailure(job.nextKey);
        cancelTransition('candidate-load-failed');
        return;
      }
      retryActiveTransitionMedia(job);
    };
    media.__mineradioTransitionErrorHandler = handler;
    media.addEventListener('error', handler);
  }

  function releaseMedia(media) {
    if (!media || media === window.audio) return;
    clearTransitionMediaErrorHandler(media);
    cancelDeckAutomation(media);
    setDeckGain(media, 0);
    try {
      media.onended = null;
      media.pause();
      media.removeAttribute('src');
      media.load();
    } catch (_) {}
    standbyMedia = media;
  }

  function acquireStandbyMedia(activeMedia) {
    var media = standbyMedia && standbyMedia !== activeMedia ? standbyMedia : null;
    if (!media) media = new Audio();
    standbyMedia = null;
    clearTransitionMediaErrorHandler(media);
    try {
      media.onended = null;
      media.pause();
      media.removeAttribute('src');
      media.load();
    } catch (_) {}
    media.crossOrigin = 'anonymous';
    media.preload = 'auto';
    media.playbackRate = 1;
    media.muted = false;
    media.volume = window.gainNode ? 1 : (Number(window.targetVolume) || 0);
    if (typeof window.attachPlaybackAudioElement === 'function') {
      try { window.attachPlaybackAudioElement(media, 0); } catch (error) {
        console.warn('[AudioTransition] standby deck graph setup failed', error);
      }
    }
    bindPlaybackCancellation(media);
    return media;
  }

  async function applyOutputToMedia(media) {
    if (!media || typeof media.setSinkId !== 'function') return;
    var settings = audioSettingsApi.getSettings();
    var deviceId = settings && settings.output && settings.output.deviceId || 'default';
    try { await media.setSinkId(deviceId); } catch (_) {}
  }

  function callOriginalEnded(job, event) {
    if (!job || typeof job.originalEnded !== 'function') return;
    try { job.originalEnded.call(job.activeMedia, event); } catch (error) {
      console.warn('[AudioTransition] original ended handler failed', error);
    }
  }

  function promiseWithTimeout(promise, timeoutMs, label) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error((label || 'operation') + ' timed out'));
      }, timeoutMs);
      Promise.resolve(promise).then(function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function jobStillMatches(job, allowEnded) {
    if (!job || transitionJob !== job || job.generation !== transitionGeneration) return false;
    if (window.audio !== job.activeMedia) return false;
    if (Number(window.currentIdx) !== job.currentIndex) return false;
    var queue = Array.isArray(window.playQueue) ? window.playQueue : [];
    if (transitionCore.songStableKey(queue[job.currentIndex]) !== job.currentKey) return false;
    if (transitionCore.songStableKey(queue[job.nextIndex]) !== job.nextKey) return false;
    if (!allowEnded && (job.activeMedia.paused || job.activeMedia.ended)) return false;
    if (window.playMode !== 'loop' || currentSleepMode() === 'track' || activeRadioTransitionBlocked()) return false;
    return true;
  }

  function bufferedSecondsFromStart(media) {
    if (!media || !media.buffered) return 0;
    try {
      for (var i = 0; i < media.buffered.length; i++) {
        if (media.buffered.start(i) <= 0.15) return Math.max(0, media.buffered.end(i));
      }
    } catch (_) {}
    return 0;
  }

  function candidateReady(job) {
    if (!job || !job.media || job.media.readyState < 3) return false;
    if (job.fadeSeconds <= 0) return true;
    var candidateDuration = Number(job.media.duration) || 0;
    if (candidateDuration && candidateDuration < job.fadeSeconds + 1) return false;
    var buffered = bufferedSecondsFromStart(job.media);
    return buffered >= job.fadeSeconds + 0.5 || job.media.readyState >= 4;
  }

  function restorePreparedEndedHandler(job) {
    if (!job || job.activeMedia !== window.audio || job.activeMedia.ended) return;
    if (job.activeMedia.onended === job.gaplessEndedHandler
      || job.activeMedia.onended === job.startingEndedHandler
      || job.activeMedia.onended == null) {
      job.activeMedia.onended = job.originalEnded;
    }
    job.armed = false;
  }

  function cancelTransition(reason) {
    var job = transitionJob;
    if (job && (job.status === 'recovering' || job.status === 'rollback')
      && reason !== 'queue-switch' && reason !== 'queue-stop'
      && reason !== 'pause-intent' && reason !== 'unload') {
      retryIncomingNormally(job, reason || 'recovery-cancelled');
      return true;
    }
    transitionGeneration++;
    transitionJob = null;
    if (!job) return false;
    if (job.finishTimer) clearTimeout(job.finishTimer);
    restorePreparedEndedHandler(job);
    clearOutgoingTransitionHandler(job);
    cancelDeckAutomation(job.activeMedia);
    cancelDeckAutomation(job.media);

    if (job.status === 'recovering' || job.status === 'rollback') {
      clearTransitionMediaErrorHandler(job.activeMedia);
      clearTransitionMediaErrorHandler(job.media);
      try { job.activeMedia.onended = null; } catch (_) {}
      try { job.activeMedia.pause(); } catch (_) {}
      try { job.media.pause(); } catch (_) {}
      if (job.activeMedia !== window.audio) releaseMedia(job.activeMedia);
      if (job.media !== window.audio) releaseMedia(job.media);
      setDeckGain(window.audio, 1);
      return true;
    }

    if (window.audio === job.media) {
      setDeckGain(job.media, 1);
      releaseMedia(job.activeMedia);
    } else {
      setDeckGain(job.activeMedia, 1);
      releaseMedia(job.media);
    }
    if (reason && reason !== 'completed') console.info('[AudioTransition] cancelled:', reason);
    return true;
  }

  function finishTransition(job) {
    if (!job || transitionJob !== job) return;
    if (job.finishTimer) clearTimeout(job.finishTimer);
    clearOutgoingTransitionHandler(job);
    cancelDeckAutomation(job.activeMedia);
    cancelDeckAutomation(job.media);
    setDeckGain(job.media, 1);
    transitionJob = null;
    transitionGeneration++;
    releaseMedia(job.activeMedia);
  }

  function retryIncomingNormally(job, reason) {
    if (!job || transitionJob !== job) return;
    if (job.finishTimer) clearTimeout(job.finishTimer);
    var globalMedia = window.audio;
    var globalIsIncoming = globalMedia === job.media;
    var globalIsOutgoing = globalMedia === job.activeMedia;
    var stopAfterCurrent = currentSleepMode() === 'track';
    var outgoingCanResume = !!(job.activeMedia && job.activeMedia.src && !job.activeMedia.ended);
    var resumeAt = Number(job.activeMedia && job.activeMedia.currentTime) || 0;
    transitionJob = null;
    transitionGeneration++;
    var recoveryGeneration = transitionGeneration;
    clearOutgoingTransitionHandler(job);
    cancelDeckAutomation(job.activeMedia);
    cancelDeckAutomation(job.media);
    clearTransitionMediaErrorHandler(job.activeMedia);
    clearTransitionMediaErrorHandler(job.media);
    try { job.activeMedia.onended = null; } catch (_) {}

    if (!globalIsIncoming && !globalIsOutgoing) {
      releaseMedia(job.activeMedia);
      releaseMedia(job.media);
      return;
    }

    var recoveryKey = job.nextKey;
    var recoveryOptions = { transitionRecovery: true };
    if (stopAfterCurrent && outgoingCanResume) {
      recoveryKey = job.currentKey;
      recoveryOptions.resumeAt = resumeAt;
      try { job.media.pause(); } catch (_) {}
      if (job.media !== globalMedia) releaseMedia(job.media);
      if (job.activeMedia !== globalMedia) releaseMedia(job.activeMedia);
    } else if (stopAfterCurrent) {
      try { job.activeMedia.pause(); } catch (_) {}
      try { job.media.pause(); } catch (_) {}
      if (job.activeMedia !== globalMedia) releaseMedia(job.activeMedia);
      if (job.media !== globalMedia) releaseMedia(job.media);
      setDeckGain(globalMedia, 1);
      return;
    } else if (globalIsIncoming) {
      setDeckGain(job.media, 1);
      releaseMedia(job.activeMedia);
    } else {
      setDeckGain(job.activeMedia, 1);
      releaseMedia(job.media);
      if (!job.activeMedia.ended) {
        recoveryKey = job.currentKey;
        recoveryOptions.resumeAt = resumeAt;
      }
    }

    setTimeout(function () {
      if (recoveryGeneration !== transitionGeneration || transitionJob) return;
      var targetIndex = queueIndexForKey(recoveryKey, -1);
      if (targetIndex < 0) targetIndex = currentQueueFallbackIndex();
      if (targetIndex < 0) return;
      Promise.resolve(window.playQueueAt(targetIndex, recoveryOptions)).catch(function (error) {
        console.warn('[AudioTransition] normal recovery failed', error);
      });
    }, 0);
    console.warn('[AudioTransition] retrying with normal playback:', reason || 'incoming-failed');
  }

  function recoverIncomingFailure(job, reason) {
    if (!job || transitionJob !== job || job.status === 'recovering' || job.status === 'rollback') return;
    recordFailure(job.nextKey);
    if (job.finishTimer) clearTimeout(job.finishTimer);
    job.nextIndex = queueIndexForKey(job.nextKey, job.nextIndex);
    job.currentIndex = queueIndexForKey(job.currentKey, job.currentIndex);
    job.status = 'recovering';
    clearOutgoingTransitionHandler(job);
    cancelDeckAutomation(job.activeMedia);
    cancelDeckAutomation(job.media);
    setDeckGain(job.activeMedia, 1);
    setDeckGain(job.media, 0);
    job.suppressPauseCancel = true;
    try { job.media.pause(); } catch (_) {}

    promiseWithTimeout(job.coreSettledPromise, CORE_SETTLE_TIMEOUT_MS, 'prepared transition commit').catch(function () {}).then(function () {
      if (transitionJob !== job) return;
      job.nextIndex = queueIndexForKey(job.nextKey, -1);
      job.currentIndex = queueIndexForKey(job.currentKey, -1);
      if (job.currentIndex < 0 || job.activeMedia.ended || !job.activeMedia.src) {
        retryIncomingNormally(job, reason);
        return;
      }
      var currentAudio = window.audio;
      var rollbackData = {
        url: job.activeMedia.src,
        level: currentQuality(),
        trial: false,
      };
      job.status = 'rollback';
      var rollbackPrepared = {
        media: job.activeMedia,
        oldAudio: currentAudio,
        oldIndex: job.nextIndex,
        nextIndex: job.currentIndex,
        nextKey: job.currentKey,
        data: rollbackData,
        proxyAudioUrl: job.activeMedia.src,
        mode: 'rollback',
        durationSeconds: 0,
        onAdopted: function () {
          if (transitionJob !== job) return;
          if (job.finishTimer) clearTimeout(job.finishTimer);
          transitionJob = null;
          transitionGeneration++;
          setDeckGain(job.activeMedia, 1);
          releaseMedia(job.media);
        },
        onRejected: function () { retryIncomingNormally(job, 'rollback-rejected'); },
      };
      Promise.resolve(window.playQueueAt(job.currentIndex, {
        preparedTransition: rollbackPrepared,
        transitionRollback: true,
        preserveHomeState: true,
      })).then(function () {
        if (transitionJob === job && job.status === 'rollback') retryIncomingNormally(job, 'rollback-not-adopted');
      }, function () { retryIncomingNormally(job, 'rollback-failed'); });
    });
  }

  function handleAdoptionRejected(job, reason) {
    if (!job || transitionJob !== job) return;
    if (job.status === 'recovering' || job.status === 'rollback') return;
    console.warn('[AudioTransition] prepared transition was rejected:', reason);
    if (job.adopted && !job.media.error && !job.media.paused && !job.media.ended) {
      setDeckGain(job.media, 1);
      finishTransition(job);
      return;
    }
    if (job.status === 'transitioning' || job.adopted) {
      recoverIncomingFailure(job, reason || 'adoption-rejected');
      return;
    }
    cancelTransition(reason || 'adoption-rejected');
  }

  async function startPreparedTransition(job, trigger) {
    if (!job || transitionJob !== job || job.status === 'starting' || job.status === 'transitioning') return;
    if (!jobStillMatches(job, trigger === 'ended')) {
      cancelTransition('stale-before-start');
      if (trigger === 'ended') callOriginalEnded(job);
      return;
    }
    if (!candidateReady(job)) {
      if (trigger === 'ended') {
        cancelTransition('candidate-not-ready');
        callOriginalEnded(job);
      }
      return;
    }

    job.status = 'starting';
    job.outgoingEndedDuringStart = !!job.activeMedia.ended;
    job.startingEndedHandler = function (event) {
      job.outgoingEndedDuringStart = true;
      job.startingEndedEvent = event;
    };
    job.activeMedia.onended = job.startingEndedHandler;
    setDeckGain(job.media, 0);
    applyOutputToMedia(job.media);
    try {
      if (typeof window.resumeAudioAnalysis === 'function') Promise.resolve(window.resumeAudioAnalysis()).catch(function () {});
      await promiseWithTimeout(job.media.play(), PLAY_START_TIMEOUT_MS, 'candidate play');
      if (job.candidateErrorDuringStart) throw new Error('candidate media failed while starting');
    } catch (error) {
      console.warn('[AudioTransition] prepared media failed to start', error);
      if (transitionJob !== job) return;
      recordFailure(job.nextKey);
      var oldEnded = job.activeMedia.ended || job.outgoingEndedDuringStart;
      cancelTransition('candidate-play-failed');
      if (oldEnded || trigger === 'ended') callOriginalEnded(job, job.startingEndedEvent);
      return;
    }

    if (transitionJob !== job || job.generation !== transitionGeneration) {
      if (!mediaHasCurrentOwner(job.media)) {
        try { job.media.pause(); } catch (_) {}
      }
      return;
    }
    job.activeMedia.onended = null;
    var outgoingEnded = job.activeMedia.ended || job.outgoingEndedDuringStart;
    if (!jobStillMatches(job, trigger === 'ended' || outgoingEnded)) {
      var shouldFallback = outgoingEnded && window.audio === job.activeMedia && Number(window.currentIdx) === job.currentIndex;
      cancelTransition('stale-after-start');
      if (shouldFallback) callOriginalEnded(job);
      return;
    }

    job.status = 'transitioning';
    var outgoingRemaining = Number(job.activeMedia.duration) - Number(job.activeMedia.currentTime);
    job.transitionSeconds = outgoingEnded
      ? 0
      : (isFinite(outgoingRemaining) && outgoingRemaining > 0
        ? Math.min(job.fadeSeconds, outgoingRemaining)
        : job.fadeSeconds);
    if (job.transitionSeconds < 0.18) job.transitionSeconds = 0;
    if (job.transitionSeconds > 0) scheduleEqualPowerFade(job.activeMedia, job.media, job.transitionSeconds);
    else {
      setDeckGain(job.activeMedia, 0);
      setDeckGain(job.media, 1);
    }
    installOutgoingTransitionHandler(job);

    var prepared = {
      media: job.media,
      oldAudio: job.activeMedia,
      oldIndex: job.currentIndex,
      nextIndex: job.nextIndex,
      nextKey: job.nextKey,
      data: job.data,
      proxyAudioUrl: job.proxyAudioUrl,
      mode: job.mode,
      durationSeconds: job.transitionSeconds,
      onAdopted: function () {
        if (transitionJob !== job) return;
        job.adopted = true;
        bindPlaybackCancellation(job.media);
        if (job.transitionSeconds <= 0) finishTransition(job);
      },
      onRejected: function (reason) { handleAdoptionRejected(job, reason); },
      onCoreSettled: function (reason) {
        job.coreSettledReason = reason || 'settled';
        if (job.resolveCoreSettled) job.resolveCoreSettled(job.coreSettledReason);
      },
    };

    if (job.transitionSeconds > 0) {
      job.finishTimer = setTimeout(function () { finishTransition(job); }, job.transitionSeconds * 1000 + 120);
    }
    job.adoptionPromise = Promise.resolve(window.playQueueAt(job.nextIndex, {
      preparedTransition: prepared,
      transitionAuto: true,
      preserveHomeState: true,
    }));
    job.adoptionPromise.catch(function (error) {
      console.warn('[AudioTransition] queue adoption failed', error);
      handleAdoptionRejected(job, 'queue-adoption-failed');
    });
  }

  function armGaplessTransition(job) {
    if (!job || job.armed || !candidateReady(job) || !jobStillMatches(job, false)) return;
    job.armed = true;
    job.gaplessEndedHandler = function (event) {
      if (!jobStillMatches(job, true)) {
        transitionJob = null;
        transitionGeneration++;
        releaseMedia(job.media);
        callOriginalEnded(job, event);
        return;
      }
      startPreparedTransition(job, 'ended');
    };
    job.activeMedia.onended = job.gaplessEndedHandler;
  }

  function markCandidateReady(job) {
    if (!job || transitionJob !== job) return;
    if (job.status !== 'loading' && job.status !== 'ready') return;
    if (!candidateReady(job)) return;
    job.status = 'ready';
    if (job.fadeSeconds <= 0) armGaplessTransition(job);
  }

  async function prepareTransition(assessment) {
    if (!assessment || !assessment.eligible || transitionJob) return;
    var queue = window.playQueue;
    var nextSong = queue && queue[assessment.nextIndex];
    var request = audioSettingsCore.buildNeteaseSourceRequest(nextSong, currentQuality(), hasNeteaseSvip());
    if (!request || typeof window.apiJson !== 'function' || navigator.onLine === false) return;

    var activeMedia = window.audio;
    var media = acquireStandbyMedia(activeMedia);
    if (!deckGainParam(activeMedia) || !deckGainParam(media)) {
      transitionGraphUnavailable = true;
      releaseMedia(media);
      return;
    }
    var generation = ++transitionGeneration;
    var requestUrl = request.url + (request.url.indexOf('?') >= 0 ? '&' : '?') + 'transitionPrepare=' + Date.now();
    var job = {
      generation: generation,
      status: 'preparing',
      mode: assessment.config.mode,
      fadeSeconds: assessment.fadeSeconds,
      currentIndex: assessment.currentIndex,
      nextIndex: assessment.nextIndex,
      currentKey: assessment.currentKey,
      nextKey: assessment.nextKey,
      activeMedia: activeMedia,
      media: media,
      originalEnded: activeMedia.onended,
      finishTimer: 0,
      armed: false,
      adopted: false,
    };
    job.coreSettledPromise = new Promise(function (resolve) { job.resolveCoreSettled = resolve; });
    transitionJob = job;

    try {
      var data = await window.apiJson(requestUrl, { timeoutMs: 12000 });
      if (transitionJob !== job || job.generation !== transitionGeneration) return;
      if (!jobStillMatches(job, false)) {
        cancelTransition('stale-after-prepare');
        return;
      }
      if (!data || !data.url) {
        recordFailure(job.nextKey);
        cancelTransition('source-unavailable');
        return;
      }
      job.data = data;
      job.proxyAudioUrl = '/api/audio?url=' + encodeURIComponent(data.url);
      job.status = 'loading';
      media.src = job.proxyAudioUrl;
      applyOutputToMedia(media);
      installTransitionMediaErrorHandler(job);
      media.addEventListener('canplay', function () { markCandidateReady(job); }, { once: true });
      media.addEventListener('canplaythrough', function () { markCandidateReady(job); }, { once: true });
      media.load();
      setTimeout(function () { markCandidateReady(job); }, 350);
    } catch (error) {
      if (transitionJob !== job) return;
      recordFailure(job.nextKey);
      console.warn('[AudioTransition] next track preparation failed', error);
      cancelTransition('prepare-failed');
    }
  }

  function bindPlaybackCancellation(media) {
    if (!media || media.__mineradioTransitionEventsBound) return;
    media.__mineradioTransitionEventsBound = true;
    media.addEventListener('pause', function () {
      if (media !== window.audio || !transitionJob) return;
      if (transitionJob.suppressPauseCancel) return;
      if (media.ended || (transitionJob.fadeSeconds <= 0 && Number(media.duration) - Number(media.currentTime) < 0.2)) return;
      cancelTransition('active-paused');
    });
    media.addEventListener('seeking', function () {
      if (media !== window.audio || !transitionJob) return;
      cancelTransition('active-seeked');
    });
  }

  function tickTransition() {
    var media = window.audio;
    bindPlaybackCancellation(media);
    if (transitionJob) {
      var job = transitionJob;
      if (job.status === 'transitioning') {
        if (currentSleepMode() === 'track') cancelTransition('stop-after-current-enabled');
        return;
      }
      if (job.status === 'starting' || job.status === 'recovering' || job.status === 'rollback') return;
      if (!jobStillMatches(job, false)) {
        cancelTransition('state-changed');
        return;
      }
      markCandidateReady(job);
      if (job.fadeSeconds > 0 && job.status === 'ready') {
        var remaining = Number(job.activeMedia.duration) - Number(job.activeMedia.currentTime);
        if (isFinite(remaining) && remaining <= job.fadeSeconds + 0.12) startPreparedTransition(job, 'crossfade');
      }
      return;
    }

    var assessment = assessCurrentTransition();
    if (!assessment.eligible) return;
    var remainingSeconds = Number(media.duration) - Number(media.currentTime);
    if (!isFinite(remainingSeconds) || remainingSeconds <= 0) return;
    var prepareAt = Math.max(PREPARE_LEAD_SECONDS, assessment.fadeSeconds + 12);
    if (remainingSeconds > prepareAt) return;
    if (lastFailureKey === assessment.nextKey && Date.now() - lastFailureAt < FAILURE_RETRY_MS) return;
    prepareTransition(assessment).catch(function (error) {
      console.warn('[AudioTransition] preparation crashed', error);
      cancelTransition('prepare-crashed');
    });
  }

  function wrapQueuePlayback() {
    var legacyPlayQueueAt = window.playQueueAt;
    if (typeof legacyPlayQueueAt !== 'function' || legacyPlayQueueAt.__v153TransitionWrapped) return;
    var wrapped = async function (index, options) {
      options = options || {};
      if (!options.preparedTransition) {
        cancelTransition('queue-switch');
        clearTransitionMediaErrorHandler(window.audio);
      }
      var result = await legacyPlayQueueAt.apply(this, arguments);
      bindPlaybackCancellation(window.audio);
      return result;
    };
    wrapped.__v153TransitionWrapped = true;
    window.playQueueAt = wrapped;
  }

  function diagnostics() {
    return {
      mode: currentSettings().mode,
      durationSeconds: currentSettings().durationSeconds,
      state: transitionJob ? transitionJob.status : 'idle',
      currentKey: transitionJob ? transitionJob.currentKey : '',
      nextKey: transitionJob ? transitionJob.nextKey : '',
      nextIndex: transitionJob ? transitionJob.nextIndex : -1,
      standbyReady: !!standbyMedia,
      graphAvailable: !transitionGraphUnavailable,
    };
  }

  function hasAudibleOutgoing() {
    if (!transitionJob || (transitionJob.status !== 'recovering' && transitionJob.status !== 'rollback')) return false;
    var media = transitionJob.activeMedia;
    return !!(media && media.src && !media.paused && !media.ended);
  }

  wrapQueuePlayback();
  bindPlaybackCancellation(window.audio);
  ticker = setInterval(tickTransition, TICK_INTERVAL_MS);
  window.addEventListener('mineradio:audio-transition-change', function () {
    cancelTransition('settings-changed');
    setTimeout(tickTransition, 0);
  });
  window.addEventListener('beforeunload', function () {
    if (ticker) clearInterval(ticker);
    cancelTransition('unload');
    if (standbyMedia) releaseMedia(standbyMedia);
  }, { once: true });

  window.MineradioTransitionV153 = {
    cancel: cancelTransition,
    tick: tickTransition,
    diagnostics: diagnostics,
    hasAudibleOutgoing: hasAudibleOutgoing,
  };
})();
