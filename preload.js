const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kubeAPI', {
  getConfig:          ()      => ipcRenderer.invoke('get-config'),
  saveConfig:         (cfg)   => ipcRenderer.invoke('save-config', cfg),
  getKubeContexts:    ()      => ipcRenderer.invoke('get-kube-contexts'),
  getCurrentCtx:      ()      => ipcRenderer.invoke('get-current-context'),
  getIngressHosts:    (ctx)   => ipcRenderer.invoke('get-ingress-hosts', ctx),
  startPortForward:   (ctx)   => ipcRenderer.invoke('start-port-forward', ctx),
  stopPortForward:    ()      => ipcRenderer.invoke('stop-port-forward'),
  navigateBrowser:    (url)   => ipcRenderer.invoke('navigate-browser', url),
  browserBack:        ()      => ipcRenderer.invoke('browser-back'),
  browserForward:     ()      => ipcRenderer.invoke('browser-forward'),
  browserReload:      ()      => ipcRenderer.invoke('browser-reload'),
  showBrowser:        (show)  => ipcRenderer.invoke('show-browser', show),
  toggleSettings:     (open)  => ipcRenderer.invoke('toggle-settings', open),
  openExternal:       (url)   => ipcRenderer.invoke('open-external', url),
  relaunchApp:        ()      => ipcRenderer.invoke('relaunch-app'),
  getPFStatus:        ()      => ipcRenderer.invoke('get-pf-status'),
  getAppVersion:      ()      => ipcRenderer.invoke('get-app-version'),
  getAppLogs:         ()      => ipcRenderer.invoke('get-app-logs'),
  browseKubeconfig:   ()      => ipcRenderer.invoke('browse-kubeconfig'),
  autoDetectIngress:  (ctx)   => ipcRenderer.invoke('auto-detect-ingress', ctx),

  onPFStatus:    (cb) => ipcRenderer.on('port-forward-status', (_e, d) => cb(d)),
  onBrowserNav:  (cb) => ipcRenderer.on('browser-navigated',   (_e, u) => cb(u)),
  onAppLog:      (cb) => ipcRenderer.on('app-log',             (_e, e) => cb(e)),
  onPFStats:     (cb) => ipcRenderer.on('pf-stats',            (_e, s) => cb(s)),
  onNetRequest:  (cb) => ipcRenderer.on('net-request',         (_e, r) => cb(r)),
  onPageLoaded:       (cb) => ipcRenderer.on('browser-page-loaded',  (_e)    => cb()),
  onPageError:        (cb) => ipcRenderer.on('browser-page-error',   (_e, e) => cb(e)),
  onKubeconfigChanged:(cb) => ipcRenderer.on('kubeconfig-changed',   ()      => cb())
});
