'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  discoverQishuiClientDataRoots,
} = require('../../desktop/qishui-local-session-discovery');

test('macOS discovery includes Application Support and sandbox containers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-qishui-macos-'));
  const appData = path.join(home, 'Library', 'Application Support');
  const container = path.join(home, 'Library', 'Containers', 'com.bytedance.sodamusic');
  try {
    fs.mkdirSync(appData, { recursive: true });
    fs.mkdirSync(container, { recursive: true });
    const candidates = discoverQishuiClientDataRoots({
      appDataPath: appData,
      homePath: home,
      platform: 'darwin',
    });

    assert.ok(candidates.some(item => item.path === container && item.exists));
    assert.equal(candidates.some(item => item.kind === 'windows-package'), false);
    assert.ok(candidates.some(item => item.hint.startsWith('Application Support/')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Windows package discovery remains Windows-only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-qishui-win-'));
  const local = path.join(root, 'Local');
  const packaged = path.join(local, 'Packages', 'SodaMusic.Client');
  try {
    fs.mkdirSync(packaged, { recursive: true });
    const candidates = discoverQishuiClientDataRoots({
      localAppDataPath: local,
      homePath: root,
      platform: 'win32',
    });

    assert.ok(candidates.some(item => item.path === packaged && item.kind === 'windows-package'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
