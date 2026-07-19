'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lyrics = require('../../public/js/core/lyrics');

test('parseLrc handles metadata, offsets, and repeated timestamps', () => {
  const lines = lyrics.parseLrc([
    '[ar:Artist]',
    '[offset:100]',
    '[00:01.00][00:02.500]Hello',
    '[00:04.00]World',
  ].join('\n'));

  assert.deepEqual(lines.map((line) => line.t), [1.1, 2.6, 4.1]);
  assert.deepEqual(lines.map((line) => line.text), ['Hello', 'Hello', 'World']);
  assert.equal(lines[0].duration, 1.5);
});

test('parseQrc preserves QQ word timing and character ranges', () => {
  const lines = lyrics.parseQrc('[1000,900]Hel(1000,180)lo(1180,220) world(1400,350)');

  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Hello world');
  assert.equal(lines[0].source, 'qrc-word');
  assert.deepEqual(lines[0].words.map((word) => [word.text, word.t, word.d, word.c0, word.c1]), [
    ['Hel', 1, 0.18, 0, 3],
    ['lo', 1.18, 0.22, 3, 5],
    [' world', 1.4, 0.35, 5, 11],
  ]);
});

test('lyricDisplayParts keeps original karaoke lines immutable', () => {
  const line = {
    text: 'Original',
    translation: 'Translation',
    romanization: 'Romanization',
    charCount: 8,
    words: [{ text: 'Original', t: 1, d: 1, c0: 0, c1: 8 }],
  };
  const before = structuredClone(line);

  assert.deepEqual(lyrics.lyricDisplayParts(line, 'bilingual'), {
    primary: 'Original',
    secondary: 'Translation',
  });
  assert.deepEqual(lyrics.lyricDisplayParts(line, 'romanization'), {
    primary: 'Original',
    secondary: 'Romanization',
  });
  assert.deepEqual(line, before);
});

test('custom lyrics never expose a translated secondary line', () => {
  assert.deepEqual(lyrics.lyricDisplayParts({ text: 'Custom', translation: 'Ignored' }, 'bilingual', { sourceMode: 'custom' }), {
    primary: 'Custom',
    secondary: '',
  });
});

test('alignTranslatedLyrics matches exact and slightly shifted timestamps', () => {
  const aligned = lyrics.alignTranslatedLyrics([
    { t: 1, text: 'Hello' },
    { t: 3, text: 'World' },
  ], [
    { t: 1.2, text: 'Greeting' },
    { t: 2.7, text: 'Planet' },
  ]);

  assert.equal(aligned[0].translation, 'Greeting');
  assert.equal(aligned[1].translation, 'Planet');
});

test('translation alignment is one-to-one', () => {
  const aligned = lyrics.alignTranslatedLyrics([
    { t: 1, text: 'Line one' },
    { t: 1.3, text: 'Line two' },
  ], [
    { t: 1.1, text: 'Only translation' },
  ], { toleranceSeconds: 0.5 });

  assert.equal(aligned[0].translation, 'Only translation');
  assert.equal(aligned[1].translation, undefined);
});

test('translation alignment chooses the nearest unused timestamp', () => {
  const aligned = lyrics.alignTranslatedLyrics([
    { t: 1, text: 'First' },
    { t: 1.4, text: 'Second' },
  ], [
    { t: 1.3, text: 'Closer to second' },
  ], { toleranceSeconds: 0.5 });

  assert.equal(aligned[0].translation, undefined);
  assert.equal(aligned[1].translation, 'Closer to second');
});

test('alignment leaves unmatched primary lines unchanged', () => {
  const aligned = lyrics.alignTranslatedLyrics([
    { t: 1, text: 'Near' },
    { t: 10, text: 'Far' },
  ], [
    { t: 1, text: 'Matched' },
  ]);

  assert.equal(aligned[0].translation, 'Matched');
  assert.equal(aligned[1].translation, undefined);
});

test('alignment preserves karaoke words and does not mutate source lines', () => {
  const source = [{
    t: 1,
    text: 'Hello',
    words: [{ text: 'Hel', t: 1, d: 0.2, c0: 0, c1: 3 }],
  }];
  const aligned = lyrics.alignTranslatedLyrics(source, [{ t: 1, text: 'Greeting' }]);

  assert.notEqual(aligned[0], source[0]);
  assert.notEqual(aligned[0].words, source[0].words);
  assert.deepEqual(aligned[0].words, source[0].words);
  assert.equal(source[0].translation, undefined);
});

test('duplicate translation text is omitted by default', () => {
  const aligned = lyrics.alignTranslatedLyrics(
    [{ t: 1, text: 'Same line' }],
    [{ t: 1, text: 'Same line' }]
  );

  assert.equal(aligned[0].translation, undefined);
});

test('mergeBilingualLyrics parses and aligns both LRC documents', () => {
  const aligned = lyrics.mergeBilingualLyrics(
    '[00:01.00]Hello\n[00:03.00]World',
    '[00:01.10]Greeting\n[00:03.10]Planet'
  );

  assert.deepEqual(aligned.map((line) => line.translation), ['Greeting', 'Planet']);
});

test('isNoLyricText recognizes common no-lyric markers', () => {
  assert.equal(lyrics.isNoLyricText('Instrumental'), true);
  assert.equal(lyrics.isNoLyricText('\u6682\u65e0\u6b4c\u8bcd'), true);
  assert.equal(lyrics.isNoLyricText('A real lyric line'), false);
});
