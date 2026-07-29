'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const verifierStart = mainSource.indexOf('function normalizeUpdateDigest');
const verifierEnd = mainSource.indexOf('function shouldEnsureDesktopShortcut', verifierStart);
assert.notEqual(verifierStart, -1);
assert.notEqual(verifierEnd, -1);

const verifier = { fs, crypto, Promise, RegExp, String, Number };
vm.createContext(verifier);
vm.runInContext(mainSource.slice(verifierStart, verifierEnd), verifier, {
  filename: 'desktop-update-verifier.inline.js',
});

test('unsigned update digest verification accepts the release hash and rejects tampering', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-update-test-'));
  const installer = path.join(tempDir, 'Mineradio-9.9.9-Setup.exe');
  const content = Buffer.from('verified unsigned installer fixture');
  try {
    fs.writeFileSync(installer, content);
    const sha512 = crypto.createHash('sha512').update(content).digest('base64');
    assert.deepEqual(
      JSON.parse(JSON.stringify(await verifier.verifyUpdateInstallerDigest(installer, {
        expectedSize: content.length,
        sha512,
      }))),
      { ok: true, algorithm: 'sha512', size: content.length },
    );

    fs.appendFileSync(installer, 'tampered');
    const rejected = await verifier.verifyUpdateInstallerDigest(installer, {
      expectedSize: content.length,
      sha512,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'UPDATE_SIZE_MISMATCH');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('release jobs expose digest metadata only for verified ready installers', () => {
  assert.match(serverSource, /const ready = job\.status === 'ready'/);
  assert.match(serverSource, /expectedSize:\s*ready\s*\?/);
  assert.match(serverSource, /sha512:\s*ready\s*\?/);
  assert.match(uiSource, /openUpdateInstaller\(\{\s*filePath:[\s\S]{0,220}sha512:/);
});

test('installer opening verifies digest before accepting an unsigned signature state', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('mineradio-open-update-installer'");
  const handlerEnd = mainSource.indexOf("ipcMain.handle('mineradio-restart-app'", handlerStart);
  const handler = mainSource.slice(handlerStart, handlerEnd);
  assert.ok(handler.indexOf('verifyUpdateInstallerDigest') < handler.indexOf('verifyUpdateInstallerSignature'));
  assert.match(mainSource, /if \(!targetThumbprint\)[\s\S]{0,260}targetStatus !== 'NotSigned'/);
  assert.match(mainSource, /return \{ ok: true, unsigned: true, status: targetStatus \|\| 'NotSigned' \}/);
});

test('unsigned builds are the default while a signed bridge command remains available', () => {
  assert.match(pkg.scripts['build:win'], /signAndEditExecutable=false/);
  assert.match(pkg.scripts['build:win:dir'], /signAndEditExecutable=false/);
  assert.match(pkg.scripts['build:win:signed'], /build-signed\.ps1/);
  assert.equal(pkg.build.win.signAndEditExecutable, false);
});
