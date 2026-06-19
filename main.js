const {
  DEFAULT_CONFIG,
  normalizeConfig,
  getEffectiveClusterConfig,
  buildPortForwardArgs,
  buildHostResolverRules
} = require('./src/config');

const { app, BrowserWindow, BrowserView, ipcMain, shell, dialog } = require('electron');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const execAsync = promisify(exec);

const CONFIG_DIR  = path.join(os.homedir(), '.kuberemoteweb');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    }
  } catch (e) {
    console.error('Config read error:', e);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function writeConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

const initialConfig  = readConfig();
const initialCluster = initialConfig.activeCluster;

if (initialCluster) {
  const cc    = getEffectiveClusterConfig(initialConfig, initialCluster);
  const rules = buildHostResolverRules(initialConfig, initialCluster);
  if (rules) {
    app.commandLine.appendSwitch('host-resolver-rules', rules);
    app.commandLine.appendSwitch('host-rules', rules);
  }
  if (cc.ignoreSSLErrors) {
    app.commandLine.appendSwitch('ignore-certificate-errors');
    app.commandLine.appendSwitch('allow-insecure-localhost');
  }
  if (cc.useProxy && cc.proxyServer) {
    app.commandLine.appendSwitch('proxy-server', cc.proxyServer);
  } else {
    app.commandLine.appendSwitch('no-proxy-server');
  }
}

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const TOOLBAR_HEIGHT = 100;
const SETTINGS_WIDTH = 400;
const STATUS_HEIGHT  = 28;

let mainWindow         = null;
let browserView        = null;
let portForwardProcess = null;
let portForwardStatus  = 'stopped';
let currentConfig      = initialConfig;
let settingsOpen       = false;
let browserVisible     = false;

const LOG_BUFFER_MAX = 500;
let logBuffer = [];

function addLog(level, text) {
  const entry = { ts: Date.now(), level, text };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-log', entry);
}

let pfStartTime = 0, pfBytesDown = 0, pfBytesWindow = 0, pfKbps = 0;
let pfStatsInterval = null;

function formatSpeed(kbps) {
  return kbps >= 1000 ? `${(kbps/1000).toFixed(1)} MB/s` : `${kbps} KB/s`;
}
function formatBytes(b) {
  if (b >= 1048576) return `${(b/1048576).toFixed(1)} MB`;
  if (b >= 1024)    return `${(b/1024).toFixed(1)} KB`;
  return `${b} B`;
}

function startStatsTracking() {
  pfStartTime = Date.now(); pfBytesDown = 0; pfBytesWindow = 0; pfKbps = 0;
  pfStatsInterval = setInterval(() => {
    pfKbps = Math.round(pfBytesWindow * 8 / 1000);
    pfBytesDown += pfBytesWindow; pfBytesWindow = 0;
    const uptime = Math.floor((Date.now() - pfStartTime) / 1000);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pf-stats', {
        uptime, kbps: pfKbps,
        speedLabel: formatSpeed(pfKbps),
        totalLabel: formatBytes(pfBytesDown)
      });
    }
  }, 1000);
}

function stopStatsTracking() {
  if (pfStatsInterval) { clearInterval(pfStatsInterval); pfStatsInterval = null; }
}

// Resolve bundled kubectl in production; fall back to system kubectl in dev
function getKubectlBin() {
  if (app.isPackaged) {
    const name = process.platform === 'win32' ? 'kubectl.exe' : 'kubectl';
    return path.join(process.resourcesPath, name);
  }
  return 'kubectl';
}

function kubeconfigFlag() {
  return currentConfig.kubeconfigPath ? `--kubeconfig="${currentConfig.kubeconfigPath}"` : '';
}

async function getKubeContexts() {
  try {
    const kubectl = getKubectlBin();
    const kc  = kubeconfigFlag();
    const cmd = `"${kubectl}" config get-contexts -o name${kc ? ' ' + kc : ''}`;
    const { stdout } = await execAsync(cmd, { timeout: 8000 });
    return stdout.trim().split('\n').filter(Boolean);
  } catch (e) {
    addLog('err', `kubectl get-contexts: ${e.message}`);
    return [];
  }
}

async function getCurrentKubeContext() {
  try {
    const kubectl = getKubectlBin();
    const kc  = kubeconfigFlag();
    const cmd = `"${kubectl}" config current-context${kc ? ' ' + kc : ''}`;
    const { stdout } = await execAsync(cmd, { timeout: 5000 });
    return stdout.trim();
  } catch (e) { return null; }
}

async function getIngressHosts(contextName) {
  try {
    const kubectl  = getKubectlBin();
    const ctxFlag  = contextName ? `--context=${contextName}` : '';
    const kc       = kubeconfigFlag();
    const cmd      = `"${kubectl}" get ingress -A -o json ${ctxFlag}${kc ? ' ' + kc : ''}`.trim();
    const { stdout } = await execAsync(cmd, { timeout: 12000 });
    const data  = JSON.parse(stdout);
    const hosts = new Set();
    for (const item of (data.items || []))
      for (const rule of (item.spec?.rules || []))
        if (rule.host) hosts.add(rule.host);
    return [...hosts];
  } catch (e) {
    addLog('err', `kubectl get ingress: ${e.message}`);
    return [];
  }
}

function sendStatus(status, message) {
  portForwardStatus = status;
  if (status === 'running') startStatsTracking();
  if (status === 'stopped' || status === 'error') stopStatsTracking();
  addLog(status === 'error' ? 'err' : 'info', `[status] ${status}${message ? ': ' + message : ''}`);
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('port-forward-status', { status, message });
}

function startPortForward(contextName) {
  if (portForwardProcess) stopPortForward();
  const args = buildPortForwardArgs(currentConfig, contextName);
  addLog('info', `[pf] kubectl ${args.join(' ')}`);
  sendStatus('starting', `kubectl ${args.join(' ')}`);
  portForwardProcess = spawn(getKubectlBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  portForwardProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    addLog('info', `[pf] ${msg}`);
    if (msg.includes('Forwarding from')) {
      const cc = getEffectiveClusterConfig(currentConfig, contextName);
      sendStatus('running', `Active on ${cc.localPort} → ${cc.remotePort}`);
    }
  });
  portForwardProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    addLog(/error/i.test(msg) ? 'err' : 'warn', `[pf stderr] ${msg}`);
    if (/error/i.test(msg)) sendStatus('error', msg.substring(0, 140));
  });
  portForwardProcess.on('error', (err) => {
    addLog('err', `[pf spawn] ${err.message}`);
    sendStatus('error', `kubectl not found: ${err.message}`);
    portForwardProcess = null;
  });
  portForwardProcess.on('close', (code) => {
    addLog('info', `[pf] process exited (${code})`);
    portForwardProcess = null;
    if (portForwardStatus === 'running' || portForwardStatus === 'starting')
      sendStatus('error', `Port-forward stopped (exit ${code})`);
  });
}

function stopPortForward() {
  if (portForwardProcess) { portForwardProcess.kill(); portForwardProcess = null; }
  sendStatus('stopped', 'Port-forward stopped');
}

function updateBrowserViewBounds() {
  if (!browserView || !mainWindow || mainWindow.isDestroyed()) return;
  const [w, h] = mainWindow.getContentSize();
  if (!browserVisible) { browserView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: 0, height: 0 }); return; }
  const x  = settingsOpen ? SETTINGS_WIDTH : 0;
  const bw = settingsOpen ? Math.max(0, w - SETTINGS_WIDTH) : w;
  browserView.setBounds({ x, y: TOOLBAR_HEIGHT, width: bw, height: Math.max(0, h - TOOLBAR_HEIGHT - STATUS_HEIGHT) });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'KubeRemoteWeb',
    backgroundColor: '#0f0f1a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });

  browserView = new BrowserView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, allowRunningInsecureContent: true, webSecurity: false }
  });

  mainWindow.addBrowserView(browserView);

  browserView.webContents.on('certificate-error', (event, _url, _err, _cert, callback) => {
    event.preventDefault(); callback(true);
  });
  browserView.webContents.on('did-navigate', (_e, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser-navigated', url);
  });
  browserView.webContents.on('did-navigate-in-page', (_e, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser-navigated', url);
  });

  // Track in-flight requests for timing and network monitor
  const pendingRequests = new Map();

  browserView.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    pendingRequests.set(details.id, { ts: Date.now(), method: details.method, url: details.url });
    callback({});
  });

  browserView.webContents.session.webRequest.onCompleted((details) => {
    // Bandwidth accounting
    if (portForwardStatus === 'running') {
      const h  = details.responseHeaders || {};
      const cl = parseInt(h['content-length']?.[0] || h['Content-Length']?.[0] || '0', 10);
      if (!isNaN(cl) && cl > 0) pfBytesWindow += cl;
    }
    // Network monitor
    const pending  = pendingRequests.get(details.id);
    pendingRequests.delete(details.id);
    const duration = pending ? Date.now() - pending.ts : 0;
    const h        = details.responseHeaders || {};
    const size     = parseInt(h['content-length']?.[0] || h['Content-Length']?.[0] || '0', 10) || 0;
    const ct       = (h['content-type']?.[0] || h['Content-Type']?.[0] || '').split(';')[0].trim();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('net-request', {
        ts: pending?.ts ?? Date.now(), method: details.method, url: details.url,
        status: details.statusCode, type: ct, size, duration
      });
    }
  });

  browserView.webContents.session.webRequest.onErrorOccurred((details) => {
    const pending  = pendingRequests.get(details.id);
    pendingRequests.delete(details.id);
    const duration = pending ? Date.now() - pending.ts : 0;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('net-request', {
        ts: pending?.ts ?? Date.now(), method: details.method, url: details.url,
        status: 0, error: details.error, type: '', size: 0, duration
      });
    }
  });

  browserView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: 0, height: 0 });
  ['resize','maximize','unmaximize','enter-full-screen','leave-full-screen'].forEach(
    (ev) => mainWindow.on(ev, () => setTimeout(updateBrowserViewBounds, 50))
  );

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => { stopPortForward(); mainWindow = null; });
  addLog('info', `KubeRemoteWeb v${app.getVersion()} started`);

  if (!currentConfig.activeCluster) {
    getCurrentKubeContext().then((ctx) => {
      if (ctx) { currentConfig.activeCluster = ctx; writeConfig(currentConfig); }
    });
  }
}

ipcMain.handle('get-config',          ()        => currentConfig);
ipcMain.handle('save-config',         (_e, cfg) => { currentConfig = cfg; writeConfig(currentConfig); return true; });
ipcMain.handle('get-kube-contexts',   ()        => getKubeContexts());
ipcMain.handle('get-current-context', ()        => getCurrentKubeContext());
ipcMain.handle('get-ingress-hosts',   (_e, ctx) => getIngressHosts(ctx));
ipcMain.handle('start-port-forward',  (_e, ctx) => { startPortForward(ctx); return true; });
ipcMain.handle('stop-port-forward',   ()        => { stopPortForward(); return true; });
ipcMain.handle('navigate-browser', (_e, url) => { if (browserView) browserView.webContents.loadURL(url); return true; });
ipcMain.handle('browser-back',    () => browserView?.webContents.canGoBack()    && browserView.webContents.goBack());
ipcMain.handle('browser-forward', () => browserView?.webContents.canGoForward() && browserView.webContents.goForward());
ipcMain.handle('browser-reload',  () => browserView?.webContents.reload());
ipcMain.handle('show-browser',    (_e, show) => { browserVisible = show; updateBrowserViewBounds(); return true; });
ipcMain.handle('toggle-settings', (_e, open) => { settingsOpen   = open; updateBrowserViewBounds(); return true; });
ipcMain.handle('open-external',   (_e, url)  => shell.openExternal(url));
ipcMain.handle('relaunch-app',    ()         => { stopPortForward(); app.relaunch(); app.quit(); });
ipcMain.handle('get-pf-status',   ()         => ({ status: portForwardStatus }));
ipcMain.handle('get-app-version', ()         => app.getVersion());
ipcMain.handle('get-app-logs',    ()         => logBuffer);

ipcMain.handle('browse-kubeconfig', async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select kubeconfig file',
    properties: ['openFile'],
    filters: [
      { name: 'Kubeconfig', extensions: ['yaml', 'yml', 'json', 'conf', 'cfg'] },
      { name: 'All Files',  extensions: ['*'] }
    ]
  });
  if (canceled || !filePaths.length) return null;
  addLog('info', `[kubeconfig] using: ${filePaths[0]}`);
  return filePaths[0];
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { stopPortForward(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
