'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../../public/js/core/lyric-layout');

test('layout mode normalization and automatic viewport selection are stable', () => {
  assert.equal(layout.normalizeLayoutMode('three'), 'three');
  assert.equal(layout.normalizeLayoutMode('unknown'), 'auto');
  assert.equal(layout.resolveLayoutMode('auto', { width: 1920, height: 1080 }), 'focus');
  assert.equal(layout.resolveLayoutMode('auto', { width: 1080, height: 1920 }), 'three');
  assert.equal(layout.resolveLayoutMode('auto', { width: 1000, height: 1000 }), 'three');
  assert.equal(layout.resolveLayoutMode('focus', { width: 800, height: 1400 }), 'focus');
  assert.equal(layout.resolveLayoutMode('auto', {}), 'focus');
});

test('three-line mode keeps context indices inside playlist boundaries', () => {
  assert.deepEqual(layout.getVisibleLyricIndices(3, 0, 'three'), [
    { index: 0, role: 'current', isCurrent: true },
    { index: 1, role: 'next', isCurrent: false },
  ]);
  assert.deepEqual(layout.getVisibleLyricIndices(3, 2, 'three'), [
    { index: 1, role: 'previous', isCurrent: false },
    { index: 2, role: 'current', isCurrent: true },
  ]);
  assert.deepEqual(layout.getVisibleLyricIndices(1, 0, 'three'), [
    { index: 0, role: 'current', isCurrent: true },
  ]);
  assert.deepEqual(layout.getVisibleLyricIndices(3, 1, 'auto'), [
    { index: 1, role: 'current', isCurrent: true },
  ]);
});

test('English wrapping balances lines without splitting words', () => {
  const text = 'You already know me better than anyone';
  const lines = layout.wrapLyricText(text, { maxWidth: 20, maxLines: 2, measure: (value) => value.length });

  assert.equal(lines.length, 2);
  assert.equal(lines.map((line) => line.text).join(' '), text);
  assert.ok(lines.every((line) => !/^\s|\s$/.test(line.text)));
  assert.equal(lines[0].sourceEnd, lines[1].sourceStart);
});

test('CJK wrapping observes line limits and punctuation boundaries', () => {
  const text = '你好，世界！今天（天气）很好。';
  const lines = layout.wrapLyricText(text, { maxWidth: 5, maxLines: 3, measure: (value) => value.length });
  const closing = /^[，。！？；：、）】》」』’”〕〉］｝]/;
  const opening = /[（【《「『“‘〔〈［｛]$/;

  assert.ok(lines.length <= 3);
  assert.equal(lines[0].sourceStart, 0);
  assert.equal(lines.at(-1).sourceEnd, text.length);
  for (let i = 0; i < lines.length; i += 1) {
    assert.doesNotMatch(lines[i].text, closing);
    assert.doesNotMatch(lines[i].text, opening);
    if (i > 0) assert.equal(lines[i - 1].sourceEnd, lines[i].sourceStart);
  }
});

test('wrapping checks visible punctuation across whitespace', () => {
  const closing = layout.wrapLyricText('你好 ，世界', { maxWidth: 3, maxLines: 2, measure: (value) => value.length });
  const opening = layout.wrapLyricText('你好（ 世界', { maxWidth: 3, maxLines: 2, measure: (value) => value.length });

  assert.ok(closing.every((line) => !/^[，。！？；：、）】》」』’”〕〉］｝]/.test(line.text)));
  assert.ok(opening.every((line) => !/[（【《「『“‘〔〈［｛]$/.test(line.text)));
});

test('wrapping preserves contractions, accented words, combining marks, and emoji clusters', () => {
  const samples = [
    "don't stop me now",
    'rock-n-roll forever',
    'déjà vu toujours',
    'cafe\u0301 noir encore',
    'family 👨‍👩‍👧‍👦 together',
    'flags 🇨🇳🇺🇸 together',
  ];

  samples.forEach((text) => {
    const lines = layout.wrapLyricText(text, { maxWidth: 7, maxLines: 3 });
    assert.equal(lines.map((line) => line.text).join(' '), text);
    assert.ok(lines.every((line) => !/^['’\-‐‑\u0300-\u036f\u200d]|['’\-‐‑\u200d]$/.test(line.text)));
    assert.ok(lines.every((line) => !/[\ud800-\udbff]$|^[\udc00-\udfff]/.test(line.text)));
  });
});

test('very long custom lyrics keep complete ranges without quadratic wrapping work', () => {
  const text = '长'.repeat(1200);
  const lines = layout.wrapLyricText(text, { maxWidth: 400, maxLines: 3, measure: (value) => value.length });

  assert.equal(lines.length, 3);
  assert.equal(lines.map((line) => line.text).join(''), text);
  assert.equal(lines[0].sourceStart, 0);
  assert.equal(lines.at(-1).sourceEnd, text.length);
});

test('visual-line progress advances through character ranges in order', () => {
  const visualLines = [
    { contentStart: 0, contentEnd: 5 },
    { contentStart: 5, contentEnd: 10 },
  ];

  assert.deepEqual(layout.mapProgressToVisualLines(visualLines, 0, 10), [0, 0]);
  assert.deepEqual(layout.mapProgressToVisualLines(visualLines, 0.25, 10), [0.5, 0]);
  assert.deepEqual(layout.mapProgressToVisualLines(visualLines, 0.75, 10), [1, 0.5]);
  assert.deepEqual(layout.mapProgressToVisualLines(visualLines, 1, 10), [1, 1]);
});

test('portrait layout provides context while secondary text stays current-only', () => {
  const source = [
    { primary: 'Previous', secondary: 'Previous translation' },
    { primary: 'Current', secondary: 'Current translation' },
    { primary: 'Next', secondary: 'Next translation' },
  ];
  const before = structuredClone(source);
  const result = layout.buildLyricLayout({
    lines: source,
    currentIndex: 1,
    mode: 'auto',
    width: 900,
    height: 1600,
    maxWidth: 20,
    measure: (value) => value.length,
  });

  assert.equal(result.mode, 'three');
  assert.equal(result.orientation, 'portrait');
  assert.deepEqual(result.items.map((item) => item.role), ['previous', 'current', 'next']);
  assert.equal(result.items[0].secondary, '');
  assert.equal(result.current.secondary, 'Current translation');
  assert.equal(result.items[2].secondary, '');
  assert.deepEqual(source, before);
});

test('focus and empty layouts never claim visible context', () => {
  const focus = layout.buildLyricLayout({
    lines: [{ primary: 'Only current' }], currentIndex: 0, mode: 'focus', width: 1600, height: 900,
  });
  const empty = layout.buildLyricLayout({ lines: [], currentIndex: 0, mode: 'three', width: 900, height: 1600 });

  assert.equal(focus.contextVisible, false);
  assert.equal(empty.contextVisible, false);
});

test('long portrait current text fades context before it can overlap', () => {
  const result = layout.buildLyricLayout({
    lines: [
      { primary: 'Previous' },
      { primary: 'abcdefghijklmnopqrstuvwx' },
      { primary: 'Next' },
    ],
    currentIndex: 1,
    mode: 'three',
    width: 900,
    height: 1600,
    maxWidth: 8,
    measure: (value) => value.length,
  });

  assert.equal(result.current.visualLines.length, 1, 'an unbreakable word stays intact');
  assert.equal(result.contextVisible, true);

  const cjk = layout.buildLyricLayout({
    lines: [
      { primary: '上一句' },
      { primary: '这是一个需要在竖屏中分成三行显示的非常长的歌词句子' },
      { primary: '下一句' },
    ],
    currentIndex: 1,
    mode: 'three',
    width: 900,
    height: 1600,
    maxWidth: 10,
    measure: (value) => value.length,
  });

  assert.equal(cjk.current.visualLines.length, 3);
  assert.equal(cjk.contextVisible, false);
  assert.ok(cjk.contexts.every((item) => item.opacity === 0));
});
