const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8');

function functionSource(name, nextName) {
  const start = mainSource.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName ? mainSource.indexOf(`function ${nextName}`, start + 1) : mainSource.length;
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return mainSource.slice(start, end);
}

test('desktop provider credential paths are fixed under userData before the local server starts', () => {
  const serverStart = mainSource.indexOf("localServer = require(path.join(__dirname, '..', 'server.js'))");
  assert.ok(serverStart > 0);

  [
    'MINERADIO_USER_DATA_DIR',
    'KUGOU_COOKIE_FILE',
    'QISHUI_COOKIE_FILE',
    'SPOTIFY_CONFIG_FILE',
    'SPOTIFY_TOKEN_FILE',
  ].forEach((name) => {
    const assignment = mainSource.indexOf(`process.env.${name} =`, mainSource.indexOf('async function createWindow'));
    assert.ok(assignment > 0 && assignment < serverStart, `${name} must be set before server.js loads`);
  });

  assert.match(mainSource, /process\.env\.KUGOU_COOKIE_FILE = path\.join\(userDataPath, '\.kugou-cookie'\)/);
  assert.match(mainSource, /process\.env\.QISHUI_COOKIE_FILE = path\.join\(userDataPath, '\.qishui-cookie'\)/);
  assert.match(mainSource, /process\.env\.SPOTIFY_CONFIG_FILE = path\.join\(userDataPath, '\.spotify-credentials\.json'\)/);
  assert.match(mainSource, /process\.env\.SPOTIFY_TOKEN_FILE = path\.join\(userDataPath, '\.spotify-token\.json'\)/);
});

test('Kugou, Qishui, and Spotify expose trusted open, state, and clear IPC contracts', () => {
  const providers = [
    ['kugou', 'Kugou'],
    ['qishui', 'Qishui'],
    ['spotify', 'Spotify'],
  ];
  providers.forEach(([provider, publicName]) => {
    ['open-login', 'login-state', 'clear-login'].forEach((action) => {
      const marker = `ipcMain.handle('${provider}-music-${action}'`;
      const start = mainSource.indexOf(marker);
      assert.ok(start > 0, `${marker} must exist`);
      const handler = mainSource.slice(start, mainSource.indexOf('});', start) + 3);
      assert.match(handler, /isTrustedMainRenderer\(event\)/);
    });
    assert.match(preloadSource, new RegExp(`open${publicName}MusicLogin:\\s*\\([^)]*\\) => ipcRenderer\\.invoke\\('${provider}-music-open-login'`));
    assert.match(preloadSource, new RegExp(`get${publicName}MusicLoginState:\\s*\\(\\) => ipcRenderer\\.invoke\\('${provider}-music-login-state'\\)`));
    assert.match(preloadSource, new RegExp(`clear${publicName}MusicLogin:\\s*\\(\\) => ipcRenderer\\.invoke\\('${provider}-music-clear-login'\\)`));
  });
});

test('Qishui PC session discovery runs only after the explicit import IPC and never reaches preload', () => {
  const importCalls = mainSource.match(/\bimportQishuiOfficialClientSession\(/g) || [];
  assert.equal(importCalls.length, 2, 'Qishui import must have only its definition and explicit IPC call');

  const importer = functionSource('importQishuiOfficialClientSession', 'clearQishuiMusicLoginSession');
  assert.match(importer, /discoverQishuiCookieStores\(root\)/);
  assert.match(importer, /readQishuiOfficialClientCookieDatabase\(store\)/);
  assert.match(importer, /importMethod,\s*sourceHint:/);
  assert.match(importer, /session\.fromPath\(store\.sessionPath, \{ cache: false \}\)/);
  assert.match(importer, /readQishuiLoginCookieHeader\(clientSession\)/);
  assert.match(importer, /readDesktopProviderLoginState\('qishui'\)/);
  assert.match(importer, /persistedSession:\s*true/);
  assert.doesNotMatch(preloadSource, /cookie|token|sessionPath|dbPath/i);

  const sanitizer = functionSource('publicDesktopProviderResult', 'readDesktopProviderLoginState');
  assert.match(sanitizer, /cookie\|token\|accessToken\|refreshToken/);
  assert.match(sanitizer, /dbPath\|sessionPath\|sourcePath/);
});

test('Spotify OAuth is loopback-only and validates state plus PKCE without a client secret', () => {
  const loopback = functionSource('spotifyLoopbackRedirectConfig', 'spotifyOAuthResultHtml');
  assert.match(loopback, /redirect\.protocol !== 'http:'/);
  assert.match(loopback, /127\.0\.0\.1/);
  assert.match(loopback, /localhost/);
  assert.match(loopback, /::1/);

  const login = functionSource('openSpotifyMusicLoginWindow', 'clearSpotifyMusicLoginSession');
  assert.match(login, /crypto\.randomBytes\(24\)/);
  assert.match(login, /createSpotifyPkcePair\(\)/);
  assert.match(login, /buildSpotifyOAuthAuthorizeUrl\(/);
  assert.match(login, /crypto\.timingSafeEqual\(/);
  assert.match(login, /exchangeSpotifyOAuthCode\(\{\s*code,\s*codeVerifier: pkce\.codeVerifier,\s*redirectUri: config\.redirectUri/s);
  assert.doesNotMatch(login, /clientSecret\s*:/);
  assert.match(login, /SPOTIFY_OAUTH_TIMEOUT_MS/);

  const pkce = functionSource('createSpotifyPkcePair', 'spotifyLoopbackRedirectConfig');
  assert.match(pkce, /createHash\('sha256'\)/);
  assert.match(pkce, /randomBytes\(48\)/);
});

test('provider login navigation is HTTPS-only except for the exact Spotify loopback callback', () => {
  const source = functionSource('spotifyOAuthRedirectMatches', 'secureMusicLoginWindow');
  const isAllowedMusicLoginUrl = vm.runInNewContext(
    `${source}\nisAllowedMusicLoginUrl`,
    { URL }
  );

  assert.equal(isAllowedMusicLoginUrl('netease', 'https://music.163.com/#/login'), true);
  assert.equal(isAllowedMusicLoginUrl('qq', 'https://y.qq.com/n/ryqq/profile'), true);
  assert.equal(isAllowedMusicLoginUrl('kugou', 'https://www.kugou.com/'), true);
  assert.equal(isAllowedMusicLoginUrl('spotify', 'https://accounts.spotify.com/authorize'), true);

  assert.equal(isAllowedMusicLoginUrl('netease', 'http://music.163.com/#/login'), false);
  assert.equal(isAllowedMusicLoginUrl('qq', 'http://y.qq.com/n/ryqq/profile'), false);
  assert.equal(isAllowedMusicLoginUrl('kugou', 'http://www.kugou.com/'), false);
  assert.equal(isAllowedMusicLoginUrl('spotify', 'http://accounts.spotify.com/authorize'), false);

  const options = { redirectUri: 'http://127.0.0.1:43879/callback' };
  assert.equal(
    isAllowedMusicLoginUrl('spotify', 'http://127.0.0.1:43879/callback?code=test', options),
    true
  );
  assert.equal(isAllowedMusicLoginUrl('spotify', 'http://localhost:43879/callback', options), false);
  assert.equal(isAllowedMusicLoginUrl('spotify', 'http://127.0.0.1:43880/callback', options), false);
  assert.equal(isAllowedMusicLoginUrl('spotify', 'http://127.0.0.1:43879/other', options), false);

  const guard = functionSource('secureMusicLoginWindow', 'cookieIsExpired');
  assert.match(guard, /if \(isAllowedMusicLoginUrl\(provider, targetUrl, options\)\) return/);
  assert.equal(
    guard.includes("if (/^https:\\/\\//i.test(String(targetUrl || ''))) shell.openExternal"),
    true
  );
  assert.equal(guard.includes('/^https?:\\/\\//i'), false);
});
