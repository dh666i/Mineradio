'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
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

async function requestJson(baseUrl, pathname, options) {
  const response = await fetch(baseUrl + pathname, options);
  return { response, body: await response.json() };
}

test('auxiliary providers expose logged-out contracts and protect mutations', { timeout: 20000 }, async t => {
  const port = await unusedPort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-providers-'));
  const output = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COOKIE_FILE: path.join(userData, '.cookie'),
      QQ_COOKIE_FILE: path.join(userData, '.qq-cookie'),
      KUGOU_COOKIE_FILE: path.join(userData, '.kugou-cookie'),
      QISHUI_COOKIE_FILE: path.join(userData, '.qishui-cookie'),
      QISHUI_TOKEN_FILE: path.join(userData, '.qishui-token'),
      SPOTIFY_TOKEN_FILE: path.join(userData, '.spotify-token.json'),
      SPOTIFY_CONFIG_FILE: path.join(userData, '.spotify-credentials.json'),
      MINERADIO_UPDATE_DIR: path.join(userData, 'updates'),
      MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS: '',
      MINERADIO_ALLOW_PLAINTEXT_COOKIE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  t.after(() => {
    if (child.exitCode == null) child.kill();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, output);

  const spotify = await requestJson(baseUrl, '/api/spotify/status');
  assert.equal(spotify.response.status, 200);
  assert.equal(spotify.body.provider, 'spotify');
  assert.equal(spotify.body.loggedIn, false);
  assert.equal(Object.hasOwn(spotify.body, 'tokenFile'), false);
  assert.equal(Object.hasOwn(spotify.body, 'credentialsFile'), false);

  const qishui = await requestJson(baseUrl, '/api/qishui/status');
  assert.equal(qishui.response.status, 200);
  assert.equal(qishui.body.provider, 'qishui');
  assert.equal(qishui.body.loggedIn, false);
  assert.equal(Object.hasOwn(qishui.body, 'token'), false);
  assert.equal(Object.hasOwn(qishui.body, 'cookie'), false);

  const kugou = await requestJson(baseUrl, '/api/kugou/login/status');
  assert.equal(kugou.response.status, 200);
  assert.equal(kugou.body.provider, 'kugou');
  assert.equal(kugou.body.loggedIn, false);
  assert.equal(Object.hasOwn(kugou.body, 'cookie'), false);

  const getLogin = await requestJson(baseUrl, '/api/kugou/login/cookie');
  assert.equal(getLogin.response.status, 405);
  assert.equal(getLogin.body.error, 'METHOD_NOT_ALLOWED');

  const untrustedLogin = await requestJson(baseUrl, '/api/kugou/login/cookie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie: 'KugooID=1; token=fake' }),
  });
  assert.equal(untrustedLogin.response.status, 403);
  assert.equal(untrustedLogin.body.error, 'UNTRUSTED_MUTATION_REQUEST');

  const untrustedSpotifyConfig = await requestJson(baseUrl, '/api/spotify/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'fake-client-id' }),
  });
  assert.equal(untrustedSpotifyConfig.response.status, 403);
  assert.equal(untrustedSpotifyConfig.body.error, 'UNTRUSTED_MUTATION_REQUEST');

  const trustedHeaders = {
    'Content-Type': 'application/json',
    'X-Mineradio-Request': '1',
  };
  const failedNeteaseLogin = await requestJson(baseUrl, '/api/login/cookie', {
    method: 'POST',
    headers: trustedHeaders,
    body: JSON.stringify({ cookie: 'MUSIC_U=test' }),
  });
  assert.equal(failedNeteaseLogin.response.status, 503);
  assert.equal(failedNeteaseLogin.body.ok, false);
  assert.equal(failedNeteaseLogin.body.loggedIn, false);
  assert.equal(failedNeteaseLogin.body.sessionPersisted, false);
  assert.equal(failedNeteaseLogin.body.error, 'LOGIN_SESSION_PERSIST_FAILED');

  const failedQQLogin = await requestJson(baseUrl, '/api/qq/login/cookie', {
    method: 'POST',
    headers: trustedHeaders,
    body: JSON.stringify({ cookie: 'uin=o12345; qm_keyst=fake' }),
  });
  assert.equal(failedQQLogin.response.status, 503);
  assert.equal(failedQQLogin.body.ok, false);
  assert.equal(failedQQLogin.body.loggedIn, false);
  assert.equal(failedQQLogin.body.sessionPersisted, false);
  assert.equal(failedQQLogin.body.error, 'LOGIN_SESSION_PERSIST_FAILED');

  assert.equal(fs.existsSync(path.join(userData, '.cookie')), false);
  assert.equal(fs.existsSync(path.join(userData, '.qq-cookie')), false);

  const neteaseAfterFailure = await requestJson(baseUrl, '/api/login/status');
  assert.equal(neteaseAfterFailure.body.loggedIn, false);
  const qqAfterFailure = await requestJson(baseUrl, '/api/qq/login/status');
  assert.equal(qqAfterFailure.body.loggedIn, false);
});
