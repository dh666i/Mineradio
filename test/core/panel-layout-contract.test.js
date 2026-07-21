'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const v140Styles = fs.readFileSync(path.join(root, 'public', 'css', 'v140.css'), 'utf8');
const defaultFxArchive = JSON.parse(fs.readFileSync(path.join(root, 'public', 'default-user-fx-archive.json'), 'utf8'));

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('queue rows keep title and artist on separate clipped lines', () => {
  assert.match(v140Styles, /\.queue-main-hit \.qi-info\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow:\s*hidden;/);
  assert.match(v140Styles, /\.queue-main-hit \.qi-name,[\s\S]*?\.queue-main-hit \.qi-sub\s*\{[\s\S]*?display:\s*block;[\s\S]*?text-overflow:\s*ellipsis;/);
});

test('library panel contains horizontal overflow and queue actions', () => {
  assert.match(v140Styles, /#playlist-panel\s*\{[\s\S]*?overflow-x:\s*hidden;/);
  assert.match(v140Styles, /#playlist-panel \.queue-item \.qi-act\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?pointer-events:\s*none;/);
  assert.match(v140Styles, /#playlist-panel \.queue-item:hover \.queue-main-hit,[\s\S]*?padding-right:\s*108px;/);
});

test('inline playlist detail is not rendered as a nested glass panel', () => {
  assert.match(v140Styles, /#playlist-panel \.pl-inline-detail,[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?box-shadow:\s*none\s*!important;/);
});

test('expanded playlist reuses its card as the only title header', () => {
  const detailRenderer = sourceBetween(
    indexSource,
    'function playlistPanelDetailHtml',
    'function renderPlaylistPanelDetailState',
  );
  assert.doesNotMatch(detailRenderer, /pl-detail-head|data-pl-detail-top/);
  assert.match(detailRenderer, /data-pl-detail-collapse/);
  assert.match(indexSource, /登录后显示网易云歌单/);
});

test('stage lyric layout modes are wired through UI and persisted settings', () => {
  assert.match(indexSource, /id="lyric-layout-seg"/);
  assert.match(indexSource, /data-lyric-layout="auto"/);
  assert.match(indexSource, /data-lyric-layout="focus"/);
  assert.match(indexSource, /data-lyric-layout="three"/);

  const defaults = sourceBetween(indexSource, 'var fxDefaults = {', 'var PACKAGED_DEFAULT_USER_FX_ARCHIVE_NAME');
  const reader = sourceBetween(indexSource, 'function readSavedLyricLayout()', 'function saveLyricLayout()');
  const writer = sourceBetween(indexSource, 'function saveLyricLayout()', 'function normalizeHexColor');
  const archive = sourceBetween(indexSource, 'function normalizeFxArchiveSnapshot', 'function readUserFxArchives');
  const reset = sourceBetween(indexSource, 'function resetFx()', 'function setShelfMode');
  assert.match(defaults, /lyricLayoutMode:\s*'auto'/);
  assert.match(reader, /lyricLayoutMode:\s*normalizeLyricLayoutMode\(raw\.lyricLayoutMode\)/);
  assert.match(writer, /lyricLayoutMode:\s*normalizeLyricLayoutMode\(fx\.lyricLayoutMode\)/);
  assert.match(archive, /archiveMode\(raw,\s*'lyricLayoutMode',\s*\/\^\(auto\|focus\|three\)\$\//);
  assert.match(reset, /refreshCurrentLyricStyle\(\)/);
  assert.equal(defaultFxArchive.snapshot.lyricLayoutMode, 'auto');
});

test('stage lyric shader maps progress and opacity per visual row', () => {
  const material = sourceBetween(indexSource, 'function makeLyricShaderMaterial', 'function buildLyricMesh');
  const progress = sourceBetween(indexSource, 'function updateLyricMeshProgress', 'function showStageLine');
  const replacement = sourceBetween(indexSource, 'function captureStageLyricVisualState', 'function refreshCurrentLyricStyle');
  assert.match(material, /glyph\.rgb \/ max\(mask/);
  assert.match(material, /rowHighlight = step/);
  assert.match(material, /mask \* uOpacity \* rowOpacity/);
  assert.match(progress, /uProgress\.value = progress/);
  assert.match(replacement, /replaceImmediately/);
  assert.match(replacement, /applyStageLyricVisualState\(mesh, carriedVisualState\)/);
  assert.doesNotMatch(material, /uRows\[/);
});

test('compact and portrait lyric masks preserve a safe world-space width', () => {
  const mask = sourceBetween(indexSource, 'function makeLyricMask', 'function makeLyricReadabilityTexture');
  const worldWidth = sourceBetween(indexSource, 'function stageLyricWorldWidth', 'function buildLyricMesh');
  const mesh = sourceBetween(indexSource, 'function buildLyricMesh', 'function updateLyricMeshProgress');
  const updater = sourceBetween(indexSource, 'function updateStageLyrics3D', 'function getLyricLineProgress');

  assert.match(mask, /STAGE_LYRIC_MASK_BASE_WIDTH \* 0\.75/);
  assert.match(mask, /row\.fitScaleX = row\.measuredWidth > maxWidth \? maxWidth \/ row\.measuredWidth : 1/);
  assert.doesNotMatch(mask, /minFit/);
  assert.match(worldWidth, /textureWidth \/ STAGE_LYRIC_MASK_BASE_WIDTH/);
  assert.match(worldWidth, /orientation === 'portrait' \? 0\.75 : 1/);
  assert.match(mesh, /stageLyricWorldWidth\(mask\)/);
  assert.match(updater, /currentLayout\.orientation === 'portrait'/);
  assert.match(updater, /camera\.position\.distanceTo\(lyricViewportFitWorldPos\)/);
  assert.match(updater, /portraitViewportFit && lockFit < stageLyrics\.lockFitScale/);
});
