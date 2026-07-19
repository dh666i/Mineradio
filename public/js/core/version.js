(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.MineradioCore = root.MineradioCore || {};
    root.MineradioCore.version = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION_PATTERN = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

  function parseVersion(value) {
    var input = String(value == null ? '' : value).trim().replace(/^v(?=\d)/i, '');
    var match = input.match(VERSION_PATTERN);
    if (!match) return null;
    if (match[4] && match[4].split('.').some(function (identifier) {
      return /^\d{2,}$/.test(identifier) && identifier.charAt(0) === '0';
    })) return null;

    return {
      raw: String(value == null ? '' : value),
      major: Number(match[1]),
      minor: Number(match[2] || 0),
      patch: Number(match[3] || 0),
      prerelease: match[4] ? match[4].split('.') : [],
      build: match[5] || '',
    };
  }

  function comparePrerelease(left, right) {
    if (!left.length && !right.length) return 0;
    if (!left.length) return 1;
    if (!right.length) return -1;

    var count = Math.max(left.length, right.length);
    for (var i = 0; i < count; i++) {
      if (left[i] == null) return -1;
      if (right[i] == null) return 1;

      var a = left[i];
      var b = right[i];
      if (a === b) continue;

      var aNumeric = /^\d+$/.test(a);
      var bNumeric = /^\d+$/.test(b);
      if (aNumeric && bNumeric) {
        var aTrimmed = a.replace(/^0+(?=\d)/, '');
        var bTrimmed = b.replace(/^0+(?=\d)/, '');
        if (aTrimmed.length !== bTrimmed.length) return aTrimmed.length > bTrimmed.length ? 1 : -1;
        return aTrimmed > bTrimmed ? 1 : -1;
      }
      if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
      return a > b ? 1 : -1;
    }
    return 0;
  }

  function compareVersions(leftValue, rightValue) {
    var left = parseVersion(leftValue);
    var right = parseVersion(rightValue);
    if (!left || !right) throw new TypeError('Invalid version value');

    var fields = ['major', 'minor', 'patch'];
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (left[field] > right[field]) return 1;
      if (left[field] < right[field]) return -1;
    }
    return comparePrerelease(left.prerelease, right.prerelease);
  }

  function isUpdateAvailable(latestVersion, currentVersion) {
    try {
      return compareVersions(latestVersion, currentVersion) > 0;
    } catch (error) {
      return false;
    }
  }

  return {
    parseVersion: parseVersion,
    compareVersions: compareVersions,
    isUpdateAvailable: isUpdateAvailable,
  };
});
