'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'desktop', 'main.js'),
  'utf8',
);

test('main window waits for the local HTTP endpoint and retries bounded load failures', () => {
  assert.match(source, /function probeLocalHttpReady\(targetUrl, timeoutMs = 900\)/);
  assert.match(source, /response\.statusCode >= 200 && response\.statusCode < 500/);
  assert.match(source, /async function waitForLocalHttpReady\(targetUrl, options = \{\}\)/);
  assert.match(source, /Math\.min\(40, Number\(options\.attempts\) \|\| 20\)/);
  assert.match(source, /async function loadMainWindowUrlWithRetry\(win, targetUrl, options = \{\}\)/);
  assert.match(source, /Math\.min\(8, Number\(options\.attempts\) \|\| 4\)/);
  assert.match(source, /if \(!ready\) throw new Error\('LOCAL_HTTP_SERVER_NOT_READY'\)/);
  assert.match(source, /await win\.loadURL\(targetUrl\)/);
  assert.match(source, /recordDiagnosticEvent\('main-window-load-retry'/);
  assert.match(
    source,
    /await loadMainWindowUrlWithRetry\(mainWindow, `http:\/\/127\.0\.0\.1:\$\{port\}`,[\s\S]*?attempts: 4/,
  );
  assert.doesNotMatch(source, /await mainWindow\.loadURL\(`http:\/\/127\.0\.0\.1:\$\{port\}`\)/);
});
