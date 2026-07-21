'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('core scripts expose the stable MineradioCore browser namespace', () => {
  const context = vm.createContext({});
  const files = [
    'version.js',
    'queue-session.js',
    'lyrics.js',
    'lyric-layout.js',
    'network-errors.js',
  ];

  files.forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, '../../public/js/core', file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  });

  assert.equal(typeof context.MineradioCore.version.compareVersions, 'function');
  assert.equal(typeof context.MineradioCore.queueSession.restoreQueueSnapshot, 'function');
  assert.equal(typeof context.MineradioCore.lyrics.alignTranslatedLyrics, 'function');
  assert.equal(typeof context.MineradioCore.lyricLayout.buildLyricLayout, 'function');
  assert.equal(typeof context.MineradioCore.networkErrors.classifyNetworkError, 'function');
});
