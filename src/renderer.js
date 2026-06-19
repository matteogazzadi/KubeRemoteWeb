/* global kubeAPI */
'use strict';

const contextSelect      = document.getElementById('contextSelect');
const refreshCtxBtn      = document.getElementById('refreshCtxBtn');
const startBtn           = document.getElementById('startBtn');
const stopBtn            = document.getElementById('stopBtn');
const statusBadge        = document.getElementById('statusBadge');
const statusText         = document.getElementById('statusText');
const settingsBtn        = document.getElementById('settingsBtn');
const settingsPanel      = document.getElementById('settingsPanel');
const closeSettingsBtn   = document.getElementById('closeSettingsBtn');
const urlBar             = document.getElementById('urlBar');
const backBtn            = document.getElementById('backBtn');
const fwdBtn             = document.getElementById('fwdBtn');
const reloadBtn          = document.getElementById('reloadBtn');
const goBtn              = document.getElementById('goBtn');
const extBtn             = document.getElementById('extBtn');
const emptyState         = document.getElementById('emptyState');
const settingsCtxLabel   = document.getElementById('settingsCtxLabel');
const discoverBtn        = document.getElementById('discoverBtn');
const saveBtn            = document.getElementById('saveBtn');
const saveRestartBtn     = document.getElementById('saveRestartBtn');
const cancelBtn          = document.getElementById('cancelBtn');
const saveDefaultsBtn    = document.getElementById('saveDefaultsBtn');
const sfUseProxy         = document.getElementById('sfUseProxy');
const proxyField         = document.getElementById('proxyField');
const connectingState    = document.getElementById('connectingState');
const themeBtn           = document.getElementById('themeBtn');
const debugBtn           = document.getElementById('debugBtn');
const debugPanel         = document.getElementById('debugPanel');
const closeDebugBtn      = document.getElementById('closeDebugBtn');
const debugLog           = document.getElementById('debugLog');
const debugNet           = document.getElementById('debugNet');
const netRows            = document.getElementById('netRows');
const clearLogBtn        = document.getElementById('clearLogBtn');
const tabLogs            = document.getElementById('tabLogs');
const tabNetwork         = document.getElementById('tabNetwork');
const appVersionEl       = document.getElementById('appVersion');
const sbDot              = document.getElementById('sbDot');
const sbPfText           = document.getElementById('sbPfText');
const sbUptimeWrap       = document.getElementById('sbUptimeWrap');
const sbBwWrap           = document.getElementById('sbBwWrap');
const sbUptime           = document.getElementById('sbUptime');
const sbSpeed            = document.getElementById('sbSpeed');
const sbTotal            = document.getElementById('sbTotal');
const sbCtxName          = document.getElementById('sbCtxName');
const sfKubeconfig       = document.getElementById('sfKubeconfig');
const browseKubeconfigBtn = document.getElementById('browseKubeconfigBtn');
const clearKubeconfigBtn = document.getElementById('clearKubeconfigBtn');

let config         = null;
let activeCtx      = null;
let settingsOpen   = false;
let debugOpen      = false;
let browserActive  = false;
let activeDebugTab = 'logs';

function toast(msg, type = '', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast${type ? ' ' + type : ''}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, duration);
}

function applyTheme(theme) {
  if (theme === 'light') { document.body.classList.add('light-theme'); themeBtn.innerHTML = '&#9790;'; themeBtn.title = 'Switch to dark theme'; }
  else { document.body.classList.remove('light-theme'); themeBtn.innerHTML = '&#9788;'; themeBtn.title = 'Switch to light theme'; }
}
function toggleTheme() {
  const next = document.body.classList.contains('light-theme') ? 'dark' : 'light';
  config.theme = next; applyTheme(next); kubeAPI.saveConfig(config).catch(() => {});
}

function switchDebugTab(tab) {
  activeDebugTab = tab;
  tabLogs.classList.toggle('active', tab === 'logs');
  tabNetwork.classList.toggle('active', tab === 'network');
  debugLog.classList.toggle('hidden', tab !== 'logs');
  debugNet.classList.toggle('hidden', tab !== 'network');
}
tabLogs.addEventListener('click',    () => switchDebugTab('logs'));
tabNetwork.addEventListener('click', () => switchDebugTab('network'));

function fmtLogTime(ts) { return new Date(ts).toTimeString().slice(0, 8); }

function appendLog(entry) {
  const atBottom = debugLog.scrollHeight - debugLog.scrollTop - debugLog.clientHeight < 60;
  const el = document.createElement('div'); el.className = 'log-entry';
  const t = document.createElement('span'); t.className = 'log-time'; t.textContent = fmtLogTime(entry.ts);
  const b = document.createElement('span'); b.className = `log-badge log-badge-${entry.level}`; b.textContent = entry.level;
  const m = document.createElement('span'); m.className = 'log-text'; m.textContent = entry.text;
  el.appendChild(t); el.appendChild(b); el.appendChild(m);
  debugLog.appendChild(el);
  if (atBottom) debugLog.scrollTop = debugLog.scrollHeight;
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes >= 1048576) return `${(bytes/1048576).toFixed(1)} MB`;
  if (bytes >= 1024)    return `${(bytes/1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
function fmtDuration(ms) { return ms >= 1000 ? `${(ms/1000).toFixed(2)} s` : `${ms} ms`; }
function statusClass(status, error) {
  if (error || !status) return 'ns-err';
  if (status >= 500) return 'ns-5xx';
  if (status >= 400) return 'ns-4xx';
  if (status >= 300) return 'ns-3xx';
  return 'ns-2xx';
}
function shortType(ct) {
  if (!ct) return '';
  if (ct.includes('javascript')) return 'js';
  if (ct.includes('css'))        return 'css';
  if (ct.includes('html'))       return 'html';
  if (ct.includes('json'))       return 'json';
  if (ct.includes('image'))      return ct.replace('image/', '');
  if (ct.includes('font'))       return 'font';
  if (ct.includes('wasm'))       return 'wasm';
  const sl = ct.lastIndexOf('/'); return sl >= 0 ? ct.slice(sl + 1) : ct;
}
function urlName(url) {
  try { const u = new URL(url); const p = u.pathname.split('/').filter(Boolean); return p.length ? p[p.length-1] : u.hostname; }
  catch { return url; }
}

function appendNetRequest(req) {
  const atBottom = netRows.scrollHeight - netRows.scrollTop - netRows.clientHeight < 60;
  const row = document.createElement('div');
  row.className = 'net-row'; row.title = req.url;
  const sc = statusClass(req.status, req.error);
  const statusLabel = req.error ? 'ERR' : (req.status || '—');
  row.innerHTML = `
    <span class="nc-status"><span class="net-status ${sc}">${statusLabel}</span></span>
    <span class="nc-method net-method">${req.method}</span>
    <span class="nc-type net-dim">${shortType(req.type)}</span>
    <span class="nc-size net-dim">${fmtSize(req.size)}</span>
    <span class="nc-time net-dim">${fmtDuration(req.duration)}</span>
    <span class="nc-url net-url">${urlName(req.url)}</span>
  `;
  row.addEventListener('click', () => row.classList.toggle('expanded'));
  const detail = document.createElement('div');
  detail.className = 'net-detail'; detail.textContent = req.url;
  row.appendChild(detail);
  netRows.appendChild(row);
  if (atBottom) netRows.scrollTop = netRows.scrollHeight;
}

clearLogBtn.addEventListener('click', () => {
  if (activeDebugTab === 'logs')    debugLog.innerHTML = '';
  if (activeDebugTab === 'network') netRows.innerHTML  = '';
});

function openDebug()  { debugOpen = true;  debugPanel.classList.add('open'); }
function closeDebug() { debugOpen = false; debugPanel.classList.remove('open'); }

function fmtUptime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':');
}

function updateStatusBar(status) {
  sbDot.className = `sb-dot sb-dot-${status}`;
  const labels = { stopped: 'Port-forward: Stopped', starting: 'Port-forward: Starting…', running: 'Port-forward: Running', error: 'Port-forward: Error' };
  sbPfText.textContent       = labels[status] || `Port-forward: ${status}`;
  sbCtxName.textContent      = activeCtx || '—';
  sbUptimeWrap.style.display = status === 'running' ? '' : 'none';
  sbBwWrap.style.display     = status === 'running' ? '' : 'none';
  if (status !== 'running') { sbUptime.textContent = '00:00:00'; sbSpeed.textContent = '0 KB/s'; sbTotal.textContent = '0 B total'; }
}

function updateKubeconfigDisplay() {
  const p = config.kubeconfigPath || '';
  sfKubeconfig.value = p;
  clearKubeconfigBtn.style.display = p ? '' : 'none';
}

function effective(ctxName) {
  return { ...(config.defaults || {}), ...((config.clusters || {})[ctxName] || {}) };
}

function populateSettingsForm(ctxName) {
  const eff  = effective(ctxName);
  const over = (config.clusters || {})[ctxName] || {};
  settingsCtxLabel.textContent = ctxName || '-';
  document.getElementById('sfService').value    = over.service   || '';
  document.getElementById('sfNamespace').value  = over.namespace || '';
  document.getElementById('sfLocalPort').value  = over.localPort  != null ? over.localPort  : '';
  document.getElementById('sfRemotePort').value = over.remotePort != null ? over.remotePort : '';
  document.getElementById('sfFqdn').value       = over.fqdn      || eff.fqdn      || '';
  document.getElementById('sfStartUrl').value   = over.startUrl  || eff.startUrl  || '';
  document.getElementById('sfIgnoreSsl').checked = over.ignoreSSLErrors != null ? over.ignoreSSLErrors : eff.ignoreSSLErrors;
  sfUseProxy.checked = over.useProxy != null ? over.useProxy : eff.useProxy;
  document.getElementById('sfProxy').value      = over.proxyServer || eff.proxyServer || '';
  proxyField.style.display = sfUseProxy.checked ? '' : 'none';
  document.getElementById('dfService').value    = config.defaults.service    || '';
  document.getElementById('dfNamespace').value  = config.defaults.namespace  || '';
  document.getElementById('dfLocalPort').value  = config.defaults.localPort  || '';
  document.getElementById('dfRemotePort').value = config.defaults.remotePort || '';
  updateKubeconfigDisplay();
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
  if (svc)  over.service   = svc;
  if (ns)   over.namespace = ns;
  if (!isNaN(lp) && lp > 0) over.localPort  = lp;
  if (!isNaN(rp) && rp > 0) over.remotePort = rp;
  if (fqdn) over.fqdn      = fqdn;
  if (url)  over.startUrl  = url;
  over.ignoreSSLErrors = ssl; over.useProxy = prx;
  if (psvr) over.proxyServer = psvr;
  if (!config.clusters) config.clusters = {};
  config.clusters[ctxName] = over;
}

async function autoDiscoverFqdn(ctxName) {
  try {
    const hosts = await kubeAPI.getIngressHosts(ctxName);
    if (!hosts.length) return;
    const fqdn = hosts[0];
    if (!config.clusters)          config.clusters          = {};
    if (!config.clusters[ctxName]) config.clusters[ctxName] = {};
    config.clusters[ctxName].fqdn     = fqdn;
    config.clusters[ctxName].startUrl = `https://${fqdn}/web-app`;
    await kubeAPI.saveConfig(config);
    urlBar.value = config.clusters[ctxName].startUrl;
    toast(`Auto-detected FQDN: ${fqdn}`, 'ok');
  } catch (_) {}
}

function openSettings()  { settingsOpen = true;  settingsPanel.classList.add('open');    kubeAPI.toggleSettings(true);  populateSettingsForm(activeCtx); }
function closeSettings() { settingsOpen = false; settingsPanel.classList.remove('open'); kubeAPI.toggleSettings(false); }

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

async function switchContext(ctxName) {
  if (ctxName === activeCtx) return;
  await kubeAPI.stopPortForward();
  activeCtx = ctxName; config.activeCluster = ctxName;
  await kubeAPI.saveConfig(config);
  await kubeAPI.showBrowser(false);
  browserActive = false;
  emptyState.classList.remove('hidden'); connectingState.classList.add('hidden');
  urlBar.value = effective(ctxName).startUrl || '';
  sbCtxName.textContent = ctxName;
  toast(`Switched to: ${ctxName}`);
  if (!effective(ctxName).fqdn) autoDiscoverFqdn(ctxName);
}

async function loadContexts() {
  contextSelect.innerHTML = '<option value="">Loading…</option>';
  const ctxs = await kubeAPI.getKubeContexts();
  contextSelect.innerHTML = '';
  if (!ctxs.length) { contextSelect.innerHTML = '<option value="">(no contexts found)</option>'; return; }
  ctxs.forEach((c) => { const opt = document.createElement('option'); opt.value = opt.textContent = c; contextSelect.appendChild(opt); });
  if (activeCtx && ctxs.includes(activeCtx)) { contextSelect.value = activeCtx; }
  else { activeCtx = ctxs[0]; contextSelect.value = activeCtx; config.activeCluster = activeCtx; await kubeAPI.saveConfig(config); }
  urlBar.value = effective(activeCtx).startUrl || '';
}

function applyStatus({ status, message }) {
  statusBadge.className = `status-badge status-${status}`;
  const labels = { stopped: 'Stopped', starting: 'Starting…', running: 'Running', error: 'Error' };
  statusText.textContent = labels[status] || status;
  startBtn.disabled = (status === 'starting' || status === 'running');
  stopBtn.disabled  = (status === 'stopped'  || status === 'error');
  if (status === 'starting') { connectingState.classList.remove('hidden'); emptyState.classList.add('hidden'); }
  else { connectingState.classList.add('hidden'); }
  updateStatusBar(status);
  if (status === 'running') toast(message || 'Port-forward active', 'ok');
  if (status === 'error')   { toast(message || 'Port-forward error', 'err'); startBtn.disabled = false; }
}

contextSelect.addEventListener('change', (e) => switchContext(e.target.value));
refreshCtxBtn.addEventListener('click', loadContexts);

startBtn.addEventListener('click', async () => {
  if (!activeCtx) { toast('Select a cluster context first', 'err'); return; }
  startBtn.disabled = true;
  await kubeAPI.startPortForward(activeCtx);
  const eff = effective(activeCtx);
  if (eff.startUrl) { urlBar.value = eff.startUrl; setTimeout(() => navigateTo(eff.startUrl), 2000); }
});

stopBtn.addEventListener('click', async () => {
  await kubeAPI.stopPortForward(); await kubeAPI.showBrowser(false);
  browserActive = false; emptyState.classList.remove('hidden'); connectingState.classList.add('hidden');
});

settingsBtn.addEventListener('click', () => settingsOpen ? closeSettings() : openSettings());
closeSettingsBtn.addEventListener('click', closeSettings);
cancelBtn.addEventListener('click', closeSettings);
themeBtn.addEventListener('click', toggleTheme);
debugBtn.addEventListener('click', () => debugOpen ? closeDebug() : openDebug());
closeDebugBtn.addEventListener('click', closeDebug);

browseKubeconfigBtn.addEventListener('click', async () => {
  const p = await kubeAPI.browseKubeconfig();
  if (!p) return;
  config.kubeconfigPath = p; await kubeAPI.saveConfig(config);
  updateKubeconfigDisplay(); toast('Loading contexts from new kubeconfig…', 'ok');
  await loadContexts();
});
clearKubeconfigBtn.addEventListener('click', async () => {
  config.kubeconfigPath = null; await kubeAPI.saveConfig(config);
  updateKubeconfigDisplay(); toast('Using default kubeconfig'); await loadContexts();
});

saveBtn.addEventListener('click', async () => {
  if (!activeCtx) return; collectClusterOverride(activeCtx); await kubeAPI.saveConfig(config); toast('Settings saved', 'ok'); closeSettings();
});
saveRestartBtn.addEventListener('click', async () => {
  if (!activeCtx) return; collectClusterOverride(activeCtx); await kubeAPI.saveConfig(config); toast('Restarting…', 'warn'); setTimeout(() => kubeAPI.relaunchApp(), 700);
});
saveDefaultsBtn.addEventListener('click', async () => {
  const svc = document.getElementById('dfService').value.trim();
  const ns  = document.getElementById('dfNamespace').value.trim();
  const lp  = parseInt(document.getElementById('dfLocalPort').value,  10);
  const rp  = parseInt(document.getElementById('dfRemotePort').value, 10);
  config.defaults = { ...config.defaults, ...(svc?{service:svc}:{}), ...(ns?{namespace:ns}:{}), ...(!isNaN(lp)&&lp>0?{localPort:lp}:{}), ...(!isNaN(rp)&&rp>0?{remotePort:rp}:{}) };
  await kubeAPI.saveConfig(config); toast('Defaults saved', 'ok');
});

discoverBtn.addEventListener('click', async () => {
  discoverBtn.textContent = '…'; discoverBtn.disabled = true;
  try {
    const hosts = await kubeAPI.getIngressHosts(activeCtx);
    if (!hosts.length) { toast('No ingress hosts found in this cluster', 'warn'); }
    else {
      document.getElementById('sfFqdn').value = hosts[0];
      if (!document.getElementById('sfStartUrl').value) document.getElementById('sfStartUrl').value = `https://${hosts[0]}`;
      toast(hosts.length===1?`FQDN discovered: ${hosts[0]}`:`Found ${hosts.length} hosts. Using first: ${hosts[0]}`, hosts.length===1?'ok':'warn', hosts.length===1?3500:5000);
    }
  } catch (e) { toast('Failed to query ingresses', 'err'); }
  finally { discoverBtn.textContent = 'Discover'; discoverBtn.disabled = false; }
});

sfUseProxy.addEventListener('change', () => { proxyField.style.display = sfUseProxy.checked ? '' : 'none'; });
urlBar.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateTo(urlBar.value); });
goBtn.addEventListener('click',    () => navigateTo(urlBar.value));
backBtn.addEventListener('click',  () => kubeAPI.browserBack());
fwdBtn.addEventListener('click',   () => kubeAPI.browserForward());
reloadBtn.addEventListener('click',() => kubeAPI.browserReload());
extBtn.addEventListener('click',   () => kubeAPI.openExternal(urlBar.value));

kubeAPI.onPFStatus((data)  => applyStatus(data));
kubeAPI.onBrowserNav((url) => { urlBar.value = url; });
kubeAPI.onAppLog((entry)   => appendLog(entry));
kubeAPI.onPFStats(({ uptime, speedLabel, totalLabel }) => {
  sbUptime.textContent = fmtUptime(uptime); sbSpeed.textContent = speedLabel; sbTotal.textContent = `${totalLabel} total`;
});
kubeAPI.onNetRequest((req) => appendNetRequest(req));

async function init() {
  config    = await kubeAPI.getConfig();
  activeCtx = config.activeCluster;
  stopBtn.disabled = true;
  appVersionEl.textContent = `v${await kubeAPI.getAppVersion()}`;
  applyTheme(config.theme || 'dark');
  updateStatusBar('stopped');
  sbCtxName.textContent = activeCtx || '—';
  (await kubeAPI.getAppLogs()).forEach((e) => appendLog(e));
  await loadContexts();
  if (activeCtx && !effective(activeCtx).fqdn) autoDiscoverFqdn(activeCtx);
}

init().catch(console.error);
