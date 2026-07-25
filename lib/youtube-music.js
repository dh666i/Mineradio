'use strict';

const YOUTUBE_SEARCH_TYPES = Object.freeze({
  all: 'video,playlist,channel',
  song: 'video',
  playlist: 'playlist',
  artist: 'channel',
});

function text(value) {
  return String(value == null ? '' : value).trim();
}

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeYouTubeSearchType(value) {
  const type = text(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(YOUTUBE_SEARCH_TYPES, type) ? type : 'all';
}

function normalizeYouTubeLimit(value, fallback, max) {
  const resolvedFallback = Math.max(1, Math.trunc(finiteNonNegative(fallback, 24)) || 24);
  const resolvedMax = Math.max(resolvedFallback, Math.trunc(finiteNonNegative(max, 50)) || 50);
  const requested = Math.trunc(finiteNonNegative(value, resolvedFallback));
  return Math.max(1, Math.min(resolvedMax, requested || resolvedFallback));
}

function youtubeSearchCacheKey(input) {
  input = input || {};
  const type = normalizeYouTubeSearchType(input.type);
  const fallbackLimit = type === 'all' ? 30 : 24;
  const keywords = text(input.keywords).replace(/\s+/g, ' ').toLocaleLowerCase();
  const pageToken = text(input.pageToken).slice(0, 512);
  const credentialScope = text(input.credentialScope);
  const limit = normalizeYouTubeLimit(input.limit, fallbackLimit, 50);
  return JSON.stringify([credentialScope, keywords, type, limit, pageToken]);
}

function createYouTubeSearchCoordinator(options) {
  options = options || {};
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const cacheTtlMs = Math.max(1000, Math.trunc(finiteNonNegative(options.cacheTtlMs, 10 * 60 * 1000)));
  const windowMs = Math.max(1000, Math.trunc(finiteNonNegative(options.windowMs, 60 * 1000)));
  const perClientLimit = Math.max(1, Math.trunc(finiteNonNegative(options.perClientLimit, 6)));
  const globalLimit = Math.max(perClientLimit, Math.trunc(finiteNonNegative(options.globalLimit, 24)));
  const maxCacheEntries = Math.max(1, Math.trunc(finiteNonNegative(options.maxCacheEntries, 160)));
  const maxClients = Math.max(1, Math.trunc(finiteNonNegative(options.maxClients, 64)));
  const cache = new Map();
  const pending = new Map();
  const clients = new Map();
  let globalEvents = [];

  function pruneEvents(events, now) {
    const cutoff = now - windowMs;
    let firstLive = 0;
    while (firstLive < events.length && events[firstLive] <= cutoff) firstLive += 1;
    return firstLive ? events.slice(firstLive) : events;
  }

  function pruneCache(now) {
    for (const [key, entry] of cache) {
      if (!entry || entry.expiresAt <= now) cache.delete(key);
    }
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
  }

  function clientBucket(clientId, now) {
    const id = text(clientId) || 'local';
    let bucket = clients.get(id);
    if (!bucket) {
      bucket = { events: [], lastSeen: now };
      clients.set(id, bucket);
    }
    bucket.events = pruneEvents(bucket.events, now);
    bucket.lastSeen = now;
    if (clients.size > maxClients) {
      const oldest = Array.from(clients.entries())
        .filter(([key]) => key !== id)
        .sort((left, right) => left[1].lastSeen - right[1].lastSeen)[0];
      if (oldest) clients.delete(oldest[0]);
    }
    return bucket;
  }

  function rateLimitError(scope, retryAfterMs) {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    const error = new Error(`YouTube 搜索请求过于频繁，请等待 ${seconds} 秒后重试`);
    error.code = 'YOUTUBE_SEARCH_RATE_LIMITED';
    error.statusCode = 429;
    error.reason = scope;
    error.rateLimitScope = scope;
    error.retryAfterMs = Math.max(1, Math.ceil(retryAfterMs));
    return error;
  }

  function consume(clientId, now) {
    globalEvents = pruneEvents(globalEvents, now);
    const bucket = clientBucket(clientId, now);
    const clientLimited = bucket.events.length >= perClientLimit;
    const globalLimited = globalEvents.length >= globalLimit;
    if (clientLimited || globalLimited) {
      const clientRetry = clientLimited ? bucket.events[0] + windowMs - now : 0;
      const globalRetry = globalLimited ? globalEvents[0] + windowMs - now : 0;
      throw rateLimitError(globalLimited ? 'global' : 'client', Math.max(clientRetry, globalRetry));
    }
    bucket.events.push(now);
    globalEvents.push(now);
  }

  async function run(input) {
    input = input || {};
    const key = text(input.key);
    if (!key) throw new TypeError('YouTube search cache key is required');
    if (typeof input.load !== 'function') throw new TypeError('YouTube search loader is required');
    const now = clock();
    pruneCache(now);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      return { value: cached.value, cacheStatus: 'hit' };
    }
    if (pending.has(key)) {
      return { value: await pending.get(key), cacheStatus: 'shared' };
    }

    consume(input.clientId, now);
    const operation = Promise.resolve().then(input.load);
    pending.set(key, operation);
    try {
      const value = await operation;
      cache.set(key, {
        value,
        expiresAt: clock() + cacheTtlMs,
      });
      pruneCache(clock());
      return { value, cacheStatus: 'miss' };
    } finally {
      if (pending.get(key) === operation) pending.delete(key);
    }
  }

  function clear() {
    cache.clear();
    pending.clear();
    clients.clear();
    globalEvents = [];
  }

  return {
    clear,
    run,
  };
}

function parseIso8601DurationMs(value) {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(text(value));
  if (!match) return 0;
  const days = finiteNonNegative(match[1], 0);
  const hours = finiteNonNegative(match[2], 0);
  const minutes = finiteNonNegative(match[3], 0);
  const seconds = finiteNonNegative(match[4], 0);
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

function bestThumbnail(snippet) {
  const thumbnails = snippet && snippet.thumbnails || {};
  const preferred = ['maxres', 'standard', 'high', 'medium', 'default'];
  for (const key of preferred) {
    if (thumbnails[key] && thumbnails[key].url) return text(thumbnails[key].url);
  }
  return '';
}

function videoIdOf(item) {
  if (!item) return '';
  const explicitId = text(item.videoId || item.youtubeId || item.id && item.id.videoId
    || item.contentDetails && item.contentDetails.videoId
    || item.snippet && item.snippet.resourceId && item.snippet.resourceId.videoId);
  if (explicitId) return explicitId;
  return typeof item.id === 'string' ? text(item.id) : '';
}

function playlistIdOf(item) {
  if (!item) return '';
  if (typeof item.id === 'string') return text(item.id);
  return text(item.playlistId || item.id && item.id.playlistId);
}

function channelIdOf(item) {
  if (!item) return '';
  if (typeof item.id === 'string') return text(item.id);
  return text(item.channelId || item.id && item.id.channelId || item.snippet && item.snippet.channelId);
}

function detailsByVideoId(input) {
  const details = new Map();
  if (input instanceof Map) return input;
  if (Array.isArray(input)) {
    input.forEach(item => {
      const id = videoIdOf(item);
      if (id) details.set(id, item);
    });
    return details;
  }
  if (input && typeof input === 'object') {
    Object.keys(input).forEach(id => {
      if (input[id]) details.set(id, input[id]);
    });
  }
  return details;
}

function mapYouTubeVideo(item, detail) {
  item = item || {};
  const hasDetails = !!(detail && videoIdOf(detail));
  detail = detail || {};
  const id = videoIdOf(detail) || videoIdOf(item);
  const snippet = detail.snippet || item.snippet || {};
  const status = detail.status || {};
  const title = text(snippet.title);
  const channelTitle = text(snippet.videoOwnerChannelTitle || snippet.channelTitle);
  const channelId = text(snippet.videoOwnerChannelId || snippet.channelId);
  if (!id || !title || /^(private|deleted) video$/i.test(title)) return null;
  const durationMs = parseIso8601DurationMs(detail.contentDetails && detail.contentDetails.duration);
  const blockedUpload = status.uploadStatus === 'deleted' || status.uploadStatus === 'rejected' || status.privacyStatus === 'private';
  const upcoming = snippet.liveBroadcastContent === 'upcoming';
  const available = hasDetails && !blockedUpload && !upcoming;
  return {
    id,
    videoId: id,
    youtubeId: id,
    name: title,
    title,
    artist: channelTitle || 'YouTube',
    artists: channelTitle ? [{ id: channelId, name: channelTitle }] : [],
    artistId: channelId,
    channelId,
    cover: bestThumbnail(snippet),
    duration: durationMs,
    durationMs,
    publishedAt: text(snippet.publishedAt),
    description: text(snippet.description),
    provider: 'youtube',
    source: 'youtube',
    type: 'youtube',
    playable: false,
    available,
    externalOnly: true,
    externalUrl: `https://music.youtube.com/watch?v=${encodeURIComponent(id)}`,
    live: snippet.liveBroadcastContent === 'live',
  };
}

function mapYouTubePlaylist(item) {
  item = item || {};
  const id = playlistIdOf(item);
  const snippet = item.snippet || {};
  const name = text(snippet.title || item.name);
  if (!id || !name) return null;
  return {
    id,
    playlistId: id,
    name,
    title: name,
    cover: bestThumbnail(snippet),
    description: text(snippet.description),
    creator: text(snippet.channelTitle),
    channelId: text(snippet.channelId),
    publishedAt: text(snippet.publishedAt),
    itemCount: finiteNonNegative(item.contentDetails && item.contentDetails.itemCount, 0),
    trackCount: finiteNonNegative(item.contentDetails && item.contentDetails.itemCount, 0),
    provider: 'youtube',
    source: 'youtube',
    type: 'playlist',
    externalOnly: true,
    externalUrl: `https://music.youtube.com/playlist?list=${encodeURIComponent(id)}`,
  };
}

function mapYouTubeChannel(item) {
  item = item || {};
  const id = channelIdOf(item);
  const snippet = item.snippet || {};
  const statistics = item.statistics || {};
  const name = text(snippet.title || item.name);
  if (!id || !name) return null;
  return {
    id,
    channelId: id,
    name,
    title: name,
    avatar: bestThumbnail(snippet),
    cover: bestThumbnail(snippet),
    description: text(snippet.description),
    customUrl: text(snippet.customUrl),
    subscriberCount: finiteNonNegative(statistics.subscriberCount, 0),
    videoCount: finiteNonNegative(statistics.videoCount, 0),
    provider: 'youtube',
    source: 'youtube',
    type: 'artist',
    externalOnly: true,
    externalUrl: `https://music.youtube.com/channel/${encodeURIComponent(id)}`,
  };
}

function mapYouTubeSearchResponse(searchBody, videoDetails) {
  const details = detailsByVideoId(videoDetails && (videoDetails.items || videoDetails));
  const sections = { songs: [], playlists: [], artists: [] };
  (Array.isArray(searchBody && searchBody.items) ? searchBody.items : []).forEach(item => {
    const kind = text(item && item.id && item.id.kind);
    if (kind === 'youtube#video' || videoIdOf(item)) {
      const id = videoIdOf(item);
      const song = mapYouTubeVideo(item, details.get(id));
      if (song && song.available) sections.songs.push(song);
      return;
    }
    if (kind === 'youtube#playlist' || playlistIdOf(item)) {
      const playlist = mapYouTubePlaylist(item);
      if (playlist) sections.playlists.push(playlist);
      return;
    }
    if (kind === 'youtube#channel' || channelIdOf(item)) {
      const artist = mapYouTubeChannel(item);
      if (artist) sections.artists.push(artist);
    }
  });
  const items = sections.songs.concat(sections.playlists, sections.artists);
  return {
    ...sections,
    items,
    nextPageToken: text(searchBody && searchBody.nextPageToken),
    prevPageToken: text(searchBody && searchBody.prevPageToken),
    total: finiteNonNegative(searchBody && searchBody.pageInfo && searchBody.pageInfo.totalResults, items.length),
  };
}

function mapYouTubePlaylistItems(playlistBody, videoDetails) {
  const details = detailsByVideoId(videoDetails && (videoDetails.items || videoDetails));
  const songs = [];
  (Array.isArray(playlistBody && playlistBody.items) ? playlistBody.items : []).forEach(item => {
    const id = videoIdOf(item);
    const song = mapYouTubeVideo(item, details.get(id));
    if (song && song.available) songs.push(song);
  });
  return songs;
}

function plausibleYouTubeApiKey(value) {
  const key = text(value);
  return key.length >= 24 && key.length <= 128 && /^[A-Za-z0-9_-]+$/.test(key);
}

module.exports = {
  YOUTUBE_SEARCH_TYPES,
  bestThumbnail,
  createYouTubeSearchCoordinator,
  mapYouTubeChannel,
  mapYouTubePlaylist,
  mapYouTubePlaylistItems,
  mapYouTubeSearchResponse,
  mapYouTubeVideo,
  normalizeYouTubeLimit,
  normalizeYouTubeSearchType,
  parseIso8601DurationMs,
  plausibleYouTubeApiKey,
  videoIdOf,
  youtubeSearchCacheKey,
};
