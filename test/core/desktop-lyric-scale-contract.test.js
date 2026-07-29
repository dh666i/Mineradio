'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const desktopLyricsSource = fs.readFileSync(path.join(root, 'public', 'desktop-lyrics.html'), 'utf8');

test('desktop lyrics allow a compact scale without changing the upper bound', () => {
  assert.match(
    indexSource,
    /id="fx-desktoplyricssize" type="range" min="0\.35" max="1\.55"/,
  );
  assert.doesNotMatch(indexSource, /desktopLyricsSize[^\n]*0\.72,\s*1\.55/);
  assert.match(
    desktopLyricsSource,
    /baseFontSize = Math\.round\(58 \* clamp\(state\.size, \.35, 1\.55, 1\)\)/,
  );
});
