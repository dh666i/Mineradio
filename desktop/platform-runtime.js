'use strict';

const path = require('path');

const COMMON_CHROMIUM_PERFORMANCE_SWITCHES = Object.freeze([
  ['autoplay-policy', 'no-user-gesture-required'],
  ['ignore-gpu-blocklist'],
  ['enable-gpu-rasterization'],
  ['enable-oop-rasterization'],
  ['enable-zero-copy'],
  ['enable-accelerated-2d-canvas'],
]);

const WINDOWS_CHROMIUM_PERFORMANCE_SWITCHES = Object.freeze([
  ['force_high_performance_gpu'],
  ['use-angle', 'd3d11'],
]);

function chromiumPerformanceSwitches(platform = process.platform) {
  const switches = COMMON_CHROMIUM_PERFORMANCE_SWITCHES.map(item => item.slice());
  if (platform === 'win32') {
    WINDOWS_CHROMIUM_PERFORMANCE_SWITCHES.forEach(item => switches.push(item.slice()));
  }
  return switches;
}

function appIconPath(projectRoot, platform = process.platform) {
  const extension = platform === 'win32' ? 'ico' : 'png';
  return path.join(projectRoot, 'build', `icon.${extension}`);
}

function runtimeCapabilities(platform = process.platform) {
  return Object.freeze({
    installerUpdates: platform === 'win32',
    taskbarMediaButtons: platform === 'win32',
    wallpaperEmbedding: platform === 'win32',
    trayBalloon: platform === 'win32',
  });
}

function filesystemPathKey(value, platform = process.platform) {
  const resolved = path.resolve(String(value || '.')).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = {
  appIconPath,
  chromiumPerformanceSwitches,
  filesystemPathKey,
  runtimeCapabilities,
};
