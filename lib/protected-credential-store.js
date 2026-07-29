'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'mineradio-safe-storage-v1:';
let safeStorage = null;

try {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.safeStorage) safeStorage = electron.safeStorage;
} catch (_) {}

function encryptionAvailable() {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable());
  } catch (_) {
    return false;
  }
}

function plaintextAllowed() {
  return process.env.MINERADIO_ALLOW_PLAINTEXT_CREDENTIALS === '1'
    || process.env.MINERADIO_ALLOW_PLAINTEXT_COOKIE === '1';
}

function encode(value) {
  const text = String(value == null ? '' : value);
  if (encryptionAvailable()) return PREFIX + safeStorage.encryptString(text).toString('base64');
  if (plaintextAllowed()) return text;
  const error = new Error('SECURE_CREDENTIAL_STORAGE_UNAVAILABLE');
  error.code = 'SECURE_CREDENTIAL_STORAGE_UNAVAILABLE';
  throw error;
}

function decode(payload) {
  payload = String(payload == null ? '' : payload).replace(/^\uFEFF/, '');
  if (!payload.startsWith(PREFIX)) {
    if (!encryptionAvailable() && !plaintextAllowed()) {
      const error = new Error('UNPROTECTED_CREDENTIAL_REJECTED');
      error.code = 'UNPROTECTED_CREDENTIAL_REJECTED';
      throw error;
    }
    return { value: payload, protected: false };
  }
  if (!encryptionAvailable()) {
    const error = new Error('SECURE_CREDENTIAL_STORAGE_UNAVAILABLE');
    error.code = 'SECURE_CREDENTIAL_STORAGE_UNAVAILABLE';
    throw error;
  }
  const encrypted = Buffer.from(payload.slice(PREFIX.length), 'base64');
  return { value: safeStorage.decryptString(encrypted), protected: true };
}

function atomicWrite(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  fs.renameSync(temporaryPath, filePath);
}

function quarantine(filePath, reason) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  const target = `${filePath}.${reason || 'unreadable'}-${Date.now()}`;
  fs.renameSync(filePath, target);
  return target;
}

function remove(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size > 0 && stat.size <= 4 * 1024 * 1024) {
      const handle = fs.openSync(filePath, 'r+');
      try {
        fs.writeSync(handle, Buffer.alloc(stat.size), 0, stat.size, 0);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    }
  } catch (_) {}
  fs.unlinkSync(filePath);
  return true;
}

function writeString(filePath, value) {
  const text = String(value == null ? '' : value);
  if (!text) {
    remove(filePath);
    return true;
  }
  atomicWrite(filePath, encode(text));
  return true;
}

function readString(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  const payload = fs.readFileSync(filePath, 'utf8');
  const protectedPayload = String(payload).replace(/^\uFEFF/, '').startsWith(PREFIX);
  try {
    const decoded = decode(payload);
    if (!decoded.protected && encryptionAvailable()) writeString(filePath, decoded.value);
    return decoded.value;
  } catch (error) {
    if (!protectedPayload) {
      try { quarantine(filePath, 'unprotected'); } catch (_) {}
    }
    throw error;
  }
}

function writeJson(filePath, value) {
  return writeString(filePath, JSON.stringify(value));
}

function readJson(filePath, fallback) {
  const text = readString(filePath);
  return text ? JSON.parse(text) : fallback;
}

module.exports = {
  PREFIX,
  encryptionAvailable,
  exists: filePath => !!(filePath && fs.existsSync(filePath)),
  plaintextAllowed,
  readJson,
  readString,
  remove,
  writeJson,
  writeString,
};
