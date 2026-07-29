'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
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

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Server exited early: ${output.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/app/version`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server start timed out: ${output.join('')}`);
}

async function getJson(baseUrl, pathname, options) {
  const response = await fetch(baseUrl + pathname, options);
  return { response, body: await response.json() };
}

test('typed search dispatches normalized detail-ready entities across providers', { timeout: 20000 }, async t => {
  const port = await unusedPort();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-provider-typed-search-'));
  const qqCookieFile = path.join(workDir, '.qq-cookie');
  const hookFile = path.join(workDir, 'provider-search-hook.js');
  fs.writeFileSync(qqCookieFile, 'uin=o12345; qqmusic_key=test-key', 'utf8');
  fs.writeFileSync(hookFile, `
'use strict';
const Module = require('node:module');
const EventEmitter = require('node:events');
const PassThrough = require('node:stream').PassThrough;
const https = require('node:https');
const realHttpsRequest = https.request;
https.request = function (target, options, callback) {
  const href = typeof target === 'string' ? target : String(target && (target.href || target.toString()) || '');
  if (!/c\\.y\\.qq\\.com\\/(?:splcloud\\/fcgi-bin\\/smartbox_new\\.fcg|soso\\/fcgi-bin\\/client_music_search_songlist)/.test(href)) {
    return realHttpsRequest.apply(this, arguments);
  }
  const request = new EventEmitter();
  request.setTimeout = function () { return request; };
  request.write = function () { return true; };
  request.destroy = function (error) {
    if (error) process.nextTick(function () { request.emit('error', error); });
  };
  request.end = function () {
    process.nextTick(function () {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = {};
      callback(response);
      const payload = href.includes('smartbox_new.fcg')
        ? {
          data: {
            singer: {
              count: 1,
              itemlist: [{
                id: '101',
                mid: 'qq-artist-mid',
                name: 'QQ Artist',
                pic: 'https://example.test/qq-artist.jpg'
              }]
            }
          }
        }
        : {
          code: 0,
          data: {
            sum: 1,
            list: [{
              dissid: 'qq-playlist-1',
              dissname: 'QQ&#32;Playlist',
              imgurl: 'https://example.test/qq-playlist.jpg',
              introduction: 'QQ&#32;Description',
              song_count: 30,
              listennum: 99,
              creator: { name: 'QQ Owner', creator_uin: '12345' }
            }]
          }
        };
      response.end(JSON.stringify(payload));
    });
  };
  return request;
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request === '../kugou-api' && parent && /provider-routes\\.js$/.test(parent.filename)) {
    return Object.assign({}, loaded, {
      handleKugouTypedSearch: async function (keywords, type, limit, cookie, offset) {
        if (keywords === 'auth') return {
          provider: 'kugou', source: 'kugou', type,
          items: [], total: 0, rawCount: 0, nextOffset: offset, hasMore: false,
          error: 'KUGOU_AUTH_REQUIRED', requiresLogin: true, loggedIn: false
        };
        return {
          provider: 'kugou', source: 'kugou', type,
          items: [{ provider: 'kugou', source: 'kugou', type: 'playlist', id: 'kg-1', name: 'KG Playlist' }],
          total: 2, rawCount: 1, nextOffset: offset + 1, hasMore: true, loggedIn: true
        };
      }
    });
  }
  if (request === '../qishui-api' && parent && /provider-routes\\.js$/.test(parent.filename)) {
    return Object.assign({}, loaded, {
      handleQishuiTypedSearch: async function (keywords, type, limit, cookie, offset) {
        if (keywords === 'auth') return {
          provider: 'qishui', source: 'qishui', type,
          items: [], total: 0, rawCount: 0, nextOffset: offset, hasMore: false,
          error: 'QISHUI_AUTH_REQUIRED', requiresLogin: true, loggedIn: false, webSession: false
        };
        return {
          provider: 'qishui', source: 'qishui', type,
          items: [{ provider: 'qishui', source: 'qishui', type: 'playlist', id: 'qs-1', name: 'QS Playlist' }],
          total: 1, rawCount: 1, nextOffset: offset + 1, hasMore: false, loggedIn: true, webSession: true
        };
      }
    });
  }
  if (request === '../spotify-api' && parent && /provider-routes\\.js$/.test(parent.filename)) {
    return Object.assign({}, loaded, {
      handleSpotifyTypedSearch: async function (keywords, type, limit, offset) {
        if (keywords === 'auth') return {
          provider: 'spotify', source: 'spotify', type,
          items: [], total: 0, rawCount: 0, nextOffset: offset, hasMore: false,
          error: 'SPOTIFY_AUTH_REQUIRED', requiresLogin: true, loggedIn: false
        };
        const item = type === 'album'
          ? { provider: 'spotify', source: 'spotify', type: 'album', id: 'sp-album-1', albumId: 'sp-album-1', name: 'SP Album' }
          : { provider: 'spotify', source: 'spotify', type: 'playlist', id: 'sp-playlist-1', name: 'SP Playlist' };
        return {
          provider: 'spotify', source: 'spotify', type,
          items: [item], total: 1, rawCount: 1, nextOffset: offset + 1, hasMore: false, loggedIn: true
        };
      }
    });
  }
  return loaded;
};
`, 'utf8');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const output = [];
  const child = spawn(process.execPath, ['--require', hookFile, 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COOKIE_FILE: path.join(workDir, '.cookie'),
      QQ_COOKIE_FILE: qqCookieFile,
      KUGOU_COOKIE_FILE: path.join(workDir, '.kugou-cookie'),
      QISHUI_COOKIE_FILE: path.join(workDir, '.qishui-cookie'),
      QISHUI_TOKEN_FILE: path.join(workDir, '.qishui-token'),
      SPOTIFY_TOKEN_FILE: path.join(workDir, '.spotify-token.json'),
      SPOTIFY_CONFIG_FILE: path.join(workDir, '.spotify-credentials.json'),
      SPOTIFY_CLIENT_ID: '',
      SPOTIFY_CLIENT_SECRET: '',
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

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, output);

  const cases = [
    ['source=qq&type=artist', 'artists', 'qq', 'qq-artist-mid'],
    ['provider=qq&type=playlist', 'playlists', 'qq', 'qq-playlist-1'],
    ['provider=kugou&type=playlist', 'playlists', 'kugou', 'kg-1'],
    ['provider=qishui&type=playlist', 'playlists', 'qishui', 'qs-1'],
    ['provider=spotify&type=album', 'albums', 'spotify', 'sp-album-1'],
    ['provider=spotify&type=playlist', 'playlists', 'spotify', 'sp-playlist-1'],
  ];
  for (const [query, listKey, provider, expectedId] of cases) {
    const result = await getJson(baseUrl, `/api/search/typed?keywords=result&limit=1&offset=0&${query}`);
    assert.equal(result.response.status, 200, query);
    assert.equal(result.body.ok, true, query);
    assert.equal(result.body.provider, provider, query);
    assert.equal(result.body.source, provider, query);
    assert.equal(result.body.items.length, 1, query);
    assert.equal(result.body[listKey][0].id, expectedId, query);
    assert.equal(result.body.items[0].provider, provider, query);
    assert.equal(result.body.items[0].source, provider, query);
    assert.equal(result.body.empty, false, query);
  }

  const unsupported = await getJson(baseUrl, '/api/search/typed?keywords=result&provider=qq&type=album');
  assert.equal(unsupported.response.status, 400);
  assert.equal(unsupported.body.error, 'SEARCH_TYPE_UNSUPPORTED');
  assert.deepEqual(unsupported.body.supportedTypes, ['artist', 'playlist']);
  assert.deepEqual(unsupported.body.items, []);

  const invalidProvider = await getJson(baseUrl, '/api/search/typed?keywords=result&provider=unknown&type=playlist');
  assert.equal(invalidProvider.response.status, 400);
  assert.equal(invalidProvider.body.error, 'INVALID_SEARCH_PROVIDER');
  assert.deepEqual(invalidProvider.body.items, []);

  const logout = await getJson(baseUrl, '/api/qq/logout', {
    method: 'POST',
    headers: { 'X-Mineradio-Request': '1' },
  });
  assert.equal(logout.response.status, 200);
  const qqAuth = await getJson(baseUrl, '/api/search/typed?keywords=auth&provider=qq&type=playlist');
  assert.equal(qqAuth.response.status, 401);
  assert.equal(qqAuth.body.error, 'QQ_LOGIN_REQUIRED');
  assert.equal(qqAuth.body.requiresLogin, true);

  for (const provider of ['kugou', 'qishui', 'spotify']) {
    const auth = await getJson(baseUrl, `/api/search/typed?keywords=auth&provider=${provider}&type=${provider === 'spotify' ? 'album' : 'playlist'}`);
    assert.equal(auth.response.status, 401, provider);
    assert.equal(auth.body.ok, false, provider);
    assert.equal(auth.body.requiresLogin, true, provider);
    assert.deepEqual(auth.body.items, [], provider);
  }
});
