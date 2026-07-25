const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  normalizeInstalledClientConfig,
  publicClientConfig,
} = require('../lib/youtube-oauth');

function findNewestRceditInCache(cacheRoot) {
  if (!cacheRoot || !fs.existsSync(cacheRoot)) return null;
  var newest = null;
  var stack = [cacheRoot];
  while (stack.length) {
    var dir = stack.pop();
    var entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    entries.forEach(function(entry) {
      var fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        return;
      }
      if (entry.isFile() && entry.name.toLowerCase() === 'rcedit-x64.exe') {
        var stat = fs.statSync(fullPath);
        if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { path: fullPath, mtimeMs: stat.mtimeMs };
      }
    });
  }
  return newest && newest.path;
}

function resolveRcedit(projectDir) {
  var localRcedit = path.join(projectDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
  if (fs.existsSync(localRcedit)) return localRcedit;

  var candidates = [];
  var localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    var cached = findNewestRceditInCache(path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign'));
    if (cached) candidates.push(cached);
  }
  candidates.push(path.join(projectDir, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'));
  var hit = candidates.find(function(candidate) { return candidate && fs.existsSync(candidate); });
  if (!hit) throw new Error('No usable rcedit executable was found for Mineradio icon injection.');
  return hit;
}

function injectGoogleOAuthClient(context) {
  const mode = String(process.env.MINERADIO_GOOGLE_OAUTH_MODE || 'auto').trim().toLowerCase();
  const sourcePath = String(process.env.MINERADIO_GOOGLE_OAUTH_CLIENT_FILE || '').trim();
  const required = mode === 'required';
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    if (required) {
      throw new Error('Google Desktop OAuth client is required for this release build. Configure MINERADIO_GOOGLE_OAUTH_CLIENT_FILE.');
    }
    console.log('  • YouTube direct login not injected (no release OAuth client configured)');
    return;
  }

  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 1024 * 1024) {
    throw new Error('Google Desktop OAuth client file is empty or unexpectedly large.');
  }
  const normalized = normalizeInstalledClientConfig(fs.readFileSync(sourcePath, 'utf8'));
  const visible = publicClientConfig(normalized);
  const targetDir = path.join(context.appOutDir, 'resources', 'mineradio-config');
  const targetPath = path.join(targetDir, 'youtube-oauth-client.json');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify({
    installed: {
      client_id: normalized.clientId,
      client_secret: normalized.clientSecret,
      project_id: normalized.projectId,
    },
  }), { encoding: 'utf8', mode: 0o600 });
  console.log(`  • injected Google Desktop OAuth client  project=${visible.projectId || 'default'} client=${visible.clientIdHint}`);
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  injectGoogleOAuthClient(context);

  const appName = context.packager.appInfo.productFilename || 'Mineradio';
  const exePath = path.join(context.appOutDir, `${appName}.exe`);
  const iconPath = path.join(context.packager.info.buildResourcesDir, 'icon.ico');
  const manifestPath = path.join(context.packager.info.buildResourcesDir, 'mineradio.exe.manifest');
  const rceditPath = resolveRcedit(context.packager.projectDir);

  if (!fs.existsSync(exePath)) throw new Error(`Mineradio executable was not found: ${exePath}`);
  if (!fs.existsSync(iconPath)) throw new Error(`Mineradio icon was not found: ${iconPath}`);
  if (!fs.existsSync(manifestPath)) throw new Error(`Mineradio application manifest was not found: ${manifestPath}`);

  const version = context.packager.appInfo.version;
  console.log(`  • injecting Mineradio resources  rcedit=${rceditPath}`);
  execFileSync(rceditPath, [
    exePath,
    '--set-icon', iconPath,
    '--application-manifest', manifestPath,
    '--set-version-string', 'FileDescription', 'Mineradio',
    '--set-version-string', 'ProductName', 'Mineradio',
    '--set-version-string', 'CompanyName', 'dh666i',
    '--set-version-string', 'OriginalFilename', `${appName}.exe`,
    '--set-file-version', version,
    '--set-product-version', version
  ], { stdio: 'inherit' });
};
