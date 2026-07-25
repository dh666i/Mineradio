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

test('Netease search defaults to a comprehensive entity view', () => {
  const setType = sourceBetween(
    searchSource,
    'function setNeteaseSearchType',
    'window.setNeteaseSearchType = setNeteaseSearchType',
  );

  assert.match(searchSource, /var SEARCH_TYPES = \['all', 'song', 'artist', 'album', 'playlist'\]/);
  assert.match(searchSource, /var SEARCH_TYPE_LABELS = \{\s*all: '综合'/);
  assert.match(searchSource, /var typedSearch = \{\s*type: 'all'/);
  assert.match(searchSource, /sections: null,\s*partialFailures: \[\]/);
  assert.match(setType, /else if \(typeof window\.renderSearchHistory === 'function'\) window\.renderSearchHistory\(\)/);
  assert.match(
    indexSource,
    /function renderSearchHistory\(\) \{\s*if \(searchMode !== 'song' && searchMode !== 'netease'\) return false;/,
  );
});

test('comprehensive search fans out only through existing Netease endpoints', () => {
  const comprehensive = sourceBetween(
    searchSource,
    'async function runComprehensiveSearch',
    'async function runTypedSearch',
  );

  assert.match(comprehensive, /Promise\.allSettled/);
  assert.match(comprehensive, /\/api\/search\?keywords=[\s\S]*?&limit=8&offset=0/);
  assert.match(comprehensive, /\/api\/search\/typed\?keywords=[\s\S]*?&type=artist&limit=6&offset=0/);
  assert.match(comprehensive, /\/api\/search\/typed\?keywords=[\s\S]*?&type=album&limit=6&offset=0/);
  assert.match(comprehensive, /\/api\/search\/typed\?keywords=[\s\S]*?&type=playlist&limit=6&offset=0/);
  assert.match(comprehensive, /if \(failures\.length === requests\.length\) throw/);
  assert.match(comprehensive, /typedSearch\.partialFailures = failures/);
  assert.match(comprehensive, /nextOffset: nextOffset/);
  assert.match(comprehensive, /hasMore: !failed && experience\.pageHasMore/);
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
    'async function playAllNeteaseSearchResults',
  );

  assert.match(rendering, /var order = \['song', 'artist', 'album', 'playlist'\]/);
  assert.match(rendering, /data-v150-play-comprehensive="1"/);
  assert.match(rendering, /data-v150-view-type="/);
  assert.match(rendering, /data-v150-comprehensive-type=/);
  assert.match(rendering, /其他分类结果已正常保留/);
  assert.match(entityOpen, /openArtistDetailForSong/);
  assert.match(entityOpen, /openAlbumDetail/);
  assert.match(entityOpen, /openNeteasePlaylistDetail/);
  assert.match(entityOpen, /window\.playSearchResult\(index\)/);
});

test('comprehensive play-all continues paging up to the queue safety cap', () => {
  const playAll = sourceBetween(
    searchSource,
    'async function playAllNeteaseSearchResults',
    'function discoverSection',
  );
  const bindings = sourceBetween(
    searchSource,
    'function bindEvents',
    'function installOverrides',
  );

  assert.match(playAll, /var expectedType = options\.expectedType \|\| 'song'/);
  assert.match(playAll, /var sourceItems = Array\.isArray\(options\.initialItems\)/);
  assert.match(playAll, /typedSearch\.type === expectedType/);
  assert.match(playAll, /experience\.collectPaged/);
  assert.match(playAll, /\/api\/search\?keywords=/);
  assert.match(playAll, /limit: 50,\s*maxItems: 5000,\s*maxPages: 100/);
  assert.match(playAll, /if \(result\.truncated\)[\s\S]*?结果过多，已载入前/);
  assert.match(playAll, /searchPlayAllBusyToken = operationToken/);
  assert.match(playAll, /if \(searchPlayAllBusyToken === operationToken\) hideOperationSoon\(\)/);
  assert.match(playAll, /if \(searchPlayAllBusyToken === operationToken\) searchPlayAllBusyToken = 0/);
  assert.match(bindings, /expectedType: 'all'/);
  assert.match(bindings, /offset: songSection\.nextOffset/);
  assert.match(bindings, /hasMore: songSection\.hasMore/);
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

  assert.match(inputHandler, /if \(currentMode\(\) !== 'netease' \|\| typedSearch\.type === 'song'\) return/);
  assert.match(inputHandler, /searchPlayAllToken \+= 1;\s*resetTypedSearch\(true\)/);
  assert.doesNotMatch(inputHandler, /searchInput\.value\.trim\(\)/);
});

test('individual entity tabs retain paging and load-more behavior', () => {
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

  assert.match(typedSearch, /\/api\/search\/typed\?keywords=/);
  assert.match(typedSearch, /typedSearch\.offset = finite\(payload\.nextOffset, responseOffset \+/);
  assert.match(typedSearch, /typedSearch\.hasMore = experience\.pageHasMore/);
  assert.match(bindings, /data-v150-load-more-typed/);
  assert.match(bindings, /data-v150-view-type/);
  assert.match(bindings, /setNeteaseSearchType\(viewType\.getAttribute\('data-v150-view-type'\)\)/);
});
