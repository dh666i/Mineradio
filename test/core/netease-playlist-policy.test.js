'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getPlaylistEditRestriction,
  normalizeNeteaseId,
} = require('../../lib/netease-playlist-policy');

test('normalizes only positive safe Netease ids', () => {
  assert.equal(normalizeNeteaseId(' 123 '), '123');
  assert.equal(normalizeNeteaseId('0'), '');
  assert.equal(normalizeNeteaseId('1.5'), '');
  assert.equal(normalizeNeteaseId('9007199254740992'), '');
});

test('allows editing only normal playlists created by the current user', () => {
  const playlist = {
    id: 42,
    creator: { userId: 7 },
    subscribed: false,
    specialType: 0,
  };
  assert.equal(getPlaylistEditRestriction(playlist, 7), '');
  assert.equal(getPlaylistEditRestriction({ ...playlist, creator: { userId: 8 } }, 7), 'PLAYLIST_NOT_OWNED');
  assert.equal(getPlaylistEditRestriction({ ...playlist, subscribed: true }, 7), 'PLAYLIST_NOT_OWNED');
  assert.equal(getPlaylistEditRestriction({ ...playlist, specialType: 5 }, 7), 'PLAYLIST_SPECIAL_READ_ONLY');
});
