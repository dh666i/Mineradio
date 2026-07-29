'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('account dialogs expose all five supported music provider tabs', () => {
  const loginModal = sourceBetween(indexSource, '<div id="login-modal"', '<!-- 用户模态 -->');
  const userModal = sourceBetween(indexSource, '<div id="user-modal"', '<!-- 封面裁剪模态 -->');
  const loginTabs = loginModal.match(/<button\b[^>]*\brole="tab"[^>]*>/g) || [];
  const userTabs = userModal.match(/<button\b[^>]*\brole="tab"[^>]*>/g) || [];

  assert.match(loginModal, /id="login-platform-tabs"[^>]*role="tablist"/);
  assert.match(userModal, /id="user-platform-tabs"[^>]*role="tablist"/);
  assert.equal(loginTabs.length, 5);
  assert.equal(userTabs.length, 5);
  assert.match(loginModal, /id="login-provider-netease"[^>]*aria-selected="true"/);
  assert.match(loginModal, /id="login-provider-qq"[^>]*aria-selected="false"/);
  assert.match(loginModal, /id="login-provider-kugou"[^>]*aria-selected="false"/);
  assert.match(loginModal, /id="login-provider-qishui"[^>]*aria-selected="false"/);
  assert.match(loginModal, /id="login-provider-spotify"[^>]*aria-selected="false"/);
  assert.match(userModal, /id="user-provider-netease"[^>]*aria-selected="true"/);
  assert.match(userModal, /id="user-provider-qq"[^>]*aria-selected="false"/);
  assert.match(userModal, /id="user-provider-kugou"[^>]*aria-selected="false"/);
  assert.match(userModal, /id="user-provider-qishui"[^>]*aria-selected="false"/);
  assert.match(userModal, /id="user-provider-spotify"[^>]*aria-selected="false"/);

  const loginUi = sourceBetween(indexSource, 'function updateLoginProviderUi()', 'async function refreshQr()');
  const userUi = sourceBetween(indexSource, 'function updateUserModalUi()', 'function showUserModal()');
  assert.match(loginUi, /\['netease', 'qq', 'kugou', 'qishui', 'spotify'\]\.forEach/);
  assert.match(userUi, /\['netease', 'qq', 'kugou', 'qishui', 'spotify'\]\.forEach/);
  assert.match(userUi, /btn\.setAttribute\('aria-selected'/);
});

test('Spotify first-run login exposes Client ID setup without collecting a secret', () => {
  const loginModal = sourceBetween(indexSource, '<div id="login-modal"', '<!-- 用户模态 -->');
  const setupFlow = sourceBetween(indexSource, 'async function submitSpotifyClientId()', 'async function openNeteaseWebLogin()');

  assert.match(loginModal, /id="spotify-config-panel"/);
  assert.match(loginModal, /id="spotify-client-id-input"/);
  assert.match(loginModal, /onclick="submitSpotifyClientId\(\)"/);
  assert.doesNotMatch(loginModal, /client secret/i);
  assert.match(setupFlow, /\/api\/spotify\/config/);
  assert.match(setupFlow, /JSON\.stringify\(\{ clientId: clientId \}\)/);
  assert.match(setupFlow, /openAuxiliaryProviderLogin\('spotify'\)/);
  assert.doesNotMatch(setupFlow, /clientSecret/);
});

test('dual-account and YouTube account UI cannot return', () => {
  const loginModal = sourceBetween(indexSource, '<div id="login-modal"', '<!-- 用户模态 -->');
  const userModal = sourceBetween(indexSource, '<div id="user-modal"', '<!-- 封面裁剪模态 -->');
  const accountUi = loginModal + userModal;

  assert.doesNotMatch(accountUi, /YouTube|Google|OAuth/i);
  assert.doesNotMatch(accountUi, /我两个都要|login-both-btn|user-provider-both/);
  assert.doesNotMatch(indexSource, /dualAccountMode|renderTopAccountPill|enableDualAccountView|requestDualLoginMode/);
  assert.doesNotMatch(indexSource, /multi-account|top-account-pill|top-account-name/);
});

test('top account button and fullscreen DIY anchor use the active provider only', () => {
  const renderUser = sourceBetween(indexSource, 'function renderUserBtn()', 'async function showLoginModal');
  const layoutDiy = sourceBetween(indexSource, 'function layoutFullscreenDiyZone()', 'function shouldSuppressFullscreenDiyPeek()');
  const pointerDiy = sourceBetween(indexSource, 'function updateFullscreenDiyPeekFromPointer', 'function isDiyMode()');

  assert.match(renderUser, /activeAccountProvider = firstLoggedProvider\(\)/);
  assert.match(renderUser, /platformStatus\(activeAccountProvider\)/);
  assert.doesNotMatch(renderUser, /renderTopAccountPill|multi-account/);
  assert.match(layoutDiy, /var anchor = document\.getElementById\('user-btn'\)/);
  assert.match(pointerDiy, /var anchor = document\.getElementById\('user-btn'\)/);
});

function createLogoutRuntime(provider, options = {}) {
  const logoutSource = sourceBetween(
    indexSource,
    'function assertLogoutCompleted',
    'var startupLoginGuideShown'
  );
  const toasts = [];
  const mutations = [];
  const qqStatus = { provider: 'qq', loggedIn: true, nickname: 'QQ user' };
  const neteaseStatus = { loggedIn: true, nickname: 'Netease user' };
  const playlists = [
    { id: 'netease-list', provider: 'netease' },
    { id: 'qq-list', provider: 'qq' },
    { id: 'kugou-list', provider: 'kugou' },
  ];
  const desktopResult = options.desktopResult || { ok: true, loggedIn: false };
  const context = vm.createContext({
    activeAccountProvider: provider,
    apiJson: async () => options.apiResult || { ok: true, loggedIn: false },
    window: {
      desktopWindow: {
        clearQQMusicLogin: async () => desktopResult,
        clearKugouMusicLogin: async () => desktopResult,
        clearQishuiMusicLogin: async () => desktopResult,
        clearSpotifyMusicLogin: async () => desktopResult,
        clearNeteaseMusicLogin: async () => desktopResult,
      },
    },
    showToast: message => toasts.push(String(message)),
    qqLoginStatus: qqStatus,
    qqPlaylists: [{ id: 'qq-list', provider: 'qq' }],
    userPlaylists: playlists,
    loginStatus: neteaseStatus,
    kugouPlaylists: [{ id: 'kugou-list', provider: 'kugou' }],
    qishuiPlaylists: [],
    spotifyPlaylists: [],
    myPodcastCollections: [{ id: 'podcast' }],
    myPodcastItems: { podcast: [{}] },
    likedSongMap: { song: true },
    miniQueueOpen: false,
    auxiliaryLoginWasLoggedIn: { kugou: true, qishui: true, spotify: true },
    firstLoggedProvider: () => 'netease',
    rememberActiveAccountProvider: () => mutations.push('remember-provider'),
    renderUserBtn: () => mutations.push('render-user'),
    hasAnyPlatformLogin: () => true,
    updateUserModalUi: () => mutations.push('update-user-modal'),
    closeUserModal: () => mutations.push('close-user-modal'),
    platformMeta: value => ({ label: value }),
    setAuxiliaryLoginStatus: () => mutations.push('set-aux-status'),
    normalizeAuxiliaryLoginStatus: (_value, status) => status,
    clearProviderPlaylistCache: () => mutations.push('clear-provider-cache'),
    resetNeteaseHomeState: () => mutations.push('reset-netease-home'),
    closeCollectModal: () => mutations.push('close-collect-modal'),
    updateLikeButtons: () => mutations.push('update-like-buttons'),
    safeRenderQueuePanel: () => mutations.push('render-queue'),
    safeShelfRebuild: () => mutations.push('rebuild-shelf'),
  });
  vm.runInContext(logoutSource, context);
  return { context, toasts, mutations, qqStatus, neteaseStatus, playlists };
}

test('QQ logout failure keeps the visible login and playlist state', async () => {
  const runtime = createLogoutRuntime('qq', {
    desktopResult: { ok: false, loggedIn: true, error: 'desktop clear blocked' },
  });
  await vm.runInContext('logoutActiveAccount()', runtime.context);

  assert.strictEqual(runtime.context.qqLoginStatus, runtime.qqStatus);
  assert.strictEqual(runtime.context.userPlaylists, runtime.playlists);
  assert.deepEqual(runtime.mutations, []);
  assert.ok(runtime.toasts.some(message => /失败|blocked/.test(message)));
  assert.equal(runtime.toasts.some(message => message === '已退出 QQ 音乐'), false);
});

test('auxiliary-provider logout failure does not clear its UI state', async () => {
  const runtime = createLogoutRuntime('kugou', {
    apiResult: { ok: false, loggedIn: true, error: 'credential clear failed' },
  });
  await vm.runInContext('logoutActiveAccount()', runtime.context);

  assert.strictEqual(runtime.context.userPlaylists, runtime.playlists);
  assert.equal(runtime.context.auxiliaryLoginWasLoggedIn.kugou, true);
  assert.deepEqual(runtime.mutations, []);
  assert.ok(runtime.toasts.some(message => /失败|failed/.test(message)));
  assert.equal(runtime.toasts.some(message => message === '已退出kugou'), false);
});

test('Netease logout failure keeps its account and Home state intact', async () => {
  const runtime = createLogoutRuntime('netease', {
    desktopResult: { ok: false, loggedIn: true, error: 'web session clear failed' },
  });
  const result = await vm.runInContext('logoutActiveAccount()', runtime.context);

  assert.equal(result, false);
  assert.strictEqual(runtime.context.loginStatus, runtime.neteaseStatus);
  assert.strictEqual(runtime.context.userPlaylists, runtime.playlists);
  assert.deepEqual(runtime.mutations, []);
  assert.ok(runtime.toasts.some(message => /失败|failed/.test(message)));
  assert.equal(runtime.toasts.some(message => message === '已退出登录'), false);
});
