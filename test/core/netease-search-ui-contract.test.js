'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const searchSource = fs.readFileSync(path.join(root, 'public', 'js', 'v150.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('music search defaults to a five-provider comprehensive entity view', () => {
  const setType = sourceBetween(
    searchSource,
    'function setNeteaseSearchType',
    'window.setNeteaseSearchType = setNeteaseSearchType',
  );

  assert.match(searchSource, /var SEARCH_TYPES = \['all', 'song', 'artist', 'album', 'playlist'\]/);
  assert.match(searchSource, /var SEARCH_TYPE_LABELS = \{\s*all: '综合'/);
  assert.match(searchSource, /var typedSearch = \{\s*type: 'all'/);
  assert.match(searchSource, /sections: null,\s*partialFailures: \[\]/);
  assert.match(
    searchSource,
    /var ENTITY_SEARCH_PROVIDERS = \['netease', 'qq', 'kugou', 'qishui', 'spotify'\]/,
  );
  assert.match(searchSource, /artist: \['netease', 'qq'\]/);
  assert.match(searchSource, /album: \['netease', 'spotify'\]/);
  assert.match(searchSource, /playlist: ENTITY_SEARCH_PROVIDERS\.slice\(\)/);
  assert.match(searchSource, /var visible = supportsEntitySearch\(\)/);
  assert.match(searchSource, /button\.disabled = !supported/);
  assert.match(
    searchSource,
    /body\.empty-home-active\.diy-mode #search-area:not\(\.has-results\) #v150-search-types\{display:none\}/,
  );
  assert.match(setType, /else if \(typeof window\.renderSearchHistory === 'function'\) window\.renderSearchHistory\(\)/);
  assert.match(indexSource, /id="search-mode-netease"[\s\S]*?>网易云<\/button>/);
  assert.match(indexSource, /id="search-mode-qq"[\s\S]*?>QQ 音乐<\/button>/);
});

test('comprehensive search fans out through the supported provider matrix', () => {
  const comprehensive = sourceBetween(
    searchSource,
    'async function fetchComprehensiveSongSection',
    'async function runTypedSearch',
  );

  assert.match(comprehensive, /Promise\.allSettled/);
  assert.match(comprehensive, /songSearchProviders\(sourceMode\)/);
  assert.match(comprehensive, /providersForEntitySearch\(type, sourceMode\)/);
  assert.match(comprehensive, /typedSearchUrl\(provider, type, query, limit, 0\)/);
  assert.match(comprehensive, /fetchComprehensiveSongSection\(query, 8, sourceMode\)/);
  assert.match(comprehensive, /fetchComprehensiveEntitySection\(query, 'artist', 6, sourceMode\)/);
  assert.match(comprehensive, /fetchComprehensiveEntitySection\(query, 'album', 6, sourceMode\)/);
  assert.match(comprehensive, /fetchComprehensiveEntitySection\(query, 'playlist', 6, sourceMode\)/);
  assert.match(comprehensive, /typedSearch\.partialFailures = failures\.filter/);
  assert.match(comprehensive, /failedSections === requests\.length/);
  assert.doesNotMatch(searchSource, /youtube|oauth|google/i);
});

test('comprehensive results keep all entity sections and their actions', () => {
  const rendering = sourceBetween(
    searchSource,
    'function comprehensiveSectionHead',
    'async function runComprehensiveSearch',
  );
  const entityOpen = sourceBetween(
    searchSource,
    'function openTypedItem',
    'async function playAllComprehensiveSearchSongs',
  );

  assert.match(rendering, /var order = \['song', 'artist', 'album', 'playlist'\]/);
  assert.match(rendering, /data-v150-play-comprehensive="1"/);
  assert.match(rendering, /data-v150-view-type="/);
  assert.match(rendering, /data-v150-comprehensive-type=/);
  assert.match(rendering, /其他分类结果已正常保留/);
  assert.match(rendering, /当前平台暂不支持此分类/);
  assert.match(entityOpen, /openArtistDetailForSong/);
  assert.match(entityOpen, /openAlbumDetail/);
  assert.match(entityOpen, /openProviderPlaylistDetail/);
  assert.match(entityOpen, /window\.playSearchResult\(index\)/);
});

test('comprehensive play-all expands into the full multi-provider song result', () => {
  const playAll = sourceBetween(
    searchSource,
    'async function playAllComprehensiveSearchSongs',
    'async function playAllNeteaseSearchResults',
  );
  const bindings = sourceBetween(
    searchSource,
    'function bindEvents',
    'function installOverrides',
  );

  assert.match(playAll, /typedSearch\.type = 'song'/);
  assert.match(playAll, /await legacy\.doSearch\(query\)/);
  assert.match(playAll, /currentMode\(\) !== sourceMode \|\| currentQuery !== query/);
  assert.match(playAll, /currentMode\(\) !== sourceMode \|\| fallbackQuery !== query/);
  assert.match(playAll, /return legacy\.playAllSearchResults\(\)/);
  assert.match(playAll, /完整搜索加载失败，先播放当前/);
  assert.match(bindings, /playAllComprehensiveSearchSongs\(\)/);
});

test('typing immediately cancels stale comprehensive results and play-all work', () => {
  const bindings = sourceBetween(
    searchSource,
    'function bindEvents',
    'function installOverrides',
  );
  const inputHandler = sourceBetween(
    bindings,
    "searchInput.addEventListener('input'",
    "var sourceTabs = byId('search-mode-tabs')",
  );

  assert.match(inputHandler, /if \(!supportsEntitySearch\(\) \|\| typedSearch\.type === 'song'\) return/);
  assert.match(inputHandler, /searchPlayAllToken \+= 1;\s*resetTypedSearch\(true\)/);
  assert.doesNotMatch(inputHandler, /searchInput\.value\.trim\(\)/);
});

test('individual entity tabs retain independent provider paging and load-more behavior', () => {
  const typedSearch = sourceBetween(
    searchSource,
    'async function runTypedSearch',
    'function openTypedItem',
  );
  const bindings = sourceBetween(
    searchSource,
    'function bindEvents',
    'function installOverrides',
  );

  assert.match(typedSearch, /providersForEntitySearch\(type, sourceMode\)/);
  assert.match(typedSearch, /typedSearch\.providerPages\[provider\]/);
  assert.match(typedSearch, /typedSearchUrl\(provider, type, query, limit, offset\)/);
  assert.match(typedSearch, /var nextOffset = finite\(/);
  assert.match(typedSearch, /var hasMore = experience\.pageHasMore/);
  assert.match(typedSearch, /typedSearch\.hasMore = providers\.some/);
  assert.match(typedSearch, /mergeProviderEntities\(append \? typedSearch\.items : \[\]/);
  assert.match(bindings, /data-v150-load-more-typed/);
  assert.match(bindings, /data-v150-view-type/);
  assert.match(bindings, /setNeteaseSearchType\(viewType\.getAttribute\('data-v150-view-type'\)\)/);
});
