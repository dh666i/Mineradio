'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const store = require('../../lib/protected-credential-store');

test('protected credential store round-trips JSON through its atomic file API', () => {
  const previous = process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-credential-'));
  const file = path.join(directory, 'credential.json');
  process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS = '1';
  try {
    store.writeJson(file, { token: 'test-token', scopes: ['read'] });
    assert.deepEqual(store.readJson(file, null), { token: 'test-token', scopes: ['read'] });
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    assert.equal(store.remove(file), true);
    assert.equal(store.exists(file), false);
  } finally {
    if (previous == null) delete process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS;
    else process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('plaintext writes are rejected when secure storage is unavailable', {
  skip: store.encryptionAvailable(),
}, () => {
  const previousCredentials = process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS;
  const previousCookies = process.env.MINERADIO_ALLOW_PLAINTEXT_COOKIE;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-credential-'));
  const file = path.join(directory, 'credential.txt');
  delete process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS;
  delete process.env.MINERADIO_ALLOW_PLAINTEXT_COOKIE;
  try {
    assert.throws(
      () => store.writeString(file, 'secret'),
      error => error && error.code === 'SECURE_CREDENTIAL_STORAGE_UNAVAILABLE'
    );
    assert.equal(fs.existsSync(file), false);
  } finally {
    if (previousCredentials == null) delete process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS;
    else process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS = previousCredentials;
    if (previousCookies == null) delete process.env.MINERADIO_ALLOW_PLAINTEXT_COOKIE;
    else process.env.MINERADIO_ALLOW_PLAINTEXT_COOKIE = previousCookies;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unprotected plaintext credentials are quarantined instead of being loaded', {
  skip: store.encryptionAvailable(),
}, () => {
  const previousCredentials = process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS;
  const previousCookies = process.env.MINERADIO_ALLOW_PLAINTEXT_COOKIE;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-credential-'));
  const file = path.join(directory, 'credential.txt');
  delete process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS;
  delete process.env.MINERADIO_ALLOW_PLAINTEXT_COOKIE;
  try {
    fs.writeFileSync(file, 'legacy-plaintext-secret', 'utf8');
    assert.throws(
      () => store.readString(file),
      error => error && error.code === 'UNPROTECTED_CREDENTIAL_REJECTED'
    );
    assert.equal(fs.existsSync(file), false);
    const quarantined = fs.readdirSync(directory)
      .filter(name => name.startsWith('credential.txt.unprotected-'));
    assert.equal(quarantined.length, 1);
    assert.equal(
      fs.readFileSync(path.join(directory, quarantined[0]), 'utf8'),
      'legacy-plaintext-secret'
    );
  } finally {
    if (previousCredentials == null) delete process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS;
    else process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS = previousCredentials;
    if (previousCookies == null) delete process.env.MINERADIO_ALLOW_PLAINTEXT_COOKIE;
    else process.env.MINERADIO_ALLOW_PLAINTEXT_COOKIE = previousCookies;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
