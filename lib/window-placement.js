'use strict';

const DEFAULT_DRAG_WIDTH = 64;
const DEFAULT_DRAG_HEIGHT = 32;
const DEFAULT_TITLEBAR_HEIGHT = 44;
const DEFAULT_CONTROL_RESERVE = 320;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeBounds(value, fallback = null) {
  if (!value || !Number.isFinite(Number(value.width)) || !Number.isFinite(Number(value.height))) {
    return fallback ? normalizeBounds(fallback) : null;
  }
  const width = Math.round(Number(value.width));
  const height = Math.round(Number(value.height));
  if (width <= 0 || height <= 0) return fallback ? normalizeBounds(fallback) : null;
  return {
    x: Math.round(finiteNumber(value.x, 0)),
    y: Math.round(finiteNumber(value.y, 0)),
    width,
    height,
  };
}

function displayArea(display) {
  if (!display) return null;
  return normalizeBounds(display.workArea || display.bounds);
}

function normalizedDisplays(displays) {
  return (Array.isArray(displays) ? displays : [])
    .map((display) => {
      const area = displayArea(display);
      if (!area) return null;
      return { display, area, id: display.id };
    })
    .filter(Boolean);
}

function intersection(a, b) {
  if (!a || !b) return null;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function intersectionArea(a, b) {
  const overlap = intersection(a, b);
  return overlap ? overlap.width * overlap.height : 0;
}

function idsEqual(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function boundsEqual(left, right) {
  return !!left && !!right
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function findDisplay(displays, displayId) {
  return normalizedDisplays(displays).find((entry) => idsEqual(entry.id, displayId)) || null;
}

function matchingDisplay(displays, bounds, preferredDisplayId) {
  const entries = normalizedDisplays(displays);
  if (!entries.length) return null;
  const preferred = entries.find((entry) => idsEqual(entry.id, preferredDisplayId));
  let best = null;
  let bestArea = 0;
  for (const entry of entries) {
    const area = intersectionArea(bounds, entry.area);
    if (area > bestArea || (area > 0 && area === bestArea && preferred && entry.id === preferred.id)) {
      best = entry;
      bestArea = area;
    }
  }
  return best || preferred || entries[0];
}

function dragStrip(bounds, options = {}) {
  const titlebarHeight = Math.max(1, Math.round(finiteNumber(options.titlebarHeight, DEFAULT_TITLEBAR_HEIGHT)));
  const leftInset = Math.max(0, Math.round(finiteNumber(options.leftInset, 18)));
  const controlReserve = Math.max(0, Math.round(finiteNumber(options.controlReserve, DEFAULT_CONTROL_RESERVE)));
  const minimumWidth = Math.max(1, Math.round(finiteNumber(options.minimumWidth, DEFAULT_DRAG_WIDTH)));
  const width = Math.max(minimumWidth, bounds.width - leftInset - controlReserve);
  return {
    x: bounds.x + leftInset,
    y: bounds.y,
    width: Math.min(width, Math.max(minimumWidth, bounds.width - leftInset)),
    height: Math.min(titlebarHeight, bounds.height),
  };
}

function isDragStripReachable(bounds, displays, options = {}) {
  const normalized = normalizeBounds(bounds);
  if (!normalized) return false;
  const strip = dragStrip(normalized, options);
  const minimumWidth = Math.min(strip.width, Math.max(1, Math.round(finiteNumber(options.minimumVisibleWidth, DEFAULT_DRAG_WIDTH))));
  const minimumHeight = Math.min(strip.height, Math.max(1, Math.round(finiteNumber(options.minimumVisibleHeight, DEFAULT_DRAG_HEIGHT))));
  return normalizedDisplays(displays).some((entry) => {
    const overlap = intersection(strip, entry.area);
    return !!overlap && overlap.width >= minimumWidth && overlap.height >= minimumHeight;
  });
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function fitBoundsToArea(bounds, area, options = {}) {
  const source = normalizeBounds(bounds, { x: area.x, y: area.y, width: area.width, height: area.height });
  const minimumWidth = Math.min(Math.max(1, Math.round(finiteNumber(options.minWidth, 1))), area.width);
  const minimumHeight = Math.min(Math.max(1, Math.round(finiteNumber(options.minHeight, 1))), area.height);
  const width = clamp(source.width, minimumWidth, area.width);
  const height = clamp(source.height, minimumHeight, area.height);
  const outside = intersectionArea(source, area) === 0;
  const centered = options.centerIfOutside !== false && outside;
  const x = centered
    ? Math.round(area.x + (area.width - width) / 2)
    : Math.round(clamp(source.x, area.x, area.x + area.width - width));
  const y = centered
    ? Math.round(area.y + (area.height - height) / 2)
    : Math.round(clamp(source.y, area.y, area.y + area.height - height));
  return { x, y, width, height };
}

function translateBoundsBetweenAreas(bounds, sourceArea, targetArea) {
  const normalized = normalizeBounds(bounds);
  const source = normalizeBounds(sourceArea);
  const target = normalizeBounds(targetArea);
  if (!normalized || !source || !target) return normalized;
  if (boundsEqual(source, target)) return normalized;
  return {
    ...normalized,
    x: target.x + (normalized.x - source.x),
    y: target.y + (normalized.y - source.y),
  };
}

function resolveWindowPlacement(options = {}) {
  const entries = normalizedDisplays(options.displays);
  const fallback = normalizeBounds(options.defaultBounds, { x: 0, y: 0, width: 960, height: 540 });
  if (!entries.length) {
    return {
      bounds: fallback,
      maximized: !!(options.saved && options.saved.maximized),
      displayId: options.saved && options.saved.displayId != null ? options.saved.displayId : null,
    };
  }

  const primary = findDisplay(options.displays, options.primaryDisplayId) || entries[0];
  const savedBounds = normalizeBounds(options.saved && options.saved.bounds);
  const savedDisplay = findDisplay(options.displays, options.saved && options.saved.displayId);
  const savedDisplayArea = normalizeBounds(options.saved && options.saved.displayWorkArea);
  const restoredBounds = savedBounds && savedDisplay && savedDisplayArea
    ? translateBoundsBetweenAreas(savedBounds, savedDisplayArea, savedDisplay.area)
    : savedBounds;
  const matching = restoredBounds
    ? matchingDisplay(options.displays, restoredBounds, options.saved && options.saved.displayId)
    : null;
  const matchingHasOverlap = !!(restoredBounds && matching && intersectionArea(restoredBounds, matching.area));
  const hasReachableDragStrip = restoredBounds && isDragStripReachable(restoredBounds, options.displays, options);

  if (restoredBounds && hasReachableDragStrip) {
    const target = (savedDisplay && savedDisplayArea ? savedDisplay : null) || matching || savedDisplay || primary;
    const area = target.area;
    const targetHasReachableDragStrip = isDragStripReachable(restoredBounds, [target.display], options);
    const needsFit = !targetHasReachableDragStrip
      || restoredBounds.width > area.width
      || restoredBounds.height > area.height
      || restoredBounds.width < Number(options.minWidth || 1)
      || restoredBounds.height < Number(options.minHeight || 1);
    return {
      bounds: needsFit ? fitBoundsToArea(restoredBounds, area, { ...options, centerIfOutside: false }) : restoredBounds,
      maximized: !!(options.saved && options.saved.maximized),
      displayId: target.id,
    };
  }

  const target = savedDisplay || (matchingHasOverlap && matching) || primary;
  return {
    bounds: fitBoundsToArea(restoredBounds || fallback, target.area, {
      ...options,
      centerIfOutside: !savedDisplay || !restoredBounds || !intersectionArea(restoredBounds || fallback, target.area),
    }),
    maximized: !!(options.saved && options.saved.maximized),
    displayId: target.id,
  };
}

module.exports = {
  DEFAULT_DRAG_WIDTH,
  DEFAULT_DRAG_HEIGHT,
  DEFAULT_TITLEBAR_HEIGHT,
  DEFAULT_CONTROL_RESERVE,
  displayArea,
  normalizeBounds,
  intersection,
  intersectionArea,
  matchingDisplay,
  isDragStripReachable,
  fitBoundsToArea,
  translateBoundsBetweenAreas,
  resolveWindowPlacement,
};
