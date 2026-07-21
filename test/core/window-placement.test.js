'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const placement = require('../../lib/window-placement');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'desktop', 'main.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function display(id, workArea, scaleFactor = 1) {
  return { id, workArea, bounds: workArea, scaleFactor };
}

const horizontalDisplays = [
  display(1, { x: 0, y: 0, width: 1920, height: 1080 }),
  display(2, { x: 1920, y: 0, width: 2560, height: 1440 }, 1.5),
];

test('keeps a reachable saved window on the secondary display', () => {
  const result = placement.resolveWindowPlacement({
    saved: { bounds: { x: 2240, y: 120, width: 1200, height: 760 }, displayId: 2 },
    defaultBounds: { x: 480, y: 270, width: 1440, height: 810 },
    displays: horizontalDisplays,
    primaryDisplayId: 1,
    minWidth: 720,
    minHeight: 405,
  });

  assert.deepEqual(result.bounds, { x: 2240, y: 120, width: 1200, height: 760 });
  assert.equal(result.displayId, 2);
});

test('preserves negative coordinates for a display on the left', () => {
  const displays = [
    display(1, { x: 1920, y: 0, width: 1920, height: 1080 }),
    display(3, { x: -1920, y: 0, width: 1920, height: 1080 }),
  ];
  const result = placement.resolveWindowPlacement({
    saved: { bounds: { x: -1700, y: 80, width: 960, height: 540 }, displayId: 3 },
    defaultBounds: { x: 2400, y: 200, width: 960, height: 540 },
    displays,
    primaryDisplayId: 1,
  });

  assert.equal(result.displayId, 3);
  assert.equal(result.bounds.x, -1700);
});

test('centers a saved window on the primary display when its display was removed', () => {
  const result = placement.resolveWindowPlacement({
    saved: { bounds: { x: 2240, y: 120, width: 1200, height: 760 }, displayId: 2 },
    defaultBounds: { x: 480, y: 270, width: 1440, height: 810 },
    displays: [display(1, { x: 0, y: 0, width: 1920, height: 1080 })],
    primaryDisplayId: 1,
    minWidth: 720,
    minHeight: 405,
  });

  assert.equal(result.displayId, 1);
  assert.deepEqual(result.bounds, { x: 360, y: 160, width: 1200, height: 760 });
});

test('resolves a fullscreen restore after its secondary display disconnects', () => {
  const result = placement.resolveWindowPlacement({
    saved: {
      bounds: { x: 2240, y: 120, width: 1200, height: 760 },
      maximized: false,
      displayId: 2,
      displayWorkArea: { x: 1920, y: 0, width: 2560, height: 1440 },
    },
    defaultBounds: { x: 480, y: 270, width: 1440, height: 810 },
    displays: [display(1, { x: 0, y: 0, width: 1920, height: 1080 })],
    primaryDisplayId: 1,
    minWidth: 720,
    minHeight: 405,
  });

  assert.equal(result.displayId, 1);
  assert.deepEqual(result.bounds, { x: 360, y: 160, width: 1200, height: 760 });
});

test('uses the primary display after removal regardless of display enumeration order', () => {
  const result = placement.resolveWindowPlacement({
    saved: { bounds: { x: 4000, y: 120, width: 1200, height: 760 }, displayId: 9 },
    defaultBounds: { x: 480, y: 270, width: 1440, height: 810 },
    displays: [
      display(2, { x: -1920, y: 0, width: 1920, height: 1080 }),
      display(1, { x: 0, y: 0, width: 1920, height: 1080 }),
    ],
    primaryDisplayId: 1,
    minWidth: 720,
    minHeight: 405,
  });

  assert.equal(result.displayId, 1);
  assert.deepEqual(result.bounds, { x: 360, y: 160, width: 1200, height: 760 });
});

test('keeps the same physical display when display positions are rearranged', () => {
  const result = placement.resolveWindowPlacement({
    saved: {
      bounds: { x: 2240, y: 120, width: 1200, height: 760 },
      displayId: 2,
      displayWorkArea: { x: 1920, y: 0, width: 2560, height: 1440 },
    },
    defaultBounds: { x: 480, y: 270, width: 1440, height: 810 },
    displays: [
      display(2, { x: 0, y: 0, width: 2560, height: 1440 }, 1.5),
      display(1, { x: 2560, y: 0, width: 1920, height: 1080 }),
    ],
    primaryDisplayId: 1,
    minWidth: 720,
    minHeight: 405,
  });

  assert.equal(result.displayId, 2);
  assert.deepEqual(result.bounds, { x: 320, y: 120, width: 1200, height: 760 });
});

test('clamps to the saved display when its work area becomes smaller', () => {
  const result = placement.resolveWindowPlacement({
    saved: {
      bounds: { x: 4000, y: 120, width: 480, height: 270 },
      displayId: 2,
      displayWorkArea: { x: 1920, y: 0, width: 2560, height: 1440 },
    },
    defaultBounds: { x: 480, y: 270, width: 960, height: 540 },
    displays: [
      display(2, { x: 0, y: 0, width: 1280, height: 720 }),
      display(1, { x: 1280, y: 0, width: 1920, height: 1080 }),
    ],
    primaryDisplayId: 1,
    minWidth: 480,
    minHeight: 270,
  });

  assert.equal(result.displayId, 2);
  assert.deepEqual(result.bounds, { x: 800, y: 120, width: 480, height: 270 });
});

test('fits a restored window using the actual BrowserWindow minimum size', () => {
  const result = placement.resolveWindowPlacement({
    saved: {
      bounds: { x: 1400, y: 700, width: 480, height: 270 },
      displayId: 1,
      displayWorkArea: { x: 0, y: 0, width: 1920, height: 1080 },
    },
    defaultBounds: { x: 480, y: 270, width: 1440, height: 810 },
    displays: [display(1, { x: 0, y: 0, width: 1920, height: 1080 })],
    primaryDisplayId: 1,
    minWidth: 720,
    minHeight: 405,
  });

  assert.deepEqual(result.bounds, { x: 1200, y: 675, width: 720, height: 405 });
});

test('does not treat controls on the right edge as a reachable drag handle', () => {
  const displays = [display(1, { x: 0, y: 0, width: 1920, height: 1080 })];
  assert.equal(placement.isDragStripReachable(
    { x: 1700, y: 100, width: 480, height: 270 },
    displays,
  ), true);
  assert.equal(placement.isDragStripReachable(
    { x: -470, y: 100, width: 480, height: 270 },
    displays,
  ), false);
});

test('uses Electron DIP bounds directly when displays have different scale factors', () => {
  const result = placement.resolveWindowPlacement({
    saved: { bounds: { x: 1920, y: 0, width: 1200, height: 760 }, displayId: 2 },
    defaultBounds: { x: 360, y: 160, width: 1200, height: 760 },
    displays: [
      display(1, { x: 0, y: 0, width: 1920, height: 1080 }, 1),
      display(2, { x: 1920, y: 0, width: 1706, height: 960 }, 1.5),
    ],
    primaryDisplayId: 1,
    minWidth: 720,
    minHeight: 405,
  });

  assert.deepEqual(result.bounds, { x: 1920, y: 0, width: 1200, height: 760 });
  assert.equal(result.displayId, 2);
});

test('preserves a window while it straddles two displays', () => {
  const bounds = { x: 1700, y: 100, width: 960, height: 540 };
  const result = placement.resolveWindowPlacement({
    saved: { bounds, displayId: 1 },
    defaultBounds: { x: 480, y: 270, width: 960, height: 540 },
    displays: horizontalDisplays,
    primaryDisplayId: 1,
  });

  assert.deepEqual(result.bounds, bounds);
});

test('restores a window on a display positioned above the primary display', () => {
  const displays = [
    display(1, { x: 0, y: 0, width: 1920, height: 1080 }),
    display(4, { x: 0, y: -1080, width: 1920, height: 1080 }),
  ];
  const result = placement.resolveWindowPlacement({
    saved: { bounds: { x: 280, y: -980, width: 1100, height: 620 }, displayId: 4 },
    defaultBounds: { x: 480, y: 270, width: 960, height: 540 },
    displays,
    primaryDisplayId: 1,
  });

  assert.equal(result.displayId, 4);
  assert.equal(result.bounds.y, -980);
});

test('repairs a window when only its non-draggable controls remain visible', () => {
  const displays = [display(1, { x: 0, y: 0, width: 1920, height: 1080 })];
  const result = placement.resolveWindowPlacement({
    saved: { bounds: { x: -470, y: 100, width: 480, height: 270 }, displayId: 1 },
    defaultBounds: { x: 720, y: 405, width: 480, height: 270 },
    displays,
    primaryDisplayId: 1,
  });

  assert.deepEqual(result.bounds, { x: 0, y: 100, width: 480, height: 270 });
});

test('fullscreen lifecycle resolves saved display metadata before restoring bounds', () => {
  const captureSource = sourceBetween(
    mainSource,
    'function captureExplicitFullscreenRestoreState',
    'function restoreExplicitFullscreenWindow',
  );
  const restoreSource = sourceBetween(
    mainSource,
    'function restoreExplicitFullscreenWindow',
    'function scheduleExplicitFullscreenRestore',
  );

  assert.match(captureSource, /displayId:\s*display\s*&&\s*display\.id/);
  assert.match(captureSource, /displayWorkArea:\s*display\s*&&\s*display\.workArea/);
  assert.match(restoreSource, /resolveMainWindowPlacementState\(restore,/);
  assert.doesNotMatch(restoreSource, /setBounds\(restore\.bounds/);
});

test('ordinary unmaximize repair preserves currently reachable bounds', () => {
  const repairSource = sourceBetween(
    mainSource,
    'function repairMainWindowPlacement',
    'function getWindowedBounds',
  );

  assert.match(repairSource, /isDragStripReachable\(currentBounds, displays\)/);
  assert.match(repairSource, /if \(!useSavedPlacement\)\s*\{/);
});
