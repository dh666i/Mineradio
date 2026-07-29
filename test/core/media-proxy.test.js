'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const {
  createMediaProxy,
  isForbiddenAddress,
} = require('../../lib/media-proxy');
const { createQishuiAudioProxy } = require('../../lib/qishui-audio-proxy');

const PUBLIC_ADDRESS = '8.8.8.8';

function publicLookup() {
  return Promise.resolve([{ address: PUBLIC_ADDRESS, family: 4 }]);
}

function createMockTransport(handler) {
  const state = {
    requests: [],
    responses: [],
  };

  const transport = (target, options, onResponse) => {
    const request = new EventEmitter();
    const entry = {
      target: target.toString(),
      options,
      request,
      response: null,
      destroyed: false,
    };
    state.requests.push(entry);

    request.end = () => {
      const socket = new EventEmitter();
      socket.connecting = false;
      request.emit('socket', socket);
      queueMicrotask(async () => {
        if (entry.destroyed) return;
        let spec;
        try {
          spec = await handler(target, options, state.requests.length - 1);
        } catch (error) {
          request.emit('error', error);
          return;
        }
        if (!spec || entry.destroyed) return;

        const response = new PassThrough();
        response.statusCode = spec.status == null ? 200 : spec.status;
        response.headers = { ...(spec.headers || {}) };
        response.setTimeout = spec.idleTimer
          ? (milliseconds, callback) => {
              const timer = setTimeout(callback, milliseconds);
              const clear = () => clearTimeout(timer);
              response.once('end', clear);
              response.once('close', clear);
              return response;
            }
          : () => response;
        entry.response = response;
        state.responses.push(response);
        onResponse(response);

        if (!spec.hold) {
          setImmediate(() => {
            if (response.destroyed) return;
            for (const chunk of spec.chunks || [spec.body || Buffer.alloc(0)]) {
              response.write(Buffer.from(chunk));
            }
            response.end();
          });
        }
      });
    };
    request.destroy = error => {
      if (entry.destroyed) return;
      entry.destroyed = true;
      if (entry.response && !entry.response.destroyed) entry.response.destroy(error);
      if (error) queueMicrotask(() => request.emit('error', error));
    };
    return request;
  };

  transport.state = state;
  return transport;
}

function createHangingConnectTransport() {
  const state = { destroyed: false };
  const transport = () => {
    const request = new EventEmitter();
    request.end = () => {
      const socket = new EventEmitter();
      socket.connecting = true;
      request.emit('socket', socket);
    };
    request.destroy = error => {
      if (state.destroyed) return;
      state.destroyed = true;
      if (error) queueMicrotask(() => request.emit('error', error));
    };
    return request;
  };
  transport.state = state;
  return transport;
}

class MockServerResponse extends Writable {
  constructor() {
    super();
    this.status = 0;
    this.headers = {};
    this.headersSent = false;
    this.chunks = [];
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = { ...(headers || {}) };
    this.headersSent = true;
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  get body() {
    return Buffer.concat(this.chunks);
  }
}

function mockRequest(method) {
  const request = new EventEmitter();
  request.method = method || 'GET';
  request.complete = true;
  request.headers = {};
  return request;
}

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

test('address classifier rejects local, private, link-local, multicast, and reserved IPs', () => {
  const forbidden = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:0:7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
    '64:ff9b::c000:201',
    '64:ff9b:1::7f00:1',
    '64:ff9b:1::808:808',
    '2001::1',
    '2002:7f00:1::',
    '3fff::1',
  ];
  for (const address of forbidden) assert.equal(isForbiddenAddress(address), true, address);
  assert.equal(isForbiddenAddress(PUBLIC_ADDRESS), false);
  assert.equal(isForbiddenAddress('64:ff9b::808:808'), false);
  assert.equal(isForbiddenAddress('64:ff9b::1.1.1.1'), false);
  assert.equal(isForbiddenAddress('2606:4700:4700::1111'), false);
});

test('URL validation rejects credentials, unsafe schemes, and non-default ports', async () => {
  const proxy = createMediaProxy({ lookup: publicLookup });
  const targets = [
    'file:///etc/passwd',
    'ftp://example.test/track.mp3',
    'https://user:secret@example.test/track.mp3',
    'https://example.test:8443/track.mp3',
  ];
  for (const target of targets) {
    await assert.rejects(
      proxy.fetch(target),
      error => error && [400, 403].includes(error.statusCode)
    );
  }
});

test('literal private IPv4 and IPv6 targets are rejected before transport', async () => {
  const transport = createMockTransport(() => ({ body: 'unreachable' }));
  const proxy = createMediaProxy({ lookup: publicLookup, transport });
  const targets = [
    'http://127.0.0.1/track.mp3',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/track.mp3',
    'http://[::ffff:127.0.0.1]/track.mp3',
  ];
  for (const target of targets) {
    await assert.rejects(
      proxy.fetch(target),
      error => error && error.code === 'MEDIA_PROXY_ADDRESS_FORBIDDEN'
    );
  }
  assert.equal(transport.state.requests.length, 0);
});

test('DNS answers containing any private address are rejected as a unit', async () => {
  const transport = createMockTransport(() => ({ body: 'unreachable' }));
  const proxy = createMediaProxy({
    lookup: async () => [
      { address: PUBLIC_ADDRESS, family: 4 },
      { address: '192.168.1.10', family: 4 },
    ],
    transport,
  });
  await assert.rejects(
    proxy.fetch('https://mixed.example/track.mp3'),
    error => error && error.code === 'MEDIA_PROXY_ADDRESS_FORBIDDEN'
  );
  assert.equal(transport.state.requests.length, 0);
});

test('validated DNS results are pinned into the outbound request lookup', async () => {
  let pinned;
  const transport = createMockTransport(async (_target, options) => {
    pinned = await new Promise((resolve, reject) => {
      options.lookup('media.example', { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });
    return {
      headers: { 'content-type': 'audio/mpeg', 'content-length': '2' },
      body: 'ok',
    };
  });
  const proxy = createMediaProxy({ lookup: publicLookup, transport });
  const response = await proxy.fetch('https://media.example/track.mp3');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'ok');
  assert.deepEqual(pinned, [{ address: PUBLIC_ADDRESS, family: 4 }]);
  assert.equal(transport.state.requests[0].options.agent, false);
});

test('every redirect hop is revalidated and private redirect targets are rejected', async () => {
  const transport = createMockTransport(() => ({
    status: 302,
    headers: { location: 'http://127.0.0.1/internal.mp3' },
  }));
  const proxy = createMediaProxy({ lookup: publicLookup, transport });
  await assert.rejects(
    proxy.fetch('https://public.example/start.mp3'),
    error => error && error.code === 'MEDIA_PROXY_ADDRESS_FORBIDDEN'
  );
  assert.equal(transport.state.requests.length, 1);
});

test('redirect count is bounded', async () => {
  const transport = createMockTransport((_target, _options, index) => ({
    status: 302,
    headers: { location: '/redirect-' + (index + 1) },
  }));
  const proxy = createMediaProxy({
    lookup: publicLookup,
    transport,
    maxRedirects: 2,
  });
  await assert.rejects(
    proxy.fetch('https://public.example/start'),
    error => error && error.code === 'MEDIA_PROXY_TOO_MANY_REDIRECTS'
  );
  assert.equal(transport.state.requests.length, 3);
});

test('pipe rejects SVG and explicit non-audio MIME without extension fallback', async () => {
  const transport = createMockTransport(target => {
    if (target.pathname.endsWith('.svg')) {
      return { headers: { 'content-type': 'image/svg+xml' }, body: '<svg />' };
    }
    return { headers: { 'content-type': 'text/html' }, body: '<html />' };
  });
  const proxy = createMediaProxy({ lookup: publicLookup, transport });

  const imageResponse = new MockServerResponse();
  const imageResult = await proxy.pipe(
    mockRequest(),
    imageResponse,
    'https://media.example/cover.svg',
    { kind: 'image' }
  );
  assert.equal(imageResult.ok, false);
  assert.equal(imageResponse.status, 415);
  assert.equal(imageResponse.headers['X-Content-Type-Options'], 'nosniff');

  const audioResponse = new MockServerResponse();
  const audioResult = await proxy.pipe(
    mockRequest(),
    audioResponse,
    'https://media.example/track.mp3',
    { kind: 'audio' }
  );
  assert.equal(audioResult.ok, false);
  assert.equal(audioResponse.status, 415);
});

test('image proxy accepts common CDN MIME aliases and emits canonical image types', async () => {
  const aliases = [
    ['image/jpg', 'image/jpeg'],
    ['image/pjpeg', 'image/jpeg'],
    ['image/x-png', 'image/png'],
  ];

  for (const [upstreamType, expectedType] of aliases) {
    const transport = createMockTransport(() => ({
      headers: { 'content-type': upstreamType, 'content-length': '4' },
      body: 'data',
    }));
    const proxy = createMediaProxy({ lookup: publicLookup, transport });
    const response = new MockServerResponse();
    const result = await proxy.pipe(
      mockRequest(),
      response,
      'https://media.example/cover.jpg',
      { kind: 'image' }
    );

    assert.deepEqual(result, { ok: true, status: 200 }, upstreamType);
    assert.equal(response.headers['Content-Type'], expectedType, upstreamType);
    assert.equal(response.body.toString(), 'data', upstreamType);
  }
});

test('audio pipe forwards Range, 206 metadata, CORS, and nosniff headers', async () => {
  const transport = createMockTransport((_target, options) => {
    assert.equal(options.headers.range, 'bytes=2-4');
    assert.equal(options.headers['accept-encoding'], 'identity');
    return {
      status: 206,
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': '3',
        'content-range': 'bytes 2-4/10',
      },
      body: '234',
    };
  });
  const proxy = createMediaProxy({ lookup: publicLookup, transport });
  const response = new MockServerResponse();
  const result = await proxy.pipe(
    mockRequest(),
    response,
    'https://media.example/track.mp3',
    { kind: 'audio', headers: { Range: 'bytes=2-4' } }
  );

  assert.deepEqual(result, { ok: true, status: 206 });
  assert.equal(response.status, 206);
  assert.equal(response.headers['Content-Type'], 'audio/mpeg');
  assert.equal(response.headers['Content-Range'], 'bytes 2-4/10');
  assert.equal(response.headers['Accept-Ranges'], 'bytes');
  assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.body.toString(), '234');
});

test('invalid, multiple, and unsafe byte Range requests are rejected before transport', async () => {
  const transport = createMockTransport(() => ({
    headers: { 'content-type': 'audio/mpeg', 'content-length': '1' },
    body: 'x',
  }));
  const proxy = createMediaProxy({ lookup: publicLookup, transport });
  const invalidRanges = [
    'bytes=',
    'bytes=-0',
    'bytes=5-4',
    'bytes=0-1,2-3',
    'items=0-1',
    'bytes=9007199254740992-',
    'bytes=0-9007199254740992',
  ];

  for (const range of invalidRanges) {
    const response = new MockServerResponse();
    const result = await proxy.pipe(
      mockRequest(),
      response,
      'https://media.example/track.mp3',
      { kind: 'audio', headers: { Range: range } }
    );
    assert.equal(result.ok, false, range);
    assert.equal(result.error.code, 'MEDIA_PROXY_REQUEST_RANGE_INVALID', range);
    assert.equal(response.status, 400, range);
  }
  assert.equal(transport.state.requests.length, 0);
});

test('open-ended and suffix byte ranges require matching upstream 206 intervals', async () => {
  const cases = [
    {
      request: 'bytes=8-99',
      contentRange: 'bytes 8-9/10',
      contentLength: '2',
      body: '89',
    },
    {
      request: 'bytes=7-',
      contentRange: 'bytes 7-9/10',
      contentLength: '3',
      body: '789',
    },
    {
      request: 'bytes=-3',
      contentRange: 'bytes 7-9/10',
      contentLength: '3',
      body: '789',
    },
  ];

  for (const spec of cases) {
    const transport = createMockTransport(() => ({
      status: 206,
      headers: {
        'content-type': 'audio/mpeg',
        'content-range': spec.contentRange,
        'content-length': spec.contentLength,
      },
      body: spec.body,
    }));
    const proxy = createMediaProxy({ lookup: publicLookup, transport });
    const response = new MockServerResponse();
    const result = await proxy.pipe(
      mockRequest(),
      response,
      'https://media.example/track.mp3',
      { kind: 'audio', headers: { Range: spec.request } }
    );
    assert.deepEqual(result, { ok: true, status: 206 }, spec.request);
    assert.equal(response.body.toString(), spec.body, spec.request);
  }
});

test('206 responses must match the requested interval and declared byte length', async () => {
  const cases = [
    {
      name: 'unsolicited partial response',
      request: null,
      contentRange: 'bytes 0-2/10',
      contentLength: '3',
    },
    {
      name: 'shifted closed interval',
      request: 'bytes=2-4',
      contentRange: 'bytes 3-4/10',
      contentLength: '2',
    },
    {
      name: 'closed interval exceeds request',
      request: 'bytes=2-4',
      contentRange: 'bytes 2-5/10',
      contentLength: '4',
    },
    {
      name: 'open interval ends before representation',
      request: 'bytes=5-',
      contentRange: 'bytes 5-8/10',
      contentLength: '4',
    },
    {
      name: 'suffix interval is not at representation end',
      request: 'bytes=-3',
      contentRange: 'bytes 6-8/10',
      contentLength: '3',
    },
    {
      name: 'content length disagrees with interval',
      request: 'bytes=2-4',
      contentRange: 'bytes 2-4/10',
      contentLength: '2',
    },
    {
      name: 'unsafe complete length',
      request: 'bytes=2-4',
      contentRange: 'bytes 2-4/9007199254740992',
      contentLength: '3',
    },
  ];

  for (const spec of cases) {
    const transport = createMockTransport(() => ({
      status: 206,
      headers: {
        'content-type': 'audio/mpeg',
        'content-range': spec.contentRange,
        'content-length': spec.contentLength,
      },
      body: '234',
    }));
    const proxy = createMediaProxy({ lookup: publicLookup, transport });
    const response = new MockServerResponse();
    const headers = spec.request ? { Range: spec.request } : {};
    const result = await proxy.pipe(
      mockRequest(),
      response,
      'https://media.example/track.mp3',
      { kind: 'audio', headers }
    );
    assert.equal(result.ok, false, spec.name);
    assert.equal(result.error.code, 'MEDIA_PROXY_RANGE_INVALID', spec.name);
    assert.equal(response.status, 502, spec.name);
  }
});

test('partial responses without a valid Content-Range are rejected', async () => {
  const transport = createMockTransport(() => ({
    status: 206,
    headers: {
      'content-type': 'audio/mpeg',
      'content-length': '3',
    },
    body: '234',
  }));
  const proxy = createMediaProxy({ lookup: publicLookup, transport });
  const response = new MockServerResponse();
  const result = await proxy.pipe(
    mockRequest(),
    response,
    'https://media.example/track.mp3',
    { kind: 'audio', headers: { Range: 'bytes=2-4' } }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_PROXY_RANGE_INVALID');
  assert.equal(response.status, 502);
});

test('invalid upstream Content-Length is rejected instead of silently omitted', async () => {
  const transport = createMockTransport(() => ({
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'content-length': 'not-a-length',
    },
    body: 'data',
  }));
  const proxy = createMediaProxy({ lookup: publicLookup, transport });
  const response = new MockServerResponse();
  const result = await proxy.pipe(
    mockRequest(),
    response,
    'https://media.example/track.mp3',
    { kind: 'audio' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_PROXY_LENGTH_INVALID');
  assert.equal(response.status, 502);
});

test('416 responses require a valid and semantically unsatisfied byte range', async () => {
  const cases = [
    {
      name: 'missing Content-Range',
      request: 'bytes=99-',
      contentRange: null,
    },
    {
      name: 'malformed Content-Range',
      request: 'bytes=99-',
      contentRange: 'bytes 99-100/10',
    },
    {
      name: 'unsafe complete length',
      request: 'bytes=99-',
      contentRange: 'bytes */9007199254740992',
    },
    {
      name: 'unsolicited 416',
      request: null,
      contentRange: 'bytes */10',
    },
    {
      name: 'requested interval is satisfiable',
      request: 'bytes=2-4',
      contentRange: 'bytes */10',
    },
    {
      name: 'suffix interval is satisfiable',
      request: 'bytes=-3',
      contentRange: 'bytes */10',
    },
  ];

  for (const spec of cases) {
    const headers = spec.contentRange ? { 'content-range': spec.contentRange } : {};
    const transport = createMockTransport(() => ({
      status: 416,
      headers,
      body: 'ignored',
    }));
    const proxy = createMediaProxy({ lookup: publicLookup, transport });
    const response = new MockServerResponse();
    const requestHeaders = spec.request ? { Range: spec.request } : {};
    const result = await proxy.pipe(
      mockRequest(),
      response,
      'https://media.example/range.mp3',
      { kind: 'audio', headers: requestHeaders }
    );
    assert.equal(result.ok, false, spec.name);
    assert.equal(result.error.code, 'MEDIA_PROXY_RANGE_INVALID', spec.name);
    assert.equal(response.status, 502, spec.name);
  }

  const emptyTransport = createMockTransport(() => ({
    status: 416,
    headers: { 'content-range': 'bytes */0' },
  }));
  const emptyProxy = createMediaProxy({ lookup: publicLookup, transport: emptyTransport });
  const emptyResponse = new MockServerResponse();
  const emptyResult = await emptyProxy.pipe(
    mockRequest(),
    emptyResponse,
    'https://media.example/empty.mp3',
    { kind: 'audio', headers: { Range: 'bytes=-3' } }
  );
  assert.deepEqual(emptyResult, { ok: true, status: 416 });
  assert.equal(emptyResponse.headers['Content-Range'], 'bytes */0');
});

test('HEAD and unsatisfied Range responses do not stream an upstream body', async () => {
  const transport = createMockTransport(target => {
    if (target.pathname === '/head.png') {
      return {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '4' },
        body: 'data',
      };
    }
    return {
      status: 416,
      headers: { 'content-range': 'bytes */10' },
      body: 'ignored',
    };
  });
  const proxy = createMediaProxy({ lookup: publicLookup, transport });

  const headResponse = new MockServerResponse();
  await proxy.pipe(
    mockRequest('HEAD'),
    headResponse,
    'https://media.example/head.png',
    { kind: 'image' }
  );
  assert.equal(transport.state.requests[0].options.method, 'HEAD');
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.body.length, 0);

  const rangeResponse = new MockServerResponse();
  await proxy.pipe(
    mockRequest(),
    rangeResponse,
    'https://media.example/range.mp3',
    { kind: 'audio', headers: { Range: 'bytes=99-' } }
  );
  assert.equal(rangeResponse.status, 416);
  assert.equal(rangeResponse.headers['Content-Range'], 'bytes */10');
  assert.equal(rangeResponse.headers['Accept-Ranges'], 'bytes');
  assert.equal(rangeResponse.body.length, 0);
});

test('missing and octet-stream audio MIME are inferred only for known extensions', async () => {
  const transport = createMockTransport(target => ({
    headers: target.pathname.endsWith('.mp3')
      ? { 'content-type': 'application/octet-stream', 'content-length': '2' }
      : { 'content-type': 'application/octet-stream', 'content-length': '2' },
    body: 'ok',
  }));
  const proxy = createMediaProxy({ lookup: publicLookup, transport });

  const accepted = new MockServerResponse();
  await proxy.pipe(
    mockRequest(),
    accepted,
    'https://media.example/track.mp3',
    { kind: 'audio' }
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers['Content-Type'], 'audio/mpeg');

  const rejected = new MockServerResponse();
  await proxy.pipe(
    mockRequest(),
    rejected,
    'https://media.example/download',
    { kind: 'audio' }
  );
  assert.equal(rejected.status, 415);
});

test('connection, idle, and total timeouts are distinct and return 504 errors', async () => {
  const connectTransport = createHangingConnectTransport();
  const connectProxy = createMediaProxy({
    lookup: publicLookup,
    transport: connectTransport,
    connectTimeoutMs: 15,
    totalTimeoutMs: 200,
  });
  await assert.rejects(
    connectProxy.fetch('https://media.example/connect.mp3'),
    error => error && error.code === 'MEDIA_PROXY_CONNECT_TIMEOUT' && error.statusCode === 504
  );
  assert.equal(connectTransport.state.destroyed, true);

  const idleTransport = createMockTransport(() => ({
    headers: { 'content-type': 'audio/mpeg' },
    hold: true,
    idleTimer: true,
  }));
  const idleProxy = createMediaProxy({
    lookup: publicLookup,
    transport: idleTransport,
    idleTimeoutMs: 15,
    totalTimeoutMs: 200,
  });
  const idleResponse = await idleProxy.fetch('https://media.example/idle.mp3');
  const idleRead = idleResponse.body.getReader().read();
  await assert.rejects(
    idleRead,
    error => error && error.code === 'MEDIA_PROXY_IDLE_TIMEOUT' && error.statusCode === 504
  );

  const totalProxy = createMediaProxy({
    lookup: () => new Promise(() => {}),
    transport: createMockTransport(() => null),
    connectTimeoutMs: 200,
    totalTimeoutMs: 15,
  });
  await assert.rejects(
    totalProxy.fetch('https://media.example/dns.mp3'),
    error => error && error.code === 'MEDIA_PROXY_TOTAL_TIMEOUT' && error.statusCode === 504
  );
});

test('AbortSignal remains active after headers and reader cancellation destroys upstream', async () => {
  const transport = createMockTransport(() => ({
    headers: { 'content-type': 'application/octet-stream' },
    hold: true,
  }));
  const proxy = createMediaProxy({ lookup: publicLookup, transport });
  const controller = new AbortController();
  const response = await proxy.fetch('https://media.example/encrypted.m4a', {
    signal: controller.signal,
  });
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  const reader = response.body.getReader();
  const pendingRead = reader.read();
  controller.abort();
  await assert.rejects(pendingRead, error => error && error.name === 'AbortError');
  assert.equal(transport.state.responses[0].destroyed, true);

  const cancelTransport = createMockTransport(() => ({
    headers: { 'content-type': 'video/mp4' },
    hold: true,
  }));
  const cancelProxy = createMediaProxy({ lookup: publicLookup, transport: cancelTransport });
  const cancelResponse = await cancelProxy.fetch('https://media.example/cancel.m4a');
  const cancelReader = cancelResponse.body.getReader();
  await cancelReader.cancel();
  cancelReader.releaseLock();
  assert.equal(cancelTransport.state.responses[0].destroyed, true);

  const bodyCancelTransport = createMockTransport(() => ({
    headers: { 'content-type': 'video/mp4' },
    hold: true,
  }));
  const bodyCancelProxy = createMediaProxy({ lookup: publicLookup, transport: bodyCancelTransport });
  const bodyCancelResponse = await bodyCancelProxy.fetch('https://media.example/body-cancel.m4a');
  await bodyCancelResponse.body.cancel();
  assert.equal(bodyCancelResponse.bodyUsed, true);
  assert.equal(bodyCancelTransport.state.responses[0].destroyed, true);
});

test('downstream disconnect aborts an active streaming proxy request', async () => {
  const transport = createMockTransport(() => ({
    headers: { 'content-type': 'audio/mpeg' },
    hold: true,
  }));
  const proxy = createMediaProxy({ lookup: publicLookup, transport });
  const response = new MockServerResponse();
  const operation = proxy.pipe(
    mockRequest(),
    response,
    'https://media.example/live.mp3',
    { kind: 'audio' }
  );

  while (!transport.state.responses.length) {
    await new Promise(resolve => setImmediate(resolve));
  }
  response.emit('close');
  const result = await operation;
  assert.equal(result.ok, false);
  assert.equal(transport.state.responses[0].destroyed, true);
});

test('secure fetch adapter remains compatible with the Qishui decrypt/cache pipeline', async () => {
  const encrypted = minimalEncryptedMp4();
  const transport = createMockTransport(() => ({
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(encrypted.length),
    },
    chunks: [encrypted.subarray(0, 11), encrypted.subarray(11)],
  }));
  const mediaProxy = createMediaProxy({ lookup: publicLookup, transport });
  const qishuiProxy = createQishuiAudioProxy({
    fetch: mediaProxy.fetch,
    decryptor: {
      decrypt({ encryptedBuffer }) {
        assert.deepEqual(encryptedBuffer, encrypted);
        return { buffer: Buffer.from('decrypted-audio'), extension: '.m4a' };
      },
    },
    maxSourceBytes: 1024,
    maxCacheBytes: 4096,
  });

  const first = await qishuiProxy.load(
    'https://media.example/encrypted.m4a#auth=test-key',
    { 'User-Agent': 'Mineradio test' }
  );
  const second = await qishuiProxy.load(
    'https://media.example/encrypted.m4a#auth=test-key',
    { 'User-Agent': 'Mineradio test' }
  );
  assert.equal(first.buffer.toString(), 'decrypted-audio');
  assert.equal(second.buffer.toString(), 'decrypted-audio');
  assert.equal(transport.state.requests.length, 1);
});
