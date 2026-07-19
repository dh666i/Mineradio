'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mapNeteasePlaylistMeta,
  mapPlaylistCategories,
  mapTypedSearchResult,
  normalizePagination,
  normalizePlaylistMetadataPatch,
  normalizeTypedSearchType,
  resolvePageCursor,
} = require('../../lib/netease-catalog');

test('normalizes bounded Netease pagination', () => {
  assert.deepEqual(
    normalizePagination('250', '40', { defaultLimit: 30, maxLimit: 100 }),
    { limit: 100, offset: 40 },
  );
  assert.deepEqual(
    normalizePagination('bad', '-3', { defaultLimit: 24, maxLimit: 50 }),
    { limit: 24, offset: 0 },
  );
});

test('page cursors advance by the upstream page even when mapped items were filtered', () => {
  assert.deepEqual(
    resolvePageCursor({ limit: 30, offset: 0 }, 20, 30, true),
    { total: 31, nextOffset: 30, more: true, hasMore: true },
  );
  assert.deepEqual(
    resolvePageCursor({ limit: 30, offset: 30 }, 20, 20, false),
    { total: 50, nextOffset: 50, more: false, hasMore: false },
  );
  assert.deepEqual(
    resolvePageCursor({ limit: 30, offset: 60 }, 0, 0, false),
    { total: 60, nextOffset: 60, more: false, hasMore: false },
  );
});

test('maps typed search responses to stable artist, album, and playlist records', () => {
  const artistResult = mapTypedSearchResult({
    result: {
      artistCount: 8,
      artists: [{ id: 1, name: 'Artist', picUrl: 'artist.jpg', albumSize: 4, musicSize: 12 }],
    },
  }, 'artist');
  assert.equal(artistResult.apiType, 100);
  assert.equal(artistResult.total, 8);
  assert.deepEqual(artistResult.items[0], {
    provider: 'netease',
    source: 'netease',
    type: 'artist',
    id: 1,
    name: 'Artist',
    avatar: 'artist.jpg',
    aliases: [],
    alias: [],
    albumCount: 4,
    albumSize: 4,
    songCount: 12,
    musicCount: 12,
    musicSize: 12,
    followed: false,
  });

  const albumResult = mapTypedSearchResult({
    result: {
      albumCount: 1,
      albums: [{ id: 2, name: 'Album', picUrl: 'album.jpg', artist: { id: 1, name: 'Artist' } }],
    },
  }, 'album');
  assert.equal(albumResult.apiType, 10);
  assert.equal(albumResult.items[0].artist, 'Artist');
  assert.equal(albumResult.items[0].cover, 'album.jpg');

  const playlistResult = mapTypedSearchResult({
    result: {
      playlistCount: 3,
      playlists: [{ id: 3, name: 'Playlist', coverImgUrl: 'list.jpg', creator: { userId: 9, nickname: 'Owner' } }],
    },
  }, 'playlist');
  assert.equal(playlistResult.apiType, 1000);
  assert.equal(playlistResult.total, 3);
  assert.equal(playlistResult.items[0].creator, 'Owner');
  assert.equal(playlistResult.items[0].creatorId, 9);
  assert.equal(normalizeTypedSearchType('song'), '');
});

test('maps complete playlist metadata without dropping ownership and management fields', () => {
  const playlist = mapNeteasePlaylistMeta({
    id: 42,
    name: 'List',
    coverImgUrl: 'cover.jpg',
    description: 'Description',
    trackCount: 650,
    playCount: 123,
    creator: { userId: 7, nickname: 'Owner' },
    tags: ['rock'],
    privacy: 0,
    subscribed: true,
    commentCount: 5,
    shareCount: 2,
    subscribedCount: 11,
  });
  assert.equal(playlist.trackCount, 650);
  assert.equal(playlist.creatorId, 7);
  assert.equal(playlist.description, 'Description');
  assert.deepEqual(playlist.tags, ['rock']);
  assert.equal(playlist.commentCount, 5);
  assert.equal(playlist.subscribedCount, 11);
});

test('groups playlist categories with stable names and hot flags', () => {
  const categories = mapPlaylistCategories({
    categories: { 0: 'Language', 1: 'Style' },
    sub: [
      { name: 'Chinese', category: 0, hot: true },
      { name: 'Rock', category: 1, hot: false },
    ],
  });
  assert.deepEqual(categories, [
    { id: '0', name: 'Language', items: [{ name: 'Chinese', hot: true, activity: false }] },
    { id: '1', name: 'Style', items: [{ name: 'Rock', hot: false, activity: false }] },
  ]);
});

test('validates partial playlist metadata updates and preserves omitted values', () => {
  const current = {
    name: 'Current',
    description: 'Old description',
    tags: ['rock'],
    privacy: 10,
  };
  const result = normalizePlaylistMetadataPatch({
    description: 'New description',
    tags: ['rock', 'study', 'rock'],
    privacy: 0,
  }, current);
  assert.equal(result.ok, true);
  assert.deepEqual(result.metadata, {
    name: 'Current',
    description: 'New description',
    tags: ['rock', 'study'],
    privacy: 0,
  });
  assert.deepEqual(result.changed, {
    name: false,
    description: true,
    tags: true,
    privacy: true,
  });

  assert.equal(normalizePlaylistMetadataPatch({}, current).error, 'NO_METADATA_CHANGES');
  assert.equal(normalizePlaylistMetadataPatch({ name: '' }, current).error, 'INVALID_PLAYLIST_NAME');
  assert.equal(normalizePlaylistMetadataPatch({ tags: ['one', 'two', 'three', 'four'] }, current).error, 'INVALID_PLAYLIST_TAGS');
  assert.equal(normalizePlaylistMetadataPatch({ privacy: 1 }, current).error, 'INVALID_PLAYLIST_PRIVACY');
});
