'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const youtubeSource = fs.readFileSync(path.join(root, 'public', 'js', 'v155-youtube.js'), 'utf8');
const queueSource = fs.readFileSync(path.join(root, 'public', 'js', 'v140.js'), 'utf8');
const youtubeCssSource = fs.readFileSync(path.join(root, 'public', 'css', 'v155.css'), 'utf8');
const desktopMainSource = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const desktopPreloadSource = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function openingTagById(source, id) {
  const match = source.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(match, `missing button: #${id}`);
  return match[0];
}

test('combined search is the default mode in state and accessible DOM', () => {
  assert.match(indexSource, /var searchMode = 'song'/);

  const combinedTab = openingTagById(indexSource, 'search-mode-song');
  assert.match(combinedTab, /class="[^"]*\bactive\b[^"]*"/);
  assert.match(combinedTab, /aria-selected="true"/);
  assert.match(indexSource, /id="search-mode-song"[^>]*>综合<\/button>/);

  ['netease', 'youtube', 'qq', 'podcast'].forEach(provider => {
    const tab = openingTagById(indexSource, `search-mode-${provider}`);
    assert.doesNotMatch(tab, /class="[^"]*\bactive\b[^"]*"/);
    assert.match(tab, /aria-selected="false"/);
  });

  const modeUi = sourceBetween(indexSource, 'function updateSearchModeTabs', 'function setSearchMode');
  assert.match(modeUi, /songBtn\.classList\.toggle\('active', searchMode === 'song'\)/);
  assert.match(modeUi, /songBtn\.setAttribute\('aria-selected', searchMode === 'song' \? 'true' : 'false'\)/);
});

test('combined v140 search only requests NetEase and QQ sources', () => {
  assert.doesNotMatch(queueSource, /\/api\/youtube\/search/);
  assert.doesNotMatch(queueSource, /combinedYouTube|requestYouTube|youtubeLoaded|youtubeTotal/);
  const combinedFetch = sourceBetween(queueSource, 'async function fetchSearchPage', 'function searchOverflowMarkup');
  assert.match(combinedFetch, /apiJsonV140\('\/api\/search\?keywords='/);
  assert.match(combinedFetch, /apiJsonV140\('\/api\/qq\/search\?keywords='/);
  assert.match(combinedFetch, /var neCombinedLimit = 18/);
  assert.match(combinedFetch, /var qqCombinedLimit = 12/);
  assert.match(combinedFetch, /hasMore: !!\(nextNeteaseHasMore \|\| nextQQHasMore\)/);
  assert.doesNotMatch(combinedFetch, /YouTube|youtube/);

  const youtubeOverride = sourceBetween(youtubeSource, 'function installOverrides', 'injectSearchTypes();');
  assert.match(youtubeOverride, /String\(window\.searchMode \|\| ''\) === 'youtube'/);
  assert.match(youtubeSource, /'\/api\/youtube\/search\?keywords='/);
});

test('YouTube typing waits for confirmation while explicit source actions still search', () => {
  const inputHandler = sourceBetween(
    indexSource,
    "$input.addEventListener('input'",
    "$input.addEventListener('focus'",
  );
  assert.match(inputHandler, /if \(searchMode === 'youtube'\) \{[\s\S]*?clearSearchResults\(\)[\s\S]*?按 Enter 搜索[\s\S]*?return;/);
  assert.match(inputHandler, /var searchDelay = searchMode === 'song' \? 750 : 180/);
  assert.match(inputHandler, /searchTimer = setTimeout\(function\(\)\{ doSearch\(q\); \}, searchDelay\)/);

  const modeSwitch = sourceBetween(indexSource, 'function setSearchMode', 'function podcastMetaText');
  assert.match(modeSwitch, /if \(searchMode === mode\) return;\s*clearTimeout\(searchTimer\);\s*searchMode = mode/);
  assert.match(modeSwitch, /else if \(q\) \{\s*doSearch\(q\)/);

  const keyHandler = sourceBetween(
    indexSource,
    "$input.addEventListener('keydown'",
    "$results.addEventListener('click'",
  );
  assert.match(keyHandler, /if \(e\.key === 'Enter'\)[\s\S]*?doSearch\(q, \{ autoPlayFirst: false \}\)/);

  const history = sourceBetween(indexSource, 'function runSearchHistory', 'function updateSearchModeTabs');
  assert.match(history, /doSearch\(q\)/);
});

test('login modal hides inactive panels and synchronizes all provider tabs atomically', () => {
  assert.match(indexSource, /#login-modal\s+\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*\}/);

  const loginUi = sourceBetween(youtubeSource, 'function syncMainLoginUi', 'function youtubeAccountIsActive');
  assert.match(loginUi, /if \(!isQQ\) window\.qqManualCookieOpen = false/);
  assert.match(loginUi, /\[\s*\[neteaseTab, isNetease\],\s*\[qqTab, isQQ\],\s*\[youtubeTab, isYouTube\],\s*\]\.forEach/);
  assert.match(loginUi, /tab\.classList\.toggle\('active', active\)[\s\S]*?tab\.setAttribute\('aria-selected', active \? 'true' : 'false'\)/);
  assert.equal((loginUi.match(/tab\.setAttribute\('aria-selected'/g) || []).length, 1);
  assert.match(loginUi, /qqPanel\.hidden = isYouTube \|\| !isQQ \|\| !window\.qqManualCookieOpen/);
});

test('account UI sources contain no legacy dual-account controls or state', () => {
  const sources = {
    index: indexSource,
    youtube: youtubeSource,
    css: youtubeCssSource,
  };
  const forbidden = [
    /login-both-btn/,
    /user-provider-both/,
    /\bdualAccountMode\b/,
    /\brequestDualLoginMode\b/,
    /\benableDualAccountView\b/,
    /dual-login-modal/,
    /dual-user-modal/,
    /\bmulti-account\b/,
    /user-platform-tabs button\.both\.active/,
    /我两个都要|双平台|双账号/,
  ];
  Object.entries(sources).forEach(([name, source]) => {
    forbidden.forEach(pattern => assert.doesNotMatch(source, pattern, `${name} still contains ${pattern}`));
  });

  const topAccount = sourceBetween(indexSource, 'function renderUserBtn', 'async function showLoginModal');
  const accountModal = sourceBetween(indexSource, 'function updateUserModalUi', 'function showUserModal');
  assert.match(topAccount, /if \(!hasPlatformLogin\(activeAccountProvider\)\) activeAccountProvider = firstLoggedProvider\(\)/);
  assert.match(accountModal, /if \(!hasPlatformLogin\(activeAccountProvider\)\) activeAccountProvider = firstLoggedProvider\(\)/);
});

test('YouTube OAuth exposes cancellation and a visible status message', () => {
  assert.match(indexSource, /id="youtube-main-login-cancel"[^>]*>取消登录<\/button>/);
  assert.match(indexSource, /id="youtube-main-login-status"[^>]*role="status"[^>]*aria-live="polite"/);

  const ui = sourceBetween(youtubeSource, 'function syncMainLoginUi', 'function youtubeAccountIsActive');
  assert.match(ui, /status\.textContent = oauthDisplayMessage\(\)/);
  assert.match(ui, /cancel\.hidden = !isAuthorizing/);

  const controls = sourceBetween(youtubeSource, 'function bindOAuthControls', 'function safeYouTubeId');
  assert.match(controls, /mainCancel\.addEventListener\('click', cancelYouTubeOAuthLogin\)/);
});

test('YouTube detail navigation distinguishes back from dismiss', () => {
  const modal = sourceBetween(youtubeSource, 'function ensureDetailModal', 'function renderDetail');
  assert.match(modal, /event\.target === mask[\s\S]*?closeDetail\(false\)/);
  assert.match(modal, /\[data-v155-detail-back\][\s\S]*?closeDetail\(true\)/);
  assert.match(modal, /\[data-v155-detail-close\][\s\S]*?closeDetail\(false\)/);
  assert.match(youtubeSource, /window\.closeYouTubeDetailModal = function \(\) \{ closeDetail\(false\); \}/);
});

test('YouTube OAuth exchange phase uses the loading visual state', () => {
  const ui = sourceBetween(youtubeSource, 'function syncMainLoginUi', 'function youtubeAccountIsActive');
  assert.match(ui, /var isAuthorizing = oauthState\.authorizing \|\| oauthState\.phase === 'exchanging'/);
  assert.match(ui, /isAuthorizing[\s\S]*?'等待浏览器授权'/);
  assert.match(ui, /cancel\.hidden = !isAuthorizing/);
});

test('authorized subscription details use the account artist endpoint', () => {
  const loader = sourceBetween(youtubeSource, 'async function loadDetail', 'function openEntityItem');
  assert.match(loader, /detailState\.authorized[\s\S]*?'\/api\/youtube\/account\/artist\?id='/);
  assert.match(loader, /detailState\.authorized[\s\S]*?'\/api\/youtube\/account\/playlist\?id='/);

  const accountEntity = sourceBetween(youtubeSource, 'function openAccountEntity', 'function bindOAuthControls');
  assert.match(accountEntity, /accountViewState\.view === 'subscriptions' \? 'artist' : 'playlist'/);
  assert.match(accountEntity, /openEntityItem\([\s\S]*?item,[\s\S]*?true,[\s\S]*?returnToAccount: true/);
});

test('main login modal exposes YouTube as an account provider', () => {
  assert.match(indexSource, /id="login-provider-youtube"[^>]*onclick="setLoginProvider\('youtube'\)"[^>]*>YouTube<\/button>/);
  assert.match(indexSource, /id="youtube-main-login-panel"/);

  const loginUi = sourceBetween(youtubeSource, 'function syncMainLoginUi', 'function youtubeAccountIsActive');
  assert.match(loginUi, /String\(window\.loginProvider \|\| ''\) === 'youtube'/);
  assert.match(loginUi, /var youtubeTab = byId\('login-provider-youtube'\)/);
  assert.match(loginUi, /panel\.hidden = !isYouTube/);
  assert.match(loginUi, /使用 Google 账号登录/);
});

test('account modal treats YouTube as a direct-login platform without credential import UI', () => {
  assert.match(indexSource, /id="user-provider-youtube"[^>]*onclick="setActiveAccountProvider\('youtube'\)"[^>]*>YouTube<\/button>/);
  assert.match(indexSource, /id="account-youtube-content"/);
  assert.doesNotMatch(indexSource, /id="account-manage-youtube"/);
  assert.doesNotMatch(indexSource, /id="youtube-api-key"/);
  assert.doesNotMatch(indexSource, /id="youtube-oauth-json"/);
  assert.doesNotMatch(indexSource, /导入\s*\/\s*替换 OAuth JSON/);

  const integration = sourceBetween(youtubeSource, 'function installMainAccountIntegration', 'var ACCOUNT_VIEW_LABELS');
  assert.match(integration, /provider === 'youtube'[\s\S]*?openYouTubeLogin\(byId\('user-modal'\), true\)/);
  assert.match(integration, /youtubeAccountIsActive\(\)[\s\S]*?logoutYouTubeOAuth\(\)/);
});

test('YouTube results stay outside the internal playback queue', () => {
  const batching = sourceBetween(youtubeSource, 'function withInternalSearchSongs', 'function decorateCombinedYouTubeRows');
  assert.match(batching, /source\.filter\(function \(song\) \{ return !isYouTubeSong\(song\); \}\)/);
  assert.match(batching, /window\.playlist = internalSongs/);
  assert.match(batching, /window\.playlist = source/);

  const overrides = sourceBetween(youtubeSource, 'function installOverrides', 'injectSearchTypes();');
  assert.match(overrides, /window\.playSearchResult[\s\S]*?isYouTubeSong\(song\)[\s\S]*?openYouTubeSong\(song\)/);
  assert.match(overrides, /window\.queueSearchResult[\s\S]*?isYouTubeSong\(song\)[\s\S]*?openYouTubeSong\(song\)/);
  assert.match(overrides, /withInternalSearchSongs\(legacy\.addAllSearchResultsToQueue/);

  assert.doesNotMatch(youtubeSource, /data-v155-detail-queue|data-v155-account-queue|queueSongNext\(/);
});

test('YouTube search mode gives the search input a specific accessible name', () => {
  const searchModeUi = sourceBetween(indexSource, 'function updateSearchModeTabs', 'function setSearchMode');
  assert.match(searchModeUi, /youtube:\s*\{\s*placeholder:\s*'搜索 YouTube Music\.\.\.',\s*label:\s*'搜索 YouTube Music'\s*\}/);
  assert.match(searchModeUi, /\$input\.setAttribute\('aria-label', activeSearchCopy\.label\)/);

  const searchTypes = sourceBetween(youtubeSource, 'function injectSearchTypes', 'function syncSearchTypes');
  assert.match(searchTypes, /root\.setAttribute\('aria-label', 'YouTube 搜索类型'\)/);
});

test('visible music source labels use full provider names', () => {
  const searchBadge = sourceBetween(indexSource, 'function songSourceTagHtml', 'function searchResultMetaText');
  assert.match(searchBadge, /key === 'qq' \? 'QQ音乐' : '网易云'/);
  assert.doesNotMatch(searchBadge, /\? 'QQ' : 'NE'/);

  const shelfItems = sourceBetween(indexSource, 'function currentItems', 'function makeRoundRect');
  assert.match(shelfItems, /sourceLabel = provider === 'qq' \? 'QQ音乐' : '网易云'/);

  const playlistCards = sourceBetween(indexSource, 'function renderUserPlaylistsList', 'function renderMyPodcastCollections');
  assert.match(playlistCards, /providerLabel = provider === 'qq' \? 'QQ音乐' : '网易云'/);
  assert.match(indexSource, /<span class="source">网易云<\/span>/);
});

test('YouTube content uses a restricted external-open IPC without hidden playback', () => {
  const external = sourceBetween(youtubeSource, 'function safeYouTubeId', 'async function playYouTubeQueueAt');
  assert.match(external, /https:\/\/music\.youtube\.com\/watch\?v=/);
  assert.match(external, /https:\/\/music\.youtube\.com\/playlist\?list=/);
  assert.match(external, /https:\/\/music\.youtube\.com\/channel\//);
  assert.match(external, /https:\/\/music\.youtube\.com\/search\?q=/);
  assert.match(external, /api\.openYouTubeContent\(url\)/);

  const adapter = sourceBetween(youtubeSource, 'window.MineradioYouTubeV155 = {', 'function withInternalSearchSongs');
  assert.match(adapter, /active: function \(\) \{ return false; \}/);
  assert.match(adapter, /isPlaying: function \(\) \{ return false; \}/);
  assert.match(adapter, /handleMediaAction: function \(\) \{ return false; \}/);

  const ipc = sourceBetween(desktopMainSource, 'function normalizeYouTubeContentUrl', "ipcMain.handle('netease-music-open-login'");
  assert.match(ipc, /host === 'music\.youtube\.com' \|\| host === 'www\.youtube\.com' \|\| host === 'youtube\.com'/);
  assert.match(ipc, /parsed\.pathname === '\/watch'/);
  assert.match(ipc, /parsed\.pathname === '\/playlist'/);
  assert.match(ipc, /\^\\\/channel\\\//);
  assert.match(ipc, /host === 'music\.youtube\.com' && parsed\.pathname === '\/search'/);
  assert.match(ipc, /ipcMain\.handle\('youtube-content-open'/);
  assert.match(ipc, /shell\.openExternal\(safeUrl\)/);
  assert.match(desktopPreloadSource, /openYouTubeContent: \(targetUrl\) => ipcRenderer\.invoke\('youtube-content-open', targetUrl\)/);

  const normalizerSource = sourceBetween(
    desktopMainSource,
    'function normalizeYouTubeContentUrl',
    "ipcMain.handle('youtube-content-open'",
  );
  const normalizeYouTubeContentUrl = Function(`${normalizerSource}; return normalizeYouTubeContentUrl;`)();
  assert.equal(
    normalizeYouTubeContentUrl('https://music.youtube.com/watch?v=abc_123&redirect=https://evil.example'),
    'https://music.youtube.com/watch?v=abc_123',
  );
  assert.equal(
    normalizeYouTubeContentUrl('https://www.youtube.com/playlist?list=LL#fragment'),
    'https://www.youtube.com/playlist?list=LL',
  );
  assert.equal(
    normalizeYouTubeContentUrl('https://music.youtube.com/channel/channel_123/'),
    'https://music.youtube.com/channel/channel_123',
  );
  assert.equal(
    normalizeYouTubeContentUrl('https://music.youtube.com/search?q=hello%20world'),
    'https://music.youtube.com/search?q=hello+world',
  );
  [
    'http://music.youtube.com/watch?v=abc',
    'https://music.youtube.com.evil.example/watch?v=abc',
    'https://accounts.google.com/o/oauth2/v2/auth',
    'https://music.youtube.com/redirect?q=https://evil.example',
    'https://music.youtube.com/watch?v=abc%2Fdef',
    'https://user@music.youtube.com/watch?v=abc',
  ].forEach(url => assert.equal(normalizeYouTubeContentUrl(url), '', url));

  [
    /YT\.Player/,
    /youtube\.com\/iframe_api/,
    /v155-youtube-player/,
    /v155-youtube-host/,
    /loadVideoById/,
    /window\.open\(/,
  ].forEach(pattern => assert.doesNotMatch(youtubeSource, pattern));
  assert.doesNotMatch(youtubeCssSource, /top:\s*-10000px|youtube-playing|v155-youtube-player|v155-youtube-host/);
});
