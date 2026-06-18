/* global kubeAPI */
'use strict';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const contextSelect    = document.getElementById('contextSelect');
const refreshCtxBtn    = document.getElementById('refreshCtxBtn');
const startBtn         = document.getElementById('startBtn');
const stopBtn          = document.getElementById('stopBtn');
const statusBadge      = document.getElementById('statusBadge');
const statusText       = document.getElementById('statusText');
const settingsBtn      = document.getElementById('settingsBtn');
const settingsPanel    = document.getElementById('settingsPanel');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const urlBar           = document.getElementById('urlBar');
const backBtn          = document.getElementById('backBtn');
const fwdBtn           = document.getElementById('fwdBtn');
const reloadBtn        = document.getElementById('reloadBtn');
const goBtn            = document.getElementById('goBtn');
const extBtn           = document.getElementById('extBtn');
const emptyState       = document.getElementById('emptyState');
const connectingState  = document.getElementById('connectingState');
const settingsCtxLabel = document.getElementById('settingsCtxLabel');
const discoverBtn      = document.getElementById('discoverBtn');
const saveBtn          = document.getElementById('saveBtn');
const saveRestartBtn   = document.getElementById('saveRestartBtn');
const cancelBtn        = document.getElementById('cancelBtn');
const saveDefaultsBtn  = document.getElementById('saveDefaultsBtn');
const sfUseProxy       = document.getElementById('sfUseProxy');
const proxyField       = document.getElementById('proxyField');

// Status bar refs
const sbDot        = document.getElementById('sbDot');
const sbPfText     = document.getElementById('sbPfText');
const sbUptimeWrap = document.getElementById('sbUptimeWrap');
const sbUptime     = document.getElementById('sbUptime');
const sbBwWrap     = document.getElementById('sbBwWrap');
const sbSpeed      = document.getElementById('sbSpeed');
const sbTotal      = document.getElementById('sbTotal');
const sbCtxName    = document.getElementById('sbCtxName');

// ── State ────────────────────────────────────────────────────────────────────
let config         = null;
let activeCtx      = null;
let settingsOpen   = false;
let browserActive  = false;

// ── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = '', duration = 3500) {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast${type ? ' ' + type : ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity    = '0';
    setTimeout(() => el.remove(), 320);
  }, duration);
}

// ── Uptime formatter ──────────────────────────────────────────────────────────
function fmtUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':');
}

// ── Status bar update ─────────────────────────────────────────────────────────
function updateStatusBar(status) {
  sbDot.className = `sb-dot sb-dot-${status}`;
  const labels = { stopped: 'Stopped', starting: 'Connecting…', running: 'Running', error: 'Error' };
  sbPfText.textContent = `Port-forward: ${labels[status] || status}`;
  const isRunning = status === 'running';
  sbUptimeWrap.style.display = isRunning ? '' : 'none';
  sbBwWrap.style.display     = isRunning ? '' : 'none';
  if (!isRunning) { sbUptime.textContent = '00:00:00'; sbSpeed.textContent = '0 KB/s'; sbTotal.textContent = '0 B total'; }
}

// ── Config helpers ────────────────────────────────────────────────────────────
function effective(ctxName) {
  const defs = config.defaults || {};
  const over = (config.clusters || {})[ctxName] || {};
  return { ...defs, ...over };
}

function populateSettingsForm(ctxName) {
  const eff  = effective(ctxName);
  const over = (config.clusters || {})[ctxName] || {};

  settingsCtxLabel.textContent = ctxName || '-';

  document.getElementById('sfService').value   = over.service   || '';
  document.getElementById('sfNamespace').value = over.namespace || '';
  document.getElementById('sfLocalPort').value = over.localPort  != null ? over.localPort  : '';
  document.getElementById('sfRemotePort').value= over.remotePort != null ? over.remotePort : '';
  document.getElementById('sfFqdn').value      = over.fqdn      || eff.fqdn      || '';
  document.getElementById('sfStartUrl').value  = over.startUrl  || eff.startUrl  || '';
  document.getElementById('sfIgnoreSsl').checked = over.ignoreSSLErrors != null ? over.ignoreSSLErrors : eff.ignoreSSLErrors;
  sfUseProxy.checked = over.useProxy != null ? over.useProxy : eff.useProxy;
  document.getElementById('sfProxy').value     = over.proxyServer || eff.proxyServer || '';
  proxyField.style.display = sfUseProxy.checked ? '' : 'none';

  // Defaults section
  document.getElementById('dfService').value    = config.defaults.service    || '';
  document.getElementById('dfNamespace').value  = config.defaults.namespace  || '';
  document.getElementById('dfLocalPort').value  = config.defaults.localPort  || '';
  document.getElementById('dfRemotePort').value = config.defaults.remotePort || '';
}

function collectClusterOverride(ctxName) {
  const svc  = document.getElementById('sfService').value.trim();
  const ns   = document.getElementById('sfNamespace').value.trim();
  const lp   = parseInt(document.getElementById('sfLocalPort').value,  10);
  const rp   = parseInt(document.getElementById('sfRemotePort').value, 10);
  const fqdn = document.getElementById('sfFqdn').value.trim();
  const url  = document.getElementById('sfStartUrl').value.trim();
  const ssl  = document.getElementById('sfIgnoreSsl').checked;
  const prx  = sfUseProxy.checked;
  const psvr = document.getElementById('sfProxy').value.trim();

  const over = {};
  if (svc)         over.service          = svc;
  if (ns)          over.namespace        = ns;
  if (!isNaN(lp) && lp > 0) over.localPort  = lp;
  if (!isNaN(rp) && rp > 0) over.remotePort = rp;
  if (fqdn)        over.fqdn             = fqdn;
  if (url)         over.startUrl         = url;
  over.ignoreSSLErrors = ssl;
  over.useProxy        = prx;
  if (psvr)        over.proxyServer      = psvr;

  if (!config.clusters) config.clusters = {};
  config.clusters[ctxName] = over;
}

// ── Auto-discover FQDN for a freshly selected cluster ────────────────────────
async function autoDiscoverFqdn(ctxName) {
  try {
    const hosts = await kubeAPI.getIngressHosts(ctxName);
    if (!hosts.length) return;
    const fqdn = hosts[0];
    if (!config.clusters)          config.clusters = {};
    if (!config.clusters[ctxName]) config.clusters[ctxName] = {};
    config.clusters[ctxName].fqdn     = fqdn;
    config.clusters[ctxName].startUrl = `https://${fqdn}/web-app`;
    await kubeAPI.saveConfig(config);
    urlBar.value = config.clusters[ctxName].startUrl;
    toast(`Auto-detected FQDN: ${fqdn}`, 'ok');
  } catch (_) {
    // Silent — user can discover manually via Settings
  }
}

// ── Settings panel ────────────────────────────────────────────────────────────
function openSettings() {
  settingsOpen = true;
  settingsPanel.classList.add('open');
  kubeAPI.toggleSettings(true);
  populateSettingsForm(activeCtx);
}

function closeSettings() {
  settingsOpen = false;
  settingsPanel.classList.remove('open');
  kubeAPI.toggleSettings(false);
}

// ── Browser navigation ────────────────────────────────────────────────────────
async function navigateTo(rawUrl) {
  let url = rawUrl.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  urlBar.value = url;
  await kubeAPI.navigateBrowser(url);
  browserActive = true;
  emptyState.classList.add('hidden');
  connectingState.classList.add('hidden');
  await kubeAPI.showBrowser(true);
}

// ── Context switching ─────────────────────────────────────────────────────────
async function switchContext(ctxName) {
  if (ctxName === activeCtx) return;
  await kubeAPI.stopPortForward();
  activeCtx = ctxName;
  config.activeCluster = ctxName;
  await kubeAPI.saveConfig(config);
  await kubeAPI.showBrowser(false);
  browserActive = false;
  emptyState.classList.remove('hidden');
  connectingState.classList.add('hidden');
  sbCtxName.textContent = ctxName || '—';

  const eff = effective(ctxName);
  urlBar.value = eff.startUrl || '';

  // Auto-discover FQDN if not already configured for this cluster
  if (!eff.fqdn) autoDiscoverFqdn(ctxName);

  toast(`Switched to: ${ctxName}`);
}

// ── Populate context selector ─────────────────────────────────────────────────
async function loadContexts() {
  contextSelect.innerHTML = '<option value="">Loading…</option>';
  const ctxs = await kubeAPI.getKubeContexts();
  contextSelect.innerHTML = '';
  if (!ctxs.length) {
    contextSelect.innerHTML = '<option value="">(no contexts found)</option>';
    return;
  }
  ctxs.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = c;
    contextSelect.appendChild(opt);
  });
  if (activeCtx && ctxs.includes(activeCtx)) {
    contextSelect.value = activeCtx;
  } else {
    activeCtx = ctxs[0];
    contextSelect.value = activeCtx;
    config.activeCluster = activeCtx;
    await kubeAPI.saveConfig(config);
  }
  urlBar.value = effective(activeCtx).startUrl || '';
  sbCtxName.textContent = activeCtx || '—';
}

// ── Status update ─────────────────────────────────────────────────────────────
function applyStatus({ status, message }) {
  statusBadge.className = `status-badge status-${status}`;
  const labels = { stopped:'Stopped', starting:'Starting…', running:'Running', error:'Error' };
  statusText.textContent = labels[status] || status;

  startBtn.disabled = (status === 'starting' || status === 'running');
  stopBtn.disabled  = (status === 'stopped'  || status === 'error');

  // Connecting overlay
  if (status === 'starting') {
    connectingState.classList.remove('hidden');
    emptyState.classList.add('hidden');
  } else {
    connectingState.classList.add('hidden');
  }

  // Bottom status bar
  updateStatusBar(status);

  if (status === 'running') toast(message || 'Port-forward active', 'ok');
  if (status === 'error')   { toast(message || 'Port-forward error', 'err'); startBtn.disabled = false; }
}

// ── Event wiring ──────────────────────────────────────────────────────────────
contextSelect.addEventListener('change', (e) => switchContext(e.target.value));

refreshCtxBtn.addEventListener('click', loadContexts);

startBtn.addEventListener('click', async () => {
  if (!activeCtx) { toast('Select a cluster context first', 'err'); return; }
  startBtn.disabled = true;
  await kubeAPI.startPortForward(activeCtx);
  const eff = effective(activeCtx);
  if (eff.startUrl) {
    urlBar.value = eff.startUrl;
    // Give port-forward ~2 s to come up before auto-navigating
    setTimeout(() => navigateTo(eff.startUrl), 2000);
  }
});

stopBtn.addEventListener('click', async () => {
  await kubeAPI.stopPortForward();
  await kubeAPI.showBrowser(false);
  browserActive = false;
  emptyState.classList.remove('hidden');
  connectingState.classList.add('hidden');
});

settingsBtn.addEventListener('click', () => settingsOpen ? closeSettings() : openSettings());
closeSettingsBtn.addEventListener('click', closeSettings);
cancelBtn.addEventListener('click', closeSettings);

saveBtn.addEventListener('click', async () => {
  if (!activeCtx) return;
  collectClusterOverride(activeCtx);
  await kubeAPI.saveConfig(config);
  toast('Settings saved', 'ok');
  closeSettings();
});

saveRestartBtn.addEventListener('click', async () => {
  if (!activeCtx) return;
  collectClusterOverride(activeCtx);
  await kubeAPI.saveConfig(config);
  toast('Restarting…', 'warn');
  setTimeout(() => kubeAPI.relaunchApp(), 700);
});

saveDefaultsBtn.addEventListener('click', async () => {
  const svc = document.getElementById('dfService').value.trim();
  const ns  = document.getElementById('dfNamespace').value.trim();
  const lp  = parseInt(document.getElementById('dfLocalPort').value,  10);
  const rp  = parseInt(document.getElementById('dfRemotePort').value, 10);
  config.defaults = {
    ...config.defaults,
    ...(svc ? { service:   svc } : {}),
    ...(ns  ? { namespace: ns  } : {}),
    ...(!isNaN(lp) && lp > 0 ? { localPort:  lp } : {}),
    ...(!isNaN(rp) && rp > 0 ? { remotePort: rp } : {})
  };
  await kubeAPI.saveConfig(config);
  toast('Defaults saved', 'ok');
});

discoverBtn.addEventListener('click', async () => {
  discoverBtn.textContent = '…';
  discoverBtn.disabled = true;
  try {
    const hosts = await kubeAPI.getIngressHosts(activeCtx);
    if (!hosts.length) {
      toast('No ingress hosts found in this cluster', 'warn');
    } else {
      document.getElementById('sfFqdn').value = hosts[0];
      if (!document.getElementById('sfStartUrl').value) {
        document.getElementById('sfStartUrl').value = `https://${hosts[0]}/web-app`;
      }
      if (hosts.length === 1) {
        toast(`FQDN discovered: ${hosts[0]}`, 'ok');
      } else {
        toast(`Found ${hosts.length} hosts. Using first: ${hosts[0]}`, 'warn', 5000);
      }
    }
  } catch (e) {
    toast('Failed to query ingresses', 'err');
  } finally {
    discoverBtn.textContent = 'Discover';
    discoverBtn.disabled    = false;
  }
});

sfUseProxy.addEventListener('change', () => {
  proxyField.style.display = sfUseProxy.checked ? '' : 'none';
});

urlBar.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateTo(urlBar.value); });
goBtn.addEventListener('click',    () => navigateTo(urlBar.value));
backBtn.addEventListener('click',  () => kubeAPI.browserBack());
fwdBtn.addEventListener('click',   () => kubeAPI.browserForward());
reloadBtn.addEventListener('click',() => kubeAPI.browserReload());
extBtn.addEventListener('click',   () => kubeAPI.openExternal(urlBar.value));

// ── IPC listeners ─────────────────────────────────────────────────────────────
kubeAPI.onPFStatus((data) => applyStatus(data));
kubeAPI.onBrowserNav((url) => { urlBar.value = url; });
kubeAPI.onPFStats(({ uptime, speedLabel, totalLabel }) => {
  sbUptime.textContent = fmtUptime(uptime);
  sbSpeed.textContent  = speedLabel;
  sbTotal.textContent  = `${totalLabel} total`;
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  config    = await kubeAPI.getConfig();
  activeCtx = config.activeCluster;
  stopBtn.disabled = true;
  await loadContexts();
  // Auto-discover FQDN for the initial context if not yet configured
  if (activeCtx && !effective(activeCtx).fqdn) {
    autoDiscoverFqdn(activeCtx);
  }
}

init().catch(console.error);
