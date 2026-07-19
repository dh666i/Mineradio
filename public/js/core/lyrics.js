(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.MineradioCore = root.MineradioCore || {};
    root.MineradioCore.lyrics = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function finiteNumber(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function cloneLine(line) {
    var copy = Object.assign({}, line || {});
    if (Array.isArray(line && line.words)) {
      copy.words = line.words.map(function (word) { return Object.assign({}, word); });
    }
    return copy;
  }

  function normalizeText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  function compactText(text) {
    return normalizeText(text).replace(/[\s,.!?~;:'"`\-_/\\|()[\]{}<>\u3000-\u303f\uff00-\uffef]+/g, '').toLowerCase();
  }

  function isNoLyricText(text) {
    var compact = compactText(text);
    return !compact || [
      '\u7eaf\u97f3\u4e50\u8bf7\u6b23\u8d4f',
      '\u6682\u65e0\u6b4c\u8bcd',
      '\u6682\u65e0\u6b4c\u8bcd\u656c\u8bf7\u671f\u5f85',
      '\u6b64\u6b4c\u66f2\u4e3a\u6ca1\u6709\u586b\u8bcd\u7684\u7eaf\u97f3\u4e50\u8bf7\u60a8\u6b23\u8d4f',
      'instrumental',
      'nolyric',
      'lyricsunavailable',
    ].indexOf(compact) >= 0;
  }

  function timestampToSeconds(minutes, seconds, fraction) {
    var total = (parseInt(minutes, 10) || 0) * 60 + (parseInt(seconds, 10) || 0);
    if (fraction) total += (parseInt(fraction, 10) || 0) / Math.pow(10, Math.min(3, fraction.length));
    return total;
  }

  function finalizeDurations(lines) {
    lines.sort(function (left, right) { return left.t - right.t; });
    for (var i = 0; i < lines.length; i++) {
      var next = lines[i + 1];
      var inferred = next && next.t > lines[i].t ? next.t - lines[i].t : 4.8;
      if (!isFinite(lines[i].duration) || lines[i].duration <= 0) lines[i].duration = inferred;
      lines[i].duration = Math.max(0.45, Math.min(12, lines[i].duration));
      lines[i].charCount = Math.max(1, Number(lines[i].charCount) || normalizeText(lines[i].text).length);
    }
    return lines;
  }

  function parseLrc(text) {
    var raw = String(text == null ? '' : text);
    var offsetMatch = raw.match(/^\s*\[offset\s*:\s*(-?\d+)\s*\]\s*$/im);
    var offsetSeconds = offsetMatch ? (parseInt(offsetMatch[1], 10) || 0) / 1000 : 0;
    var timePattern = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    var lines = [];

    raw.split(/\r?\n/).forEach(function (row) {
      var times = [];
      var match;
      timePattern.lastIndex = 0;
      while ((match = timePattern.exec(row))) {
        times.push(timestampToSeconds(match[1], match[2], match[3]) + offsetSeconds);
      }
      if (!times.length) return;
      var lineText = normalizeText(row.replace(timePattern, ''));
      if (!lineText) return;
      times.forEach(function (time) {
        lines.push({
          t: Math.max(0, time),
          text: lineText,
          source: 'lrc',
        });
      });
    });

    return finalizeDurations(lines);
  }

  function parseQrc(text) {
    var lines = [];

    String(text == null ? '' : text).split(/\r?\n/).forEach(function (row) {
      var lineMatch = row.match(/^\s*\[(\d+),(\d+)\](.*)$/);
      if (!lineMatch) return;
      var lineStartMs = parseInt(lineMatch[1], 10) || 0;
      var lineDurationMs = parseInt(lineMatch[2], 10) || 0;
      var body = lineMatch[3] || '';
      var wordPattern = /([^()]*)\((\d+),(\d+)\)/g;
      var words = [];
      var fullText = '';
      var match;

      while ((match = wordPattern.exec(body))) {
        var wordText = String(match[1] || '').replace(/\s+/g, ' ');
        if (!wordText) continue;
        if (/\s$/.test(fullText) && /^\s/.test(wordText)) wordText = wordText.replace(/^\s+/, '');
        var rawStart = parseInt(match[2], 10) || 0;
        var rawDuration = parseInt(match[3], 10) || 0;
        var absoluteStartMs = rawStart >= lineStartMs - 500 ? rawStart : lineStartMs + rawStart;
        var c0 = fullText.length;
        fullText += wordText;
        words.push({
          text: wordText,
          t: absoluteStartMs / 1000,
          d: Math.max(0.06, rawDuration / 1000),
          c0: c0,
          c1: fullText.length,
        });
      }

      if (!fullText) fullText = body.replace(/\(\d+,\d+\)/g, ' ');
      var leading = (fullText.match(/^\s+/) || [''])[0].length;
      fullText = normalizeText(fullText);
      if (!fullText) return;
      if (words.length) {
        words.forEach(function (word) {
          word.c0 = Math.max(0, Math.min(fullText.length, word.c0 - leading));
          word.c1 = Math.max(word.c0, Math.min(fullText.length, word.c1 - leading));
        });
        words = words.filter(function (word) { return word.c1 > word.c0; });
      }
      lines.push({
        t: lineStartMs / 1000,
        duration: lineDurationMs / 1000,
        text: fullText,
        words: words,
        charCount: Math.max(1, fullText.length),
        source: words.length ? 'qrc-word' : 'qrc-line',
      });
    });

    return finalizeDurations(lines);
  }

  function lyricDisplayParts(line, mode, options) {
    line = line || {};
    options = options || {};
    var primary = normalizeText(line.originalText || line.text);
    var secondary = '';
    if (options.sourceMode !== 'custom') {
      if (mode === 'bilingual') secondary = normalizeText(line.translation);
      else if (mode === 'romanization') secondary = normalizeText(line.romanization);
    }
    return { primary: primary, secondary: secondary };
  }

  function alignTranslatedLyrics(primaryLines, translatedLines, options) {
    options = options || {};
    var tolerance = Math.max(0, finiteNumber(options.toleranceSeconds, 0.65));
    var offset = finiteNumber(options.translationOffsetSeconds, 0);
    var omitDuplicates = options.omitDuplicateText !== false;
    var primary = (Array.isArray(primaryLines) ? primaryLines : []).map(cloneLine);
    var translated = (Array.isArray(translatedLines) ? translatedLines : []).map(function (line, index) {
      return {
        index: index,
        t: finiteNumber(line && line.t, NaN) + offset,
        text: normalizeText(line && line.text),
      };
    }).filter(function (line) {
      return isFinite(line.t) && line.text && !isNoLyricText(line.text);
    });
    var pairs = [];
    primary.forEach(function (line, primaryIndex) {
      var lineTime = finiteNumber(line.t, NaN);
      if (!isFinite(lineTime)) return;
      translated.forEach(function (candidate) {
        var distance = Math.abs(candidate.t - lineTime);
        if (distance <= tolerance) {
          pairs.push({ primaryIndex: primaryIndex, candidate: candidate, distance: distance });
        }
      });
    });
    pairs.sort(function (left, right) {
      return left.distance - right.distance ||
        left.primaryIndex - right.primaryIndex ||
        left.candidate.index - right.candidate.index;
    });

    var usedPrimary = {};
    var usedTranslated = {};
    pairs.forEach(function (pair) {
      if (usedPrimary[pair.primaryIndex] || usedTranslated[pair.candidate.index]) return;
      usedPrimary[pair.primaryIndex] = true;
      usedTranslated[pair.candidate.index] = true;
      var line = primary[pair.primaryIndex];
      if (omitDuplicates && compactText(pair.candidate.text) === compactText(line.text)) return;
      line.translation = pair.candidate.text;
      line.translationT = pair.candidate.t;
    });

    return primary;
  }

  function mergeBilingualLyrics(primaryText, translatedText, options) {
    return alignTranslatedLyrics(parseLrc(primaryText), parseLrc(translatedText), options);
  }

  return {
    normalizeText: normalizeText,
    isNoLyricText: isNoLyricText,
    parseLrc: parseLrc,
    parseQrc: parseQrc,
    lyricDisplayParts: lyricDisplayParts,
    alignTranslatedLyrics: alignTranslatedLyrics,
    mergeBilingualLyrics: mergeBilingualLyrics,
  };
});
