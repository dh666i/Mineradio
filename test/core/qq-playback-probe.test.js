'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const probeSource = sourceBetween(
  serverSource,
  'const QQ_PLAYABLE_PROBE_LIMIT',
  'async function handleQQSongUrl',
);
const handlerSource = sourceBetween(
  serverSource,
  'async function handleQQSongUrl',
  'function mapQQComment',
);
const context = vm.createContext({
  AbortController,
  URL,
  http,
  https,
  QQ_HEADERS: { 'User-Agent': 'Mineradio test' },
  setTimeout,
  clearTimeout,
});
vm.runInContext(probeSource, context, { filename: 'server-qq-playback-probe.js' });

test('QQ stream probe uses a bounded two-byte request and accepts only playable responses', async t => {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, range: request.headers.range });
    if (request.url === '/playable') {
      response.writeHead(206, {
        'Content-Type': 'audio/mpeg',
        'Content-Range': 'bytes 0-1/10',
      });
      response.end('ab');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal(await context.qqProbePlayable(base + '/missing', { timeoutMs: 1000 }), false);
  assert.equal(await context.qqProbePlayable(base + '/playable', { timeoutMs: 1000 }), true);
  assert.deepEqual(seen, [
    { url: '/missing', range: 'bytes=0-1' },
    { url: '/playable', range: 'bytes=0-1' },
  ]);
});

test('candidate selection keeps quality order when lower candidates respond sooner', async () => {
  const infos = [
    { filename: 'high.flac', purl: 'high.flac?vkey=1' },
    { filename: 'lossless.flac', purl: 'lossless.flac?vkey=2' },
    { filename: 'standard.mp3', purl: 'standard.mp3?vkey=3' },
  ];
  const delays = new Map([
    ['high.flac', 20],
    ['lossless.flac', 30],
    ['standard.mp3', 1],
  ]);
  const playable = new Set(['lossless.flac', 'standard.mp3']);

  const selected = await context.selectQQPlayableInfo(infos, 'https://stream.example/base/', targetUrl => {
    const name = new URL(targetUrl).pathname.split('/').pop();
    return new Promise(resolve => setTimeout(() => resolve(playable.has(name)), delays.get(name)));
  });

  assert.equal(selected.info.filename, 'lossless.flac');
  assert.equal(selected.url, 'https://stream.example/base/lossless.flac?vkey=2');
  assert.equal(selected.verified, true);
});

test('candidate selection resolves as soon as the highest quality is verified', async () => {
  const infos = [
    { filename: 'high.flac', purl: 'high.flac' },
    { filename: 'lower.mp3', purl: 'lower.mp3' },
  ];
  const selected = await context.selectQQPlayableInfo(infos, 'https://stream.example/', targetUrl => {
    if (targetUrl.endsWith('/high.flac')) return true;
    return new Promise(() => {});
  });

  assert.equal(selected.info.filename, 'high.flac');
  assert.equal(selected.verified, true);
});

test('candidate selection falls back when probes exceed the shared budget', async () => {
  const infos = [
    { filename: 'high.flac', purl: 'high.flac' },
    { filename: 'lower.mp3', purl: 'lower.mp3' },
  ];
  const startedAt = Date.now();
  const selected = await context.selectQQPlayableInfo(
    infos,
    'https://stream.example/',
    () => new Promise(() => {}),
    { timeoutMs: 60 },
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(selected.info.filename, 'high.flac');
  assert.equal(selected.verified, false);
  assert.equal(selected.timedOut, true);
  assert.ok(elapsedMs >= 40, `probe budget returned too early (${elapsedMs}ms)`);
  assert.ok(elapsedMs < 500, `probe budget returned too late (${elapsedMs}ms)`);
});

test('candidate probing is capped and preserves the legacy fallback on probe failure', async () => {
  const infos = Array.from({ length: 6 }, (_, index) => ({
    filename: `quality-${index}.flac`,
    purl: `quality-${index}.flac`,
  }));
  const calls = [];
  const selected = await context.selectQQPlayableInfo(infos, 'https://stream.example/', targetUrl => {
    calls.push(targetUrl);
    return false;
  });

  assert.equal(calls.length, 4);
  assert.equal(selected.info.filename, 'quality-0.flac');
  assert.equal(selected.verified, false);
});

test('QQ URL handler returns the selected verified candidate instead of the first purl', () => {
  assert.match(probeSource, /QQ_PLAYABLE_PROBE_LIMIT = 4/);
  assert.match(probeSource, /QQ_PLAYABLE_PROBE_TIMEOUT_MS = 2500/);
  assert.match(probeSource, /QQ_VKEY_TIMEOUT_MS = 6000/);
  assert.match(probeSource, /QQ_SONG_URL_TOTAL_TIMEOUT_MS = 9000/);
  assert.match(probeSource, /Range: 'bytes=0-1'/);
  assert.match(probeSource, /response\.statusCode === 200 \|\| response\.statusCode === 206/);
  assert.match(handlerSource, /timeoutMs: Math\.min\(QQ_VKEY_TIMEOUT_MS, remainingBudgetMs\(\)\)/);
  assert.match(handlerSource, /await selectQQPlayableInfo\(infos, sip, null, \{\s*timeoutMs: remainingBudgetMs\(\),\s*\}\)/);
  assert.match(handlerSource, /url: selected\.url \|\| resolveQQStreamUrl\(sip, purl\)/);
});
