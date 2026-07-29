'use strict';

// 差量更新真机验证脚本: 用 dist/ 里两个真实安装包走一遍生产差量路径。
// 用法:  node scripts/verify-differential-update.js [旧版本] [新版本] [--require-differential]
// 例如:  node scripts/verify-differential-update.js 1.5.4 3.0.1
// 默认读取 dist/，也可通过 MINERADIO_VERIFY_DIST 指定隔离目录。
// 需要目录下存在两个版本的 Setup.exe 与 .blockmap。验证过程全程本地回环。

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(process.env.MINERADIO_VERIFY_DIST || path.join(ROOT, 'dist'));
const cliArgs = process.argv.slice(2);
const requireDifferential = cliArgs.includes('--require-differential');
const versionArgs = cliArgs.filter(arg => arg !== '--require-differential');
const oldVersion = versionArgs[0] || '1.5.4';
const newVersion = versionArgs[1] || '3.0.1';

function mustRead(file) {
  if (!fs.existsSync(file)) {
    console.error('缺少文件:', file);
    process.exit(2);
  }
  return fs.readFileSync(file);
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function main() {
  const oldExe = mustRead(path.join(DIST, `Mineradio-${oldVersion}-Setup.exe`));
  const oldMap = mustRead(path.join(DIST, `Mineradio-${oldVersion}-Setup.exe.blockmap`));
  const newExe = mustRead(path.join(DIST, `Mineradio-${newVersion}-Setup.exe`));
  const newMap = mustRead(path.join(DIST, `Mineradio-${newVersion}-Setup.exe.blockmap`));
  const newSha256 = sha256(newExe);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-diff-verify-'));
  const downloadsDir = path.join(workDir, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.writeFileSync(path.join(downloadsDir, `Mineradio-${oldVersion}-Setup.exe`), oldExe);
  fs.writeFileSync(path.join(downloadsDir, `Mineradio-${oldVersion}-Setup.exe.blockmap`), oldMap);

  const stats = { rangeRequests: 0, rangeBytes: 0, fullDownloads: 0 };
  let fixturePort = 0;
  const fixture = http.createServer((req, res) => {
    if (req.url === '/manifest.json') {
      const downloadUrl = `http://127.0.0.1:${fixturePort}/Mineradio-${newVersion}-Setup.exe`;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        latestVersion: newVersion,
        updateAvailable: true,
        release: {
          version: newVersion,
          downloadUrl,
          asset: { name: `Mineradio-${newVersion}-Setup.exe`, size: newExe.length, downloadUrl, sha256: newSha256 },
        },
      }));
      return;
    }
    const body = req.url === `/Mineradio-${newVersion}-Setup.exe` ? newExe
      : req.url === `/Mineradio-${newVersion}-Setup.exe.blockmap` ? newMap
      : null;
    if (!body) { res.writeHead(404).end(); return; }
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ''));
    if (match && req.url.endsWith('.exe')) {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), body.length - 1);
      const slice = body.subarray(start, end + 1);
      stats.rangeRequests += 1;
      stats.rangeBytes += slice.length;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Content-Length': slice.length,
        'Content-Type': 'application/octet-stream',
      });
      res.end(slice);
      return;
    }
    if (req.url.endsWith('.exe')) stats.fullDownloads += 1;
    res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  fixturePort = fixture.address().port;

  process.env.COOKIE_FILE = path.join(workDir, '.cookie');
  process.env.QQ_COOKIE_FILE = path.join(workDir, '.qq-cookie');
  process.env.MINERADIO_BEAT_CACHE_DIR = path.join(workDir, 'beatmap-cache');
  process.env.MINERADIO_UPDATE_MANIFEST = `http://127.0.0.1:${fixturePort}/manifest.json`;
  process.env.MINERADIO_UPDATE_MIRRORS = 'disabled';
  process.env.MINERADIO_UPDATE_DIR = workDir;
  process.env.MINERADIO_UPDATE_DOWNLOAD_DIR = downloadsDir;
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';

  const server = require(path.join(ROOT, 'server.js'));
  const listenDeadline = Date.now() + 5000;
  while (!server.address() || !(server.address().port > 0)) {
    if (Date.now() >= listenDeadline) throw new Error('本地验证服务器启动超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Mineradio-Request': '1' };

  const startedAt = Date.now();
  const start = await (await fetch(base + '/api/update/download', { method: 'POST', headers, body: '{}' })).json();
  if (!start.ok) throw new Error('下载任务启动失败: ' + JSON.stringify(start));
  let status = start;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && status.status !== 'ready' && status.status !== 'error') {
    await new Promise(resolve => setTimeout(resolve, 200));
    status = await (await fetch(base + `/api/update/download/status?id=${encodeURIComponent(start.id)}`)).json();
  }
  console.log('任务状态:', status.status, '| 模式:', status.mode, '|', status.message);
  console.log('Range 请求:', stats.rangeRequests, '| 差量下载:', (stats.rangeBytes / 1024 / 1024).toFixed(2) + ' MB',
    '| 整包下载次数:', stats.fullDownloads, '| 耗时:', ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
  const assembledPath = path.join(downloadsDir, `Mineradio-${newVersion}-Setup.exe`);
  const identical = status.status === 'ready' && sha256(fs.readFileSync(assembledPath)) === newSha256;
  console.log('拼装结果与全量安装包逐字节一致:', identical);
  console.log('全量', (newExe.length / 1024 / 1024).toFixed(1) + ' MB → 实际下载',
    (stats.rangeBytes / 1024 / 1024).toFixed(2) + ' MB (' + Math.round((stats.rangeBytes / newExe.length) * 100) + '%)');
  fs.rmSync(workDir, { recursive: true, force: true });
  if (!identical || (requireDifferential && status.mode !== 'differential')) {
    console.error('验证未通过');
    process.exit(1);
  }
  if (status.mode === 'differential') {
    console.log('差量更新验证通过 ✔');
  } else {
    console.log('差量不划算，整包回退与完整性校验通过 ✔');
  }
  process.exit(0);
}
main().catch((err) => { console.error('验证失败:', err); process.exit(1); });
