'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  appIconPath,
  chromiumPerformanceSwitches,
  filesystemPathKey,
  runtimeCapabilities,
} = require('../../desktop/platform-runtime');

test('Windows-only Chromium switches are not applied on macOS', () => {
  const windows = chromiumPerformanceSwitches('win32');
  const mac = chromiumPerformanceSwitches('darwin');

  assert.ok(windows.some(item => item[0] === 'use-angle' && item[1] === 'd3d11'));
  assert.ok(windows.some(item => item[0] === 'force_high_performance_gpu'));
  assert.equal(mac.some(item => item[0] === 'use-angle'), false);
  assert.equal(mac.some(item => item[0] === 'force_high_performance_gpu'), false);
  assert.ok(mac.some(item => item[0] === 'enable-gpu-rasterization'));
});

test('runtime selects native icon formats and installer capabilities', () => {
  const root = path.resolve('fixture-root');

  assert.equal(appIconPath(root, 'win32'), path.join(root, 'build', 'icon.ico'));
  assert.equal(appIconPath(root, 'darwin'), path.join(root, 'build', 'icon.png'));
  assert.equal(runtimeCapabilities('win32').installerUpdates, true);
  assert.equal(runtimeCapabilities('darwin').installerUpdates, false);
  assert.equal(runtimeCapabilities('darwin').taskbarMediaButtons, false);
});

test('path identity remains case-sensitive outside Windows', () => {
  assert.equal(filesystemPathKey('Case/Path', 'win32'), filesystemPathKey('case/path', 'win32'));
  assert.notEqual(filesystemPathKey('Case/Path', 'darwin'), filesystemPathKey('case/path', 'darwin'));
});
