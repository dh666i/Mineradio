'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('volume slider opens only through the explicit button state', () => {
  const volumeBindings = sourceBetween(
    indexSource,
    'function bindVolumeControls',
    'function queueItemKey',
  );
  const volumeToggle = sourceBetween(
    indexSource,
    'function setVolumePanelOpen',
    'function toggleMute',
  );

  assert.match(indexSource, /\.volume-control\.open \.volume-popover/);
  assert.doesNotMatch(indexSource, /\.volume-control:hover \.volume-popover/);
  assert.doesNotMatch(indexSource, /\.volume-control:focus-within \.volume-popover/);
  assert.doesNotMatch(indexSource, /\.volume-control:hover::before/);
  assert.doesNotMatch(volumeBindings, /mouseenter|mouseleave|dblclick/);
  assert.match(volumeBindings, /slider\.addEventListener\('input'/);
  assert.match(volumeBindings, /slider\.addEventListener\('change'/);
  assert.match(volumeBindings, /wrap\.addEventListener\('wheel'/);
  assert.match(volumeBindings, /e\.preventDefault\(\)/);
  assert.match(volumeBindings, /Math\.abs\(wheelCarry\) < 24/);
  assert.match(volumeBindings, /wheelCarry < 0 \? 0\.05 : -0\.05/);
  assert.match(volumeBindings, /setVolume\(clampRange\(targetVolume \+ step, 0, 1\), false\)/);
  assert.match(volumeBindings, /\{ passive: false \}/);
  assert.match(volumeBindings, /!wrap\.contains\(e\.target\).*setVolumePanelOpen\(false\)/);
  assert.match(volumeToggle, /button\.setAttribute\('aria-expanded', expanded \? 'true' : 'false'\)/);
  assert.match(indexSource, /id="volume-btn"[^>]*aria-expanded="false"[^>]*aria-controls="volume-popover"/);
});

test('mini queue close action remains a compact header icon', () => {
  assert.match(indexSource, /\.mini-queue-close\{width:28px;height:28px;flex:0 0 28px;padding:0/);
  assert.match(
    indexSource,
    /<button class="mini-queue-close" type="button" onclick="closeMiniQueue\(\)"[^>]*><svg/,
  );
  assert.doesNotMatch(indexSource, /<button class="fx-mini-btn ghost" onclick="closeMiniQueue\(\)"/);
});
