const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopWindow', {
  isDesktop: true,
  minimize: () => ipcRenderer.invoke('desktop-window-minimize'),
  toggleMaximize: () => ipcRenderer.invoke('desktop-window-toggle-maximize'),
  toggleFullscreen: () => ipcRenderer.invoke('desktop-window-toggle-fullscreen'),
  setFullscreen: (enabled) => ipcRenderer.invoke('desktop-window-set-fullscreen', !!enabled),
  exitFullscreenWindowed: () => ipcRenderer.invoke('desktop-window-exit-fullscreen-windowed'),
  getState: () => ipcRenderer.invoke('desktop-window-get-state'),
  close: () => ipcRenderer.invoke('desktop-window-close'),
  getBackgroundPolicy: () => ipcRenderer.invoke('mineradio-background-policy-get'),
  setBackgroundPolicy: (mode) => ipcRenderer.invoke('mineradio-background-policy-set', mode),
  openNeteaseMusicLogin: () => ipcRenderer.invoke('netease-music-open-login'),
  getNeteaseMusicLoginState: () => ipcRenderer.invoke('netease-music-login-state'),
  clearNeteaseMusicLogin: (reason) => ipcRenderer.invoke('netease-music-clear-login', reason),
  invalidateNeteaseMusicLogin: () => ipcRenderer.invoke('netease-music-clear-login', 'expired'),
  openQQMusicLogin: () => ipcRenderer.invoke('qq-music-open-login'),
  getQQMusicLoginState: () => ipcRenderer.invoke('qq-music-login-state'),
  clearQQMusicLogin: (reason) => ipcRenderer.invoke('qq-music-clear-login', reason),
  invalidateQQMusicLogin: () => ipcRenderer.invoke('qq-music-clear-login', 'expired'),
  getUpdateDownloadStatus: (jobId) => ipcRenderer.invoke('mineradio-update-download-status', jobId),
  cancelUpdateDownload: (jobId) => ipcRenderer.invoke('mineradio-update-download-cancel', jobId),
  openUpdateInstaller: (filePath) => ipcRenderer.invoke('mineradio-open-update-installer', filePath),
  restartApp: () => ipcRenderer.invoke('mineradio-restart-app'),
  configureGlobalHotkeys: (bindings) => ipcRenderer.invoke('mineradio-hotkeys-configure-global', bindings || []),
  updateSystemMediaState: (payload) => ipcRenderer.invoke('mineradio-system-media-update', payload || {}),
  backupSettings: (payload) => ipcRenderer.invoke('mineradio-settings-backup', payload || {}),
  restoreLatestSettingsBackup: () => ipcRenderer.invoke('mineradio-settings-restore-latest'),
  exportDiagnostics: (payload) => ipcRenderer.invoke('mineradio-export-diagnostics', payload || {}),
  exportJsonFile: (payload) => ipcRenderer.invoke('mineradio-export-json-file', payload || {}),
  importJsonFile: () => ipcRenderer.invoke('mineradio-import-json-file'),
  onGlobalHotkey: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-global-hotkey', listener);
    return () => ipcRenderer.removeListener('mineradio-global-hotkey', listener);
  },
  setDesktopLyricsEnabled: (enabled, payload) => ipcRenderer.invoke('mineradio-desktop-lyrics-set-enabled', !!enabled, payload || {}),
  updateDesktopLyrics: (payload) => ipcRenderer.invoke('mineradio-desktop-lyrics-update', payload || {}),
  onDesktopLyricsLockState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-desktop-lyrics-lock-state', listener);
    return () => ipcRenderer.removeListener('mineradio-desktop-lyrics-lock-state', listener);
  },
  onDesktopLyricsEnabledState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-desktop-lyrics-enabled-state', listener);
    return () => ipcRenderer.removeListener('mineradio-desktop-lyrics-enabled-state', listener);
  },
  setWallpaperMode: (enabled, payload) => ipcRenderer.invoke('mineradio-wallpaper-set-enabled', !!enabled, payload || {}),
  updateWallpaperMode: (payload) => ipcRenderer.invoke('mineradio-wallpaper-update', payload || {}),
  onStateChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop-window-state', listener);
    return () => ipcRenderer.removeListener('desktop-window-state', listener);
  },
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-shell-root');
  document.body.classList.add('desktop-shell');
});
