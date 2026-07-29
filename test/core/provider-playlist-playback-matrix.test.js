'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const ui = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const spotify = fs.readFileSync(path.join(root, 'spotify-api.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = ui.indexOf(startMarker);
  const end = ui.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return ui.slice(start, end);
}

function createProviderRoutingRuntime() {
  const providerKey = sourceBetween(
    'function songProviderKey',
    'function songSourceTagHtml',
  );
  const playback = sourceBetween(
    'function providerPlaybackUrlEndpoint',
    'function fetchProviderPlaybackData',
  );
  const playlists = sourceBetween(
    'function playlistTracksEndpoint',
    'function parseProviderPlaylistId',
  );
  const fallback = sourceBetween(
    'function alternatePlaybackProviders',
    'function alternatePlaybackProvider',
  );
  const sandbox = {
    encodeURIComponent,
    sourceFallbackProviderReady() {
      return true;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${providerKey}\n${playback}\n${playlists}\n${fallback}\n` +
      'this.routes = { songProviderKey, providerPlaybackUrlEndpoint, playlistTracksEndpoint, alternatePlaybackProviders };',
    sandbox,
  );
  return sandbox.routes;
}

test('five providers route songs and playlists through their desktop API endpoints', () => {
  const routes = createProviderRoutingRuntime();
  const songs = {
    netease: { provider: 'netease', id: '1' },
    qq: { provider: 'qq', mid: 'qq-mid', mediaMid: 'qq-media' },
    kugou: { provider: 'kugou', hash: 'kg-hash', albumAudioId: 'kg-audio' },
    qishui: { provider: 'qishui', providerSongId: 'qs-track' },
    spotify: { provider: 'spotify', spotifyId: 'sp-track', spotifyUri: 'spotify:track:sp-track' },
  };

  assert.match(routes.providerPlaybackUrlEndpoint(songs.netease, 'standard'), /^\/api\/song\/url\?/);
  assert.match(routes.providerPlaybackUrlEndpoint(songs.qq, 'standard'), /^\/api\/qq\/song\/url\?/);
  assert.match(routes.providerPlaybackUrlEndpoint(songs.kugou, 'standard'), /^\/api\/kugou\/song\/url\?/);
  assert.match(routes.providerPlaybackUrlEndpoint(songs.qishui, 'standard'), /^\/api\/qishui\/song\/url\?/);
  assert.match(routes.providerPlaybackUrlEndpoint(songs.spotify, 'standard'), /^\/api\/spotify\/song\/url\?/);

  assert.equal(routes.playlistTracksEndpoint('netease', '1'), '/api/playlist/tracks?id=1');
  assert.equal(routes.playlistTracksEndpoint('qq', '2'), '/api/qq/playlist/tracks?id=2');
  assert.equal(routes.playlistTracksEndpoint('kugou', '3'), '/api/kugou/playlist/tracks?id=3');
  assert.equal(routes.playlistTracksEndpoint('qishui', '4'), '/api/qishui/playlist/tracks?id=4');
  assert.equal(routes.playlistTracksEndpoint('spotify', '5'), '/api/spotify/playlist/tracks?id=5');
});

test('Spotify metadata playback enters the bounded cross-provider fallback path', () => {
  const routes = createProviderRoutingRuntime();
  assert.deepEqual(
    Array.from(routes.alternatePlaybackProviders({ provider: 'spotify', spotifyId: 'sp-track' })),
    ['netease', 'qq', 'kugou', 'qishui'],
  );
  assert.match(
    spotify,
    /async function handleSpotifySongUrl\(track\)[\s\S]*?url: '',[\s\S]*?playbackMode: 'recommend-match'[\s\S]*?action: 'switch_source'/,
  );
  assert.match(
    ui,
    /if \(!data\.url\)[\s\S]*?tryAutoPlaybackFallback\(song, data, idx, token/,
  );
});
