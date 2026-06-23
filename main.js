const {
  DEFAULT_CONFIG,
  normalizeConfig,
  getEffectiveClusterConfig,
  buildPortForwardArgs,
  buildHostResolverRules
} = require('./src/config');

const { app, BrowserWindow, BrowserView, ipcMain, shell, dialog, Menu } = require('electron');
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
const TABBAR_HEIGHT  = 34;

let mainWindow         = null;
let portForwardProcess = null;
let portForwardStatus  = 'stopped';
let currentConfig      = initialConfig;
let settingsOpen       = false;
let browserVisible     = false;
let kubeconfigWatcher  = null;

let tabCounter  = 0;
const tabs      = new Map(); // id -> { browserView, url, title }
let activeTabId = null;

function getKubeconfigPath() {
  return currentConfig.kubeconfigPath || path.join(os.homedir(), '.kube', 'config');
}

let kubeconfigChangeTimer = null;
function onKubeconfigFileChanged() {
  // Debounce: editors write in multiple steps
  clearTimeout(kubeconfigChangeTimer);
  kubeconfigChangeTimer = setTimeout(() => {
    addLog('info', '[kubeconfig] file changed — refreshing contexts');
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('kubeconfig-changed');
  }, 500);
}

function watchKubeconfig() {
  if (kubeconfigWatcher) { kubeconfigWatcher.close(); kubeconfigWatcher = null; }
  const filePath = getKubeconfigPath();
  try {
    kubeconfigWatcher = fs.watch(filePath, () => onKubeconfigFileChanged());
    addLog('info', `[kubeconfig] watching ${filePath}`);
  } catch (e) {
    addLog('warn', `[kubeconfig] cannot watch ${filePath}: ${e.message}`);
  }
}

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

const INGRESS_CANDIDATES = [
  { service: 'svc/tp-ingress-controller',             namespace: 'tp-ingress-controller' },
  { service: 'svc/nginx-ingress-nginx-ingress-controller', namespace: 'nginx-ingress'   },
];

async function autoDetectIngress(contextName) {
  const kubectl  = getKubectlBin();
  const ctxFlag  = contextName ? `--context=${contextName}` : '';
  const kc       = kubeconfigFlag();
  for (const candidate of INGRESS_CANDIDATES) {
    try {
      const svcName = candidate.service.replace(/^svc\//, '');
      const cmd = `"${kubectl}" get svc ${svcName} -n ${candidate.namespace} ${ctxFlag}${kc ? ' ' + kc : ''}`.trim();
      await execAsync(cmd, { timeout: 10000 });
      addLog('info', `[auto-detect] found ${candidate.service} in ${candidate.namespace}`);
      return candidate;
    } catch (_) {
      // not found, try next
    }
  }
  addLog('warn', '[auto-detect] no known ingress controller found');
  return null;
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

function sendTabsState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const tabList = [...tabs.entries()].map(([id, t]) => ({ id, url: t.url, title: t.title }));
  mainWindow.webContents.send('tabs-state', { tabs: tabList, activeTabId });
}

function updateActiveTabBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [w, h] = mainWindow.getContentSize();
  // Hide all tabs first
  for (const [, tab] of tabs) {
    tab.browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
  // Show active tab if browser is visible
  if (browserVisible && activeTabId && tabs.has(activeTabId)) {
    const bv = tabs.get(activeTabId).browserView;
    const x  = settingsOpen ? SETTINGS_WIDTH : 0;
    const bw = settingsOpen ? Math.max(0, w - SETTINGS_WIDTH) : w;
    bv.setBounds({ x, y: TOOLBAR_HEIGHT + TABBAR_HEIGHT, width: bw, height: Math.max(0, h - TOOLBAR_HEIGHT - TABBAR_HEIGHT - STATUS_HEIGHT) });
  }
}

function createTab(url) {
  const id = ++tabCounter;
  const bv = new BrowserView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, allowRunningInsecureContent: true, webSecurity: false }
  });

  mainWindow.addBrowserView(bv);
  bv.setBounds({ x: 0, y: 0, width: 0, height: 0 });

  bv.webContents.on('certificate-error', (event, _url, _err, _cert, callback) => {
    event.preventDefault(); callback(true);
  });

  bv.webContents.on('did-navigate', (_e, navUrl) => {
    if (tabs.has(id)) tabs.get(id).url = navUrl;
    if (id === activeTabId && mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('browser-navigated', navUrl);
    sendTabsState();
  });

  bv.webContents.on('did-navigate-in-page', (_e, navUrl) => {
    if (tabs.has(id)) tabs.get(id).url = navUrl;
    if (id === activeTabId && mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('browser-navigated', navUrl);
    sendTabsState();
  });

  bv.webContents.on('page-title-updated', (_e, title) => {
    if (tabs.has(id)) tabs.get(id).title = title;
    sendTabsState();
  });

  bv.webContents.on('did-finish-load', () => {
    if (id === activeTabId && mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('browser-page-loaded');
  });

  bv.webContents.on('did-fail-load', (_e, code, desc) => {
    if (id === activeTabId && mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('browser-page-error', { code, desc });
  });

  tabs.set(id, { browserView: bv, url: url || '', title: '' });

  if (!activeTabId) {
    activeTabId = id;
  }

  if (url) {
    bv.webContents.loadURL(url);
    switchTab(id);
  } else {
    sendTabsState();
  }

  return id;
}

function closeTab(id) {
  if (!tabs.has(id)) return;
  if (tabs.size <= 1) return; // Don't close last tab

  const tab = tabs.get(id);
  mainWindow.removeBrowserView(tab.browserView);
  tab.browserView.webContents.destroy();
  tabs.delete(id);

  if (activeTabId === id) {
    // Switch to another tab
    const remaining = [...tabs.keys()];
    activeTabId = remaining[remaining.length - 1];
    updateActiveTabBounds();
    const active = tabs.get(activeTabId);
    if (active && active.url && mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('browser-navigated', active.url);
  }

  sendTabsState();
}

function switchTab(id) {
  if (!tabs.has(id)) return;
  activeTabId = id;
  updateActiveTabBounds();
  const tab = tabs.get(id);
  if (tab.url && mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('browser-navigated', tab.url);
  sendTabsState();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'KubeRemoteWeb',
    backgroundColor: '#0f0f1a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });

  // Create initial tab
  createTab(null);

  // Set up webRequest on the first tab's session
  const firstTab = tabs.get(activeTabId);
  const pendingRequests = new Map();

  firstTab.browserView.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    pendingRequests.set(details.id, { ts: Date.now(), method: details.method, url: details.url });
    callback({});
  });

  firstTab.browserView.webContents.session.webRequest.onCompleted((details) => {
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

  firstTab.browserView.webContents.session.webRequest.onErrorOccurred((details) => {
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

  ['resize','maximize','unmaximize','enter-full-screen','leave-full-screen'].forEach(
    (ev) => mainWindow.on(ev, () => setTimeout(updateActiveTabBounds, 50))
  );

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => { stopPortForward(); if (kubeconfigWatcher) { kubeconfigWatcher.close(); kubeconfigWatcher = null; } mainWindow = null; });
  watchKubeconfig();
  addLog('info', `KubeRemoteWeb v${app.getVersion()} started`);

  if (!currentConfig.activeCluster) {
    getCurrentKubeContext().then((ctx) => {
      if (ctx) { currentConfig.activeCluster = ctx; writeConfig(currentConfig); }
    });
  }
}

ipcMain.handle('get-config',          ()        => currentConfig);
ipcMain.handle('save-config',         (_e, cfg) => {
  const prevKc = currentConfig.kubeconfigPath;
  currentConfig = cfg; writeConfig(currentConfig);
  if (cfg.kubeconfigPath !== prevKc) watchKubeconfig();
  return true;
});
ipcMain.handle('get-kube-contexts',   ()        => getKubeContexts());
ipcMain.handle('get-current-context', ()        => getCurrentKubeContext());
ipcMain.handle('get-ingress-hosts',    (_e, ctx) => getIngressHosts(ctx));
ipcMain.handle('auto-detect-ingress',  (_e, ctx) => autoDetectIngress(ctx));
ipcMain.handle('start-port-forward',  (_e, ctx) => { startPortForward(ctx); return true; });
ipcMain.handle('stop-port-forward',   ()        => { stopPortForward(); return true; });
ipcMain.handle('navigate-browser', (_e, url) => {
  const tab = tabs.get(activeTabId);
  if (tab) tab.browserView.webContents.loadURL(url);
  return true;
});
ipcMain.handle('browser-back',    () => {
  const tab = tabs.get(activeTabId);
  return tab?.browserView.webContents.canGoBack() && tab.browserView.webContents.goBack();
});
ipcMain.handle('browser-forward', () => {
  const tab = tabs.get(activeTabId);
  return tab?.browserView.webContents.canGoForward() && tab.browserView.webContents.goForward();
});
ipcMain.handle('browser-reload',  () => {
  const tab = tabs.get(activeTabId);
  return tab?.browserView.webContents.reload();
});
ipcMain.handle('show-browser',    (_e, show) => { browserVisible = show; updateActiveTabBounds(); return true; });
ipcMain.handle('toggle-settings', (_e, open) => { settingsOpen   = open; updateActiveTabBounds(); return true; });
ipcMain.handle('open-external',   (_e, url)  => shell.openExternal(url));
ipcMain.handle('relaunch-app',    ()         => { stopPortForward(); app.relaunch(); app.quit(); });
ipcMain.handle('get-pf-status',   ()         => ({ status: portForwardStatus }));
ipcMain.handle('get-app-version', ()         => app.getVersion());
ipcMain.handle('get-app-logs',    ()         => logBuffer);

ipcMain.handle('new-tab',    (_e, url) => createTab(url));
ipcMain.handle('close-tab',  (_e, id)  => closeTab(id));
ipcMain.handle('switch-tab', (_e, id)  => switchTab(id));
ipcMain.handle('get-tabs',   ()        => {
  const tabList = [...tabs.entries()].map(([id, t]) => ({ id, url: t.url, title: t.title }));
  return { tabs: tabList, activeTabId };
});

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

Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { stopPortForward(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
