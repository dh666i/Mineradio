const { app, BrowserWindow, ipcMain, shell, screen, session, globalShortcut, dialog, nativeImage, Tray, Menu } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

let mainWindow = null;
let tray = null;
let isAppQuitting = false;
let localServer = null;
let mainServerPort = 0;
let desktopLyricsWindow = null;
let desktopLyricsState = {};
let desktopLyricsUserBounds = null;
let desktopLyricsProgrammaticMove = false;
let desktopLyricsPointerCapture = false;
let desktopLyricsMouseIgnored = null;
let desktopLyricsMousePoller = null;
let desktopLyricsMousePollerBuffer = '';
let desktopLyricsHotBounds = null;
let desktopLyricsLastMiddleAt = 0;
let wallpaperWindow = null;
let wallpaperState = {};
let htmlFullscreenActive = false;
let windowFullscreenActive = false;
let mainWindowStateTimer = null;
let backgroundRuntimePolicy = 'auto';
const registeredGlobalHotkeys = new Map();
let systemMediaState = {
  hasTrack: false,
  playing: false,
  canPrevious: false,
  canNext: false,
  title: '',
  artist: '',
};
const taskbarMediaIcons = new Map();
const diagnosticEvents = [];
const adaptiveLoginWindows = new Map();
const invalidatedLoginSessions = { netease: false, qq: false };
let legacyUserDataPath = '';
const PROTECTED_CREDENTIAL_PREFIX = 'mineradio-safe-storage-v1:';

function redactDiagnosticText(value) {
  return String(value == null ? '' : value)
    .replace(/\b(MUSIC_U|MUSIC_A|__csrf|qm_keyst|qqmusic_key|p_skey|skey|token|cookie)\s*[=:]\s*[^\s;,&]+/gi, '$1=[redacted]')
    .replace(/([?&](?:token|key|cookie|auth|code)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/[A-Za-z]:\\[^\r\n"']+/g, '[local-path]')
    .slice(0, 1200);
}

function recordDiagnosticEvent(level, args) {
  const message = Array.from(args || []).map((item) => {
    if (item instanceof Error) return item.stack || item.message;
    if (typeof item === 'string') return item;
    try { return JSON.stringify(item); } catch (_) { return String(item); }
  }).join(' ');
  diagnosticEvents.push({ at: new Date().toISOString(), level, message: redactDiagnosticText(message) });
  if (diagnosticEvents.length > 160) diagnosticEvents.splice(0, diagnosticEvents.length - 160);
}

['warn', 'error'].forEach((level) => {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    recordDiagnosticEvent(level, args);
    original(...args.map((item) => {
      if (item instanceof Error) return redactDiagnosticText(item.stack || item.message);
      if (typeof item === 'string') return redactDiagnosticText(item);
      try { return redactDiagnosticText(JSON.stringify(item)); } catch (_) { return redactDiagnosticText(item); }
    }));
  };
});

const WINDOWED_ASPECT = 16 / 9;
const WINDOWED_SCALE = 3 / 4;
const WINDOWED_MARGIN = 32;
const MIN_WINDOWED_WIDTH = 720;
const MIN_WINDOWED_HEIGHT = 405;
const MIN_COMPACT_WIDTH = 480;
const MIN_COMPACT_HEIGHT = 270;
const APP_NAME = 'Mineradio';
const APP_USER_MODEL_ID = 'com.dh666i.mineradio';
const APP_ICON_ICO = path.join(__dirname, '..', 'build', 'icon.ico');
const NETEASE_LOGIN_PARTITION = 'persist:mineradio-netease-login';
const NETEASE_LOGIN_URL = 'https://music.163.com/#/login';
const QQ_LOGIN_PARTITION = 'persist:mineradio-qqmusic-login';
const QQ_LOGIN_URL = 'https://y.qq.com/n/ryqq/profile';

function configureIndependentUserDataPath() {
  const overridePath = String(process.env.MINERADIO_USER_DATA_DIR || '').trim();
  if (overridePath) {
    app.setPath('userData', path.resolve(overridePath));
    return;
  }
  const legacyPath = app.getPath('userData');
  legacyUserDataPath = legacyPath;
  const targetPath = path.join(app.getPath('appData'), 'dh666i', APP_NAME);
  if (path.resolve(legacyPath).toLowerCase() === path.resolve(targetPath).toLowerCase()) return;
  const markerPath = path.join(targetPath, '.mineradio-user-data');
  try {
    if (fs.existsSync(legacyPath) && !fs.existsSync(markerPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
      const skippedNames = new Set([
        'cache', 'code cache', 'gpucache', 'dawncache', 'crashpad', 'crashes',
        'logs', 'updates', 'temp', 'singletoncookie', 'singletonlock', 'singletonsocket',
        '.cookie', '.qq-cookie',
      ]);
      fs.cpSync(legacyPath, targetPath, {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: (source) => !skippedNames.has(path.basename(source).toLowerCase()),
      });
      fs.writeFileSync(markerPath, `Migrated from the legacy Mineradio profile on ${new Date().toISOString()}\n`, 'utf8');
    } else if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
      fs.writeFileSync(markerPath, `Created ${new Date().toISOString()}\n`, 'utf8');
    }
    app.setPath('userData', targetPath);
  } catch (e) {
    console.warn('User data migration deferred:', e.message);
  }
}

function sameResolvedPath(left, right) {
  try { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
  catch (_) { return false; }
}

function stageLegacyCredentialFiles(cookieTarget, qqCookieTarget) {
  const candidates = [];
  if (legacyUserDataPath) {
    candidates.push({ source: path.join(legacyUserDataPath, '.cookie'), target: cookieTarget });
    candidates.push({ source: path.join(legacyUserDataPath, '.qq-cookie'), target: qqCookieTarget });
  }
  candidates.push({ source: path.join(__dirname, '..', '.cookie'), target: cookieTarget });
  candidates.push({ source: path.join(__dirname, '..', '.qq-cookie'), target: qqCookieTarget });

  const seen = new Set();
  const staged = [];
  for (const candidate of candidates) {
    const key = path.resolve(candidate.source).toLowerCase();
    if (seen.has(key) || sameResolvedPath(candidate.source, candidate.target) || !fs.existsSync(candidate.source)) continue;
    seen.add(key);
    try {
      if (!fs.existsSync(candidate.target)) {
        fs.mkdirSync(path.dirname(candidate.target), { recursive: true });
        fs.copyFileSync(candidate.source, candidate.target);
      }
      staged.push(candidate);
    } catch (e) {
      console.warn('Legacy credential staging skipped:', e.message);
    }
  }
  return staged;
}

function protectedCredentialFileReady(filePath) {
  try {
    return fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').startsWith(PROTECTED_CREDENTIAL_PREFIX);
  } catch (_) {
    return false;
  }
}

function scrubLegacyCredentialFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024) {
      const handle = fs.openSync(filePath, 'r+');
      try {
        fs.writeSync(handle, Buffer.alloc(stat.size), 0, stat.size, 0);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    }
    fs.unlinkSync(filePath);
  } catch (e) {
    console.warn('Legacy credential cleanup skipped:', e.message);
  }
}

function finalizeLegacyCredentialMigration(staged) {
  for (const candidate of staged || []) {
    let sourceEmpty = false;
    try { sourceEmpty = fs.existsSync(candidate.source) && fs.statSync(candidate.source).size === 0; } catch (_) {}
    if (sourceEmpty || protectedCredentialFileReady(candidate.target)) scrubLegacyCredentialFile(candidate.source);
  }
}

const CHROMIUM_PERFORMANCE_SWITCHES = [
  ['autoplay-policy', 'no-user-gesture-required'],
  ['ignore-gpu-blocklist'],
  ['enable-gpu-rasterization'],
  ['enable-oop-rasterization'],
  ['enable-zero-copy'],
  ['enable-accelerated-2d-canvas'],
  ['force_high_performance_gpu'],
  ['use-angle', 'd3d11'],
];
for (const [name, value] of CHROMIUM_PERFORMANCE_SWITCHES) {
  if (value == null) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, value);
}
app.setName(APP_NAME);
configureIndependentUserDataPath();
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
const gotSingleInstanceLock = app.requestSingleInstanceLock();

const QQ_LOGIN_COOKIE_PRIORITY = [
  'uin',
  'qqmusic_uin',
  'wxuin',
  'login_type',
  'qm_keyst',
  'qqmusic_key',
  'p_skey',
  'skey',
  'psrf_qqopenid',
  'psrf_qqunionid',
  'psrf_qqaccess_token',
  'psrf_qqrefresh_token',
  'wxopenid',
  'wxunionid',
  'wxrefresh_token',
  'wxskey',
  'p_uin',
  'ptcz',
  'RK',
];
const NETEASE_LOGIN_COOKIE_PRIORITY = [
  'MUSIC_U',
  '__csrf',
  'NMTID',
  'MUSIC_A',
  '__remember_me',
  '_ntes_nuid',
  '_ntes_nnid',
  'WEVNSM',
  'WNMCID',
  'JSESSIONID-WYYY',
];

function findOpenPort(startPort) {
  return new Promise((resolve, reject) => {
    function tryPort(port) {
      const tester = net.createServer();

      tester.once('error', (err) => {
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          tryPort(port + 1);
          return;
        }
        reject(err);
      });

      tester.once('listening', () => {
        tester.close(() => resolve(port));
      });

      tester.listen(port, '127.0.0.1');
    }

    tryPort(startPort);
  });
}

function waitForServer(server) {
  if (!server || server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function sendWindowState(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('desktop-window-state', getWindowState(win));
}

function sendGlobalHotkeyAction(action) {
  if (!mainWindow || mainWindow.isDestroyed() || !action) return;
  mainWindow.webContents.send('mineradio-global-hotkey', { action });
}

function createTaskbarMediaIcon(kind) {
  if (taskbarMediaIcons.has(kind)) return taskbarMediaIcons.get(kind);
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  const setPixel = (x, y, alpha = 235) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (y * size + x) * 4;
    bitmap[offset] = 255;
    bitmap[offset + 1] = 255;
    bitmap[offset + 2] = 255;
    bitmap[offset + 3] = alpha;
  };
  const fillRect = (left, top, right, bottom) => {
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) setPixel(x, y);
    }
  };
  const fillTriangle = (direction) => {
    for (let y = 3; y <= 12; y++) {
      const distance = Math.abs(7.5 - y);
      const width = Math.max(1, Math.floor(5 - distance));
      if (direction === 'right') {
        for (let x = 5; x <= 5 + width; x++) setPixel(x, y);
      } else {
        for (let x = 10 - width; x <= 10; x++) setPixel(x, y);
      }
    }
  };

  if (kind === 'pause') {
    fillRect(4, 3, 6, 12);
    fillRect(9, 3, 11, 12);
  } else if (kind === 'previous') {
    fillRect(3, 3, 4, 12);
    fillTriangle('left');
  } else if (kind === 'next') {
    fillTriangle('right');
    fillRect(11, 3, 12, 12);
  } else {
    fillTriangle('right');
  }

  const image = nativeImage.createFromBitmap(bitmap, { width: size, height: size, scaleFactor: 1 });
  taskbarMediaIcons.set(kind, image);
  return image;
}

function updateTaskbarMediaButtons() {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
  const state = systemMediaState;
  const trackFlags = state.hasTrack ? ['enabled'] : ['disabled'];
  const previousFlags = state.hasTrack && state.canPrevious ? ['enabled'] : ['disabled'];
  const nextFlags = state.hasTrack && state.canNext ? ['enabled'] : ['disabled'];
  mainWindow.setThumbarButtons([
    {
      tooltip: '上一首',
      icon: createTaskbarMediaIcon('previous'),
      flags: previousFlags,
      click: () => sendGlobalHotkeyAction('prevTrack'),
    },
    {
      tooltip: state.playing ? '暂停' : '播放',
      icon: createTaskbarMediaIcon(state.playing ? 'pause' : 'play'),
      flags: trackFlags,
      click: () => sendGlobalHotkeyAction('togglePlay'),
    },
    {
      tooltip: '下一首',
      icon: createTaskbarMediaIcon('next'),
      flags: nextFlags,
      click: () => sendGlobalHotkeyAction('nextTrack'),
    },
  ]);
}

function trayTooltipText() {
  if (!systemMediaState.hasTrack) return APP_NAME;
  const detail = [systemMediaState.title, systemMediaState.artist].filter(Boolean).join(' - ');
  return (detail ? `${APP_NAME}: ${detail}` : APP_NAME).slice(0, 120);
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(trayTooltipText());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Mineradio', click: () => focusMainWindow() },
    { type: 'separator' },
    {
      label: systemMediaState.playing ? '暂停' : '播放',
      enabled: !!systemMediaState.hasTrack,
      click: () => sendGlobalHotkeyAction('togglePlay'),
    },
    {
      label: '上一首',
      enabled: !!(systemMediaState.hasTrack && systemMediaState.canPrevious),
      click: () => sendGlobalHotkeyAction('prevTrack'),
    },
    {
      label: '下一首',
      enabled: !!(systemMediaState.hasTrack && systemMediaState.canNext),
      click: () => sendGlobalHotkeyAction('nextTrack'),
    },
    { type: 'separator' },
    {
      label: '退出 Mineradio',
      click: () => {
        isAppQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  tray = new Tray(APP_ICON_ICO);
  tray.on('click', () => focusMainWindow());
  tray.on('double-click', () => focusMainWindow());
  updateTrayMenu();
  return tray;
}

function showTrayNoticeOnce() {
  if (!tray || tray.isDestroyed()) return;
  const markerPath = path.join(app.getPath('userData'), '.tray-close-notice-shown');
  if (fs.existsSync(markerPath)) return;
  try {
    tray.displayBalloon({
      iconType: 'info',
      title: 'Mineradio 仍在运行',
      content: '音乐会继续播放，可从系统托盘重新打开或退出。',
      noSound: true,
    });
  } catch (_) {}
  try { fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8'); } catch (_) {}
}

function unregisterMineradioGlobalHotkeys() {
  for (const accelerator of registeredGlobalHotkeys.keys()) {
    try { globalShortcut.unregister(accelerator); } catch (e) {}
  }
  registeredGlobalHotkeys.clear();
}

function configureMineradioGlobalHotkeys(bindings = []) {
  unregisterMineradioGlobalHotkeys();
  const results = [];
  const seen = new Set();
  for (const item of Array.isArray(bindings) ? bindings : []) {
    const action = item && String(item.action || '').trim();
    const accelerator = item && String(item.accelerator || '').trim();
    if (!action || !accelerator || seen.has(accelerator)) continue;
    seen.add(accelerator);
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, () => sendGlobalHotkeyAction(action));
    } catch (error) {
      registered = false;
    }
    if (registered) {
      registeredGlobalHotkeys.set(accelerator, action);
      results.push({ action, accelerator, ok: true });
    } else {
      results.push({
        action,
        accelerator,
        ok: false,
        conflict: {
          sourceName: '系统 / 其他软件',
          sourceIcon: 'warning',
          reason: '该组合键已被占用或被系统保留',
        },
      });
    }
  }
  return { ok: true, results };
}

function scheduleWindowStateSend(win, delay = 80) {
  if (!win || win.isDestroyed()) return;
  if (mainWindowStateTimer) clearTimeout(mainWindowStateTimer);
  mainWindowStateTimer = setTimeout(() => {
    mainWindowStateTimer = null;
    sendWindowState(win);
  }, delay);
}

function rectsOverlapOnY(a, b) {
  if (!a || !b) return false;
  const aTop = Number(a.y) || 0;
  const bTop = Number(b.y) || 0;
  const aBottom = aTop + (Number(a.height) || 0);
  const bBottom = bTop + (Number(b.height) || 0);
  return aBottom > bTop && bBottom > aTop;
}

function getDisplayState(win) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : primary;
  const bounds = display && display.bounds ? display.bounds : primary.bounds;
  const workArea = display && display.workArea ? display.workArea : primary.workArea;
  const displayId = display && display.id;
  const primaryId = primary && primary.id;
  const edgeTolerance = 2;
  const hasDisplayOnLeft = displays.some((candidate) => {
    if (!candidate || candidate.id === displayId || !candidate.bounds) return false;
    return rectsOverlapOnY(bounds, candidate.bounds)
      && Math.abs((candidate.bounds.x + candidate.bounds.width) - bounds.x) <= edgeTolerance;
  });
  const hasDisplayOnRight = displays.some((candidate) => {
    if (!candidate || candidate.id === displayId || !candidate.bounds) return false;
    return rectsOverlapOnY(bounds, candidate.bounds)
      && Math.abs((bounds.x + bounds.width) - candidate.bounds.x) <= edgeTolerance;
  });
  return {
    displayId,
    primaryDisplayId: primaryId,
    isPrimaryDisplay: !!(display && primary && display.id === primary.id),
    hasDisplayOnLeft,
    hasDisplayOnRight,
    displayBounds: bounds ? {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    } : null,
    displayWorkArea: workArea ? {
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height,
    } : null,
    displayScaleFactor: Number(display && display.scaleFactor) || 1,
  };
}

function getWindowState(win) {
  if (!win || win.isDestroyed()) return {
    isMaximized: false,
    isNativeFullScreen: false,
    isHtmlFullScreen: false,
    isWindowFullScreen: false,
    isFullScreen: false,
    isMinimized: false,
    isVisible: false,
    isFocused: false,
    isPrimaryDisplay: true,
    hasDisplayOnLeft: false,
    hasDisplayOnRight: false,
    displayBounds: null,
    displayWorkArea: null,
    displayScaleFactor: 1,
  };
  return {
    isMaximized: win.isMaximized(),
    isNativeFullScreen: win.isFullScreen(),
    isHtmlFullScreen: htmlFullscreenActive,
    isWindowFullScreen: windowFullscreenActive,
    isFullScreen: win.isFullScreen() || htmlFullscreenActive || windowFullscreenActive,
    isMinimized: win.isMinimized(),
    isVisible: win.isVisible(),
    isFocused: win.isFocused(),
    ...getDisplayState(win),
  };
}

function getSenderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function isTrustedMainUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:'
      && parsed.hostname === '127.0.0.1'
      && Number(parsed.port) === mainServerPort;
  } catch (_) {
    return false;
  }
}

function isTrustedMainRenderer(event) {
  if (!event || !event.sender || !mainWindow || mainWindow.isDestroyed()) return false;
  if (event.sender.id !== mainWindow.webContents.id) return false;
  if (event.senderFrame && event.senderFrame.parent) return false;
  return isTrustedMainUrl(event.senderFrame && event.senderFrame.url || event.sender.getURL() || '');
}

function normalizeBackgroundRuntimePolicy(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'keep' || mode === 'release' ? mode : 'auto';
}

function applyBackgroundRuntimePolicy(value) {
  backgroundRuntimePolicy = normalizeBackgroundRuntimePolicy(value);
  const backgroundThrottling = backgroundRuntimePolicy !== 'keep';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setBackgroundThrottling(backgroundThrottling);
  }
  return {
    ok: true,
    mode: backgroundRuntimePolicy,
    backgroundThrottling,
    explicitKeepAlive: backgroundRuntimePolicy === 'keep',
  };
}

function normalizeUpdateJobId(value) {
  const id = String(value || '').trim();
  return /^(?:(?:patch|cached)-)?[a-z0-9]{6,24}-[a-z0-9]{4,16}$/i.test(id) ? id : '';
}

async function callLocalUpdateApi(pathname, options = {}) {
  if (!mainServerPort) return { ok: false, error: 'UPDATE_SERVICE_UNAVAILABLE' };
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 6000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = {};
    if (options.body) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD') headers['X-Mineradio-Request'] = '1';
    const response = await fetch(`http://127.0.0.1:${mainServerPort}${pathname}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: 'error',
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch (_) { return { ok: false, error: 'UPDATE_SERVICE_RESPONSE_INVALID' }; }
    if (!response.ok && payload.ok !== false) payload.ok = false;
    if (!response.ok && !payload.error) payload.error = `UPDATE_SERVICE_HTTP_${response.status}`;
    return payload;
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return {
      ok: false,
      error: timedOut ? 'UPDATE_SERVICE_TIMEOUT' : 'UPDATE_SERVICE_UNAVAILABLE',
    };
  } finally {
    clearTimeout(timer);
  }
}

function displayForWindow(win) {
  if (win && !win.isDestroyed()) return screen.getDisplayMatching(win.getBounds());
  return screen.getPrimaryDisplay();
}

function adaptiveWindowBounds(owner, preferredWidth, preferredHeight, designMinWidth, designMinHeight) {
  const display = displayForWindow(owner);
  const area = display.workArea;
  const margin = Math.min(24, Math.max(8, Math.floor(Math.min(area.width, area.height) * 0.025)));
  const availableWidth = Math.max(320, area.width - margin * 2);
  const availableHeight = Math.max(240, area.height - margin * 2);
  const width = Math.min(Math.max(MIN_COMPACT_WIDTH, preferredWidth), availableWidth);
  const height = Math.min(Math.max(MIN_COMPACT_HEIGHT, preferredHeight), availableHeight);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
    minWidth: Math.round(Math.min(designMinWidth, availableWidth, width)),
    minHeight: Math.round(Math.min(designMinHeight, availableHeight, height)),
  };
}

function applyAdaptiveWindowConstraints(win, options = {}) {
  if (!win || win.isDestroyed()) return;
  const display = displayForWindow(win);
  const area = display.workArea;
  const margin = Number.isFinite(options.margin) ? options.margin : 12;
  const minWidth = Math.max(
    Math.min(MIN_COMPACT_WIDTH, Math.max(320, area.width - margin * 2)),
    Math.min(options.minWidth || MIN_WINDOWED_WIDTH, Math.max(320, area.width - margin * 2)),
  );
  const minHeight = Math.max(
    Math.min(MIN_COMPACT_HEIGHT, Math.max(240, area.height - margin * 2)),
    Math.min(options.minHeight || MIN_WINDOWED_HEIGHT, Math.max(240, area.height - margin * 2)),
  );
  win.setMinimumSize(Math.round(minWidth), Math.round(minHeight));
  if (win.isMaximized() || win.isFullScreen()) return;

  const bounds = win.getBounds();
  const width = Math.min(Math.max(bounds.width, minWidth), area.width);
  const height = Math.min(Math.max(bounds.height, minHeight), area.height);
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  const x = Math.min(Math.max(bounds.x, area.x), maxX);
  const y = Math.min(Math.max(bounds.y, area.y), maxY);
  if (x !== bounds.x || y !== bounds.y || width !== bounds.width || height !== bounds.height) {
    win.setBounds({ x, y, width, height }, false);
  }
}

function registerAdaptiveLoginWindow(win, options) {
  if (!win || win.isDestroyed()) return;
  adaptiveLoginWindows.set(win.id, { win, options: { ...options } });
  const apply = () => applyAdaptiveWindowConstraints(win, options);
  win.on('move', apply);
  win.on('resize', apply);
  win.once('closed', () => adaptiveLoginWindows.delete(win.id));
  apply();
}

function refreshAdaptiveLoginWindows() {
  for (const entry of adaptiveLoginWindows.values()) {
    applyAdaptiveWindowConstraints(entry.win, entry.options);
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  sendWindowState(mainWindow);
  return true;
}

function getUpdateDownloadDir() {
  return path.join(app.getPath('userData'), 'updates');
}

function getSettingsBackupDir() {
  return path.join(app.getPath('userData'), 'backups', 'settings');
}

function sanitizeSettingsEntries(entries) {
  const source = entries && typeof entries === 'object' ? entries : {};
  const output = {};
  let totalBytes = 0;
  Object.keys(source).sort().forEach((key) => {
    if (!/^(mineradio-|apex-)/i.test(key) || /cookie|token|secret|password|auth/i.test(key)) return;
    const value = String(source[key] == null ? '' : source[key]);
    const size = Buffer.byteLength(value, 'utf8');
    if (size > 512 * 1024 || totalBytes + size > 4 * 1024 * 1024) return;
    output[key.slice(0, 180)] = value;
    totalBytes += size;
  });
  return output;
}

function rotateSettingsBackups() {
  const dir = getSettingsBackupDir();
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir)
    .filter((name) => /^settings-.*\.json$/i.test(name))
    .map((name) => ({ name, path: path.join(dir, name), mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  files.slice(6).forEach((item) => {
    try { fs.unlinkSync(item.path); } catch (_) {}
  });
}

function createSettingsBackup(payload = {}) {
  const entries = sanitizeSettingsEntries(payload.entries);
  if (!Object.keys(entries).length) return { ok: true, skipped: true, reason: 'SETTINGS_BACKUP_EMPTY' };
  const dir = getSettingsBackupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reason = String(payload.reason || 'manual').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 36) || 'manual';
  const filePath = path.join(dir, `settings-${stamp}-${reason}.json`);
  const document = {
    schema: 1,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    reason,
    fromSchema: Number(payload.fromSchema || 0) || 0,
    toSchema: Number(payload.toSchema || 0) || 0,
    entries,
  };
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  rotateSettingsBackups();
  return { ok: true, createdAt: document.createdAt, entryCount: Object.keys(entries).length };
}

function readLatestSettingsBackup() {
  const dir = getSettingsBackupDir();
  if (!fs.existsSync(dir)) return { ok: false, error: 'SETTINGS_BACKUP_MISSING' };
  const latest = fs.readdirSync(dir)
    .filter((name) => /^settings-.*\.json$/i.test(name))
    .map((name) => ({ path: path.join(dir, name), mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!latest) return { ok: false, error: 'SETTINGS_BACKUP_MISSING' };
  const document = JSON.parse(fs.readFileSync(latest.path, 'utf8'));
  return {
    ok: true,
    createdAt: document.createdAt || '',
    appVersion: document.appVersion || '',
    entries: sanitizeSettingsEntries(document.entries),
  };
}

function scrubDiagnosticValue(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => scrubDiagnosticValue(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    Object.keys(value).slice(0, 120).forEach((key) => {
      output[key] = /cookie|token|secret|password|authorization/i.test(key)
        ? '[redacted]'
        : scrubDiagnosticValue(value[key], depth + 1);
    });
    return output;
  }
  return redactDiagnosticText(value);
}

function inspectAuthenticodeSignatures(currentExecutable, installerPath) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: true, skipped: true });
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$current = Get-AuthenticodeSignature -LiteralPath $env:MINERADIO_CURRENT_EXE',
    '$target = Get-AuthenticodeSignature -LiteralPath $env:MINERADIO_TARGET_EXE',
    '[PSCustomObject]@{',
    '  currentThumbprint = if ($current.SignerCertificate) { $current.SignerCertificate.Thumbprint } else { "" }',
    '  targetThumbprint = if ($target.SignerCertificate) { $target.SignerCertificate.Thumbprint } else { "" }',
    '  currentSubject = if ($current.SignerCertificate) { $current.SignerCertificate.Subject } else { "" }',
    '  targetSubject = if ($target.SignerCertificate) { $target.SignerCertificate.Subject } else { "" }',
    '  currentStatus = [string]$current.Status',
    '  targetStatus = [string]$target.Status',
    '  currentStatusMessage = [string]$current.StatusMessage',
    '  targetStatusMessage = [string]$target.StatusMessage',
    '  targetTimestampThumbprint = if ($target.TimeStamperCertificate) { $target.TimeStamperCertificate.Thumbprint } else { "" }',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      timeout: 12000,
      env: {
        ...process.env,
        MINERADIO_CURRENT_EXE: currentExecutable,
        MINERADIO_TARGET_EXE: installerPath,
      },
    }, (error, stdout) => {
      if (error) {
        reject(new Error('UPDATE_SIGNATURE_CHECK_FAILED'));
        return;
      }
      try {
        resolve(JSON.parse(String(stdout || '').trim()));
      } catch (_) {
        reject(new Error('UPDATE_SIGNATURE_RESULT_INVALID'));
      }
    });
  });
}

async function verifyUpdateInstallerSignature(installerPath) {
  if (process.platform !== 'win32') return { ok: true, skipped: true };
  const result = await inspectAuthenticodeSignatures(process.execPath, installerPath);
  const currentThumbprint = String(result.currentThumbprint || '').replace(/\s+/g, '').toUpperCase();
  const targetThumbprint = String(result.targetThumbprint || '').replace(/\s+/g, '').toUpperCase();
  const currentStatus = String(result.currentStatus || '');
  const targetStatus = String(result.targetStatus || '');
  const allowedStatuses = new Set(['Valid', 'UnknownError']);
  if (!currentThumbprint) return { ok: false, error: 'CURRENT_APP_SIGNATURE_MISSING' };
  if (!targetThumbprint) return { ok: false, error: 'UPDATE_SIGNATURE_MISSING' };
  if (!allowedStatuses.has(currentStatus)) return { ok: false, error: 'CURRENT_APP_SIGNATURE_INVALID', status: currentStatus };
  if (!allowedStatuses.has(targetStatus)) return { ok: false, error: 'UPDATE_SIGNATURE_INVALID', status: targetStatus };
  if (currentThumbprint !== targetThumbprint) return { ok: false, error: 'UPDATE_SIGNER_MISMATCH' };
  if (!String(result.targetTimestampThumbprint || '').trim()) return { ok: false, error: 'UPDATE_SIGNATURE_TIMESTAMP_MISSING' };
  return {
    ok: true,
    thumbprint: targetThumbprint,
    subject: String(result.targetSubject || ''),
    status: targetStatus,
  };
}

function shouldEnsureDesktopShortcut() {
  if (process.platform !== 'win32') return false;
  if (process.env.MINERADIO_NO_DESKTOP_SHORTCUT === '1') return false;
  return app.isPackaged || process.env.MINERADIO_CREATE_DESKTOP_SHORTCUT === '1';
}

function ensureDesktopShortcut() {
  if (!shouldEnsureDesktopShortcut()) return { ok: false, skipped: true };
  try {
    const shortcutPath = path.join(app.getPath('desktop'), `${APP_NAME}.lnk`);
    const target = process.execPath;
    const shortcut = {
      target,
      cwd: path.dirname(target),
      args: '',
      description: 'Mineradio desktop music player',
      icon: fs.existsSync(APP_ICON_ICO) ? APP_ICON_ICO : target,
      iconIndex: 0,
      appUserModelId: APP_USER_MODEL_ID,
    };

    if (fs.existsSync(shortcutPath) && shell.readShortcutLink) {
      try {
        const existing = shell.readShortcutLink(shortcutPath);
        if (existing && path.resolve(existing.target || '') === path.resolve(target) && String(existing.args || '') === '') {
          return { ok: true, path: shortcutPath, existing: true };
        }
      } catch (_) {}
      shell.writeShortcutLink(shortcutPath, 'replace', shortcut);
    } else {
      shell.writeShortcutLink(shortcutPath, 'create', shortcut);
    }
    return { ok: true, path: shortcutPath, created: true };
  } catch (e) {
    console.warn('Desktop shortcut creation skipped:', e.message);
    return { ok: false, error: e.message || 'DESKTOP_SHORTCUT_FAILED' };
  }
}

function parseCookieHeader(cookieText) {
  const out = {};
  String(cookieText || '').split(';').forEach((part) => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const idx = raw.indexOf('=');
    if (idx <= 0) return;
    out[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  });
  return out;
}

function qqCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  const rawUin = Number(obj.login_type) === 2
    ? (obj.wxuin || obj.uin || obj.p_uin || '')
    : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin || '');
  const uin = String(rawUin).replace(/\D/g, '');
  const musicKey = obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.p_skey || obj.skey ||
    obj.psrf_qqaccess_token || obj.psrf_qqrefresh_token || obj.wxrefresh_token || obj.wxskey || '';
  return !!(uin && musicKey);
}

function qqCookieHasPlaybackLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  const rawUin = Number(obj.login_type) === 2
    ? (obj.wxuin || obj.uin || obj.p_uin || '')
    : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin || '');
  const uin = String(rawUin).replace(/\D/g, '');
  const playbackKey = obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || '';
  return !!(uin && playbackKey);
}

function neteaseCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  return !!obj.MUSIC_U;
}

function describeMusicLoginSession(provider, cookieText, options = {}) {
  const cookie = String(cookieText || '');
  const loggedIn = provider === 'qq' ? qqCookieHasLogin(cookie) : neteaseCookieHasLogin(cookie);
  const playbackReady = provider === 'qq' ? qqCookieHasPlaybackLogin(cookie) : loggedIn;
  const partial = loggedIn && !playbackReady;
  const defaultState = loggedIn
    ? (partial ? 'partial' : 'authenticated')
    : (invalidatedLoginSessions[provider] ? 'expired' : 'signed-out');
  const state = options.state || defaultState;
  const result = {
    ok: options.ok == null ? loggedIn : !!options.ok,
    provider,
    state,
    loggedIn,
    playbackReady,
    partial,
    expired: state === 'expired',
  };
  if (options.includeCookie && cookie) result.cookie = cookie;
  if (options.reused) result.reused = true;
  if (options.cancelled) result.cancelled = true;
  if (options.offline) result.offline = true;
  if (options.reason) result.reason = options.reason;
  if (options.error) result.error = options.error;
  if (options.message) result.message = options.message;
  return result;
}

function successfulMusicLoginResult(provider, cookieText, options = {}) {
  invalidatedLoginSessions[provider] = false;
  return describeMusicLoginSession(provider, cookieText, {
    ok: true,
    includeCookie: true,
    reused: !!options.reused,
  });
}

async function persistMusicLoginResult(provider, result) {
  const safeResult = { ...(result || {}) };
  const cookie = String(safeResult.cookie || '');
  delete safeResult.cookie;
  if (!safeResult.ok || !cookie) return safeResult;

  const route = provider === 'qq' ? '/api/qq/login/cookie' : '/api/login/cookie';
  const persisted = await callLocalUpdateApi(route, {
    method: 'POST',
    body: { cookie },
    timeoutMs: 20000,
  });
  if (!persisted || persisted.ok === false || persisted.loggedIn !== true) {
    return {
      ...safeResult,
      ...(persisted || {}),
      ok: false,
      loggedIn: false,
      state: 'unavailable',
      error: persisted && persisted.error || 'LOGIN_SESSION_PERSIST_FAILED',
      message: persisted && persisted.message || '登录成功，但本机会话保存失败',
    };
  }
  return {
    ...safeResult,
    ...persisted,
    ok: true,
    loggedIn: true,
    sessionPersisted: true,
  };
}

function cancelledMusicLoginResult(provider, cookieText) {
  const label = provider === 'qq' ? 'QQ 音乐' : '网易云';
  const result = describeMusicLoginSession(provider, cookieText, {
    ok: false,
    cancelled: true,
    reason: invalidatedLoginSessions[provider] ? 'expired' : 'cancelled',
    error: invalidatedLoginSessions[provider] ? 'LOGIN_SESSION_EXPIRED' : 'LOGIN_CANCELLED',
    message: invalidatedLoginSessions[provider] ? `${label}登录已失效，请重新登录` : `${label}登录窗口已关闭`,
  });
  if (result.loggedIn) return successfulMusicLoginResult(provider, cookieText);
  return result;
}

function failedMusicLoginResult(provider, error, cookieText = '') {
  const rawCode = String(error && (error.code || error.name) || '').toUpperCase();
  const rawMessage = String(error && (error.message || error.description) || '');
  const isNetworkFailure = /ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION|NETWORK|PROXY|TIMED_OUT)|ABORTERROR/.test(`${rawCode} ${rawMessage.toUpperCase()}`);
  const label = provider === 'qq' ? 'QQ 音乐' : '网易云';
  return describeMusicLoginSession(provider, cookieText, {
    ok: false,
    state: 'unavailable',
    offline: isNetworkFailure,
    reason: isNetworkFailure ? 'network' : 'login-window',
    error: isNetworkFailure ? 'LOGIN_NETWORK_UNAVAILABLE' : 'LOGIN_WINDOW_UNAVAILABLE',
    message: isNetworkFailure ? `无法连接${label}，请检查网络后重试` : `${label}登录窗口加载失败`,
  });
}

function isNavigationAbort(error) {
  return Number(error && (error.errno || error.code)) === -3
    || /ERR_ABORTED/i.test(String(error && error.message || ''));
}

function loginSessionReadFailure(provider) {
  const label = provider === 'qq' ? 'QQ 音乐' : '网易云';
  return describeMusicLoginSession(provider, '', {
    ok: false,
    state: 'unavailable',
    reason: 'session-read',
    error: 'LOGIN_SESSION_READ_FAILED',
    message: `${label}登录状态读取失败`,
  });
}

function isQQCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === 'qq.com' || normalized.endsWith('.qq.com') || normalized.endsWith('qqmusic.qq.com');
}

function isNeteaseCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === '163.com' || normalized.endsWith('.163.com') ||
    normalized === 'music.163.com' || normalized.endsWith('.music.163.com') ||
    normalized === 'netease.com' || normalized.endsWith('.netease.com');
}

function buildCookieHeaderFor(cookies, isAllowedDomain, priority) {
  const picked = new Map();
  (cookies || []).forEach((cookie) => {
    if (!cookie || !cookie.name || !isAllowedDomain(cookie.domain)) return;
    picked.set(cookie.name, cookie.value || '');
  });

  const ordered = [];
  (priority || []).forEach((name) => {
    if (picked.has(name)) {
      ordered.push([name, picked.get(name)]);
      picked.delete(name);
    }
  });
  picked.forEach((value, name) => ordered.push([name, value]));

  return ordered
    .filter(([name, value]) => name && value != null && String(value) !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function buildCookieHeader(cookies) {
  return buildCookieHeaderFor(cookies, isQQCookieDomain, QQ_LOGIN_COOKIE_PRIORITY);
}

async function readQQLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeader(cookies);
}

async function readNeteaseLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeaderFor(cookies, isNeteaseCookieDomain, NETEASE_LOGIN_COOKIE_PRIORITY);
}

async function openNeteaseMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(NETEASE_LOGIN_PARTITION);
  let initialCookie = '';
  try {
    initialCookie = await readNeteaseLoginCookieHeader(cookieSession);
  } catch (e) {
    console.warn('Netease login session read failed:', e.message);
    return loginSessionReadFailure('netease');
  }
  if (neteaseCookieHasLogin(initialCookie)) return successfulMusicLoginResult('netease', initialCookie, { reused: true });

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    const loginBounds = adaptiveWindowBounds(owner, 940, 760, 720, 500);

    const loginWindow = new BrowserWindow({
      x: loginBounds.x,
      y: loginBounds.y,
      width: loginBounds.width,
      height: loginBounds.height,
      minWidth: loginBounds.minWidth,
      minHeight: loginBounds.minHeight,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: '网易云音乐登录',
      backgroundColor: '#111111',
      icon: APP_ICON_ICO,
      webPreferences: {
        partition: NETEASE_LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    registerAdaptiveLoginWindow(loginWindow, { minWidth: 720, minHeight: 500, margin: 12 });

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      resolve(result);
    };

    const finish = (result) => {
      if (settled) return;
      settle(result);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
    };

    const checkCookies = async () => {
      try {
        const cookie = await readNeteaseLoginCookieHeader(cookieSession);
        if (neteaseCookieHasLogin(cookie)) {
          finish(successfulMusicLoginResult('netease', cookie));
        }
      } catch (e) {
        console.warn('Netease login cookie check failed:', e.message);
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\/([^/]+\.)?(163|music\.163|netease)\.com/i.test(url)) {
        loginWindow.loadURL(url).catch((e) => console.warn('Netease login popup navigation failed:', e.message));
      } else if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const docs = [document];
          document.querySelectorAll('iframe').forEach((frame) => {
            try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (_) {}
          });
          for (const doc of docs) {
            const nodes = Array.from(doc.querySelectorAll('a, button, span, div'));
            const loginNode = nodes.find((node) => {
              const text = (node.textContent || '').trim();
              if (!/登录|立即登录/.test(text)) return false;
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            if (loginNode) { loginNode.click(); return true; }
          }
          return false;
        }, 900);
      `, true).catch(() => {});
    });

    loginWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame === false || errorCode === -3 || settled) return;
      finish(failedMusicLoginResult('netease', { code: errorDescription || errorCode, message: errorDescription }));
    });

    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      try {
        const cookie = await readNeteaseLoginCookieHeader(cookieSession);
        settle(cancelledMusicLoginResult('netease', cookie));
      } catch (e) {
        console.warn('Netease login close state read failed:', e.message);
        settle(loginSessionReadFailure('netease'));
      }
    });

    pollTimer = setInterval(checkCookies, 1200);
    loginWindow.loadURL(NETEASE_LOGIN_URL).catch((e) => {
      if (!isNavigationAbort(e)) finish(failedMusicLoginResult('netease', e));
    });
  });
}

async function openQQMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(QQ_LOGIN_PARTITION);
  let initialCookie = '';
  try {
    initialCookie = await readQQLoginCookieHeader(cookieSession);
  } catch (e) {
    console.warn('QQ login session read failed:', e.message);
    return loginSessionReadFailure('qq');
  }
  if (qqCookieHasPlaybackLogin(initialCookie)) return successfulMusicLoginResult('qq', initialCookie, { reused: true });

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let warmupStarted = false;
    const loginBounds = adaptiveWindowBounds(owner, 900, 720, 700, 480);

    const loginWindow = new BrowserWindow({
      x: loginBounds.x,
      y: loginBounds.y,
      width: loginBounds.width,
      height: loginBounds.height,
      minWidth: loginBounds.minWidth,
      minHeight: loginBounds.minHeight,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: 'QQ 音乐登录',
      backgroundColor: '#111111',
      icon: APP_ICON_ICO,
      webPreferences: {
        partition: QQ_LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    registerAdaptiveLoginWindow(loginWindow, { minWidth: 700, minHeight: 480, margin: 12 });

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      resolve(result);
    };

    const finish = (result) => {
      if (settled) return;
      settle(result);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
    };

    const checkCookies = async () => {
      try {
        const cookie = await readQQLoginCookieHeader(cookieSession);
        if (qqCookieHasPlaybackLogin(cookie)) {
          finish(successfulMusicLoginResult('qq', cookie));
        } else if (qqCookieHasLogin(cookie) && !warmupStarted) {
          warmupStarted = true;
          setTimeout(() => {
            if (!settled && loginWindow && !loginWindow.isDestroyed()) {
              loginWindow.loadURL('https://y.qq.com/n/ryqq/player').catch((e) => console.warn('QQ login warmup navigation failed:', e.message));
            }
          }, 900);
        }
      } catch (e) {
        console.warn('QQ login cookie check failed:', e.message);
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(String(url || ''));
        if (/^https?:$/.test(parsed.protocol) && isQQCookieDomain(parsed.hostname)) {
          loginWindow.loadURL(parsed.href).catch((e) => console.warn('QQ login popup navigation failed:', e.message));
        } else if (/^https?:$/.test(parsed.protocol)) {
          shell.openExternal(parsed.href).catch(() => {});
        }
      } catch (_) {
        // Ignore malformed or non-web popup targets from the remote login page.
      }
      return { action: 'deny' };
    });

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
          const loginNode = nodes.find((node) => {
            const text = (node.textContent || '').trim();
            if (!/登录|登陆/.test(text)) return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (loginNode) loginNode.click();
        }, 700);
      `, true).catch(() => {});
    });

    loginWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame === false || errorCode === -3 || settled) return;
      finish(failedMusicLoginResult('qq', { code: errorDescription || errorCode, message: errorDescription }, initialCookie));
    });

    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      try {
        const cookie = await readQQLoginCookieHeader(cookieSession);
        settle(cancelledMusicLoginResult('qq', cookie));
      } catch (e) {
        console.warn('QQ login close state read failed:', e.message);
        settle(loginSessionReadFailure('qq'));
      }
    });

    pollTimer = setInterval(checkCookies, 1200);
    loginWindow.loadURL(QQ_LOGIN_URL).catch((e) => {
      if (!isNavigationAbort(e)) finish(failedMusicLoginResult('qq', e, initialCookie));
    });
  });
}

async function readMusicLoginSessionState(provider) {
  try {
    const cookieSession = session.fromPartition(provider === 'qq' ? QQ_LOGIN_PARTITION : NETEASE_LOGIN_PARTITION);
    const cookie = provider === 'qq'
      ? await readQQLoginCookieHeader(cookieSession)
      : await readNeteaseLoginCookieHeader(cookieSession);
    return describeMusicLoginSession(provider, cookie, { ok: true });
  } catch (e) {
    console.warn(`${provider} login state read failed:`, e.message);
    return loginSessionReadFailure(provider);
  }
}

async function clearQQMusicLoginSession(reason = 'logout') {
  const cookieSession = session.fromPartition(QQ_LOGIN_PARTITION);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  const expired = String(reason || '').toLowerCase() === 'expired';
  invalidatedLoginSessions.qq = expired;
  return describeMusicLoginSession('qq', '', {
    ok: true,
    state: expired ? 'expired' : 'signed-out',
    reason: expired ? 'expired' : 'logout',
  });
}

async function clearNeteaseMusicLoginSession(reason = 'logout') {
  const cookieSession = session.fromPartition(NETEASE_LOGIN_PARTITION);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  const expired = String(reason || '').toLowerCase() === 'expired';
  invalidatedLoginSessions.netease = expired;
  return describeMusicLoginSession('netease', '', {
    ok: true,
    state: expired ? 'expired' : 'signed-out',
    reason: expired ? 'expired' : 'logout',
  });
}

function getAdaptiveMainMinimumSize(win) {
  const display = displayForWindow(win);
  const area = display.workArea;
  const availableWidth = Math.max(320, area.width - 16);
  const availableHeight = Math.max(240, area.height - 16);
  const width = Math.max(
    Math.min(MIN_COMPACT_WIDTH, availableWidth),
    Math.min(MIN_WINDOWED_WIDTH, availableWidth, Math.floor(availableHeight * WINDOWED_ASPECT)),
  );
  const height = Math.max(
    Math.min(MIN_COMPACT_HEIGHT, availableHeight),
    Math.min(MIN_WINDOWED_HEIGHT, availableHeight, Math.floor(width / WINDOWED_ASPECT)),
  );
  return { width: Math.round(width), height: Math.round(height) };
}

function applyAdaptiveMainWindowConstraints(win) {
  const minimum = getAdaptiveMainMinimumSize(win);
  applyAdaptiveWindowConstraints(win, {
    minWidth: minimum.width,
    minHeight: minimum.height,
    margin: 8,
  });
}

function getWindowedBounds(win) {
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const basis = display.bounds || area;
  const maxWidth = Math.max(640, area.width - WINDOWED_MARGIN);
  const maxHeight = Math.max(360, area.height - WINDOWED_MARGIN);

  let width = Math.round(basis.width * WINDOWED_SCALE);
  let height = Math.round(width / WINDOWED_ASPECT);
  const scaledHeight = Math.round(basis.height * WINDOWED_SCALE);

  if (height > scaledHeight) {
    height = scaledHeight;
    width = Math.round(height * WINDOWED_ASPECT);
  }

  if (width < MIN_WINDOWED_WIDTH && maxWidth >= MIN_WINDOWED_WIDTH && maxHeight >= MIN_WINDOWED_HEIGHT) {
    width = MIN_WINDOWED_WIDTH;
    height = MIN_WINDOWED_HEIGHT;
  }

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.round(width / WINDOWED_ASPECT);
  }
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * WINDOWED_ASPECT);
  }

  width = Math.round(width);
  height = Math.round(height);

  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

function applyWindowedBounds(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize();
  const minimum = getAdaptiveMainMinimumSize(win);
  win.setMinimumSize(minimum.width, minimum.height);
  win.setBounds(getWindowedBounds(win), false);
  applyAdaptiveMainWindowConstraints(win);
  sendWindowState(win);
}

function exitFullscreenToWindow(win) {
  if (!win || win.isDestroyed()) return;
  windowFullscreenActive = false;

  if (!win.isFullScreen()) {
    applyWindowedBounds(win);
    return;
  }

  let applied = false;
  const applyOnce = () => {
    if (applied || !win || win.isDestroyed() || win.isFullScreen()) return;
    applied = true;
    applyWindowedBounds(win);
  };

  win.once('leave-full-screen', () => setTimeout(applyOnce, 50));
  win.setFullScreen(false);
  setTimeout(applyOnce, 500);
}

function toggleFullscreen(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen() || windowFullscreenActive) {
    exitFullscreenToWindow(win);
    return;
  }
  windowFullscreenActive = true;
  win.setFullScreen(true);
  sendWindowState(win);
}

function overlayUrl(page) {
  const port = mainServerPort || process.env.PORT || 3000;
  return `http://127.0.0.1:${port}/${page}`;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function desktopLyricsDefaultBounds(payload = desktopLyricsState) {
  const display = desktopLyricsUserBounds
    ? screen.getDisplayMatching(desktopLyricsUserBounds)
    : screen.getPrimaryDisplay();
  const bounds = display.bounds;
  const yRatio = clampNumber(payload.y, 0.08, 0.92, 0.76);
  const width = Math.round(Math.min(Math.max(880, bounds.width * 0.72), bounds.width - 96));
  const height = Math.round(Math.min(Math.max(340, bounds.height * 0.38), 560, bounds.height - 96));
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + bounds.height * yRatio - height / 2),
    width,
    height,
  };
}

function constrainDesktopLyricsBounds(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const area = display.bounds;
  const next = {
    ...bounds,
    width: Math.round(Math.min(Math.max(320, bounds.width), area.width)),
    height: Math.round(Math.min(Math.max(180, bounds.height), area.height)),
  };
  const maxX = area.x + Math.max(0, area.width - next.width);
  const maxY = area.y + Math.max(0, area.height - next.height);
  next.x = Math.round(clampNumber(next.x, area.x, maxX, area.x));
  next.y = Math.round(clampNumber(next.y, area.y, maxY, area.y));
  return next;
}

function setDesktopLyricsBounds(bounds) {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const nextBounds = constrainDesktopLyricsBounds(bounds);
  const currentBounds = desktopLyricsWindow.getBounds();
  if (
    currentBounds.x === nextBounds.x
    && currentBounds.y === nextBounds.y
    && currentBounds.width === nextBounds.width
    && currentBounds.height === nextBounds.height
  ) {
    return;
  }
  desktopLyricsProgrammaticMove = true;
  desktopLyricsWindow.setBounds(nextBounds, false);
  setTimeout(() => {
    desktopLyricsProgrammaticMove = false;
  }, 120);
}

function rememberDesktopLyricsBounds() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsProgrammaticMove) return;
  desktopLyricsUserBounds = desktopLyricsWindow.getBounds();
}

function applyDesktopLyricsMouseBehavior() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const locked = desktopLyricsState.clickThrough !== false;
  const shouldIgnore = locked || !desktopLyricsPointerCapture;
  if (desktopLyricsMouseIgnored === shouldIgnore) return;
  desktopLyricsMouseIgnored = shouldIgnore;
  desktopLyricsWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true });
}

function desktopLyricsHotBoundsOnScreen() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return null;
  const winBounds = desktopLyricsWindow.getBounds();
  const rel = desktopLyricsHotBounds;
  if (!rel) return winBounds;
  return {
    x: winBounds.x + rel.left,
    y: winBounds.y + rel.top,
    width: Math.max(1, rel.right - rel.left),
    height: Math.max(1, rel.bottom - rel.top),
  };
}

function pointInBounds(point, bounds) {
  if (!point || !bounds) return false;
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

function handleDesktopLyricsGlobalMiddleClick() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  if (!desktopLyricsState.enabled) return;
  const now = Date.now();
  if (now - desktopLyricsLastMiddleAt < 260) return;
  const point = screen.getCursorScreenPoint();
  if (!pointInBounds(point, desktopLyricsHotBoundsOnScreen())) return;
  desktopLyricsLastMiddleAt = now;
  const nextLocked = desktopLyricsState.clickThrough === false;
  desktopLyricsState = { ...desktopLyricsState, clickThrough: nextLocked };
  desktopLyricsPointerCapture = !nextLocked;
  applyDesktopLyricsMouseBehavior();
  broadcastDesktopLyricsLockState();
}

function startDesktopLyricsMousePoller() {
  if (process.platform !== 'win32' || desktopLyricsMousePoller) return;
  const script = `
$ErrorActionPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MineradioMousePoll {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}
"@
$prev = $false
while ($true) {
  $down = (([MineradioMousePoll]::GetAsyncKeyState(4) -band 0x8000) -ne 0)
  if ($down -and -not $prev) {
    [Console]::Out.WriteLine("MMB")
    [Console]::Out.Flush()
  }
  $prev = $down
  Start-Sleep -Milliseconds 24
}
`;
  try {
    desktopLyricsMousePoller = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    desktopLyricsMousePoller.stdout.on('data', (chunk) => {
      desktopLyricsMousePollerBuffer += chunk.toString('utf8');
      const lines = desktopLyricsMousePollerBuffer.split(/\r?\n/);
      desktopLyricsMousePollerBuffer = lines.pop() || '';
      lines.forEach((line) => {
        if (line.trim() === 'MMB') handleDesktopLyricsGlobalMiddleClick();
      });
    });
    desktopLyricsMousePoller.on('exit', () => {
      desktopLyricsMousePoller = null;
      desktopLyricsMousePollerBuffer = '';
    });
    desktopLyricsMousePoller.on('error', () => {
      desktopLyricsMousePoller = null;
      desktopLyricsMousePollerBuffer = '';
    });
  } catch (e) {
    desktopLyricsMousePoller = null;
    desktopLyricsMousePollerBuffer = '';
  }
}

function stopDesktopLyricsMousePoller() {
  if (!desktopLyricsMousePoller) return;
  try {
    desktopLyricsMousePoller.kill();
  } catch (e) {}
  desktopLyricsMousePoller = null;
  desktopLyricsMousePollerBuffer = '';
}

function broadcastDesktopLyricsLockState() {
  const locked = desktopLyricsState.clickThrough !== false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mineradio-desktop-lyrics-lock-state', { locked });
  }
  sendDesktopLyricsState();
}

function broadcastDesktopLyricsEnabledState(enabled) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mineradio-desktop-lyrics-enabled-state', { enabled: !!enabled });
  }
}

function positionDesktopLyricsWindow(payload = desktopLyricsState, options = {}) {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const shouldUseManualBounds = desktopLyricsUserBounds && !options.force;
  setDesktopLyricsBounds(shouldUseManualBounds ? desktopLyricsUserBounds : desktopLyricsDefaultBounds(payload));
  if (typeof desktopLyricsWindow.setOpacity === 'function') {
    desktopLyricsWindow.setOpacity(clampNumber(payload.opacity, 0.28, 1, 0.92));
  }
}

function sendDesktopLyricsState() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  desktopLyricsWindow.webContents.send('mineradio-desktop-lyrics-state', desktopLyricsState);
}

function createDesktopLyricsWindow(payload = {}) {
  const previousY = desktopLyricsState.y;
  const previousOpacity = desktopLyricsState.opacity;
  desktopLyricsState = { ...desktopLyricsState, ...payload, enabled: true };
  const hasY = Object.prototype.hasOwnProperty.call(payload || {}, 'y');
  const nextY = clampNumber(desktopLyricsState.y, 0.08, 0.92, 0.76);
  const yChanged = hasY && Number.isFinite(Number(previousY)) && Math.abs(nextY - clampNumber(previousY, 0.08, 0.92, 0.76)) > 0.001;
  const opacityChanged = Object.prototype.hasOwnProperty.call(payload || {}, 'opacity')
    && Math.abs(clampNumber(desktopLyricsState.opacity, 0.28, 1, 0.92) - clampNumber(previousOpacity, 0.28, 1, 0.92)) > 0.001;
  if (yChanged) desktopLyricsUserBounds = null;
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    if (yChanged) {
      positionDesktopLyricsWindow(desktopLyricsState, { force: yChanged });
    } else if (opacityChanged && typeof desktopLyricsWindow.setOpacity === 'function') {
      desktopLyricsWindow.setOpacity(clampNumber(desktopLyricsState.opacity, 0.28, 1, 0.92));
    }
    applyDesktopLyricsMouseBehavior();
    sendDesktopLyricsState();
    return desktopLyricsWindow;
  }

  desktopLyricsWindow = new BrowserWindow({
    width: 920,
    height: 190,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    focusable: false,
    skipTaskbar: true,
    show: false,
    title: 'Mineradio Desktop Lyrics',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try {
    desktopLyricsWindow.setAlwaysOnTop(true, 'screen-saver');
    desktopLyricsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) {
    console.warn('Desktop lyrics topmost setup skipped:', e.message);
  }
  startDesktopLyricsMousePoller();
  applyDesktopLyricsMouseBehavior();
  positionDesktopLyricsWindow(desktopLyricsState, { force: yChanged || !desktopLyricsUserBounds });
  desktopLyricsWindow.once('ready-to-show', () => {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
    desktopLyricsWindow.showInactive();
    sendDesktopLyricsState();
  });
  desktopLyricsWindow.webContents.once('did-finish-load', sendDesktopLyricsState);
  desktopLyricsWindow.on('closed', () => {
    desktopLyricsWindow = null;
    desktopLyricsMouseIgnored = null;
  });
  desktopLyricsWindow.on('moved', rememberDesktopLyricsBounds);
  desktopLyricsWindow.loadURL(overlayUrl('desktop-lyrics.html')).catch((e) => console.warn('Desktop lyrics load failed:', e.message));
  return desktopLyricsWindow;
}

function closeDesktopLyricsWindow() {
  desktopLyricsState = { ...desktopLyricsState, enabled: false };
  desktopLyricsPointerCapture = false;
  desktopLyricsMouseIgnored = null;
  desktopLyricsHotBounds = null;
  stopDesktopLyricsMousePoller();
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    sendDesktopLyricsState();
    desktopLyricsWindow.close();
  }
  desktopLyricsWindow = null;
  broadcastDesktopLyricsEnabledState(false);
}

function nativeWindowHandleDecimal(win) {
  const handle = win.getNativeWindowHandle();
  if (process.arch === 'x64') return handle.readBigUInt64LE(0).toString();
  return String(handle.readUInt32LE(0));
}

function attachWallpaperToWorkerW(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  const hwnd = nativeWindowHandleDecimal(win);
  const script = `
$ErrorActionPreference = "Stop"
if (-not ("MineradioNativeWin" -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MineradioNativeWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
}
"@
}
$progman = [MineradioNativeWin]::FindWindow("Progman", $null)
$result = [IntPtr]::Zero
[MineradioNativeWin]::SendMessageTimeout($progman, 0x052C, [IntPtr]::Zero, [IntPtr]::Zero, 0, 1000, [ref]$result) | Out-Null
$script:workerw = [IntPtr]::Zero
$enum = [MineradioNativeWin+EnumWindowsProc]{
  param([IntPtr]$top, [IntPtr]$param)
  $shell = [MineradioNativeWin]::FindWindowEx($top, [IntPtr]::Zero, "SHELLDLL_DefView", $null)
  if ($shell -ne [IntPtr]::Zero) {
    $script:workerw = [MineradioNativeWin]::FindWindowEx([IntPtr]::Zero, $top, "WorkerW", $null)
  }
  return $true
}
[MineradioNativeWin]::EnumWindows($enum, [IntPtr]::Zero) | Out-Null
if ($script:workerw -eq [IntPtr]::Zero) { $script:workerw = $progman }
$target = [IntPtr]::new([Int64]${hwnd})
[MineradioNativeWin]::SetParent($target, $script:workerw) | Out-Null
[MineradioNativeWin]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, 0, 0, 0x0013) | Out-Null
`;
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    timeout: 5000,
  }, (error) => {
    if (error) console.warn('Wallpaper WorkerW attach failed:', error.message);
  });
}

function positionWallpaperWindow() {
  if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
  const bounds = screen.getPrimaryDisplay().bounds;
  wallpaperWindow.setBounds(bounds, false);
}

function sendWallpaperState() {
  if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
  wallpaperWindow.webContents.send('mineradio-wallpaper-state', wallpaperState);
}

function createWallpaperWindow(payload = {}) {
  wallpaperState = { ...wallpaperState, ...payload, enabled: true };
  if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
    positionWallpaperWindow();
    sendWallpaperState();
    return wallpaperWindow;
  }
  const bounds = screen.getPrimaryDisplay().bounds;
  wallpaperWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: false,
    backgroundColor: '#050608',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    title: 'Mineradio Wallpaper',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  wallpaperWindow.setIgnoreMouseEvents(true, { forward: true });
  wallpaperWindow.once('ready-to-show', () => {
    if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
    positionWallpaperWindow();
    wallpaperWindow.showInactive();
    attachWallpaperToWorkerW(wallpaperWindow);
    sendWallpaperState();
  });
  wallpaperWindow.webContents.once('did-finish-load', sendWallpaperState);
  wallpaperWindow.on('closed', () => {
    wallpaperWindow = null;
  });
  wallpaperWindow.loadURL(overlayUrl('wallpaper.html')).catch((e) => console.warn('Wallpaper load failed:', e.message));
  return wallpaperWindow;
}

function closeWallpaperWindow() {
  wallpaperState = { ...wallpaperState, enabled: false };
  if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
    sendWallpaperState();
    wallpaperWindow.close();
  }
  wallpaperWindow = null;
}

function closeOverlayWindows() {
  closeDesktopLyricsWindow();
  closeWallpaperWindow();
}

ipcMain.handle('desktop-window-minimize', (event) => {
  getSenderWindow(event)?.minimize();
});

ipcMain.handle('desktop-window-toggle-maximize', (event) => {
  toggleFullscreen(getSenderWindow(event));
});

ipcMain.handle('desktop-window-toggle-fullscreen', (event) => {
  toggleFullscreen(getSenderWindow(event));
});

ipcMain.handle('desktop-window-exit-fullscreen-windowed', (event) => {
  exitFullscreenToWindow(getSenderWindow(event));
});

ipcMain.handle('desktop-window-get-state', (event) => {
  return getWindowState(getSenderWindow(event));
});

ipcMain.handle('mineradio-background-policy-get', (event) => {
  if (!isTrustedMainRenderer(event)) return { ok: false, error: 'IPC_FORBIDDEN' };
  return applyBackgroundRuntimePolicy(backgroundRuntimePolicy);
});

ipcMain.handle('mineradio-background-policy-set', (event, mode) => {
  if (!isTrustedMainRenderer(event)) return { ok: false, error: 'IPC_FORBIDDEN' };
  return applyBackgroundRuntimePolicy(mode);
});

ipcMain.handle('desktop-window-close', (event) => {
  getSenderWindow(event)?.close();
});

ipcMain.handle('mineradio-hotkeys-configure-global', (_event, bindings) => {
  return configureMineradioGlobalHotkeys(bindings);
});

ipcMain.handle('mineradio-system-media-update', (_event, payload = {}) => {
  systemMediaState = {
    hasTrack: !!payload.hasTrack,
    playing: !!payload.playing,
    canPrevious: !!payload.canPrevious,
    canNext: !!payload.canNext,
    title: String(payload.title || '').slice(0, 240),
    artist: String(payload.artist || '').slice(0, 240),
  };
  updateTaskbarMediaButtons();
  updateTrayMenu();
  return { ok: true };
});

ipcMain.handle('mineradio-settings-backup', (_event, payload = {}) => {
  try {
    return createSettingsBackup(payload);
  } catch (e) {
    return { ok: false, error: e.message || 'SETTINGS_BACKUP_FAILED' };
  }
});

ipcMain.handle('mineradio-settings-restore-latest', () => {
  try {
    return readLatestSettingsBackup();
  } catch (e) {
    return { ok: false, error: e.message || 'SETTINGS_RESTORE_FAILED' };
  }
});

ipcMain.handle('mineradio-export-diagnostics', async (event, rendererPayload = {}) => {
  try {
    const owner = getSenderWindow(event);
    let gpu = {};
    try { gpu = await app.getGPUInfo('basic'); } catch (e) { gpu = { error: e.message || 'GPU_INFO_FAILED' }; }
    const displays = screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      internal: !!display.internal,
    }));
    const updateDir = getUpdateDownloadDir();
    const updateFiles = fs.existsSync(updateDir)
      ? fs.readdirSync(updateDir, { recursive: true }).filter((name) => /\.(exe|download|invalid-\d+)$/i.test(String(name))).length
      : 0;
    const diagnostics = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      app: {
        name: APP_NAME,
        version: app.getVersion(),
        packaged: app.isPackaged,
        appUserModelId: APP_USER_MODEL_ID,
      },
      runtime: {
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        locale: app.getLocale(),
        memoryMb: Math.round(os.totalmem() / 1024 / 1024),
        cpuCount: os.cpus().length,
      },
      window: getWindowState(mainWindow),
      displays,
      gpu,
      updater: { cachedFileCount: updateFiles },
      processes: app.getAppMetrics().map((metric) => ({
        type: metric.type,
        cpu: metric.cpu,
        memory: metric.memory,
      })),
      renderer: rendererPayload,
      recentEvents: diagnosticEvents.slice(-120),
    };
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(owner, {
      title: '导出 Mineradio 诊断信息',
      defaultPath: `Mineradio-diagnostics-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(scrubDiagnosticValue(diagnostics), null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DIAGNOSTICS_EXPORT_FAILED' };
  }
});

ipcMain.handle('mineradio-export-json-file', async (event, payload = {}) => {
  try {
    const owner = getSenderWindow(event);
    const defaultName = String(payload.defaultName || 'mineradio-export.json').replace(/[\\/:*?"<>|]+/g, '-');
    const result = await dialog.showSaveDialog(owner, {
      title: '导出 Mineradio 存档',
      defaultPath: defaultName.toLowerCase().endsWith('.json') ? defaultName : `${defaultName}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const text = typeof payload.text === 'string' ? payload.text : JSON.stringify(payload.data || {}, null, 2);
    fs.writeFileSync(result.filePath, text, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message || 'EXPORT_FAILED' };
  }
});

ipcMain.handle('mineradio-import-json-file', async (event) => {
  try {
    const owner = getSenderWindow(event);
    const result = await dialog.showOpenDialog(owner, {
      title: '导入 Mineradio 存档',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
    const filePath = result.filePaths[0];
    const text = fs.readFileSync(filePath, 'utf8');
    return { ok: true, filePath, text };
  } catch (e) {
    return { ok: false, error: e.message || 'IMPORT_FAILED' };
  }
});

ipcMain.handle('netease-music-open-login', async (event) => {
  if (!isTrustedMainRenderer(event)) return { ok: false, error: 'IPC_FORBIDDEN' };
  const result = await openNeteaseMusicLoginWindow(getSenderWindow(event));
  return persistMusicLoginResult('netease', result);
});

ipcMain.handle('netease-music-login-state', async (event) => {
  if (!isTrustedMainRenderer(event)) return { ok: false, error: 'IPC_FORBIDDEN' };
  return readMusicLoginSessionState('netease');
});

ipcMain.handle('netease-music-clear-login', async (event, reason) => {
  if (!isTrustedMainRenderer(event)) return { ok: false, error: 'IPC_FORBIDDEN' };
  return clearNeteaseMusicLoginSession(reason);
});

ipcMain.handle('qq-music-open-login', async (event) => {
  if (!isTrustedMainRenderer(event)) return { ok: false, error: 'IPC_FORBIDDEN' };
  const result = await openQQMusicLoginWindow(getSenderWindow(event));
  return persistMusicLoginResult('qq', result);
});

ipcMain.handle('qq-music-login-state', async (event) => {
  if (!isTrustedMainRenderer(event)) return { ok: false, error: 'IPC_FORBIDDEN' };
  return readMusicLoginSessionState('qq');
});

ipcMain.handle('qq-music-clear-login', async (event, reason) => {
  if (!isTrustedMainRenderer(event)) return { ok: false, error: 'IPC_FORBIDDEN' };
  return clearQQMusicLoginSession(reason);
});

ipcMain.handle('mineradio-update-download-status', async (event, jobId) => {
  if (!isTrustedMainRenderer(event)) return { ok: false, error: 'IPC_FORBIDDEN' };
  const id = normalizeUpdateJobId(jobId);
  if (!id) return { ok: false, error: 'UPDATE_JOB_ID_INVALID' };
  return callLocalUpdateApi(`/api/update/download/status?id=${encodeURIComponent(id)}`);
});

ipcMain.handle('mineradio-update-download-cancel', async (event, jobId) => {
  if (!isTrustedMainRenderer(event)) return { ok: false, error: 'IPC_FORBIDDEN' };
  const id = normalizeUpdateJobId(jobId);
  if (!id) return { ok: false, error: 'UPDATE_JOB_ID_INVALID' };
  return callLocalUpdateApi('/api/update/download/cancel', {
    method: 'POST',
    body: { id },
  });
});

ipcMain.handle('mineradio-open-update-installer', async (_event, filePath) => {
  try {
    const requestedTarget = path.resolve(String(filePath || ''));
    const updateDir = path.resolve(getUpdateDownloadDir());
    if (!requestedTarget || !fs.existsSync(requestedTarget)) return { ok: false, error: 'UPDATE_FILE_MISSING' };
    const target = fs.realpathSync.native(requestedTarget);
    const realUpdateDir = fs.realpathSync.native(updateDir);
    const targetLower = target.toLowerCase();
    const updatePrefix = (realUpdateDir + path.sep).toLowerCase();
    if (!targetLower.startsWith(updatePrefix)) return { ok: false, error: 'INVALID_UPDATE_PATH' };
    const stat = fs.statSync(target);
    if (!stat.isFile()) return { ok: false, error: 'UPDATE_FILE_INVALID' };
    if (!/^Mineradio-\d+(?:\.\d+){1,3}-Setup\.exe$/i.test(path.basename(target))) {
      return { ok: false, error: 'UPDATE_FILE_NAME_INVALID' };
    }
    const signature = await verifyUpdateInstallerSignature(target);
    const allowDevelopmentSignerMismatch = !app.isPackaged
      && process.env.MINERADIO_ALLOW_UPDATE_SIGNER_MISMATCH === '1'
      && signature.error === 'UPDATE_SIGNER_MISMATCH';
    if (!signature.ok && !allowDevelopmentSignerMismatch) return signature;
    const error = await shell.openPath(target);
    if (error) return { ok: false, error };
    const quitTimer = setTimeout(() => {
      isAppQuitting = true;
      app.quit();
    }, 500);
    if (quitTimer.unref) quitTimer.unref();
    return { ok: true, signature };
  } catch (e) {
    return { ok: false, error: e.message || 'OPEN_UPDATE_FAILED' };
  }
});

ipcMain.handle('mineradio-restart-app', async () => {
  try {
    isAppQuitting = true;
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'RESTART_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-enabled', async (_event, enabled, payload) => {
  try {
    if (enabled) {
      createDesktopLyricsWindow(payload || {});
      broadcastDesktopLyricsEnabledState(true);
    } else {
      closeDesktopLyricsWindow();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-update', async (_event, payload) => {
  try {
    const nextState = { ...desktopLyricsState, ...(payload || {}) };
    if (nextState.enabled) {
      createDesktopLyricsWindow(payload || {});
    } else if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
      desktopLyricsState = nextState;
      sendDesktopLyricsState();
    } else {
      desktopLyricsState = nextState;
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_UPDATE_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-dragging', async () => {
  return { ok: true };
});

ipcMain.handle('mineradio-desktop-lyrics-set-pointer-capture', async (_event, active) => {
  try {
    desktopLyricsPointerCapture = !!active;
    applyDesktopLyricsMouseBehavior();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_POINTER_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-hot-bounds', async (_event, bounds) => {
  try {
    const left = clampNumber(bounds && bounds.left, -2000, 4000, 0);
    const top = clampNumber(bounds && bounds.top, -2000, 4000, 0);
    const right = clampNumber(bounds && bounds.right, left + 1, 6000, left + 1);
    const bottom = clampNumber(bounds && bounds.bottom, top + 1, 6000, top + 1);
    desktopLyricsHotBounds = { left, top, right, bottom };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_HOT_BOUNDS_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-lock-state', async (_event, locked) => {
  try {
    desktopLyricsState = { ...desktopLyricsState, clickThrough: !!locked };
    if (desktopLyricsState.clickThrough !== false) desktopLyricsPointerCapture = false;
    applyDesktopLyricsMouseBehavior();
    broadcastDesktopLyricsLockState();
    return { ok: true, locked: desktopLyricsState.clickThrough !== false };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_LOCK_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-move-by', async (_event, dx, dy) => {
  try {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return { ok: false, error: 'NO_DESKTOP_LYRICS_WINDOW' };
    if (desktopLyricsState.clickThrough !== false) return { ok: false, error: 'DESKTOP_LYRICS_LOCKED' };
    const bounds = desktopLyricsWindow.getBounds();
    const next = {
      ...bounds,
      x: Math.round(bounds.x + clampNumber(dx, -160, 160, 0)),
      y: Math.round(bounds.y + clampNumber(dy, -160, 160, 0)),
    };
    desktopLyricsWindow.setBounds(next, false);
    desktopLyricsUserBounds = desktopLyricsWindow.getBounds();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_MOVE_FAILED' };
  }
});

ipcMain.handle('mineradio-wallpaper-set-enabled', async (_event, enabled, payload) => {
  try {
    if (enabled) createWallpaperWindow(payload || {});
    else closeWallpaperWindow();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'WALLPAPER_FAILED' };
  }
});

ipcMain.handle('mineradio-wallpaper-update', async (_event, payload) => {
  try {
    wallpaperState = { ...wallpaperState, ...(payload || {}) };
    if (wallpaperState.enabled) {
      createWallpaperWindow(wallpaperState);
      if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
        positionWallpaperWindow();
        sendWallpaperState();
      }
    } else if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
      sendWallpaperState();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'WALLPAPER_UPDATE_FAILED' };
  }
});

async function createWindow() {
  htmlFullscreenActive = false;
  windowFullscreenActive = false;
  const port = await findOpenPort(3000);
  mainServerPort = port;

  process.env.HOST = '127.0.0.1';
  process.env.PORT = String(port);
  process.env.COOKIE_FILE = path.join(app.getPath('userData'), '.cookie');
  process.env.QQ_COOKIE_FILE = path.join(app.getPath('userData'), '.qq-cookie');
  process.env.MINERADIO_UPDATE_DIR = getUpdateDownloadDir();
  const stagedLegacyCredentials = stageLegacyCredentialFiles(process.env.COOKIE_FILE, process.env.QQ_COOKIE_FILE);

  localServer = require(path.join(__dirname, '..', 'server.js'));
  await waitForServer(localServer);
  finalizeLegacyCredentialMigration(stagedLegacyCredentials);

  const initialBounds = getWindowedBounds();
  const initialMinimum = getAdaptiveMainMinimumSize();

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: initialMinimum.width,
    minHeight: initialMinimum.height,
    show: false,
    frame: false,
    fullscreen: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    autoHideMenuBar: true,
    title: APP_NAME,
    icon: APP_ICON_ICO,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: backgroundRuntimePolicy !== 'keep',
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedMainUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url).catch(() => {});
  });

  mainWindow.webContents.once('did-finish-load', () => {
    sendWindowState(mainWindow);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'Escape' || input.code === 'Escape') && mainWindow.isFullScreen()) {
      event.preventDefault();
      exitFullscreenToWindow(mainWindow);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    updateTaskbarMediaButtons();
    sendWindowState(mainWindow);
  });

  mainWindow.on('maximize', () => sendWindowState(mainWindow));
  mainWindow.on('unmaximize', () => sendWindowState(mainWindow));
  mainWindow.on('minimize', () => sendWindowState(mainWindow));
  mainWindow.on('restore', () => sendWindowState(mainWindow));
  mainWindow.on('show', () => sendWindowState(mainWindow));
  mainWindow.on('hide', () => sendWindowState(mainWindow));
  mainWindow.on('focus', () => sendWindowState(mainWindow));
  mainWindow.on('blur', () => sendWindowState(mainWindow));
  mainWindow.on('move', () => {
    applyAdaptiveMainWindowConstraints(mainWindow);
    scheduleWindowStateSend(mainWindow);
  });
  mainWindow.on('resize', () => scheduleWindowStateSend(mainWindow));
  mainWindow.on('close', (event) => {
    if (isAppQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    sendWindowState(mainWindow);
    showTrayNoticeOnce();
  });
  mainWindow.on('closed', () => {
    if (mainWindowStateTimer) {
      clearTimeout(mainWindowStateTimer);
      mainWindowStateTimer = null;
    }
    closeOverlayWindows();
    mainWindow = null;
  });
  mainWindow.on('enter-full-screen', () => {
    windowFullscreenActive = true;
    sendWindowState(mainWindow);
  });
  mainWindow.on('leave-full-screen', () => {
    windowFullscreenActive = false;
    setTimeout(() => applyWindowedBounds(mainWindow), 50);
  });
  mainWindow.on('enter-html-full-screen', () => {
    htmlFullscreenActive = true;
    sendWindowState(mainWindow);
  });
  mainWindow.on('leave-html-full-screen', () => {
    htmlFullscreenActive = false;
    setTimeout(() => applyWindowedBounds(mainWindow), 50);
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!focusMainWindow()) {
      app.whenReady().then(() => createWindow()).catch((e) => console.error('Second instance window restore failed:', e));
    }
  });

  app.whenReady().then(async () => {
    screen.on('display-metrics-changed', () => {
      positionDesktopLyricsWindow();
      positionWallpaperWindow();
      applyAdaptiveMainWindowConstraints(mainWindow);
      refreshAdaptiveLoginWindows();
      scheduleWindowStateSend(mainWindow);
    });
    screen.on('display-added', () => {
      applyAdaptiveMainWindowConstraints(mainWindow);
      refreshAdaptiveLoginWindows();
      scheduleWindowStateSend(mainWindow);
    });
    screen.on('display-removed', () => {
      applyAdaptiveMainWindowConstraints(mainWindow);
      refreshAdaptiveLoginWindows();
      scheduleWindowStateSend(mainWindow);
    });
    createTray();
    await createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    isAppQuitting = true;
    unregisterMineradioGlobalHotkeys();
    closeOverlayWindows();
    if (localServer && localServer.close) localServer.close();
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  });
}
