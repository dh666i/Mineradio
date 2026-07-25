'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createYouTubeSearchCoordinator,
  mapYouTubeChannel,
  mapYouTubePlaylistItems,
  mapYouTubeSearchResponse,
  mapYouTubeVideo,
  normalizeYouTubeLimit,
  normalizeYouTubeSearchType,
  parseIso8601DurationMs,
  plausibleYouTubeApiKey,
  youtubeSearchCacheKey,
} = require('../../lib/youtube-music');

test('normalizes YouTube search types and bounded result limits', () => {
  assert.equal(normalizeYouTubeSearchType('song'), 'song');
  assert.equal(normalizeYouTubeSearchType('CHANNEL'), 'all');
  assert.equal(normalizeYouTubeSearchType('unknown'), 'all');
  assert.equal(normalizeYouTubeLimit('80', 24, 50), 50);
  assert.equal(normalizeYouTubeLimit('bad', 12, 50), 12);
});

test('normalizes YouTube search cache keys without crossing credentials or pages', () => {
  const first = youtubeSearchCacheKey({
    credentialScope: 'oauth:one',
    keywords: '  Hello   WORLD  ',
    type: 'SONG',
    limit: '24',
  });
  const equivalent = youtubeSearchCacheKey({
    credentialScope: 'oauth:one',
    keywords: 'hello world',
    type: 'song',
    limit: 24,
  });
  assert.equal(first, equivalent);
  assert.notEqual(first, youtubeSearchCacheKey({
    credentialScope: 'oauth:two',
    keywords: 'hello world',
    type: 'song',
    limit: 24,
  }));
  assert.notEqual(first, youtubeSearchCacheKey({
    credentialScope: 'oauth:one',
    keywords: 'hello world',
    type: 'song',
    limit: 24,
    pageToken: 'NEXT',
  }));
});

test('YouTube search coordinator caches successes and coalesces in-flight requests before limiting', async () => {
  let now = 1000;
  let calls = 0;
  let release;
  const pendingResult = new Promise(resolve => { release = resolve; });
  const coordinator = createYouTubeSearchCoordinator({
    now: () => now,
    cacheTtlMs: 10000,
    windowMs: 60000,
    perClientLimit: 1,
    globalLimit: 2,
  });
  const load = () => {
    calls += 1;
    return pendingResult;
  };

  const first = coordinator.run({ key: 'same', clientId: 'client-a', load });
  const shared = coordinator.run({ key: 'same', clientId: 'client-a', load });
  release({ songs: [{ id: 'video-1' }] });
  assert.deepEqual(await first, {
    value: { songs: [{ id: 'video-1' }] },
    cacheStatus: 'miss',
  });
  assert.deepEqual(await shared, {
    value: { songs: [{ id: 'video-1' }] },
    cacheStatus: 'shared',
  });
  assert.equal(calls, 1);

  const cached = await coordinator.run({
    key: 'same',
    clientId: 'client-a',
    load: async () => {
      calls += 1;
      return {};
    },
  });
  assert.equal(cached.cacheStatus, 'hit');
  assert.equal(calls, 1);

  await assert.rejects(
    coordinator.run({ key: 'uncached', clientId: 'client-a', load: async () => ({}) }),
    error => error.code === 'YOUTUBE_SEARCH_RATE_LIMITED'
      && error.statusCode === 429
      && error.rateLimitScope === 'client'
      && error.retryAfterMs === 60000,
  );

  now += 60001;
  const afterWindow = await coordinator.run({
    key: 'uncached',
    clientId: 'client-a',
    load: async () => ({ songs: [] }),
  });
  assert.equal(afterWindow.cacheStatus, 'miss');
});

test('YouTube search coordinator applies a global window and never caches failures', async () => {
  let now = 5000;
  let failingCalls = 0;
  const coordinator = createYouTubeSearchCoordinator({
    now: () => now,
    cacheTtlMs: 10000,
    windowMs: 10000,
    perClientLimit: 2,
    globalLimit: 3,
  });

  await assert.rejects(
    coordinator.run({
      key: 'fails',
      clientId: 'client-a',
      load: async () => {
        failingCalls += 1;
        throw new Error('upstream failed');
      },
    }),
    /upstream failed/,
  );
  now += 10001;
  await assert.rejects(
    coordinator.run({
      key: 'fails',
      clientId: 'client-a',
      load: async () => {
        failingCalls += 1;
        throw new Error('upstream failed again');
      },
    }),
    /upstream failed again/,
  );
  assert.equal(failingCalls, 2);

  now += 10001;
  await coordinator.run({ key: 'one', clientId: 'client-a', load: async () => ({}) });
  await coordinator.run({ key: 'two', clientId: 'client-b', load: async () => ({}) });
  await coordinator.run({ key: 'three', clientId: 'client-c', load: async () => ({}) });
  await assert.rejects(
    coordinator.run({ key: 'four', clientId: 'client-d', load: async () => ({}) }),
    error => error.code === 'YOUTUBE_SEARCH_RATE_LIMITED'
      && error.rateLimitScope === 'global'
      && error.retryAfterMs === 10000,
  );
});

test('parses ISO 8601 YouTube durations', () => {
  assert.equal(parseIso8601DurationMs('PT3M5S'), 185000);
  assert.equal(parseIso8601DurationMs('PT1H2M3.5S'), 3723500);
  assert.equal(parseIso8601DurationMs('P1DT2H'), 93600000);
  assert.equal(parseIso8601DurationMs('bad'), 0);
});

test('maps an available YouTube video as an external-only result', () => {
  const mapped = mapYouTubeVideo({
    id: { kind: 'youtube#video', videoId: 'video-1' },
    snippet: {
      title: 'Track',
      channelTitle: 'Artist Channel',
      channelId: 'channel-1',
      thumbnails: { high: { url: 'cover.jpg' } },
    },
  }, {
    id: 'video-1',
    contentDetails: { duration: 'PT4M2S' },
    status: { embeddable: true, privacyStatus: 'public', uploadStatus: 'processed' },
  });

  assert.deepEqual(mapped, {
    id: 'video-1',
    videoId: 'video-1',
    youtubeId: 'video-1',
    name: 'Track',
    title: 'Track',
    artist: 'Artist Channel',
    artists: [{ id: 'channel-1', name: 'Artist Channel' }],
    artistId: 'channel-1',
    channelId: 'channel-1',
    cover: 'cover.jpg',
    duration: 242000,
    durationMs: 242000,
    publishedAt: '',
    description: '',
    provider: 'youtube',
    source: 'youtube',
    type: 'youtube',
    playable: false,
    available: true,
    externalOnly: true,
    externalUrl: 'https://music.youtube.com/watch?v=video-1',
    live: false,
  });
});

test('groups mixed search results and keeps non-embeddable videos for official external playback', () => {
  const search = {
    nextPageToken: 'NEXT',
    pageInfo: { totalResults: 3 },
    items: [
      { id: { kind: 'youtube#video', videoId: 'ok' }, snippet: { title: 'Song', channelTitle: 'Artist' } },
      { id: { kind: 'youtube#video', videoId: 'blocked' }, snippet: { title: 'Blocked', channelTitle: 'Artist' } },
      { id: { kind: 'youtube#playlist', playlistId: 'pl-1' }, snippet: { title: 'Playlist', channelTitle: 'Owner' } },
      { id: { kind: 'youtube#channel', channelId: 'ch-1' }, snippet: { title: 'Channel' } },
    ],
  };
  const mapped = mapYouTubeSearchResponse(search, {
    items: [
      { id: 'ok', contentDetails: { duration: 'PT1M' }, status: { embeddable: true } },
      { id: 'blocked', contentDetails: { duration: 'PT1M' }, status: { embeddable: false } },
    ],
  });

  assert.equal(mapped.songs.length, 2);
  assert.equal(mapped.songs[1].playable, false);
  assert.equal(mapped.songs[1].externalOnly, true);
  assert.equal(mapped.playlists.length, 1);
  assert.equal(mapped.artists.length, 1);
  assert.equal(mapped.nextPageToken, 'NEXT');
});

test('filters videos that have no playable details or are not live yet', () => {
  const search = {
    items: [
      { id: { kind: 'youtube#video', videoId: 'missing' }, snippet: { title: 'Missing detail' } },
      { id: { kind: 'youtube#video', videoId: 'upcoming' }, snippet: { title: 'Upcoming' } },
    ],
  };
  const mapped = mapYouTubeSearchResponse(search, {
    items: [{
      id: 'upcoming',
      snippet: { title: 'Upcoming', liveBroadcastContent: 'upcoming' },
      contentDetails: { duration: 'P0D' },
      status: { embeddable: true },
    }],
  });
  assert.deepEqual(mapped.songs, []);
});

test('maps playlist items using video details and channel metadata', () => {
  const songs = mapYouTubePlaylistItems({
    items: [{
      id: 'playlist-item-resource-id',
      kind: 'youtube#playlistItem',
      contentDetails: { videoId: 'video-2' },
      snippet: {
        title: 'Playlist title',
        videoOwnerChannelTitle: 'Playlist artist',
        videoOwnerChannelId: 'artist-1',
        resourceId: { videoId: 'video-2' },
      },
    }],
  }, {
    items: [{
      id: 'video-2',
      contentDetails: { duration: 'PT2M30S' },
      status: { embeddable: true },
    }],
  });
  assert.equal(songs[0].id, 'video-2');
  assert.equal(songs[0].durationMs, 150000);
  assert.equal(songs[0].artistId, 'artist-1');
});

test('maps channel statistics and validates API key shape without exposing it', () => {
  const channel = mapYouTubeChannel({
    id: 'channel-1',
    snippet: { title: 'Artist', thumbnails: { default: { url: 'avatar.jpg' } } },
    statistics: { subscriberCount: '1200', videoCount: '42' },
  });
  assert.equal(channel.subscriberCount, 1200);
  assert.equal(channel.videoCount, 42);
  assert.equal(plausibleYouTubeApiKey('AIza' + 'x'.repeat(35)), true);
  assert.equal(plausibleYouTubeApiKey('short key'), false);
});
