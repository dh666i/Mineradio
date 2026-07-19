'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const version = require('../../public/js/core/version');

test('parseVersion accepts v-prefixed and shortened versions', () => {
  assert.deepEqual(version.parseVersion(' v1.4 '), {
    raw: ' v1.4 ',
    major: 1,
    minor: 4,
    patch: 0,
    prerelease: [],
    build: '',
  });
});

test('compareVersions compares core version components', () => {
  assert.equal(version.compareVersions('1.4.0', '1.3.2'), 1);
  assert.equal(version.compareVersions('1.3.2', '1.4.0'), -1);
  assert.equal(version.compareVersions('1.3', '1.3.0'), 0);
});

test('compareVersions follows prerelease precedence', () => {
  assert.equal(version.compareVersions('1.4.0-beta.2', '1.4.0-beta.11'), -1);
  assert.equal(version.compareVersions('1.4.0-beta', '1.4.0'), -1);
  assert.equal(version.compareVersions('1.4.0-rc.1', '1.4.0-beta.9'), 1);
});

test('build metadata does not affect precedence', () => {
  assert.equal(version.compareVersions('1.4.0+build.9', '1.4.0+build.1'), 0);
});

test('invalid versions never produce an available update', () => {
  assert.equal(version.parseVersion('release-latest'), null);
  assert.equal(version.isUpdateAvailable('release-latest', '1.3.2'), false);
  assert.throws(() => version.compareVersions('release-latest', '1.3.2'), TypeError);
  assert.equal(version.parseVersion('1.4.0-beta.01'), null);
  assert.equal(version.isUpdateAvailable('1.4.0-beta.01', '1.3.2'), false);
});

test('isUpdateAvailable only returns true for a newer valid version', () => {
  assert.equal(version.isUpdateAvailable('v1.4.0', '1.3.2'), true);
  assert.equal(version.isUpdateAvailable('1.3.2', '1.3.2'), false);
  assert.equal(version.isUpdateAvailable('1.4.0-beta.1', '1.4.0'), false);
});
