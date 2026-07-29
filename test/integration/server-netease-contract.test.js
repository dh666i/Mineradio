'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Mineradio server exited early: ${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Mineradio server: ${output.join('')}`);
}

async function getJson(baseUrl, pathname, options) {
  const response = await fetch(baseUrl + pathname, options);
  return { response, body: await response.json() };
}

test('Netease routes expose stable validation and logged-out contracts', { timeout: 20000 }, async t => {
  const appPort = await unusedPort();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-netease-contract-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const output = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: '127.0.0.1',
      COOKIE_FILE: path.join(workDir, '.cookie'),
      QQ_COOKIE_FILE: path.join(workDir, '.qq-cookie'),
      MINERADIO_UPDATE_DIR: path.join(workDir, 'updates'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  t.after(() => {
    if (child.exitCode == null) child.kill();
  });

  const baseUrl = `http://127.0.0.1:${appPort}`;
  await waitForServer(`${baseUrl}/api/app/version`, child, output);

  const invalidSearch = await getJson(baseUrl, '/api/search/typed?keywords=test&type=song');
  assert.equal(invalidSearch.response.status, 400);
  assert.equal(invalidSearch.body.error, 'INVALID_SEARCH_TYPE');
  assert.deepEqual(invalidSearch.body.items, []);
  assert.deepEqual(invalidSearch.body.artists, []);
  assert.deepEqual(invalidSearch.body.albums, []);
  assert.deepEqual(invalidSearch.body.playlists, []);
  assert.equal(invalidSearch.body.hasMore, false);

  const emptySongSearch = await getJson(baseUrl, '/api/search?keywords=&limit=999&offset=-1');
  assert.equal(emptySongSearch.response.status, 400);
  assert.equal(emptySongSearch.body.error, 'MISSING_KEYWORDS');
  assert.equal(emptySongSearch.body.type, 'song');
  assert.equal(emptySongSearch.body.limit, 50);
  assert.equal(emptySongSearch.body.offset, 0);
  assert.equal(emptySongSearch.body.nextOffset, 0);
  assert.deepEqual(emptySongSearch.body.items, []);
  assert.deepEqual(emptySongSearch.body.songs, []);

  const emptyArtistSearch = await getJson(baseUrl, '/api/search/typed?keywords=&type=artist');
  assert.equal(emptyArtistSearch.response.status, 400);
  assert.equal(emptyArtistSearch.body.error, 'MISSING_KEYWORDS');
  assert.equal(emptyArtistSearch.body.type, 'artist');
  assert.deepEqual(emptyArtistSearch.body.artists, []);

  const invalidSearchMethod = await getJson(baseUrl, '/api/search/typed?keywords=test&type=album', {
    method: 'POST',
  });
  assert.equal(invalidSearchMethod.response.status, 405);
  assert.equal(invalidSearchMethod.body.error, 'METHOD_NOT_ALLOWED');
  assert.deepEqual(invalidSearchMethod.body.albums, []);

  const invalidDiscover = await getJson(baseUrl, '/api/discover/netease?section=unknown');
  assert.equal(invalidDiscover.response.status, 400);
  assert.equal(invalidDiscover.body.error, 'INVALID_DISCOVER_SECTION');

  const invalidPlaylist = await getJson(baseUrl, '/api/playlist/tracks?id=bad&limit=999&offset=-1');
  assert.equal(invalidPlaylist.response.status, 400);
  assert.equal(invalidPlaylist.body.error, 'INVALID_PLAYLIST_ID');
  assert.equal(invalidPlaylist.body.limit, 500);
  assert.equal(invalidPlaylist.body.offset, 0);

  const playlists = await getJson(baseUrl, '/api/user/playlists?limit=999&offset=-1');
  assert.equal(playlists.response.status, 401);
  assert.equal(playlists.body.error, 'LOGIN_REQUIRED');
  assert.equal(playlists.body.loggedIn, false);
  assert.equal(playlists.body.limit, 200);
  assert.equal(playlists.body.offset, 0);
  assert.deepEqual(playlists.body.playlists, []);

  const protectedSections = {
    recent: 'songs',
    cloud: 'songs',
    'favorite-albums': 'albums',
    'followed-artists': 'artists',
    'listening-rank': 'songs',
  };
  for (const [section, listKey] of Object.entries(protectedSections)) {
    const result = await getJson(baseUrl, `/api/discover/netease?section=${section}&limit=10`);
    assert.equal(result.response.status, 401, section);
    assert.equal(result.body.error, 'LOGIN_REQUIRED', section);
    assert.equal(result.body.loggedIn, false, section);
    assert.deepEqual(result.body.items, [], section);
    assert.deepEqual(result.body[listKey], [], section);
    assert.equal(result.body.limit, 10, section);
    assert.equal(result.body.offset, 0, section);
    assert.equal(result.body.hasMore, false, section);
  }

  const mutationHeaders = {
    'Content-Type': 'application/json',
    'X-Mineradio-Request': '1',
  };
  const update = await getJson(baseUrl, '/api/playlist/update-meta', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ pid: '1', name: 'Test' }),
  });
  assert.equal(update.response.status, 401);
  assert.equal(update.body.error, 'LOGIN_REQUIRED');

  const subscribe = await getJson(baseUrl, '/api/playlist/subscribe', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ pid: '1', subscribe: true }),
  });
  assert.equal(subscribe.response.status, 401);
  assert.equal(subscribe.body.error, 'LOGIN_REQUIRED');

  const untrustedSubscribe = await getJson(baseUrl, '/api/playlist/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: '1', subscribe: true }),
  });
  assert.equal(untrustedSubscribe.response.status, 403);
  assert.equal(untrustedSubscribe.body.error, 'UNTRUSTED_MUTATION_REQUEST');
});

test('Netease search maps all entity types and recovers from an expired public cookie', { timeout: 20000 }, async t => {
  const appPort = await unusedPort();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-netease-search-'));
  const cookieFile = path.join(workDir, '.cookie');
  const hookFile = path.join(workDir, 'netease-search-hook.js');
  fs.writeFileSync(cookieFile, 'MUSIC_U=expired-session', 'utf8');
  fs.writeFileSync(hookFile, `
'use strict';
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request !== 'NeteaseCloudMusicApi') return loaded;
  return {
    ...loaded,
    cloudsearch: async function (options) {
      const keywords = String(options && options.keywords || '');
      if (keywords === 'expired-cookie' && options && options.cookie) {
        return { status: 200, body: { code: 301, message: '需要登录' } };
      }
      if (keywords === 'upstream-failure') {
        const error = new Error('stub upstream unavailable');
        error.status = 503;
        error.body = { code: 503, message: 'stub upstream unavailable' };
        throw error;
      }
      const type = Number(options && options.type || 1);
      const result = type === 100
        ? { artistCount: 1, artists: [{ id: 11, name: 'Artist', picUrl: 'artist.jpg' }] }
        : (type === 10
          ? { albumCount: 1, albums: [{ id: 12, name: 'Album', picUrl: 'album.jpg', artist: { id: 11, name: 'Artist' } }] }
          : (type === 1000
            ? { playlistCount: keywords === 'empty-result' ? 0 : 1, playlists: keywords === 'empty-result' ? [] : [{ id: 13, name: 'Playlist', coverImgUrl: 'playlist.jpg' }] }
            : { songCount: 1, songs: [{ id: 10, name: 'Song', ar: [{ id: 11, name: 'Artist' }], al: { id: 12, name: 'Album', picUrl: 'song.jpg' } }] }));
      return { status: 200, body: { code: 200, result } };
    },
  };
};
`, 'utf8');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const output = [];
  const child = spawn(process.execPath, ['--require', hookFile, 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: '127.0.0.1',
      COOKIE_FILE: cookieFile,
      QQ_COOKIE_FILE: path.join(workDir, '.qq-cookie'),
      MINERADIO_ALLOW_PLAINTEXT_COOKIE: '1',
      MINERADIO_UPDATE_DIR: path.join(workDir, 'updates'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  t.after(() => {
    if (child.exitCode == null) child.kill();
  });

  const baseUrl = `http://127.0.0.1:${appPort}`;
  await waitForServer(`${baseUrl}/api/app/version`, child, output);

  const song = await getJson(baseUrl, '/api/search?keywords=expired-cookie&limit=1');
  assert.equal(song.response.status, 200);
  assert.equal(song.body.ok, true);
  assert.equal(song.body.type, 'song');
  assert.equal(song.body.authExpired, true);
  assert.equal(song.body.loggedIn, false);
  assert.equal(song.body.songs.length, 1);
  assert.deepEqual(song.body.items, song.body.songs);
  assert.equal(fs.existsSync(cookieFile), false);

  const entityCases = [
    ['artist', 'artists', 11],
    ['album', 'albums', 12],
    ['playlist', 'playlists', 13],
  ];
  for (const [type, listKey, expectedId] of entityCases) {
    const result = await getJson(baseUrl, `/api/search/typed?keywords=result&type=${type}&limit=1`);
    assert.equal(result.response.status, 200, type);
    assert.equal(result.body.ok, true, type);
    assert.equal(result.body.type, type, type);
    assert.equal(result.body.items.length, 1, type);
    assert.equal(result.body[listKey][0].id, expectedId, type);
    assert.equal(result.body.empty, false, type);
  }

  const empty = await getJson(baseUrl, '/api/search/typed?keywords=empty-result&type=playlist');
  assert.equal(empty.response.status, 200);
  assert.equal(empty.body.ok, true);
  assert.equal(empty.body.empty, true);
  assert.equal(empty.body.hasMore, false);
  assert.deepEqual(empty.body.items, []);
  assert.deepEqual(empty.body.playlists, []);

  const failure = await getJson(baseUrl, '/api/search?keywords=upstream-failure');
  assert.equal(failure.response.status, 502);
  assert.equal(failure.body.ok, false);
  assert.equal(failure.body.error, 'SEARCH_FAILED');
  assert.equal(failure.body.message, 'stub upstream unavailable');
  assert.deepEqual(failure.body.items, []);
  assert.deepEqual(failure.body.songs, []);
});
