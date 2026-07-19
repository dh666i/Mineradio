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
