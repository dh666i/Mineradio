'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('QQ cookie selection ignores expiry and prefers the current music domain', () => {
  assert.match(mainSource, /function cookieIsExpired/);
  assert.match(mainSource, /function qqLoginCookieCandidateScore/);
  assert.match(mainSource, /domain === 'y\.qq\.com' \|\| domain\.endsWith\('\.y\.qq\.com'\)/);
  assert.match(mainSource, /cookieIsExpired\(cookie, nowSeconds\)/);
  assert.match(mainSource, /QQ_LOGIN_COOKIE_PRIORITY, qqLoginCookieCandidateScore/);
});

test('QQ reconnect clears the isolated login partition before opening the page', () => {
  assert.match(mainSource, /async function openQQMusicLoginWindow\(owner, options = \{\}\)/);
  assert.match(mainSource, /if \(options\.forceReauth\)[\s\S]*?cookieSession\.clearStorageData/);
  assert.match(mainSource, /!options\.forceReauth && qqCookieHasPlaybackLogin/);
  assert.match(mainSource, /ipcMain\.handle\('qq-music-open-login', async \(event, options\)/);
  assert.match(preloadSource, /openQQMusicLogin: \(options\) => ipcRenderer\.invoke\('qq-music-open-login', options \|\| \{\}\)/);
  assert.match(indexSource, /forceReauth: !!\(qqLoginStatus && qqLoginStatus\.loggedIn\)/);
});

test('QQ membership refresh preserves last known state but marks it stale on failure', () => {
  assert.match(serverSource, /getQQLoginInfo\(\{ forceVip: true \}\)/);
  assert.match(indexSource, /options\.forceVip \? '&forceVip=1' : ''/);
  assert.match(indexSource, /membershipStale: true/);
  assert.match(indexSource, /vipSyncState: 'stale'/);
});
