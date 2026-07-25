'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('account dialogs expose only accessible Netease and QQ Music tabs', () => {
  const loginModal = sourceBetween(indexSource, '<div id="login-modal"', '<!-- 用户模态 -->');
  const userModal = sourceBetween(indexSource, '<div id="user-modal"', '<!-- 封面裁剪模态 -->');
  const loginTabs = loginModal.match(/<button\b[^>]*\brole="tab"[^>]*>/g) || [];
  const userTabs = userModal.match(/<button\b[^>]*\brole="tab"[^>]*>/g) || [];

  assert.match(loginModal, /id="login-platform-tabs"[^>]*role="tablist"/);
  assert.match(userModal, /id="user-platform-tabs"[^>]*role="tablist"/);
  assert.equal(loginTabs.length, 2);
  assert.equal(userTabs.length, 2);
  assert.match(loginModal, /id="login-provider-netease"[^>]*aria-selected="true"/);
  assert.match(loginModal, /id="login-provider-qq"[^>]*aria-selected="false"/);
  assert.match(userModal, /id="user-provider-netease"[^>]*aria-selected="true"/);
  assert.match(userModal, /id="user-provider-qq"[^>]*aria-selected="false"/);

  const loginUi = sourceBetween(indexSource, 'function updateLoginProviderUi()', 'async function refreshQr()');
  const userUi = sourceBetween(indexSource, 'function updateUserModalUi()', 'function showUserModal()');
  assert.match(loginUi, /neteaseBtn\.setAttribute\('aria-selected'/);
  assert.match(loginUi, /qqBtn\.setAttribute\('aria-selected'/);
  assert.match(userUi, /\['netease','qq'\]\.forEach/);
  assert.match(userUi, /btn\.setAttribute\('aria-selected'/);
});

test('dual-account and YouTube account UI cannot return', () => {
  const loginModal = sourceBetween(indexSource, '<div id="login-modal"', '<!-- 用户模态 -->');
  const userModal = sourceBetween(indexSource, '<div id="user-modal"', '<!-- 封面裁剪模态 -->');
  const accountUi = loginModal + userModal;

  assert.doesNotMatch(accountUi, /YouTube|Google|OAuth/i);
  assert.doesNotMatch(accountUi, /我两个都要|login-both-btn|user-provider-both/);
  assert.doesNotMatch(indexSource, /dualAccountMode|renderTopAccountPill|enableDualAccountView|requestDualLoginMode/);
  assert.doesNotMatch(indexSource, /multi-account|top-account-pill|top-account-name/);
});

test('top account button and fullscreen DIY anchor use the active provider only', () => {
  const renderUser = sourceBetween(indexSource, 'function renderUserBtn()', 'async function showLoginModal');
  const layoutDiy = sourceBetween(indexSource, 'function layoutFullscreenDiyZone()', 'function shouldSuppressFullscreenDiyPeek()');
  const pointerDiy = sourceBetween(indexSource, 'function updateFullscreenDiyPeekFromPointer', 'function isDiyMode()');

  assert.match(renderUser, /activeAccountProvider = firstLoggedProvider\(\)/);
  assert.match(renderUser, /platformStatus\(activeAccountProvider\)/);
  assert.doesNotMatch(renderUser, /renderTopAccountPill|multi-account/);
  assert.match(layoutDiy, /var anchor = document\.getElementById\('user-btn'\)/);
  assert.match(pointerDiy, /var anchor = document\.getElementById\('user-btn'\)/);
});
