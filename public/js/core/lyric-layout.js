'use strict';

(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MineradioCore = root.MineradioCore || {};
    root.MineradioCore.lyricLayout = factory();
  }
})(typeof self !== 'undefined' ? self : this, function() {
  var CLOSE_PUNCT = '，。！？；：、）】》」』’”〕〉］｝,.!?;:%…)]}';
  var OPEN_PUNCT = '（【《「『“‘〔〈［｛([{';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeLayoutMode(value) {
    value = String(value || '').toLowerCase();
    return /^(auto|focus|three)$/.test(value) ? value : 'auto';
  }

  function isPortraitViewport(viewport) {
    viewport = viewport || {};
    var width = Number(viewport.width);
    var height = Number(viewport.height);
    return width > 0 && height > 0 && width / height < 1.05;
  }

  function resolveLayoutMode(mode, viewport) {
    mode = normalizeLayoutMode(mode);
    if (mode !== 'auto') return mode;
    viewport = viewport || {};
    if (!(Number(viewport.width) > 0) || !(Number(viewport.height) > 0)) return 'focus';
    return isPortraitViewport(viewport) ? 'three' : 'focus';
  }

  function getVisibleLyricIndices(total, currentIndex, mode) {
    total = Math.max(0, Math.floor(Number(total) || 0));
    if (!total) return [];
    currentIndex = clamp(Math.floor(Number(currentIndex) || 0), 0, total - 1);
    mode = normalizeLayoutMode(mode);
    var result = [{ index: currentIndex, role: 'current', isCurrent: true }];
    if (mode !== 'three') return result;
    if (currentIndex > 0) result.unshift({ index: currentIndex - 1, role: 'previous', isCurrent: false });
    if (currentIndex + 1 < total) result.push({ index: currentIndex + 1, role: 'next', isCurrent: false });
    return result;
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function defaultMeasure(text) {
    var total = 0;
    for (var i = 0; i < text.length;) {
      var codePoint = typeof text.codePointAt === 'function' ? text.codePointAt(i) : text.charCodeAt(i);
      var ch = typeof String.fromCodePoint === 'function' ? String.fromCodePoint(codePoint) : text.charAt(i);
      if (/\s/.test(ch)) total += 0.30;
      else if (/^[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]$/.test(ch)) total += 1;
      else total += 0.56;
      i += ch.length;
    }
    return total;
  }

  var unicodeWordCharPattern = null;
  try { unicodeWordCharPattern = new RegExp('^[\\p{L}\\p{N}\\p{M}]$', 'u'); } catch (e) {}

  function isWordChar(ch) {
    if (!ch) return false;
    return unicodeWordCharPattern ? unicodeWordCharPattern.test(ch) : /^[A-Za-z0-9]$/.test(ch);
  }

  function isCjkChar(ch) {
    return /^[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]$/.test(ch || '');
  }

  function isCombiningOrJoiner(ch) {
    if (!ch) return false;
    var codePoint = ch.codePointAt ? ch.codePointAt(0) : ch.charCodeAt(0);
    return codePoint === 0x200d || codePoint === 0xfe0e || codePoint === 0xfe0f ||
      (codePoint >= 0x0300 && codePoint <= 0x036f) ||
      (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
      (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
      (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
      (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
      (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff);
  }

  function isJoiner(ch) {
    return !!ch && (ch.codePointAt ? ch.codePointAt(0) : ch.charCodeAt(0)) === 0x200d;
  }

  function codePointBefore(text, index) {
    if (index <= 0) return '';
    var first = text.charCodeAt(index - 1);
    if (index > 1 && first >= 0xdc00 && first <= 0xdfff) return text.slice(index - 2, index);
    return text.charAt(index - 1);
  }

  function codePointAfter(text, index) {
    if (index >= text.length) return '';
    var first = text.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) return text.slice(index, index + 2);
    return text.charAt(index);
  }

  function visibleBefore(text, index) {
    var cursor = index;
    var ch = '';
    do {
      ch = codePointBefore(text, cursor);
      cursor -= ch.length;
    } while (ch && /\s/.test(ch));
    return ch;
  }

  function visibleAfter(text, index) {
    var cursor = index;
    var ch = '';
    do {
      ch = codePointAfter(text, cursor);
      cursor += ch.length;
    } while (ch && /\s/.test(ch));
    return ch;
  }

  function wordConnectorKeepsTogether(text, index) {
    var leftText = text.slice(0, index);
    var rightText = text.slice(index);
    var word = unicodeWordCharPattern ? '[\\p{L}\\p{N}\\p{M}]' : '[A-Za-z0-9]';
    var beforeConnector = new RegExp(word + "['’\\-‐‑]$", unicodeWordCharPattern ? 'u' : '');
    var afterConnector = new RegExp("^['’\\-‐‑]" + word, unicodeWordCharPattern ? 'u' : '');
    return (beforeConnector.test(leftText) && new RegExp('^' + word, unicodeWordCharPattern ? 'u' : '').test(rightText)) ||
      (new RegExp(word + '$', unicodeWordCharPattern ? 'u' : '').test(leftText) && afterConnector.test(rightText));
  }

  function codePointBoundaries(text) {
    if (typeof Intl === 'object' && typeof Intl.Segmenter === 'function') {
      try {
        var segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        var segmented = [0];
        Array.from(segmenter.segment(text)).forEach(function(part){
          segmented.push(part.index + part.segment.length);
        });
        return segmented;
      } catch (e) {}
    }
    var result = [0];
    for (var i = 0; i < text.length;) {
      var codePoint = typeof text.codePointAt === 'function' ? text.codePointAt(i) : text.charCodeAt(i);
      var ch = typeof String.fromCodePoint === 'function' ? String.fromCodePoint(codePoint) : text.charAt(i);
      i += ch.length;
      var next = codePointAfter(text, i);
      if (i >= text.length || (!isJoiner(ch) && !isCombiningOrJoiner(next))) result.push(i);
    }
    return result;
  }

  function isLegalBreak(text, index) {
    if (index <= 0 || index >= text.length) return false;
    var left = codePointBefore(text, index);
    var right = codePointAfter(text, index);
    var visibleLeft = visibleBefore(text, index);
    var visibleRight = visibleAfter(text, index);
    if (OPEN_PUNCT.indexOf(visibleLeft) >= 0 || CLOSE_PUNCT.indexOf(visibleRight) >= 0) return false;
    if (/\s/.test(left)) return true;
    if (/\s/.test(right)) return false;
    if (wordConnectorKeepsTogether(text, index)) return false;
    if (isWordChar(left) && isWordChar(right) && !isCjkChar(left) && !isCjkChar(right)) return false;
    return true;
  }

  function legalBoundaries(text) {
    var points = codePointBoundaries(text);
    var result = [0];
    for (var i = 1; i < points.length - 1; i++) {
      if (isLegalBreak(text, points[i])) result.push(points[i]);
    }
    result.push(text.length);
    return result;
  }

  function trimRange(text, start, end) {
    while (start < end && /\s/.test(text.charAt(start))) start++;
    while (end > start && /\s/.test(text.charAt(end - 1))) end--;
    return { start: start, end: end };
  }

  function buildRanges(text, boundaries, lineCount, measure, maxWidth) {
    var target = measure(text) / lineCount;
    var dp = [];
    for (var row = 0; row <= lineCount; row++) dp[row] = [];
    dp[0][0] = { score: 0, previousBoundary: -1 };

    for (var r = 1; r <= lineCount; r++) {
      for (var endIndex = r; endIndex < boundaries.length; endIndex++) {
        var end = boundaries[endIndex];
        var best = null;
        for (var startIndex = r - 1; startIndex < endIndex; startIndex++) {
          var start = boundaries[startIndex];
          var previous = dp[r - 1][startIndex];
          if (!previous) continue;
          var visible = trimRange(text, start, end);
          if (visible.start >= visible.end) continue;
          var width = measure(text.slice(visible.start, visible.end));
          var overflow = Math.max(0, width - maxWidth);
          var score = previous.score + Math.pow(width - target, 2) + overflow * overflow * 16;
          if (!best || score < best.score) {
            best = { score: score, previousBoundary: startIndex };
          }
        }
        if (best) dp[r][endIndex] = best;
      }
    }

    var lastIndex = boundaries.length - 1;
    if (!dp[lineCount][lastIndex]) return null;
    var ranges = [];
    for (var rr = lineCount; rr > 0; rr--) {
      var cell = dp[rr][lastIndex];
      var previousIndex = cell.previousBoundary;
      ranges.unshift([boundaries[previousIndex], boundaries[lastIndex]]);
      lastIndex = previousIndex;
    }
    return ranges;
  }

  function buildLongTextRanges(text, boundaries, lineCount) {
    var ranges = [];
    var lastBoundary = 0;
    for (var row = 1; row <= lineCount; row++) {
      var remainingRows = lineCount - row;
      var targetIndex = row === lineCount
        ? boundaries.length - 1
        : Math.round((boundaries.length - 1) * row / lineCount);
      targetIndex = clamp(targetIndex, lastBoundary + 1, boundaries.length - 1 - remainingRows);
      ranges.push([boundaries[lastBoundary], boundaries[targetIndex]]);
      lastBoundary = targetIndex;
    }
    return ranges;
  }

  function wrapLyricText(value, options) {
    options = options || {};
    var text = normalizeText(value);
    var maxWidth = Math.max(0.1, Number(options.maxWidth) || 1);
    var maxLines = Math.max(1, Math.floor(Number(options.maxLines) || 1));
    var measure = typeof options.measure === 'function' ? options.measure : defaultMeasure;
    if (!text) {
      return [{ text: '', sourceStart: 0, sourceEnd: 0, contentStart: 0, contentEnd: 0, width: 0 }];
    }

    var boundaries = legalBoundaries(text);
    var totalWidth = measure(text);
    var requestedLines = Math.max(1, Math.min(maxLines, Math.ceil(totalWidth / maxWidth)));
    var ranges = boundaries.length > 320 ? buildLongTextRanges(text, boundaries, requestedLines) : null;
    for (var lineCount = requestedLines; lineCount >= 1 && !ranges; lineCount--) {
      ranges = buildRanges(text, boundaries, lineCount, measure, maxWidth);
    }
    if (!ranges) ranges = [[0, text.length]];

    return ranges.map(function(range) {
      var content = trimRange(text, range[0], range[1]);
      return {
        text: text.slice(content.start, content.end),
        sourceStart: range[0],
        sourceEnd: range[1],
        contentStart: content.start,
        contentEnd: content.end,
        width: measure(text.slice(content.start, content.end))
      };
    });
  }

  function displayParts(line) {
    line = line || {};
    return {
      primary: normalizeText(line.primary != null ? line.primary : (line.originalText != null ? line.originalText : line.text)),
      secondary: normalizeText(line.secondary || '')
    };
  }

  function buildLyricLayout(options) {
    options = options || {};
    var lines = Array.isArray(options.lines) ? options.lines : [];
    var viewport = { width: Number(options.width), height: Number(options.height) };
    var mode = resolveLayoutMode(options.mode, viewport);
    var portrait = isPortraitViewport(viewport);
    var visible = getVisibleLyricIndices(lines.length, options.currentIndex, mode);
    var maxWidth = Math.max(0.1, Number(options.maxWidth) || 1);
    var measure = typeof options.measure === 'function' ? options.measure : defaultMeasure;
    var currentMaxLines = portrait ? 3 : 2;

    var items = visible.map(function(entry) {
      var parts = displayParts(lines[entry.index]);
      var current = entry.role === 'current';
      return {
        index: entry.index,
        role: entry.role,
        isCurrent: current,
        primary: parts.primary,
        secondary: current ? parts.secondary : '',
        visualLines: wrapLyricText(parts.primary, {
          maxWidth: maxWidth,
          maxLines: current ? currentMaxLines : 1,
          measure: measure
        }),
        secondaryLines: current && parts.secondary ? wrapLyricText(parts.secondary, {
          maxWidth: maxWidth * 0.92,
          maxLines: 1,
          measure: measure
        }) : [],
        opacity: current ? 1 : 0.44,
        highlight: current
      };
    });

    var currentItem = null;
    var contexts = [];
    items.forEach(function(item) {
      if (item.isCurrent) currentItem = item;
      else contexts.push(item);
    });
    var currentRows = currentItem ? currentItem.visualLines.length + currentItem.secondaryLines.length : 0;
    var contextOpacity = currentRows >= (portrait ? 3 : 2) ? 0 : (currentRows > 1 ? 0.30 : 0.44);
    contexts.forEach(function(item) { item.opacity = contextOpacity; });

    return {
      mode: mode,
      orientation: portrait ? 'portrait' : 'landscape',
      items: items,
      current: currentItem,
      contexts: contexts,
      contextVisible: contexts.length > 0 && contextOpacity > 0
    };
  }

  function mapProgressToVisualLines(visualLines, globalProgress, charCount) {
    var lines = Array.isArray(visualLines) ? visualLines : [];
    var count = Math.max(1, Number(charCount) || 0);
    var cursor = clamp(Number(globalProgress) || 0, 0, 1) * count;
    return lines.map(function(line) {
      var start = Number(line.contentStart != null ? line.contentStart : line.sourceStart) || 0;
      var end = Number(line.contentEnd != null ? line.contentEnd : line.sourceEnd);
      if (!(end > start)) end = start + 1;
      return clamp((cursor - start) / (end - start), 0, 1);
    });
  }

  return {
    normalizeLayoutMode: normalizeLayoutMode,
    isPortraitViewport: isPortraitViewport,
    resolveLayoutMode: resolveLayoutMode,
    getVisibleLyricIndices: getVisibleLyricIndices,
    wrapLyricText: wrapLyricText,
    buildLyricLayout: buildLyricLayout,
    mapProgressToVisualLines: mapProgressToVisualLines,
    normalizeText: normalizeText
  };
});
