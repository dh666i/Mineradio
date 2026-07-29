'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const desktop = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');

test('packaged releases cannot replace GitHub update metadata with a local manifest', () => {
  assert.match(server, /function isPackagedRuntime\(\)/);
  assert.match(
    server,
    /return process\.env\.MINERADIO_APP_PACKAGED === '1' \|\| process\.env\.NODE_ENV === 'production'/,
  );
  assert.match(server, /function readUpdateManifestOverride\(\)/);
  assert.match(server, /if \(isPackagedRuntime\(\)\) return ''/);
  assert.match(server, /manifest: readUpdateManifestOverride\(\)/);
  assert.match(desktop, /process\.env\.MINERADIO_APP_PACKAGED = app\.isPackaged \? '1' : '0'/);
});
