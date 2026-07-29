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

async function getJson(baseUrl, pathname) {
  const response = await fetch(baseUrl + pathname);
  return { response, body: await response.json() };
}

function readTrace(traceFile) {
  if (!fs.existsSync(traceFile)) return [];
  return fs.readFileSync(traceFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test('artist detail endpoints expose stable pagination and preserve public retry behavior', { timeout: 20000 }, async t => {
  const appPort = await unusedPort();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-artist-pagination-'));
  const cookieFile = path.join(workDir, '.cookie');
  const hookFile = path.join(workDir, 'artist-pagination-hook.js');
  const traceFile = path.join(workDir, 'trace.jsonl');
  fs.writeFileSync(cookieFile, 'MUSIC_U=expired-session', 'utf8');
  fs.writeFileSync(hookFile, `
'use strict';
const fs = require('node:fs');
const https = require('node:https');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

function trace(value) {
  fs.appendFileSync(process.env.MINERADIO_ARTIST_TRACE, JSON.stringify(value) + '\\n', 'utf8');
}

function neteaseSong(id, name) {
  return {
    id,
    name,
    ar: [{ id: 501, name: 'Netease Artist' }],
    al: { id: 601, name: 'Netease Album', picUrl: 'netease-cover.jpg' },
    dt: 180000,
  };
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request !== 'NeteaseCloudMusicApi') return loaded;
  return {
    ...loaded,
    artist_detail: async function (options) {
      trace({ type: 'netease-detail', id: String(options.id), cookie: options.cookie || '' });
      if (String(options.id) === '401' && options.cookie) {
        return { status: 200, body: { code: 301, message: '需要登录' } };
      }
      return {
        status: 200,
        body: {
          code: 200,
          artist: {
            id: options.id,
            name: 'Netease Artist',
            picUrl: 'netease-artist.jpg',
            briefDesc: 'Artist bio',
            musicSize: 'not-a-count',
            albumSize: 7,
          },
        },
      };
    },
    artist_songs: async function (options) {
      trace({
        type: 'netease-songs',
        id: String(options.id),
        cookie: options.cookie || '',
        limit: options.limit,
        offset: options.offset,
      });
      if (String(options.id) === 'fallback') {
        return {
          status: 200,
          body: { code: 200, total: 'bad-total', more: true, songs: [] },
        };
      }
      return {
        status: 200,
        body: {
          code: 200,
          total: 'bad-total',
          more: true,
          songs: [
            neteaseSong(1000 + Number(options.offset), 'Offset ' + options.offset),
            neteaseSong(1001 + Number(options.offset), 'Offset ' + options.offset + ' B'),
          ],
        },
      };
    },
    artist_top_song: async function (options) {
      trace({ type: 'netease-top', id: String(options.id), cookie: options.cookie || '' });
      return {
        status: 200,
        body: {
          code: 200,
          songs: [
            neteaseSong(2001, 'Fallback A'),
            neteaseSong(2002, 'Fallback B'),
            neteaseSong(2003, 'Fallback C'),
          ],
        },
      };
    },
  };
};

const originalHttpsRequest = https.request;
https.request = function (target, options, callback) {
  const targetUrl = target instanceof URL ? target : new URL(String(target));
  if (targetUrl.hostname !== 'u.y.qq.com') {
    return originalHttpsRequest.apply(this, arguments);
  }
  const chunks = [];
  const request = new EventEmitter();
  request.setTimeout = function () { return request; };
  request.write = function (chunk) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };
  request.destroy = function (error) {
    if (error) process.nextTick(() => request.emit('error', error));
  };
  request.end = function () {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const params = payload.singer.param;
    trace({
      type: 'qq-songs',
      mid: params.singermid,
      limit: params.num,
      offset: params.sin,
    });
    const responseBody = {
      singer: {
        code: 0,
        data: {
          total_song: 'not-a-count',
          has_more: 1,
          singer_info: {
            mid: params.singermid,
            name: 'QQ Artist',
            songCount: -20,
          },
          total_album: 4,
          total_mv: 2,
          songlist: [
            {
              id: 3001,
              mid: 'qq-song-' + params.sin,
              name: 'QQ Offset ' + params.sin,
              singer: [{ id: 701, mid: params.singermid, name: 'QQ Artist' }],
              album: { id: 801, mid: 'qq-album', name: 'QQ Album' },
              interval: 200,
            },
            {
              id: 3002,
              mid: 'qq-song-' + (params.sin + 1),
              name: 'QQ Offset ' + (params.sin + 1),
              singer: [{ id: 701, mid: params.singermid, name: 'QQ Artist' }],
              album: { id: 801, mid: 'qq-album', name: 'QQ Album' },
              interval: 201,
            },
          ],
        },
      },
    };
    const response = Readable.from([Buffer.from(JSON.stringify(responseBody))]);
    response.statusCode = 200;
    process.nextTick(() => callback(response));
  };
  return request;
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
      MINERADIO_ARTIST_TRACE: traceFile,
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

  const invalidNetease = await getJson(baseUrl, '/api/artist/detail?limit=2&offset=-5');
  assert.equal(invalidNetease.response.status, 400);
  assert.equal(invalidNetease.body.limit, 10);
  assert.equal(invalidNetease.body.offset, 0);
  assert.equal(invalidNetease.body.nextOffset, 0);
  assert.equal(invalidNetease.body.hasMore, false);

  const invalidQQ = await getJson(baseUrl, '/api/qq/artist/detail?limit=999&offset=-5');
  assert.equal(invalidQQ.response.status, 400);
  assert.equal(invalidQQ.body.limit, 80);
  assert.equal(invalidQQ.body.offset, 0);
  assert.equal(invalidQQ.body.nextOffset, 0);
  assert.equal(invalidQQ.body.hasMore, false);

  const netease = await getJson(baseUrl, '/api/artist/detail?id=401&limit=5&offset=7');
  assert.equal(netease.response.status, 200);
  assert.equal(netease.body.authExpired, true);
  assert.equal(netease.body.offset, 7);
  assert.equal(netease.body.limit, 10);
  assert.equal(netease.body.nextOffset, 17);
  assert.equal(netease.body.hasMore, true);
  assert.equal(netease.body.songs.length, 2);
  assert.equal(netease.body.songs[0].name, 'Offset 7');
  assert.equal(Number.isFinite(netease.body.total), true);
  assert.equal(netease.body.total >= netease.body.offset + netease.body.songs.length, true);
  assert.equal(fs.existsSync(cookieFile), false);

  const fallback = await getJson(baseUrl, '/api/artist/detail?id=fallback&limit=12&offset=0');
  assert.equal(fallback.response.status, 200);
  assert.equal(fallback.body.songs.length, 3);
  assert.equal(fallback.body.total, 3);
  assert.equal(fallback.body.offset, 0);
  assert.equal(fallback.body.limit, 12);
  assert.equal(fallback.body.nextOffset, 3);
  assert.equal(fallback.body.hasMore, false);

  const laterEmpty = await getJson(baseUrl, '/api/artist/detail?id=fallback&limit=12&offset=12');
  assert.equal(laterEmpty.response.status, 200);
  assert.deepEqual(laterEmpty.body.songs, []);
  assert.equal(laterEmpty.body.offset, 12);
  assert.equal(laterEmpty.body.nextOffset, 12);
  assert.equal(laterEmpty.body.hasMore, false);

  const qq = await getJson(baseUrl, '/api/qq/artist/detail?mid=qq-mid&limit=7&offset=23');
  assert.equal(qq.response.status, 200);
  assert.equal(qq.body.provider, 'qq');
  assert.equal(qq.body.offset, 23);
  assert.equal(qq.body.limit, 10);
  assert.equal(qq.body.nextOffset, 33);
  assert.equal(qq.body.hasMore, true);
  assert.equal(qq.body.songs.length, 2);
  assert.equal(qq.body.songs[0].name, 'QQ Offset 23');
  assert.equal(Number.isFinite(qq.body.total), true);
  assert.equal(qq.body.artist.musicSize, qq.body.total);

  const trace = readTrace(traceFile);
  const detailCalls = trace.filter(entry => entry.type === 'netease-detail' && entry.id === '401');
  assert.equal(detailCalls.length, 2);
  assert.notEqual(detailCalls[0].cookie, '');
  assert.equal(detailCalls[1].cookie, '');
  assert.deepEqual(
    trace.filter(entry => entry.type === 'netease-songs' && entry.id === '401')
      .map(entry => ({ limit: entry.limit, offset: entry.offset, cookie: entry.cookie })),
    [{ limit: 10, offset: 7, cookie: '' }],
  );
  assert.equal(trace.filter(entry => entry.type === 'netease-top' && entry.id === 'fallback').length, 1);
  assert.deepEqual(
    trace.filter(entry => entry.type === 'qq-songs')
      .map(entry => ({ mid: entry.mid, limit: entry.limit, offset: entry.offset })),
    [{ mid: 'qq-mid', limit: 10, offset: 23 }],
  );
});
