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

test('YouTube routes expose stable unconfigured and mutation contracts', { timeout: 20000 }, async t => {
  const appPort = await unusedPort();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-youtube-contract-'));
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
      YOUTUBE_API_KEY_FILE: path.join(workDir, '.youtube-api-key'),
      YOUTUBE_OAUTH_CLIENT_FILE: path.join(workDir, '.youtube-oauth-client'),
      YOUTUBE_OAUTH_TOKEN_FILE: path.join(workDir, '.youtube-oauth-token'),
      YOUTUBE_OAUTH_BUNDLED_CLIENT_FILE: path.join(workDir, 'missing-bundled-oauth-client.json'),
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

  const config = await getJson(baseUrl, '/api/youtube/config');
  assert.equal(config.response.status, 200);
  assert.equal(config.body.ok, true);
  assert.equal(config.body.provider, 'youtube');
  assert.equal(config.body.configured, false);
  assert.equal(config.body.secureStorageAvailable, false);

  const oauthStatus = await getJson(baseUrl, '/api/youtube/oauth/status');
  assert.equal(oauthStatus.response.status, 200);
  assert.equal(oauthStatus.body.ok, true);
  assert.equal(oauthStatus.body.provider, 'youtube');
  assert.equal(oauthStatus.body.clientConfigured, false);
  assert.equal(oauthStatus.body.clientSource, 'none');
  assert.equal(oauthStatus.body.connected, false);
  assert.equal(oauthStatus.body.authorizing, false);
  assert.equal(oauthStatus.body.secureStorageAvailable, false);
  assert.equal(oauthStatus.body.account, null);
  for (const sensitive of ['clientSecret', 'accessToken', 'refreshToken', 'verifier', 'state']) {
    assert.equal(JSON.stringify(oauthStatus.body).includes(sensitive), false, sensitive);
  }

  const search = await getJson(baseUrl, '/api/youtube/search?keywords=test&type=song');
  assert.equal(search.response.status, 401);
  assert.equal(search.body.ok, false);
  assert.equal(search.body.provider, 'youtube');
  assert.equal(search.body.configured, false);
  assert.equal(search.body.error, 'YOUTUBE_OAUTH_LOGIN_REQUIRED');
  assert.equal(search.body.type, 'song');
  assert.equal(search.body.keywords, 'test');
  assert.deepEqual(search.body.items, []);
  assert.deepEqual(search.body.songs, []);
  assert.deepEqual(search.body.playlists, []);
  assert.deepEqual(search.body.artists, []);
  assert.equal(search.body.hasMore, false);

  for (let index = 0; index < 8; index += 1) {
    const unauthenticated = await getJson(
      baseUrl,
      `/api/youtube/search?keywords=unauthenticated-${index}&type=song`,
    );
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.body.error, 'YOUTUBE_OAUTH_LOGIN_REQUIRED');
    assert.equal(unauthenticated.response.headers.get('retry-after'), null);
  }

  const missingKeywords = await getJson(baseUrl, '/api/youtube/search?keywords=%20&type=song');
  assert.equal(missingKeywords.response.status, 400);
  assert.equal(missingKeywords.body.error, 'MISSING_KEYWORDS');

  for (const pathname of [
    '/api/youtube/config/save',
    '/api/youtube/config/clear',
    '/api/youtube/oauth/config/save',
    '/api/youtube/oauth/config/clear',
    '/api/youtube/oauth/start',
    '/api/youtube/oauth/cancel',
    '/api/youtube/oauth/logout',
  ]) {
    const wrongMethod = await getJson(baseUrl, pathname);
    assert.equal(wrongMethod.response.status, 405, pathname);
    assert.equal(wrongMethod.body.error, 'METHOD_NOT_ALLOWED', pathname);

    const untrustedPost = await getJson(baseUrl, pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'AIzaSyExampleKeyForContractTesting123456' }),
    });
    assert.equal(untrustedPost.response.status, 403, pathname);
    assert.equal(untrustedPost.body.error, 'UNTRUSTED_MUTATION_REQUEST', pathname);
  }

  const oauthStart = await getJson(baseUrl, '/api/youtube/oauth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mineradio-Request': '1' },
    body: '{}',
  });
  assert.equal(oauthStart.response.status, 428);
  assert.equal(oauthStart.body.error, 'YOUTUBE_OAUTH_CONFIG_REQUIRED');
  assert.equal(oauthStart.body.authorizationUrl, '');

  const oauthConfigSave = await getJson(baseUrl, '/api/youtube/oauth/config/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mineradio-Request': '1' },
    body: JSON.stringify({
      credentials: {
        installed: {
          client_id: '1234567890-contract.apps.googleusercontent.com',
          client_secret: 'GOCSPX-contract-test',
          project_id: 'mineradio-contract',
        },
      },
    }),
  });
  assert.equal(oauthConfigSave.response.status, 400);
  assert.equal(oauthConfigSave.body.error, 'YOUTUBE_SECURE_STORAGE_UNAVAILABLE');
  assert.equal(oauthConfigSave.body.saved, false);

  for (const pathname of ['/api/youtube/oauth/config/clear', '/api/youtube/oauth/logout']) {
    const cleared = await getJson(baseUrl, pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mineradio-Request': '1' },
      body: '{}',
    });
    assert.equal(cleared.response.status, 200, pathname);
    assert.equal(cleared.body.connected, false, pathname);
  }

  const oauthCancel = await getJson(baseUrl, '/api/youtube/oauth/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mineradio-Request': '1' },
    body: '{}',
  });
  assert.equal(oauthCancel.response.status, 200);
  assert.equal(oauthCancel.body.connected, false);
  assert.equal(oauthCancel.body.authorizing, false);
  assert.equal(oauthCancel.body.phase, 'idle');
  assert.equal(oauthCancel.body.cancelled, false);

  for (const pathname of [
    '/api/youtube/account/playlists',
    '/api/youtube/account/likes',
    '/api/youtube/account/subscriptions',
    '/api/youtube/account/playlist?id=PLcontract123',
  ]) {
    const account = await getJson(baseUrl, pathname);
    assert.equal(account.response.status, 401, pathname);
    assert.equal(account.body.error, 'YOUTUBE_OAUTH_LOGIN_REQUIRED', pathname);
    assert.equal(account.body.connected, false, pathname);
    if (pathname.includes('/playlist?')) assert.deepEqual(account.body.tracks, [], pathname);
    else assert.deepEqual(account.body.items, [], pathname);
  }


  const accountArtist = await getJson(baseUrl, '/api/youtube/account/artist?id=UCcontract123');
  assert.equal(accountArtist.response.status, 401);
  assert.equal(accountArtist.body.error, 'YOUTUBE_OAUTH_LOGIN_REQUIRED');
  assert.equal(accountArtist.body.connected, false);
  assert.equal(accountArtist.body.artist, null);
  assert.deepEqual(accountArtist.body.songs, []);

  const invalidAccountArtist = await getJson(baseUrl, '/api/youtube/account/artist?id=%20');
  assert.equal(invalidAccountArtist.response.status, 400);
  assert.equal(invalidAccountArtist.body.error, 'INVALID_CHANNEL_ID');
  assert.equal(invalidAccountArtist.body.artist, null);
  assert.deepEqual(invalidAccountArtist.body.songs, []);

  const wrongMethodAccountArtist = await getJson(baseUrl, '/api/youtube/account/artist?id=UCcontract123', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mineradio-Request': '1' },
    body: '{}',
  });
  assert.equal(wrongMethodAccountArtist.response.status, 405);
  assert.equal(wrongMethodAccountArtist.body.error, 'METHOD_NOT_ALLOWED');
  assert.equal(wrongMethodAccountArtist.body.artist, null);
  assert.deepEqual(wrongMethodAccountArtist.body.songs, []);

  const callback = await fetch(
    baseUrl + '/api/youtube/oauth/callback?state=must-not-echo&code=secret-code-must-not-echo',
    {
      headers: {
        'Sec-Fetch-Site': 'cross-site',
        Referer: 'https://accounts.google.com/',
      },
    },
  );
  const callbackHtml = await callback.text();
  assert.equal(callback.status, 400);
  assert.match(callback.headers.get('content-type') || '', /^text\/html/);
  assert.match(callback.headers.get('cache-control') || '', /no-store/);
  assert.match(callback.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(callbackHtml.includes('must-not-echo'), false);
  assert.equal(callbackHtml.includes('secret-code-must-not-echo'), false);
  assert.equal(callbackHtml.includes('UNTRUSTED_API_REQUEST'), false);
});

test('bundled YouTube OAuth client is detected without exposing its secret', { timeout: 20000 }, async t => {
  const appPort = await unusedPort();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-youtube-bundled-'));
  const bundledClientFile = path.join(workDir, 'youtube-oauth-client.json');
  const clientSecret = 'GOCSPX-bundled-contract-secret';
  fs.writeFileSync(bundledClientFile, JSON.stringify({
    installed: {
      client_id: '1234567890-bundled.apps.googleusercontent.com',
      client_secret: clientSecret,
      project_id: 'mineradio-bundled-contract',
    },
  }));
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
      YOUTUBE_API_KEY_FILE: path.join(workDir, '.youtube-api-key'),
      YOUTUBE_OAUTH_CLIENT_FILE: path.join(workDir, '.youtube-oauth-client'),
      YOUTUBE_OAUTH_TOKEN_FILE: path.join(workDir, '.youtube-oauth-token'),
      YOUTUBE_OAUTH_BUNDLED_CLIENT_FILE: bundledClientFile,
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

  const status = await getJson(baseUrl, '/api/youtube/oauth/status');
  assert.equal(status.response.status, 200);
  assert.equal(status.body.clientConfigured, true);
  assert.equal(status.body.clientSource, 'bundled');
  assert.equal(status.body.connected, false);
  assert.equal(JSON.stringify(status.body).includes(clientSecret), false);

  const search = await getJson(baseUrl, '/api/youtube/search?keywords=test&type=song');
  assert.equal(search.response.status, 401);
  assert.equal(search.body.error, 'YOUTUBE_OAUTH_LOGIN_REQUIRED');

  const oauthStart = await getJson(baseUrl, '/api/youtube/oauth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mineradio-Request': '1' },
    body: '{}',
  });
  assert.equal(oauthStart.response.status, 400);
  assert.equal(oauthStart.body.error, 'YOUTUBE_SECURE_STORAGE_UNAVAILABLE');
  assert.equal(oauthStart.body.clientConfigured, true);
});
