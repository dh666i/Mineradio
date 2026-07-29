'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const vendorSource = fs.readFileSync(path.join(root, 'public', 'vendor', 'pinyin-pro.min.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('packaged pinyin bundle supports full pinyin and initial matching', () => {
  const sandbox = {};
  vm.runInNewContext(vendorSource, sandbox);

  assert.deepEqual(Array.from(sandbox.pinyinPro.match('周杰伦', 'zjl')), [0, 1, 2]);
  assert.deepEqual(Array.from(sandbox.pinyinPro.match('青花瓷', 'qinghuaci')), [0, 1, 2]);
  assert.match(indexSource, /<script src="vendor\/pinyin-pro\.min\.js"><\/script>/);
});

test('song ranking boosts pinyin title and artist matches without making the library mandatory', () => {
  const helperSource = sourceBetween(
    indexSource,
    'function tryPinyinBoost',
    'function scoreSongSearchResult',
  );
  const library = require('pinyin-pro');
  const sandbox = {
    window: { pinyinPro: library },
  };

  vm.runInNewContext(`${helperSource}; result = tryPinyinBoost({ name: '青花瓷', artist: '周杰伦' }, 'qhc');`, sandbox);
  assert.ok(sandbox.result >= 50);

  sandbox.window.pinyinPro = null;
  vm.runInNewContext(`${helperSource}; fallbackResult = tryPinyinBoost({ name: '青花瓷' }, 'qhc');`, sandbox);
  assert.equal(sandbox.fallbackResult, 0);
  assert.match(indexSource, /score \+= tryPinyinBoost\(song, q\)/);
});
