const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createQishuiAudioProxy,
  parseEncryptedAudioUrl,
  resolveByteRange,
  sendAudioBuffer,
  validateTopLevelMp4,
} = require('../../lib/qishui-audio-proxy');

const serverSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server.js'), 'utf8');

function mp4Box(type, data) {
  data = Buffer.from(data || []);
  const output = Buffer.alloc(8 + data.length);
  output.writeUInt32BE(output.length, 0);
  output.write(type, 4, 4, 'ascii');
  data.copy(output, 8);
  return output;
}

function minimalEncryptedMp4() {
  return Buffer.concat([
    mp4Box('ftyp', Buffer.from('isom')),
    mp4Box('moov'),
    mp4Box('mdat', Buffer.alloc(16, 7)),
  ]);
}

function mockResponse(buffer, declaredLength) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-length'
          ? String(declaredLength == null ? buffer.length : declaredLength)
          : null;
      },
    },
    arrayBuffer: async () => buffer,
  };
}

function mockServerResponse() {
  return {
    status: 0,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ? Buffer.from(body) : Buffer.alloc(0);
    },
  };
}

test('encrypted Qishui URLs keep the auth fragment out of the upstream request', () => {
  assert.deepEqual(
    parseEncryptedAudioUrl('https://audio.example/track.m4a#auth=a%2Bb%3D'),
    { cleanUrl: 'https://audio.example/track.m4a', auth: 'a+b=' }
  );
});

test('MP4 validation accepts bounded required boxes and rejects overflow boxes', () => {
  assert.equal(validateTopLevelMp4(minimalEncryptedMp4()), true);
  const invalid = Buffer.from(minimalEncryptedMp4());
  invalid.writeUInt32BE(invalid.length + 100, 0);
  assert.throws(() => validateTopLevelMp4(invalid), /MP4 box/);
});

test('Qishui audio load deduplicates inflight work and caches decrypted buffers', async () => {
  let fetchCount = 0;
  let decryptCount = 0;
  const encrypted = minimalEncryptedMp4();
  const proxy = createQishuiAudioProxy({
    fetch: async () => {
      fetchCount += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return mockResponse(encrypted);
    },
    decryptor: {
      decrypt() {
        decryptCount += 1;
        return { buffer: Buffer.from('decoded-audio'), extension: '.m4a' };
      },
    },
    maxSourceBytes: 1024,
    maxCacheBytes: 4096,
  });
  const url = 'https://audio.example/track.m4a#auth=test-key';
  const [first, second] = await Promise.all([proxy.load(url), proxy.load(url)]);
  const third = await proxy.load(url);
  assert.equal(first.buffer.toString(), 'decoded-audio');
  assert.equal(second.buffer.toString(), 'decoded-audio');
  assert.equal(third.buffer.toString(), 'decoded-audio');
  assert.equal(fetchCount, 1);
  assert.equal(decryptCount, 1);
});

test('Qishui audio load keeps shared work alive while another consumer is waiting', async () => {
  const encrypted = minimalEncryptedMp4();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let resolveFetch;
  let upstreamSignal;
  let fetchCount = 0;
  const proxy = createQishuiAudioProxy({
    fetch: async (_url, options) => {
      fetchCount += 1;
      upstreamSignal = options.signal;
      await new Promise(resolve => { resolveFetch = resolve; });
      return mockResponse(encrypted);
    },
    decryptor: {
      decrypt: () => ({ buffer: Buffer.from('shared-audio'), extension: '.m4a' }),
    },
    maxSourceBytes: 1024,
    maxCacheBytes: 4096,
  });
  const url = 'https://audio.example/shared.m4a#auth=shared-key';
  const first = proxy.load(url, {}, { signal: firstController.signal });
  const second = proxy.load(url, {}, { signal: secondController.signal });
  while (!upstreamSignal) await new Promise(resolve => setImmediate(resolve));

  firstController.abort();
  await assert.rejects(first, error => error && error.code === 'QISHUI_AUDIO_CLIENT_ABORTED');
  assert.equal(upstreamSignal.aborted, false);

  resolveFetch();
  const payload = await second;
  assert.equal(payload.buffer.toString(), 'shared-audio');
  assert.equal(fetchCount, 1);
});

test('Qishui audio load aborts upstream work after every consumer disconnects', async () => {
  const controller = new AbortController();
  let upstreamSignal;
  const proxy = createQishuiAudioProxy({
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      upstreamSignal = options.signal;
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
    decryptor: { decrypt: () => ({ buffer: Buffer.from('unused'), extension: '.m4a' }) },
    fetchTimeoutMs: 2000,
  });
  const pending = proxy.load(
    'https://audio.example/disconnect.m4a#auth=disconnect-key',
    {},
    { signal: controller.signal }
  );
  while (!upstreamSignal) await new Promise(resolve => setImmediate(resolve));

  controller.abort();
  await assert.rejects(pending, error => error && error.code === 'QISHUI_AUDIO_CLIENT_ABORTED');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstreamSignal.aborted, true);
});

test('a new Qishui request replaces an aborted inflight entry immediately', async () => {
  const encrypted = minimalEncryptedMp4();
  const controller = new AbortController();
  let firstUpstreamSignal;
  let fetchCount = 0;
  const proxy = createQishuiAudioProxy({
    fetch: async (_url, options) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        firstUpstreamSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            setTimeout(() => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            }, 20);
          }, { once: true });
        });
      }
      return mockResponse(encrypted);
    },
    decryptor: {
      decrypt: () => ({ buffer: Buffer.from('replacement-audio'), extension: '.m4a' }),
    },
    maxSourceBytes: 1024,
    maxCacheBytes: 4096,
  });
  const url = 'https://audio.example/replacement.m4a#auth=replacement-key';
  const first = proxy.load(url, {}, { signal: controller.signal });
  while (!firstUpstreamSignal) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(first, error => error && error.code === 'QISHUI_AUDIO_CLIENT_ABORTED');

  const replacement = await proxy.load(url);
  assert.equal(replacement.buffer.toString(), 'replacement-audio');
  assert.equal(fetchCount, 2);
});

test('Qishui audio route forwards downstream disconnects without writing a late response', () => {
  assert.match(serverSource, /req\.once\('aborted', abortDownstream\)/);
  assert.match(serverSource, /res\.once\('close', abortDownstream\)/);
  assert.match(serverSource, /qishuiAudioProxy\.load\([\s\S]*?\{ signal: downstreamController\.signal \}/);
  assert.match(serverSource, /downstreamController\.signal\.aborted \|\| res\.destroyed \|\| res\.writableEnded/);
  assert.match(serverSource, /err\.code === 'QISHUI_AUDIO_CLIENT_ABORTED'/);
});

test('Qishui audio load rejects declared files above the configured limit', async () => {
  const encrypted = minimalEncryptedMp4();
  const proxy = createQishuiAudioProxy({
    fetch: async () => mockResponse(encrypted, 2048),
    decryptor: { decrypt: () => ({ buffer: Buffer.from('unused'), extension: '.m4a' }) },
    maxSourceBytes: 1024,
  });
  await assert.rejects(
    proxy.load('https://audio.example/large.m4a#auth=test-key'),
    error => error && error.code === 'QISHUI_AUDIO_TOO_LARGE' && error.statusCode === 413
  );
});

test('decrypted audio responses implement regular, open, and suffix byte ranges', () => {
  assert.deepEqual(resolveByteRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(resolveByteRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(resolveByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.equal(resolveByteRange('bytes=20-30', 10).invalid, true);

  const response = mockServerResponse();
  sendAudioBuffer(response, { buffer: Buffer.from('0123456789'), contentType: 'audio/mp4' }, 'bytes=-3', 'GET');
  assert.equal(response.status, 206);
  assert.equal(response.headers['Content-Range'], 'bytes 7-9/10');
  assert.equal(response.body.toString(), '789');
});
