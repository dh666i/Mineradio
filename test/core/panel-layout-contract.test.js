'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const v140Styles = fs.readFileSync(path.join(root, 'public', 'css', 'v140.css'), 'utf8');
const v140Source = fs.readFileSync(path.join(root, 'public', 'js', 'v140.js'), 'utf8');
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

test('rounded scrolling panels inset their scrollbar tracks', () => {
  assert.match(v140Styles, /#search-results,[\s\S]*?#playlist-panel\s*\{\s*--panel-scrollbar-end-gap:\s*10px;/);
  assert.match(v140Styles, /#search-results::\-webkit-scrollbar-track,[\s\S]*?#playlist-panel::\-webkit-scrollbar-track\s*\{[\s\S]*?margin-block:\s*var\(--panel-scrollbar-end-gap\);/);
});

test('pointer boundary cleanup closes only transient player chrome', () => {
  const cleanup = sourceBetween(indexSource, 'function clearTransientPointerUi', "window.addEventListener('mousemove'");
  assert.match(cleanup, /document\.activeElement === \$input[\s\S]*?\$input\.blur\(\)/);
  assert.match(cleanup, /setPeek\(document\.getElementById\('search-area'\), false, 'search', \{ immediate:true \}\)/);
  assert.match(cleanup, /setPeek\(document\.getElementById\('playlist-panel'\), false, 'pl', \{ immediate:true \}\)/);
  assert.match(cleanup, /if \(immersiveMode \|\| controlsAutoHide\) setControlsHidden\(true\)/);
  assert.doesNotMatch(cleanup, /close(?:Settings|Login|User|Gsap)Modal/);
  assert.match(indexSource, /function didPointerExitViewport\(e\)[\s\S]*?x <= 1 \|\| y <= 1 \|\| x >= innerWidth - 1 \|\| y >= innerHeight - 1/);
  assert.match(indexSource, /document\.documentElement\.addEventListener\('pointerleave'[\s\S]*?didPointerExitViewport\(e\)[\s\S]*?clearTransientPointerUi\('root-pointerleave'\)/);
  assert.match(indexSource, /desktopRuntimeState\.minimized \|\| !desktopRuntimeState\.visible \|\| !desktopRuntimeState\.focused[\s\S]*?clearTransientPointerUi\('desktop-runtime-state'\)/);
});

test('desktop search stays interactive across the titlebar hover corridor', () => {
  assert.match(indexSource, /id="desktop-search-hover-bridge"/);
  assert.match(indexSource, /#desktop-search-hover-bridge\{[^}]*width:clamp\(240px,calc\(100vw - 160px\),700px\)[^}]*pointer-events:none[^}]*-webkit-app-region:drag/);
  assert.match(indexSource, /#desktop-search-hover-bridge\.active\{pointer-events:auto;-webkit-app-region:no-drag\}/);
  assert.match(indexSource, /body\.desktop-shell #search-area\.peek\{top:46px\}/);
  assert.match(indexSource, /key === 'search'\) setDesktopSearchHoverBridgeActive\(true\)/);
  assert.match(indexSource, /key === 'search'\) setDesktopSearchHoverBridgeActive\(false\)/);
  const immersiveCleanup = sourceBetween(indexSource, 'function closeImmersiveInterference', 'function setImmersiveMode');
  assert.match(immersiveCleanup, /setDesktopSearchHoverBridgeActive\(false\)/);
});

test('paused session restoration reveals visuals without starting playback', () => {
  const restore = sourceBetween(v140Source, 'function restoreQueueSession()', 'function showUndoToast');
  const reveal = sourceBetween(indexSource, 'function revealRestoredPlaybackVisual()', 'function applyStartupStarfieldPreset');
  assert.match(restore, /renderSelectedSongPaused\(playQueue\[currentIdx\]\);[\s\S]*?revealRestoredPlaybackVisual\(\)/);
  assert.match(reveal, /firstPlayDone\s*=\s*true/);
  assert.match(reveal, /tweenParticleAlpha\(currentAlpha, 1\.0, 520\)/);
  assert.doesNotMatch(reveal, /playQueueAt|audio\.play|playing\s*=\s*true/);
});

test('settings exposes an About page with the packaged feedback QR', () => {
  assert.match(indexSource, /data-settings-tab="update">关于<\/button>/);
  assert.match(indexSource, /<h3>关于 Mineradio<\/h3>/);
  assert.match(indexSource, /assets\/wechat-feedback-qr\.png/);
  assert.match(indexSource, /有功能或优化建议，添加此微信反馈。/);
  const qrPath = path.join(root, 'public', 'assets', 'wechat-feedback-qr.png');
  assert.ok(fs.existsSync(qrPath));
  assert.ok(fs.statSync(qrPath).size > 1000);
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

test('expanded playlist actions keep the collapse control compact', () => {
  const stickyStyles = sourceBetween(v140Styles, '#playlist-panel .pl-detail-sticky {', '#playlist-panel .pl-detail-actions {');
  assert.match(stickyStyles, /border-radius:\s*10px/);
  assert.doesNotMatch(stickyStyles, /border-radius:\s*0/);
  assert.match(v140Styles, /#playlist-panel \.pl-detail-collapse-btn\s*\{[\s\S]*?flex:\s*0 0 30px/);
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
