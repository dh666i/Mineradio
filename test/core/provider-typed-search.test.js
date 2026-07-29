'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const kugou = require('../../kugou-api');
const qishui = require('../../qishui-api');
const spotify = require('../../spotify-api');

test('Kugou typed playlist mapping keeps the public detail id and normalized metadata', () => {
  const item = kugou._test.mapKugouTypedPlaylist({
    specialid: 6409645,
    specialname: '测试歌单',
    imgurl: 'http://example.test/{size}/cover.jpg',
    songcount: 154,
    playcount: 30086587,
    nickname: '创建者',
    suid: 123,
    intro: '说明',
  });

  assert.equal(item.provider, 'kugou');
  assert.equal(item.source, 'kugou');
  assert.equal(item.type, 'playlist');
  assert.equal(item.id, '6409645');
  assert.equal(item.name, '测试歌单');
  assert.equal(item.cover, 'http://example.test/240/cover.jpg');
  assert.equal(item.trackCount, 154);
  assert.equal(item.playCount, 30086587);
  assert.equal(item.creatorId, '123');
});

test('Qishui typed playlist extraction produces detail-ready provider records', () => {
  const items = qishui._test.extractQishuiPlaylistCards({
    data: {
      result_groups: [{
        type: 'playlist',
        data: [{
          playlist: {
            playlist_id: 'qishui-playlist-1',
            title: '汽水测试歌单',
            track_count: 12,
            cover_url: 'https://example.test/qishui.jpg',
            owner_name: '汽水用户',
          },
        }],
      }],
    },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].provider, 'qishui');
  assert.equal(items[0].source, 'qishui');
  assert.equal(items[0].type, 'playlist');
  assert.equal(items[0].id, 'qishui-playlist-1');
  assert.equal(items[0].trackCount, 12);
});

test('Spotify typed album and playlist mapping keeps ids required by detail routes', () => {
  const album = spotify._test.mapSpotifyAlbum({
    id: 'spotify-album-1',
    name: 'Spotify Album',
    album_type: 'album',
    release_date: '2025-06-01',
    total_tracks: 9,
    uri: 'spotify:album:spotify-album-1',
    images: [{ url: 'https://example.test/album.jpg', width: 640 }],
    artists: [{ id: 'spotify-artist-1', name: 'Artist', uri: 'spotify:artist:spotify-artist-1' }],
  });
  const playlist = spotify._test.mapSpotifyPlaylist({
    id: 'spotify-playlist-1',
    name: 'Spotify Playlist',
    uri: 'spotify:playlist:spotify-playlist-1',
    owner: { id: 'spotify-user-1', display_name: 'Owner' },
    tracks: { total: 20 },
    images: [{ url: 'https://example.test/playlist.jpg', width: 640 }],
  }, { id: 'spotify-user-1' });

  assert.equal(album.provider, 'spotify');
  assert.equal(album.source, 'spotify');
  assert.equal(album.type, 'album');
  assert.equal(album.albumId, 'spotify-album-1');
  assert.equal(album.songCount, 9);
  assert.equal(playlist.provider, 'spotify');
  assert.equal(playlist.source, 'spotify');
  assert.equal(playlist.type, 'playlist');
  assert.equal(playlist.id, 'spotify-playlist-1');
  assert.equal(playlist.shelfPane, 'mine');
});
