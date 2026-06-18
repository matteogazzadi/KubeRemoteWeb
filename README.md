# KubeRemoteWeb

Desktop application that establishes a Kubernetes port-forward and opens an embedded Chromium browser pointed at the forwarded service — no DNS changes or hosts-file edits required.

## How it works

1. **Port-forward** — spawns `kubectl port-forward` for the configured service/namespace/ports of the selected cluster context.
2. **Host mapping** — uses Chromium's `--host-resolver-rules` to map the cluster FQDN → `127.0.0.1`, so the embedded browser resolves the hostname through the port-forward tunnel while keeping the correct TLS SNI.
3. **Embedded browser** — a `BrowserView` renders the remote web application without leaving the app.

## Requirements

- [Node.js](https://nodejs.org/) ≥ 18
- `kubectl` on your PATH and configured with the relevant cluster contexts

## Quick start

```bash
npm install
npm start
```

## Build distributable

```bash
npm run build:win    # Windows NSIS installer (.exe)
npm run build:mac    # macOS DMG (.dmg)
npm run build:linux  # Linux AppImage (.AppImage)
```

## Configuration

Config is stored at `~/.kuberemoteweb/config.json` (created automatically on first run).

```jsonc
{
  "activeCluster": "my-context",
  "defaults": {
    "service":         "svc/tp-ingress-controller",
    "namespace":       "tp-ingress-controller",
    "localPort":       443,
    "remotePort":      443,
    "fqdn":            "",
    "startUrl":        "",
    "ignoreSSLErrors": true,
    "useProxy":        false,
    "proxyServer":     ""
  },
  "clusters": {
    "my-context": {
      // any field here overrides the defaults for this context only
      "fqdn":     "tp-onprem-k3s-roma-cc-14",
      "startUrl": "https://tp-onprem-k3s-roma-cc-14/web-app"
    }
  }
}
```

### Per-cluster settings

Edit via the **⚙ Settings** panel inside the app.
Changes to FQDN, SSL, or proxy require **Save & Restart** to take effect (those are Chromium command-line switches set at startup).

### FQDN auto-discovery

Click **Discover** inside the settings panel to query `kubectl get ingress -A` on the selected context and populate the FQDN automatically.

## Releasing

Every PR merged into `main` automatically:
1. Bumps the SemVer patch version (or minor/major via PR labels `bump:minor` / `bump:major`)
2. Pushes a new git tag
3. Triggers the release workflow → builds Win/Mac/Linux installers → publishes a GitHub Release

## Architecture notes

| Concern | Solution |
|---|---|
| FQDN→127.0.0.1 mapping | `app.commandLine.appendSwitch('host-resolver-rules', 'MAP fqdn 127.0.0.1')` set before `app.ready` |
| SSL cert errors on tunnel | `certificate-error` event handler on the BrowserView |
| Per-cluster host rules | App relaunches (`app.relaunch()`) when cluster/FQDN changes so new switches take effect |
| Proxy toggle | `--proxy-server` / `--no-proxy-server` switches applied at startup from saved config |
