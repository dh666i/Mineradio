'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const v140Styles = fs.readFileSync(path.join(root, 'public', 'css', 'v140.css'), 'utf8');

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
