'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const ui = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('finalizing listen statistics cannot recursively start a new session', () => {
  assert.match(ui, /function updateListenStatsTick\(force,\s*noRestart\)/);
  assert.match(ui, /if\s*\(!noRestart\s*&&\s*\(!listenSession\s*\|\|\s*listenSession\.key\s*!==\s*key\)\)/);
  assert.match(ui, /function finalizeListenSession\(completed\)[\s\S]*?updateListenStatsTick\(true,\s*true\)/);
});

test('the first rendered accent matches the packaged white default', () => {
  assert.match(ui, /--fc-accent:#FFFFFF/);
  assert.match(ui, /--fc-accent-rgb:255,255,255/);
  assert.match(ui, /id="ui-accent-picker"[^>]+value="#ffffff"/);
  assert.match(ui, /function defaultUiAccentColor\(\)/);
});

test('playlist shelf detail stays above the visual scene without the old floor mirror', () => {
  assert.doesNotMatch(ui, /\bfloorMirror\b/);
  assert.match(ui, /group\.renderOrder\s*=\s*\(contentOpenForLayer\s*\|\|\s*shelfPinnedOpen\s*\|\|\s*liftedCardActive\)\s*\?\s*300\s*:\s*30/);
  assert.match(ui, /group\.renderOrder\s*=\s*320/);
});

test('v2.0.3 keeps lyric layers readable after shelf and cursor state changes', () => {
  assert.match(ui, /function syncStageLyricRenderOrder\(renderBase\)/);
  assert.match(ui, /stageLyrics\.current\.renderOrder = renderBase/);
  assert.match(ui, /stageLyrics\.outgoing\[i\]\.renderOrder = renderBase/);
  assert.match(ui, /var stageLyricRenderBase = shelfDetailOpen \? 24 : 38/);
  assert.match(ui, /syncStageLyricRenderOrder\(stageLyricRenderBase\)/);
  assert.match(ui, /function shelfPointerSelectionForegroundActive\(\)/);
  assert.match(ui, /selectedIdx >= 0 && !document\.body\.classList\.contains\('cursor-hidden'\)/);
  assert.match(ui, /card\.selected && shelfPointerSelectionForegroundActive\(\) && !detailOpenSide/);
  assert.match(ui, /\(contentList && contentList\.isOpen\(\)\) \|\| shelfPointerSelectionForegroundActive\(\)/);
});

test('startup preview preserves and restores the saved playback visual preset', () => {
  assert.match(ui, /var playbackVisualPreset = readSavedPlaybackVisualPreset\(\)/);
  assert.match(ui, /function applyStartupStarfieldPreset\(\)[\s\S]*?startupVisualPreviewActive = true;[\s\S]*?setPreset\(5, \{ silent: true, preserveCamera: false, skipTransition: true, noSave: true \}\)/);
  assert.match(ui, /function saveLyricLayout\(\)[\s\S]*?startupVisualPreviewActive && !playing && currentIdx < 0[\s\S]*?\? playbackVisualPreset/);
  assert.match(ui, /function switchPlaybackVisualToEmily\(\)[\s\S]*?var targetPreset = typeof playbackVisualPreset === 'number' \? playbackVisualPreset : fxDefaults\.preset;[\s\S]*?startupVisualPreviewActive = false;[\s\S]*?setPreset\(targetPreset, \{ silent: true, preserveCamera: false, noSave: true \}\)/);
});

test('Netease VIP type ignores unrelated numeric level fields', () => {
  const match = server.match(/function normalizeNeteaseVip\([\s\S]*?function normalizeLoginInfo/);
  assert.ok(match, 'normalizeNeteaseVip should be present');
  const implementation = match[0];
  assert.match(implementation, /firstPositiveNumberFrom\(\[profile,\s*account,\s*vipInfo\]/);
  assert.doesNotMatch(implementation, /'redVipLevel'/);
  assert.doesNotMatch(implementation, /'musicVipLevel'/);
  assert.doesNotMatch(implementation, /'blackVipLevel'/);
});
