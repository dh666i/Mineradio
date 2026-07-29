'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const kugouSource = fs.readFileSync(path.join(root, 'kugou-api.js'), 'utf8');
const qishuiSource = fs.readFileSync(path.join(root, 'qishui-api.js'), 'utf8');
const { isKugouAuthInvalidError } = require('../../kugou-api')._test;
const { isQishuiAuthInvalidError } = require('../../qishui-api')._test;

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('QQ expires only explicit authentication failures, not network outages', () => {
  const source = sourceBetween(
    serverSource,
    'function qqProfileAuthInvalid',
    'function expiredQQLoginInfo'
  );
  const qqProfileAuthInvalid = vm.runInNewContext(
    `${source}\nqqProfileAuthInvalid`
  );

  [
    { statusCode: 401 },
    { statusCode: 403 },
    { code: 1000 },
    { result: 301 },
    { message: 'cookie 已过期，请重新登录' },
  ].forEach(value => assert.equal(qqProfileAuthInvalid(value), true));

  [
    { code: 'ETIMEDOUT', message: 'request timed out' },
    { name: 'AbortError', message: 'request aborted' },
    { code: 'ECONNRESET', message: 'socket hang up' },
    { message: 'temporary network failure' },
  ].forEach(value => assert.equal(qqProfileAuthInvalid(value), false));

  const login = sourceBetween(serverSource, 'async function getQQLoginInfo', 'async function qqGetJSON');
  assert.match(login, /if \(qqProfileAuthInvalid\(e\)\) return expiredQQLoginInfo\(\)/);
  assert.match(login, /profileUnavailable:\s*true/);
  assert.match(login, /unavailable:\s*true/);
  assert.match(login, /loginCheckFailed:\s*true/);
});

test('Kugou and Qishui distinguish expired credentials from timeout and network errors', () => {
  const expiredCases = [
    { statusCode: 401 },
    { statusCode: 403 },
    { message: 'token expired, please login again' },
    { body: { message: '登录会话已过期，请重新登录' } },
  ];
  const networkCases = [
    { code: 'ETIMEDOUT', message: 'request timed out' },
    { name: 'AbortError', message: 'request aborted' },
    { code: 'ECONNRESET', message: 'socket hang up' },
    { message: 'temporary network failure' },
  ];

  expiredCases.forEach(value => {
    assert.equal(isKugouAuthInvalidError(value), true);
    assert.equal(isQishuiAuthInvalidError(value), true);
  });
  networkCases.forEach(value => {
    assert.equal(isKugouAuthInvalidError(value), false);
    assert.equal(isQishuiAuthInvalidError(value), false);
  });

  const kugouLogin = sourceBetween(
    kugouSource,
    'async function getKugouLoginInfo',
    'function isKugouAuthInvalidError'
  );
  assert.match(kugouLogin, /profileError && isKugouAuthInvalidError\(profileError\)/);
  assert.match(kugouLogin, /error:\s*'LOGIN_EXPIRED'/);
  assert.match(kugouLogin, /loggedIn:\s*auth\.loggedIn/);
  assert.match(kugouLogin, /unavailable:\s*!!profileError/);
  assert.match(kugouLogin, /loginCheckFailed:\s*!!profileError/);

  const qishuiStatus = sourceBetween(
    qishuiSource,
    'async function handleQishuiStatus',
    'async function fetchQishuiWebPlaylistTracks'
  );
  assert.match(qishuiStatus, /if \(isQishuiAuthInvalidError\(err\)\)/);
  assert.match(qishuiStatus, /status\.error = 'LOGIN_EXPIRED'/);
  assert.match(qishuiStatus, /status\.unavailable = true/);
  assert.match(qishuiStatus, /status\.loginCheckFailed = true/);
});
