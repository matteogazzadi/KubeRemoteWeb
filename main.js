const { app, BrowserWindow, BrowserView, ipcMain, shell } = require('electron');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');

const execAsync = promisify(exec);

// Config lives at ~/.kuberemoteweb/config.json so it can be read before app.ready
const CONFIG_DIR = path.join(os.homedir(), '.kuberemoteweb');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  activeCluster: null,
  defaults: {
    service: 'svc/tp-ingress-controller',
    namespace: 'tp-ingress-controller',
    localPort: 443,
    remotePort: 443,
    fqdn: '',
    startUrl: '',
    ignoreSSLErrors: true,
    useProxy: false,
    proxyServer: ''
  },
  clusters: {}
};

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        defaults: { ...DEFAULT_CONFIG.defaults, ...(raw.defaults || {}) },
        clusters: raw.clusters || {}
      };
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

function getEffectiveClusterConfig(cfg, contextName) {
  const defaults = cfg.defaults || DEFAULT_CONFIG.defaults;
  const override = (cfg.clusters || {})[contextName] || {};
  return { ...defaults, ...override };
}

// ── Read config BEFORE app.ready to apply command-line switches ──────────────
const initialConfig = readConfig();
const initialCluster = initialConfig.activeCluster;

if (initialCluster) {
  const cc = getEffectiveClusterConfig(initialConfig, initialCluster);

  if (cc.fqdn) {
    app.commandLine.appendSwitch('host-resolver-rules', `MAP ${cc.fqdn} 127.0.0.1`);
    app.commandLine.appendSwitch('host-rules', `MAP ${cc.fqdn} 127.0.0.1`);
  }
  if (cc.ignoreSSLErrors) {
    app.commandLine.appendSwitch('ignore-certificate-errors');
    app.commandLine.appendSwitch('ignore-urlfetcher-cert-requests');
    app.commandLine.appendSwitch('allow-insecure-localhost');
  }
  if (cc.useProxy && cc.proxyServer) {
    app.commandLine.appendSwitch('proxy-server', cc.proxyServer);
  } else {
    app.commandLine.appendSwitch('no-proxy-server');
  }
}

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// ── State ────────────────────────────────────────────────────────────────────
const TOOLBAR_HEIGHT = 100;
const SETTINGS_WIDTH = 400;

let mainWindow = null;
let browserView = null;
let portForwardProcess = null;
let portForwardStatus = 'stopped';
let currentConfig = initialConfig;
let settingsOpen = false;
let browserVisible = false;

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
    const cmd = `kubectl get ingress -A -o jsonpath="{range .items[*]}{range .spec.rules[*]}{.host}{\"\\n\"}{end}{end}" ${ctxFlag}`.trim();
    const { stdout } = await execAsync(cmd, { timeout: 12000 });
    return [...new Set(stdout.trim().split('\n').filter(Boolean))];
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

  const cc = getEffectiveClusterConfig(currentConfig, contextName);
  const args = [
    'port-forward',
    '-n', cc.namespace,
    cc.service,
    `${cc.localPort}:${cc.remotePort}`,
    `--context=${contextName}`
  ];

  console.log('[pf] starting:', 'kubectl', args.join(' '));
  sendStatus('starting', `Starting: kubectl ${args.join(' ')}`);

  portForwardProcess = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  portForwardProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    console.log('[pf stdout]', msg);
    if (msg.includes('Forwarding from')) {
      sendStatus('running', `Active on port ${cc.localPort} → ${cc.remotePort}`);
    }
  });

  portForwardProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    console.error('[pf stderr]', msg);
    if (msg.includes('error') || msg.includes('Error')) {
      sendStatus('error', msg.substring(0, 120));
    }
  });

  portForwardProcess.on('error', (err) => {
    console.error('[pf] spawn error:', err);
    sendStatus('error', `kubectl not found or failed: ${err.message}`);
    portForwardProcess = null;
  });

  portForwardProcess.on('close', (code) => {
    console.log('[pf] exited with code', code);
    portForwardProcess = null;
    if (portForwardStatus === 'running' || portForwardStatus === 'starting') {
      sendStatus('error', `Port-forward stopped unexpectedly (exit ${code})`);
    }
  });
}

function stopPortForward() {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
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
  const x = settingsOpen ? SETTINGS_WIDTH : 0;
  const bw = settingsOpen ? Math.max(0, w - SETTINGS_WIDTH) : w;
  browserView.setBounds({ x, y: TOOLBAR_HEIGHT, width: bw, height: Math.max(0, h - TOOLBAR_HEIGHT) });
}

// ── Window creation ───────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'KubeRemoteWeb',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  browserView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      allowRunningInsecureContent: true,
      webSecurity: false
    }
  });

  mainWindow.addBrowserView(browserView);

  // Allow cert errors for tunnelled traffic
  browserView.webContents.on('certificate-error', (event, url, error, cert, callback) => {
    event.preventDefault();
    callback(true);
  });

  browserView.webContents.on('did-navigate', (event, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser-navigated', url);
    }
  });

  browserView.webContents.on('did-navigate-in-page', (event, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser-navigated', url);
    }
  });

  browserView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: 0, height: 0 });

  ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach((ev) => {
    mainWindow.on(ev, () => setTimeout(updateBrowserViewBounds, 50));
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('closed', () => {
    stopPortForward();
    mainWindow = null;
  });

  // Auto-detect current context on first run
  if (!currentConfig.activeCluster) {
    getCurrentKubeContext().then((ctx) => {
      if (ctx) {
        currentConfig.activeCluster = ctx;
        writeConfig(currentConfig);
      }
    });
  }
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => currentConfig);

ipcMain.handle('save-config', (event, cfg) => {
  currentConfig = cfg;
  writeConfig(currentConfig);
  return true;
});

ipcMain.handle('get-kube-contexts', () => getKubeContexts());
ipcMain.handle('get-current-context', () => getCurrentKubeContext());
ipcMain.handle('get-ingress-hosts', (event, ctx) => getIngressHosts(ctx));

ipcMain.handle('start-port-forward', (event, ctx) => {
  startPortForward(ctx);
  return true;
});

ipcMain.handle('stop-port-forward', () => {
  stopPortForward();
  return true;
});

ipcMain.handle('navigate-browser', (event, url) => {
  if (browserView) browserView.webContents.loadURL(url);
  return true;
});

ipcMain.handle('browser-back', () => {
  if (browserView && browserView.webContents.canGoBack()) browserView.webContents.goBack();
});

ipcMain.handle('browser-forward', () => {
  if (browserView && browserView.webContents.canGoForward()) browserView.webContents.goForward();
});

ipcMain.handle('browser-reload', () => {
  if (browserView) browserView.webContents.reload();
});

ipcMain.handle('show-browser', (event, show) => {
  browserVisible = show;
  updateBrowserViewBounds();
  return true;
});

ipcMain.handle('toggle-settings', (event, open) => {
  settingsOpen = open;
  updateBrowserViewBounds();
  return true;
});

ipcMain.handle('open-external', (event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('relaunch-app', () => {
  stopPortForward();
  app.relaunch();
  app.quit();
});

ipcMain.handle('get-pf-status', () => ({ status: portForwardStatus }));

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopPortForward();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
