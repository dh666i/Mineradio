'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('legacy JSON resource patches stay disabled without a dormant file writer', () => {
  assert.match(
    serverSource,
    /if \(pn === '\/api\/update\/patch'\) \{\s*sendJSON\(res, \{ ok: false, error: 'PATCH_UPDATES_DISABLED' \}, 410\)/,
  );
  assert.match(
    serverSource,
    /if \(pn === '\/api\/update\/patch\/status'\) \{\s*sendJSON\(res, \{ ok: false, error: 'PATCH_UPDATES_DISABLED' \}, 410\)/,
  );
  [
    'safePatchRelativePath',
    'patchTargetPath',
    'writePatchFile',
    'normalizePatchPayload',
    'downloadAndApplyPatch',
    'startUpdatePatchJob',
    '.mineradio-patch',
  ].forEach((marker) => assert.doesNotMatch(serverSource, new RegExp(marker)));
});
