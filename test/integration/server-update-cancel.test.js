const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port || 0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function unusedPort() {
  const server = net.createServer();
  const port = await listen(server, 0);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Mineradio server exited early: ${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Mineradio server: ${output.join('')}`);
}

test('update download cancellation aborts the stream and removes the partial file', { timeout: 20000 }, async t => {
  const version = '9.9.9';
  const fileName = `Mineradio-${version}-Setup.exe`;
  const asset = Buffer.alloc(4 * 1024 * 1024, 0x5a);
  const sha256 = crypto.createHash('sha256').update(asset).digest('hex');
  let fixturePort = 0;
  let streamClosedEarly = false;

  const fixture = http.createServer((req, res) => {
    if (req.url === '/manifest.json') {
      const downloadUrl = `http://127.0.0.1:${fixturePort}/${fileName}`;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        latestVersion: version,
        updateAvailable: true,
        release: {
          version,
          downloadUrl,
          asset: { name: fileName, size: asset.length, downloadUrl, sha256 },
        },
      }));
      return;
    }
    if (req.url !== `/${fileName}`) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': asset.length,
    });
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= asset.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      const end = Math.min(asset.length, offset + 32 * 1024);
      res.write(asset.subarray(offset, end));
      offset = end;
    }, 40);
    req.once('close', () => {
      clearInterval(timer);
      if (offset < asset.length) streamClosedEarly = true;
    });
  });
  fixturePort = await listen(fixture, 0);
  t.after(() => new Promise(resolve => fixture.close(resolve)));

  const appPort = await unusedPort();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-update-cancel-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const output = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: '127.0.0.1',
      MINERADIO_UPDATE_MANIFEST: `http://127.0.0.1:${fixturePort}/manifest.json`,
      MINERADIO_UPDATE_MIRRORS: 'disabled',
      MINERADIO_UPDATE_DIR: workDir,
      MINERADIO_UPDATE_DOWNLOAD_DIR: path.join(workDir, 'downloads'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  t.after(() => {
    if (child.exitCode == null) child.kill();
  });

  const baseUrl = `http://127.0.0.1:${appPort}`;
  await waitForServer(`${baseUrl}/api/app/version`, child, output);
  const mutationHeaders = {
    'Content-Type': 'application/json',
    'X-Mineradio-Request': '1',
  };
  const startResponse = await fetch(`${baseUrl}/api/update/download`, {
    method: 'POST',
    headers: mutationHeaders,
    body: '{}',
  });
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json();
  assert.equal(started.ok, true);
  assert.match(started.id, /^[a-z0-9-]{8,96}$/i);

  await new Promise(resolve => setTimeout(resolve, 220));
  const cancelResponse = await fetch(`${baseUrl}/api/update/download/cancel`, {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ id: started.id }),
  });
  assert.equal(cancelResponse.status, 200);
  const cancelled = await cancelResponse.json();
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.canCancel, false);

  await new Promise(resolve => setTimeout(resolve, 250));
  const statusResponse = await fetch(`${baseUrl}/api/update/download/status?id=${encodeURIComponent(started.id)}`);
  const status = await statusResponse.json();
  assert.equal(status.status, 'cancelled');
  assert.equal(status.filePath, '');
  assert.equal(streamClosedEarly, true);
  assert.equal(fs.existsSync(path.join(workDir, 'downloads', fileName + '.download')), false);
  assert.equal(fs.existsSync(path.join(workDir, 'downloads', fileName)), false);
});
