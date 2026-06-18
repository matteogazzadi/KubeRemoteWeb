# KubeRemoteWeb

A Windows desktop application that connects to a Kubernetes cluster over a secure port-forward tunnel and opens the cluster's web interface in a built-in browser — no VPN, no DNS changes, no hosts-file edits required.

---

## Installation on Windows

1. Go to the [**Releases**](https://github.com/matteogazzadi/KubeRemoteWeb/releases) page.
2. Download the latest `KubeRemoteWeb-Setup-x.x.x.exe` file.
3. Run the installer and follow the on-screen steps.
4. Launch **KubeRemoteWeb** from the Start Menu or Desktop shortcut.

> **Requirement:** `kubectl` must be installed and on your PATH, and your kubeconfig (`~/.kube/config`) must already be set up with the cluster contexts you want to use.  
> Download kubectl: https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/

---

## How to use

### 1. Select a cluster

Use the **Cluster** dropdown at the top to pick a Kubernetes context (pulled directly from your kubeconfig).  
When you switch to a context that has no FQDN configured, the app will automatically try to discover the hostname from the cluster's Ingress resources.

### 2. Configure settings (first time)

Click the **⚙ Settings** button (top right) to open the settings panel.

| Field | Description |
|---|---|
| **Service** | The Kubernetes service to port-forward to (e.g. `svc/tp-ingress-controller`) |
| **Namespace** | The namespace of that service (e.g. `tp-ingress-controller`) |
| **Local port** | Port on your machine (default `443`) |
| **Remote port** | Port on the remote service (default `443`) |
| **FQDN** | The hostname the cluster's web app uses (e.g. `my-cluster.example.com`). Click **Discover** to detect automatically from Ingress. |
| **Start URL** | The URL to open when the connection is established (e.g. `https://my-cluster.example.com/web-app`) |
| **Ignore SSL errors** | Enable if the cluster uses a self-signed certificate |
| **Proxy** | Optional HTTP proxy for corporate networks |

After changing FQDN, SSL, or proxy settings, click **Save & Restart** for them to take effect. Other changes only need **Save**.

Global defaults at the bottom of the panel apply to all clusters that don't have a specific override.

### 3. Start the connection

Click **▶ Start**.  
The app spawns a `kubectl port-forward` in the background. A spinning **Connecting…** animation appears while the tunnel is being established. Once ready, the embedded browser opens automatically at the configured Start URL.

### 4. Browse

Use the address bar and navigation buttons (Back, Forward, Reload) exactly like a regular browser.  
The ↗ button opens the current URL in your default system browser.

### 5. Stop the connection

Click **■ Stop** to terminate the port-forward and close the browser view.

---

## Status bar

The bar at the bottom of the window shows live connection information:

| Indicator | Meaning |
|---|---|
| Coloured dot + text | Port-forward state: Stopped / Starting / Running / Error |
| ⏱ timer | How long the current connection has been active |
| ↓ speed | Live download bandwidth through the tunnel |
| · total | Total data downloaded in this session |
| Context | The currently active Kubernetes context |

---

## Debug logs

Click the **☰** button (top right, next to Settings) to open the **Debug Logs** panel.  
It shows a live, timestamped log of:

- `kubectl port-forward` command and output
- Port-forward status transitions
- Ingress discovery results
- Any errors from `kubectl`

Use **Clear** to reset the log. The panel can be closed with **✕** or by clicking **☰** again.

---

## Light / Dark theme

Click the **☀** button in the toolbar to switch to light theme. Click **☾** to switch back to dark.  
The preference is saved automatically.

---

## Configuration file

Settings are stored at `%USERPROFILE%\.kuberemoteweb\config.json` on Windows.  
The file is created automatically on first run and is edited through the in-app Settings panel.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "no contexts found" in the dropdown | Check that `kubectl config get-contexts` works in a terminal. Ensure `~/.kube/config` exists. |
| Connection stays in "Starting" | Open Debug Logs to see the kubectl output. The service name or namespace may be wrong. |
| Browser shows certificate error | Enable **Ignore SSL certificate errors** in Settings and click **Save & Restart**. |
| FQDN not auto-detected | The cluster may have no Ingress resources. Enter the FQDN manually in Settings. |
| App opens but browser is blank | Ensure the port-forward is running (status bar shows green "Running") then click **Reload**. |
