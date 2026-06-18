'use strict';

const DEFAULT_CONFIG = {
  activeCluster: null,
  defaults: {
    service:         'svc/tp-ingress-controller',
    namespace:       'tp-ingress-controller',
    localPort:       443,
    remotePort:      443,
    fqdn:            '',
    startUrl:        '',
    ignoreSSLErrors: true,
    useProxy:        false,
    proxyServer:     ''
  },
  clusters: {}
};

/** Merge raw JSON from disk with DEFAULT_CONFIG, filling in any missing keys. */
function normalizeConfig(raw) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    defaults: { ...DEFAULT_CONFIG.defaults, ...(raw.defaults || {}) },
    clusters: raw.clusters || {}
  };
}

/** Return the effective config for a context (defaults merged with per-cluster override). */
function getEffectiveClusterConfig(config, contextName) {
  const defaults = config.defaults || DEFAULT_CONFIG.defaults;
  const override = (config.clusters || {})[contextName] || {};
  return { ...defaults, ...override };
}

/** Build the kubectl port-forward argument array for a given context. */
function buildPortForwardArgs(config, contextName) {
  const cc = getEffectiveClusterConfig(config, contextName);
  return [
    'port-forward',
    '-n', cc.namespace,
    cc.service,
    `${cc.localPort}:${cc.remotePort}`,
    `--context=${contextName}`
  ];
}

/**
 * Return the Chromium --host-resolver-rules value for a context, or null if no
 * FQDN is configured.
 */
function buildHostResolverRules(config, contextName) {
  const cc = getEffectiveClusterConfig(config, contextName);
  return cc.fqdn ? `MAP ${cc.fqdn} 127.0.0.1` : null;
}

/**
 * Normalise a URL typed by the user: trim whitespace and prepend https:// when
 * no scheme is present.  Returns null for empty input.
 */
function normalizeUrl(raw) {
  const url = (raw || '').trim();
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig,
  getEffectiveClusterConfig,
  buildPortForwardArgs,
  buildHostResolverRules,
  normalizeUrl
};
