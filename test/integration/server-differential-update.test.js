'use strict';

// 差量更新端到端回归:
//   1. 正常路径: 只通过 HTTP Range 下载变化的块, 拼装结果与全量文件字节一致
//   2. 兜底路径: 本地基准包损坏时自动回退整包下载, 更新依然成功
// 通过拦截 require('NeteaseCloudMusicApi') 注入桩模块, 在本进程内启动 server.js,
// 完全离线运行, 不依赖真实网易云包或外网。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------- NeteaseCloudMusicApi 桩 ----------
const neteaseStub = new Proxy({}, {
  get(target, prop) {
    if (typeof prop !== 'string') return undefined;
    return async () => ({ body: {} });
  },
});
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'NeteaseCloudMusicApi') return neteaseStub;
  return realLoad.apply(this, arguments);
};

// ---------- 合成安装包与 blockmap ----------
const BLOCK = 64 * 1024;
function makeBlock(seed, size) {
  const buf = Buffer.alloc(size || BLOCK);
  for (let i = 0; i < buf.length; i++) buf[i] = (seed * 131 + i * 17) & 0xff;
  return buf;
}
function blockMapFor(blocks) {
  return zlib.gzipSync(Buffer.from(JSON.stringify({
    version: '2',
    files: [{
      name: 'file',
      offset: 0,
      checksums: blocks.map(b => crypto.createHash('sha256').update(b).digest('base64')),
      sizes: blocks.map(b => b.length),
    }],
  }), 'utf8'));
}

const oldBlocks = [];
for (let i = 0; i < 40; i++) oldBlocks.push(makeBlock(i + 1));
const oldFile = Buffer.concat(oldBlocks);
const oldMapGz = blockMapFor(oldBlocks);

// 新文件: 改 2 块、隔一块再改 1 块 (触发间隙合并)、中部插入 3 块、尾部追加 2 块
const newBlocks = oldBlocks.slice();
newBlocks[5] = makeBlock(1005);
newBlocks[6] = makeBlock(1006);
newBlocks[10] = makeBlock(1010);
newBlocks[12] = makeBlock(1012);
newBlocks.splice(20, 0, makeBlock(2001), makeBlock(2002), makeBlock(2003));
newBlocks.push(makeBlock(3001), makeBlock(3002, 17 * 1024));
const newFile = Buffer.concat(newBlocks);
const newMapGz = blockMapFor(newBlocks);
const newSha256 = crypto.createHash('sha256').update(newFile).digest('hex');
const newSha512 = crypto.createHash('sha512').update(newFile).digest('base64');

// 第二轮目标 (回退路径用): 在 newFile 基础上再改一些块
const thirdBlocks = newBlocks.slice();
thirdBlocks[3] = makeBlock(4003);
thirdBlocks[30] = makeBlock(4030);
const thirdFile = Buffer.concat(thirdBlocks);
const thirdMapGz = blockMapFor(thirdBlocks);
const thirdSha256 = crypto.createHash('sha256').update(thirdFile).digest('hex');

// ---------- 带 Range 支持的固定资产服务器 ----------
const stats = { rangeRequests: 0, rangeBytes: 0, fullDownloads: 0 };
let manifestVersion = '9.9.9';
const assets = () => ({
  ['/Mineradio-9.9.9-Setup.exe']: newFile,
  ['/Mineradio-9.9.9-Setup.exe.blockmap']: newMapGz,
  ['/Mineradio-9.9.10-Setup.exe']: thirdFile,
  ['/Mineradio-9.9.10-Setup.exe.blockmap']: thirdMapGz,
  ['/Mineradio-9.9.8-Setup.exe.blockmap']: oldMapGz,
});
let fixturePort = 0;
const fixture = http.createServer((req, res) => {
  if (req.url === '/manifest.json') {
    const version = manifestVersion;
    const fileName = `Mineradio-${version}-Setup.exe`;
    const body = version === '9.9.9' ? newFile : thirdFile;
    const sha256 = version === '9.9.9' ? newSha256 : thirdSha256;
    const downloadUrl = `http://127.0.0.1:${fixturePort}/${fileName}`;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      latestVersion: version,
      updateAvailable: true,
      release: {
        version,
        downloadUrl,
        asset: { name: fileName, size: body.length, downloadUrl, sha256, sha512: version === '9.9.9' ? newSha512 : '' },
      },
    }));
    return;
  }
  const body = assets()[req.url];
  if (!body) { res.writeHead(404).end(); return; }
  const range = String(req.headers.range || '');
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (match && req.url.endsWith('.exe')) {
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    const slice = body.subarray(start, end + 1);
    stats.rangeRequests += 1;
    stats.rangeBytes += slice.length;
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Content-Length': slice.length,
    });
    res.end(slice);
    return;
  }
  if (req.url.endsWith('.exe')) stats.fullDownloads += 1;
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
  res.end(body);
});

let server = null;
let base = '';
let downloadsDir = '';
let workDir = '';
const POST_HEADERS = { 'Content-Type': 'application/json', 'X-Mineradio-Request': '1' };

async function getJson(pathname, options) {
  const response = await fetch(base + pathname, options);
  return { response, body: await response.json().catch(() => null) };
}
async function runDownloadJobToCompletion() {
  const started = await getJson('/api/update/download', { method: 'POST', headers: POST_HEADERS, body: '{}' });
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.ok, true, JSON.stringify(started.body));
  const id = started.body.id;
  const deadline = Date.now() + 15000;
  let status = started.body;
  while (Date.now() < deadline) {
    if (status.status === 'ready' || status.status === 'error') break;
    await new Promise(resolve => setTimeout(resolve, 120));
    status = (await getJson(`/api/update/download/status?id=${encodeURIComponent(id)}`)).body;
  }
  return status;
}

test.before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-differential-'));
  downloadsDir = path.join(workDir, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  // 预置旧版安装包缓存 + blockmap 边车 (模拟上一次更新留下的现场)
  fs.writeFileSync(path.join(downloadsDir, 'Mineradio-9.9.8-Setup.exe'), oldFile);
  fs.writeFileSync(path.join(downloadsDir, 'Mineradio-9.9.8-Setup.exe.blockmap'), oldMapGz);

  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  fixturePort = fixture.address().port;

  process.env.COOKIE_FILE = path.join(workDir, '.cookie');
  process.env.QQ_COOKIE_FILE = path.join(workDir, '.qq-cookie');
  process.env.MINERADIO_BEAT_CACHE_DIR = path.join(workDir, 'beatmap-cache');
  process.env.MINERADIO_UPDATE_MANIFEST = `http://127.0.0.1:${fixturePort}/manifest.json`;
  process.env.MINERADIO_UPDATE_MIRRORS = 'disabled';
  process.env.MINERADIO_UPDATE_DIR = workDir;
  process.env.MINERADIO_UPDATE_DOWNLOAD_DIR = downloadsDir;
  process.env.MINERADIO_RUNTIME_PLATFORM = 'win32';
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';

  server = require(path.join(ROOT, 'server.js'));
  const listenDeadline = Date.now() + 5000;
  while (!server.address() || !(server.address().port > 0)) {
    if (Date.now() >= listenDeadline) throw new Error('local test server did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  Module._load = realLoad;
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => fixture.close(resolve));
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('differential update fetches only changed ranges and assembles a byte-identical installer', { timeout: 20000 }, async () => {
  const status = await runDownloadJobToCompletion();
  assert.equal(status.status, 'ready', JSON.stringify(status));
  assert.equal(status.mode, 'differential', 'job should complete via the differential path');
  assert.equal(stats.fullDownloads, 0, 'full installer must not be downloaded');
  assert.ok(stats.rangeRequests >= 1, 'at least one range request expected');
  assert.ok(
    stats.rangeBytes < newFile.length * 0.5,
    `range bytes ${stats.rangeBytes} should be far below full size ${newFile.length}`
  );

  const assembledPath = path.join(downloadsDir, 'Mineradio-9.9.9-Setup.exe');
  const assembled = fs.readFileSync(assembledPath);
  assert.equal(crypto.createHash('sha256').update(assembled).digest('hex'), newSha256, 'assembled file must be byte-identical');
  assert.equal(fs.existsSync(assembledPath + '.blockmap'), true, 'new blockmap sidecar saved for the next differential');
  assert.equal(fs.existsSync(path.join(downloadsDir, 'Mineradio-9.9.8-Setup.exe')), false, 'older cached installer pruned');
});

test('corrupted local base falls back to a verified full download', { timeout: 20000 }, async () => {
  // 弄脏上一轮留下的 9.9.9 缓存 (保持大小与边车不变), 目标切到 9.9.10
  const basePath = path.join(downloadsDir, 'Mineradio-9.9.9-Setup.exe');
  const corrupted = fs.readFileSync(basePath);
  for (let i = 0; i < 64; i++) corrupted[128 * 1024 + i] ^= 0xff;
  fs.writeFileSync(basePath, corrupted);
  manifestVersion = '9.9.10';
  const fullBefore = stats.fullDownloads;
  // 与真实用户路径一致: 手动"检查更新"强制刷新检查缓存, 再开始下载
  const check = await getJson('/api/update/latest?force=1');
  assert.equal(check.body.latestVersion, '9.9.10');

  const status = await runDownloadJobToCompletion();
  assert.equal(status.status, 'ready', JSON.stringify(status));
  assert.equal(status.mode, 'installer', 'fallback should finish as a full download');
  assert.equal(stats.fullDownloads, fullBefore + 1, 'exactly one full download after fallback');
  assert.ok(
    (status.failedAttempts || []).some(item => String(item.source || '').includes('差量')),
    'failure list should mention the differential attempt'
  );
  const assembled = fs.readFileSync(path.join(downloadsDir, 'Mineradio-9.9.10-Setup.exe'));
  assert.equal(crypto.createHash('sha256').update(assembled).digest('hex'), thirdSha256);
});
