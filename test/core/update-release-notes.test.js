'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const start = serverSource.indexOf('function cleanReleaseLine');
const end = serverSource.indexOf('function pickReleaseAsset', start);

assert.notEqual(start, -1);
assert.notEqual(end, -1);

const context = {};
vm.createContext(context);
vm.runInContext(serverSource.slice(start, end), context, {
  filename: 'server-release-notes.inline.js',
});

test('release notes omit hidden metadata, URLs, and download headings', () => {
  const notes = context.extractReleaseNotes([
    '## 更新日志',
    '<!-- mineradio-download-page: 备用 | https://download.example/setup -->',
    '- 修复多行歌词层级',
    '- 详细说明：https://example.test/release',
    '- 百度网盘：请查看发布页',
    '- 安装包下载',
    '- 优化 3D 歌单架显示',
  ].join('\n'));

  assert.deepEqual(
    JSON.parse(JSON.stringify(notes)),
    ['修复多行歌词层级', '优化 3D 歌单架显示'],
  );
});
