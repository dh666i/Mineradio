'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const pagingSource = fs.readFileSync(path.join(root, 'public', 'js', 'v140.js'), 'utf8');
const entitySource = fs.readFileSync(path.join(root, 'public', 'js', 'v150.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const providerRoutesSource = fs.readFileSync(path.join(root, 'lib', 'provider-routes.js'), 'utf8');
const qishuiSource = fs.readFileSync(path.join(root, 'qishui-api.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function searchPolicySource() {
  return sourceBetween(
    'function loggedSearchProvider',
    'function musicSearchProviderUrl',
  );
}

function createPolicyRuntime(options = {}) {
  const loggedIn = new Set(options.loggedIn || []);
  const statuses = options.statuses || {};
  const clock = { now: options.now || 1_900_000_000_000 };
  const sandbox = {
    activeAccountProvider: options.active || 'netease',
    preferredAccountProvider: options.preferred || options.active || 'netease',
    spotifyLoginStatus: statuses.spotify || { reauthRequired: false },
    hasPlatformLogin(provider) {
      return loggedIn.has(provider);
    },
    platformStatus(provider) {
      return statuses[provider] || { loggedIn: loggedIn.has(provider) };
    },
    firstLoggedProvider() {
      if (loggedIn.has(sandbox.preferredAccountProvider)) return sandbox.preferredAccountProvider;
      if (loggedIn.has(sandbox.activeAccountProvider)) return sandbox.activeAccountProvider;
      return ['netease', 'qq', 'kugou', 'qishui', 'spotify'].find(provider => loggedIn.has(provider)) || 'netease';
    },
    songProviderKey(song) {
      return String(song && (song.provider || song.source) || 'netease').toLowerCase();
    },
    window: { pinyinPro: null },
    Date: class extends Date {
      static now() { return clock.now; }
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(
    `${searchPolicySource()}\n` +
      'result = { primarySearchProvider, prioritizeSearchProviders, searchResultIsVisible, ' +
      'filterVisibleSearchResults, rememberUnavailableSearchResult, musicSearchProviders, ' +
      'scoreSongSearchResult, mergeSongSearchResults };',
    sandbox,
  );
  sandbox.advanceTime = milliseconds => { clock.now += milliseconds; };
  return sandbox;
}

function providers(runtime, values) {
  return Array.from(runtime.result.prioritizeSearchProviders(values));
}

test('combined search prioritizes the selected logged-in account, then other logged-in providers', () => {
  const qqPrimary = createPolicyRuntime({
    active: 'qq',
    preferred: 'qq',
    loggedIn: ['netease', 'qq', 'spotify'],
  });
  assert.equal(qqPrimary.result.primarySearchProvider(), 'qq');
  assert.deepEqual(
    providers(qqPrimary, ['netease', 'qq', 'kugou', 'qishui', 'spotify']),
    ['qq', 'netease', 'spotify', 'kugou', 'qishui'],
  );
  assert.deepEqual(
    Array.from(qqPrimary.result.musicSearchProviders('song')),
    ['qq', 'netease', 'spotify', 'kugou', 'qishui'],
  );

  const neteasePrimary = createPolicyRuntime({
    active: 'netease',
    preferred: 'netease',
    loggedIn: ['netease', 'qq'],
  });
  assert.equal(neteasePrimary.result.primarySearchProvider(), 'netease');
  assert.deepEqual(
    providers(neteasePrimary, ['qq', 'netease', 'kugou']),
    ['netease', 'qq', 'kugou'],
  );
});

test('primary search provider skips an expired preferred account and finds another valid login', () => {
  const runtime = createPolicyRuntime({
    active: 'netease',
    preferred: 'netease',
    loggedIn: ['netease', 'qishui'],
    statuses: {
      netease: { loggedIn: true, authExpired: true, reauthRequired: true },
      qishui: { loggedIn: true, authExpired: false, reauthRequired: false },
    },
  });

  assert.equal(runtime.firstLoggedProvider(), 'netease');
  assert.equal(runtime.result.primarySearchProvider(), 'qishui');
  assert.deepEqual(
    providers(runtime, ['netease', 'qq', 'kugou', 'qishui']),
    ['qishui', 'netease', 'qq', 'kugou'],
  );
});

test('explicit provider searches remain scoped to the requested provider', () => {
  const runtime = createPolicyRuntime({ active: 'qq', loggedIn: ['qq', 'netease'] });

  assert.deepEqual(Array.from(runtime.result.musicSearchProviders('netease')), ['netease']);
  assert.deepEqual(Array.from(runtime.result.musicSearchProviders('qq')), ['qq']);
});

test('merged songs use the selected account provider as the first sort key before relevance', () => {
  const runtime = createPolicyRuntime({
    active: 'qq',
    preferred: 'qq',
    loggedIn: ['qq', 'netease'],
  });
  const exactSecondaryMatch = {
    provider: 'netease',
    id: 'netease-exact',
    name: 'Needle',
    artist: 'Needle',
    album: 'Needle',
    playable: true,
  };
  const unrelatedPrimaryMatch = {
    provider: 'qq',
    id: 'qq-unrelated',
    mid: 'qq-unrelated',
    name: 'Completely unrelated track',
    artist: 'Unknown artist',
    playable: true,
  };

  const merged = runtime.result.mergeSongSearchResults(
    [exactSecondaryMatch],
    [unrelatedPrimaryMatch],
    [],
    [],
    [],
    10,
    'Needle',
  );

  assert.deepEqual(Array.from(merged, song => song.provider), ['qq', 'netease']);
});

test('search filtering removes hard-invalid metadata without treating playable false as invalid', () => {
  const runtime = createPolicyRuntime({ active: 'netease', loggedIn: ['netease', 'qq', 'spotify'] });
  const songs = [
    { provider: 'netease', id: 'ne-ok', name: '网易云可播' },
    { provider: 'netease', id: '', name: '缺少 ID' },
    { provider: 'qq', id: '', mid: '', name: 'QQ 缺少 MID' },
    { provider: 'kugou', id: '', hash: '', name: '酷狗缺少 HASH' },
    { provider: 'qishui', id: '', providerSongId: '', name: '汽水缺少歌曲 ID' },
    { provider: 'spotify', id: '', spotifyId: '', name: 'Spotify 缺少 ID' },
    { provider: 'qq', mid: 'qq-mid', id: 'qq-id', name: 'QQ 待取链', playable: false },
    { provider: 'spotify', spotifyId: 'sp-id', id: 'sp-id', name: 'Spotify 跨平台匹配', playable: false },
    { provider: 'qishui', providerSongId: 'qs-id', id: 'qs-id', name: '平台限制但可回退', playable: false, reason: 'provider_limited' },
    { provider: 'netease', id: 'ne-gone', name: '明确下架', unavailable: true },
  ];

  assert.deepEqual(
    Array.from(runtime.result.filterVisibleSearchResults(songs), song => song.name),
    ['网易云可播', 'QQ 待取链', 'Spotify 跨平台匹配', '平台限制但可回退'],
  );
  assert.equal(runtime.result.searchResultIsVisible(songs[6]), true);
  assert.equal(runtime.result.searchResultIsVisible(songs[7]), true);
  assert.equal(runtime.result.searchResultIsVisible(songs[8]), true);
});

test('only confirmed copyright and URL failures are hidden by the short-lived cache', () => {
  const runtime = createPolicyRuntime({ active: 'qq', loggedIn: ['qq'] });
  const copyright = { provider: 'qq', mid: 'copy-mid', id: 'copy-id', name: '版权不可用', playable: false };
  const url = { provider: 'qq', mid: 'url-mid', id: 'url-id', name: '取链不可用', playable: false };
  const providerLimited = { provider: 'qq', mid: 'limit-mid', id: 'limit-id', name: '平台限制', playable: false };
  const loginRequired = { provider: 'qq', mid: 'login-mid', id: 'login-id', name: '需要登录', playable: false };

  runtime.result.rememberUnavailableSearchResult(copyright, 'copyright_unavailable');
  runtime.result.rememberUnavailableSearchResult(url, 'url_unavailable');
  runtime.result.rememberUnavailableSearchResult(providerLimited, 'provider_limited');
  runtime.result.rememberUnavailableSearchResult(loginRequired, 'login_required');

  assert.equal(runtime.result.searchResultIsVisible(copyright), false);
  assert.equal(runtime.result.searchResultIsVisible(url), false);
  assert.equal(runtime.result.searchResultIsVisible(providerLimited), true);
  assert.equal(runtime.result.searchResultIsVisible(loginRequired), true);

  runtime.result.rememberUnavailableSearchResult(copyright, 'login_required');
  assert.equal(runtime.result.searchResultIsVisible(copyright), false);

  runtime.advanceTime(3 * 60 * 1000 + 1);
  assert.equal(runtime.result.searchResultIsVisible(copyright), true);
  assert.equal(runtime.result.searchResultIsVisible(url), true);
});

test('filtered pages advance with the raw provider count instead of the visible count', () => {
  const paging = sourceBetweenText(
    pagingSource,
    'async function fetchSearchPage',
    'function renderSongSearchResultsV140',
  );

  assert.match(paging, /var rawSongs = Array\.isArray\(value\.songs\)/);
  assert.match(paging, /var rawCount = Math\.max\(0, finite\(value\.rawCount, rawSongs\.length\)\)/);
  assert.match(paging, /filterVisibleSearchResults\(rawSongs\)/);
  assert.match(paging, /finite\(value\.nextOffset, response\.offset \+ rawCount\)/);
  assert.match(paging, /rawCount >= response\.limit/);
  assert.doesNotMatch(paging, /response\.offset \+ songs\.length/);
});

test('artist, album, and playlist searches share the selected-account provider priority', () => {
  const providerSelection = sourceBetweenText(
    entitySource,
    'function providersForEntitySearch',
    'function typedSearchUrl',
  );

  assert.match(providerSelection, /window\.prioritizeSearchProviders\(supported\)/);
  assert.match(providerSelection, /return supported\.indexOf\(mode\) >= 0 \? \[mode\] : \[\]/);
});

test('audio element startup failure records a short-lived URL-unavailable result', () => {
  const startupFailure = sourceBetween(
    'if (!playbackStarted) {',
    'if (invocationRecovery && !sourceFallbackRecoveryCanContinue(invocationRecovery)) {',
  );

  assert.match(startupFailure, /rememberUnavailableSearchResult\(song, 'url_unavailable'\)/);
  assert.match(startupFailure, /tryAutoPlaybackFallback\(song, \{\s*reason: 'url_unavailable'/);
});

test('QQ and Kugou search responses preserve raw paging progress before filtering', () => {
  const qqSearch = sourceBetweenText(
    serverSource,
    'async function handleQQSearch',
    'function decodeQQSearchText',
  );
  const kugouRoute = sourceBetweenText(
    providerRoutesSource,
    "if (pathname === '/api/kugou/search')",
    "if (pathname === '/api/kugou/recommendations')",
  );

  assert.match(qqSearch, /rawCount:\s*page\.length/);
  assert.match(qqSearch, /nextOffset:\s*pageOffset \+ page\.length/);

  assert.match(kugouRoute, /(?:const|let) result = await kugou\.handleKugouSearch/);
  assert.match(kugouRoute, /songs:\s*result\.songs/);
  assert.match(kugouRoute, /rawCount:\s*result\.rawCount/);
  assert.match(kugouRoute, /nextOffset:\s*result\.nextOffset/);
});

test('Qishui PC search advances nextOffset by raw upstream items before filtering', () => {
  const pcSearch = sourceBetweenText(
    qishuiSource,
    'async function handleQishuiPcSearch',
    'async function handleQishuiTypedSearch',
  );

  assert.match(pcSearch, /const rawItems = extractQishuiPcSearchItems\(json\)/);
  assert.match(pcSearch, /rawCount:\s*rawItems\.length/);
  assert.match(pcSearch, /nextOffset:\s*offset \+ rawItems\.length/);
  assert.doesNotMatch(pcSearch, /nextOffset:\s*offset \+ songs\.length/);
});

test('clicking the active source from a typed view reruns comprehensive search from the input', () => {
  const sourceTabs = sourceBetweenText(
    entitySource,
    "var sourceTabs = byId('search-mode-tabs')",
    "var discover = byId('v150-discover-modal')",
  );

  assert.match(sourceTabs, /sourceTabs\.addEventListener\('click', function \(event\)/);
  assert.match(sourceTabs, /var requestedMode = button \? button\.id\.slice\('search-mode-'\.length\) : ''/);
  assert.match(sourceTabs, /var previousMode = currentMode\(\)/);
  assert.match(sourceTabs, /var returningFromTypedView = typedSearch\.type !== 'all'/);
  assert.match(sourceTabs, /setTimeout\(function \(\) \{\s*resetSearchTypeToComprehensive\(\);\s*syncSearchTypeUi\(\)/);
  assert.match(
    sourceTabs,
    /returningFromTypedView && requestedMode === previousMode && requestedMode === currentMode\(\)/,
  );
  assert.match(sourceTabs, /var input = byId\('search-input'\);\s*var query = input \? input\.value\.trim\(\) : ''/);
  assert.match(sourceTabs, /if \(query\) window\.doSearch\(query\)/);
});

function sourceBetweenText(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return text.slice(start, end);
}
