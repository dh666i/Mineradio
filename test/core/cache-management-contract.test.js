'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const v140Source = fs.readFileSync(path.join(root, 'public', 'js', 'v140.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('desktop stores beat maps under Electron userData', () => {
  assert.match(mainSource, /function getBeatmapCacheDir\(\)[\s\S]*?app\.getPath\('userData'\)[\s\S]*?'cache', 'beatmaps'/);
  assert.match(mainSource, /process\.env\.MINERADIO_BEAT_CACHE_DIR = getBeatmapCacheDir\(\)/);
  assert.doesNotMatch(serverSource, /D:\\\\MineradioCache/);
});

test('cache clear is limited to cache data and exposed through trusted IPC', () => {
  const clearCacheSource = sourceBetween(mainSource, 'async function clearMineradioCaches()', 'function sanitizeSettingsEntries');
  assert.match(mainSource, /ipcMain\.handle\('mineradio-cache-clear'/);
  assert.match(clearCacheSource, /session\.defaultSession/);
  assert.match(clearCacheSource, /\.clearCache\(\)/);
  assert.match(clearCacheSource, /\.clearCodeCaches\(\{\}\)/);
  assert.match(mainSource, /entry\.isFile\(\)[\s\S]*?\\\.\(\?:json\|tmp\)/);
  assert.doesNotMatch(clearCacheSource, /(?:cookies|localStorage|settings|playlist)/i);
  assert.match(preloadSource, /clearCache: \(\) => ipcRenderer\.invoke\('mineradio-cache-clear'\)/);
});

test('About page exposes cache clear without deleting user data', () => {
  assert.match(indexSource, /onclick="clearApplicationCacheFromSettings\(\)">清理缓存<\/button>/);
  assert.match(v140Source, /window\.clearApplicationCacheFromSettings = async function/);
  assert.match(v140Source, /api\.clearCache\(\)/);
  assert.match(serverSource, /req\.method === 'DELETE'[\s\S]*?clearBeatMapCache\(\)/);
  assert.match(serverSource, /UNTRUSTED_MUTATION_REQUEST/);
});
