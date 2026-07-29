'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadRedactor() {
  const context = {};
  vm.runInNewContext(
    `${sourceBetween('function redactDiagnosticText(value)', 'function recordDiagnosticEvent')}\nthis.redact = redactDiagnosticText;`,
    context
  );
  return context.redact;
}

test('diagnostic redaction removes JSON cookie arrays and OAuth credentials', () => {
  const redact = loadRedactor();
  const message = JSON.stringify({
    status: 405,
    cookie: ['NMTID=secret-tracking-value; Path=/'],
    headers: {
      'set-cookie': ['MUSIC_U=secret-session; HttpOnly'],
      authorization: 'Bearer secret.access.token',
    },
    access_token: 'spotify-access',
    refreshToken: 'spotify-refresh',
    clientSecret: 'spotify-secret',
  });
  const output = redact(message);

  assert.doesNotMatch(output, /secret-tracking-value|secret-session|secret\.access\.token/);
  assert.doesNotMatch(output, /spotify-access|spotify-refresh|spotify-secret/);
  assert.match(output, /\[redacted\]/);
  assert.match(output, /"status":405/);
});

test('diagnostic redaction covers cookie assignments, bearer values, and query secrets', () => {
  const redact = loadRedactor();
  const output = redact(
    'MUSIC_U=session-value; NMTID=tracking-value Authorization: Bearer abc.def ' +
    'https://example.test/callback?code=oauth-code&token=api-token'
  );

  assert.doesNotMatch(output, /session-value|tracking-value|abc\.def|oauth-code|api-token/);
  assert.match(output, /MUSIC_U=\[redacted\]/);
  assert.match(output, /NMTID=\[redacted\]/);
  assert.match(output, /Bearer \[redacted\]/);
});

test('diagnostic redaction hides macOS and Linux home directory paths', () => {
  const redact = loadRedactor();
  const output = redact(
    'mac=/Users/alice/Library/Application Support/Mineradio/main.log ' +
    'linux=/home/bob/.config/Mineradio/main.log'
  );

  assert.doesNotMatch(output, /alice|bob|\/Users\/|\/home\//);
  assert.match(output, /\[local-path\]/);
});

test('historical diagnostic logs are scrubbed after the primary instance lock is acquired', () => {
  const lock = source.indexOf('const gotSingleInstanceLock = app.requestSingleInstanceLock()');
  const scrub = source.indexOf('if (gotSingleInstanceLock) scrubPersistentDiagnosticLogs()', lock);

  assert.ok(lock > 0);
  assert.ok(scrub > lock);
  assert.match(
    sourceBetween('function scrubPersistentDiagnosticLogs()', "['warn', 'error'].forEach"),
    /parsed\.message = redactDiagnosticText\(parsed\.message\)/
  );
});
