const {
  DEFAULT_CONFIG,
  normalizeConfig,
  getEffectiveClusterConfig,
  buildPortForwardArgs,
  buildHostResolverRules
} = require('./src/config');

const { app, BrowserWindow, BrowserView, ipcMain, shell } = require('electron');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const execAsync = promisify(exec);

// Config lives at ~/.kuberemoteweb/config.json — readable before app.ready
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

// ── Apply command-line switches BEFORE app.ready ────────────────────────────
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

// ── State ───────────────────────────────────────────────────────────────────
const TOOLBAR_HEIGHT = 100;
const SETTINGS_WIDTH = 400;

let mainWindow         = null;
let browserView        = null;
let portForwardProcess = null;
let portForwardStatus  = 'stopped';
let currentConfig      = initialConfig;
let settingsOpen       = false;
let browserVisible     = false;

// ── kubectl helpers ──────────────────────────────────────────────────────────
async function getKubeContexts() {
  try {
    const { stdout } = await execAsync('kubectl config get-contexts -o name', { timeout: 8000 });
    return stdout.trim().split('\n').filter(Boolean);
  } catch (e) {
    console.error('kubectl get-contexts error:', e.message);
    return [];
  }
}

async function getCurrentKubeContext() {
  try {
    const { stdout } = await execAsync('kubectl config current-context', { timeout: 5000 });
    return stdout.trim();
  } catch (e) {
    return null;
  }
}

async function getIngressHosts(contextName) {
  try {
    const ctxFlag = contextName ? `--context=${contextName}` : '';
    const { stdout } = await execAsync(
      `kubectl get ingress -A -o json ${ctxFlag}`,
      { timeout: 12000 }
    );
    const data  = JSON.parse(stdout);
    const hosts = new Set();
    for (const item of (data.items || [])) {
      for (const rule of (item.spec?.rules || [])) {
        if (rule.host) hosts.add(rule.host);
      }
    }
    return [...hosts];
  } catch (e) {
    console.error('kubectl get ingress error:', e.message);
    return [];
  }
}

// ── Port-forward ─────────────────────────────────────────────────────────────
function sendStatus(status, message) {
  portForwardStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('port-forward-status', { status, message });
  }
}

function startPortForward(contextName) {
  if (portForwardProcess) stopPortForward();

  const args = buildPortForwardArgs(currentConfig, contextName);
  console.log('[pf] kubectl', args.join(' '));
  sendStatus('starting', `kubectl ${args.join(' ')}`);

  portForwardProcess = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  portForwardProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    console.log('[pf stdout]', msg);
    if (msg.includes('Forwarding from')) {
      const cc = getEffectiveClusterConfig(currentConfig, contextName);
      sendStatus('running', `Active on ${cc.localPort} → ${cc.remotePort}`);
    }
  });

  portForwardProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    console.error('[pf stderr]', msg);
    if (/error/i.test(msg)) sendStatus('error', msg.substring(0, 140));
  });

  portForwardProcess.on('error', (err) => {
    console.error('[pf spawn error]', err);
    sendStatus('error', `kubectl not found: ${err.message}`);
    portForwardProcess = null;
  });

  portForwardProcess.on('close', (code) => {
    console.log('[pf] exited', code);
    portForwardProcess = null;
    if (portForwardStatus === 'running' || portForwardStatus === 'starting') {
      sendStatus('error', `Port-forward stopped (exit ${code})`);
    }
  });
}

function stopPortForward() {
  if (portForwardProcess) { portForwardProcess.kill(); portForwardProcess = null; }
  sendStatus('stopped', 'Port-forward stopped');
}

// ── BrowserView layout ────────────────────────────────────────────────────────
function updateBrowserViewBounds() {
  if (!browserView || !mainWindow || mainWindow.isDestroyed()) return;
  const [w, h] = mainWindow.getContentSize();
  if (!browserVisible) {
    browserView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: 0, height: 0 });
    return;
  }
  const x  = settingsOpen ? SETTINGS_WIDTH : 0;
  const bw = settingsOpen ? Math.max(0, w - SETTINGS_WIDTH) : w;
  browserView.setBounds({ x, y: TOOLBAR_HEIGHT, width: bw, height: Math.max(0, h - TOOLBAR_HEIGHT) });
}

// ── Window creation ───────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'KubeRemoteWeb',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });

  browserView = new BrowserView({
    webPreferences: {
      contextIsolation:          true,
      nodeIntegration:           false,
      allowRunningInsecureContent: true,
      webSecurity:               false
    }
  });

  mainWindow.addBrowserView(browserView);

  browserView.webContents.on('certificate-error', (event, _url, _err, _cert, callback) => {
    event.preventDefault();
    callback(true);
  });

  browserView.webContents.on('did-navigate', (_e, url) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('browser-navigated', url);
  });
  browserView.webContents.on('did-navigate-in-page', (_e, url) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('browser-navigated', url);
  });

  browserView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: 0, height: 0 });

  ['resize','maximize','unmaximize','enter-full-screen','leave-full-screen'].forEach(
    (ev) => mainWindow.on(ev, () => setTimeout(updateBrowserViewBounds, 50))
  );

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => { stopPortForward(); mainWindow = null; });

  if (!currentConfig.activeCluster) {
    getCurrentKubeContext().then((ctx) => {
      if (ctx) { currentConfig.activeCluster = ctx; writeConfig(currentConfig); }
    });
  }
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-config',          ()        => currentConfig);
ipcMain.handle('save-config',         (_e, cfg) => { currentConfig = cfg; writeConfig(currentConfig); return true; });
ipcMain.handle('get-kube-contexts',   ()        => getKubeContexts());
ipcMain.handle('get-current-context', ()        => getCurrentKubeContext());
ipcMain.handle('get-ingress-hosts',   (_e, ctx) => getIngressHosts(ctx));
ipcMain.handle('start-port-forward',  (_e, ctx) => { startPortForward(ctx); return true; });
ipcMain.handle('stop-port-forward',   ()        => { stopPortForward();      return true; });

ipcMain.handle('navigate-browser', (_e, url) => {
  if (browserView) browserView.webContents.loadURL(url);
  return true;
});
ipcMain.handle('browser-back',    () => browserView?.webContents.canGoBack()    && browserView.webContents.goBack());
ipcMain.handle('browser-forward', () => browserView?.webContents.canGoForward() && browserView.webContents.goForward());
ipcMain.handle('browser-reload',  () => browserView?.webContents.reload());

ipcMain.handle('show-browser',     (_e, show) => { browserVisible = show; updateBrowserViewBounds(); return true; });
ipcMain.handle('toggle-settings',  (_e, open) => { settingsOpen   = open; updateBrowserViewBounds(); return true; });
ipcMain.handle('open-external',    (_e, url)  => shell.openExternal(url));
ipcMain.handle('relaunch-app',     ()         => { stopPortForward(); app.relaunch(); app.quit(); });
ipcMain.handle('get-pf-status',    ()         => ({ status: portForwardStatus }));

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { stopPortForward(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
