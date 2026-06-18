'use strict';

const {
  DEFAULT_CONFIG,
  normalizeConfig,
  getEffectiveClusterConfig
} = require('../src/config');

describe('DEFAULT_CONFIG', () => {
  test('has expected default service and namespace', () => {
    expect(DEFAULT_CONFIG.defaults.service).toBe('svc/tp-ingress-controller');
    expect(DEFAULT_CONFIG.defaults.namespace).toBe('tp-ingress-controller');
  });

  test('default ports are 443:443', () => {
    expect(DEFAULT_CONFIG.defaults.localPort).toBe(443);
    expect(DEFAULT_CONFIG.defaults.remotePort).toBe(443);
  });

  test('SSL errors ignored by default', () => {
    expect(DEFAULT_CONFIG.defaults.ignoreSSLErrors).toBe(true);
  });
});

describe('normalizeConfig()', () => {
  test('fills every missing default when passed an empty object', () => {
    const result = normalizeConfig({});
    expect(result.defaults.service).toBe(DEFAULT_CONFIG.defaults.service);
    expect(result.defaults.localPort).toBe(443);
    expect(result.clusters).toEqual({});
    expect(result.activeCluster).toBeNull();
  });

  test('keeps user-supplied defaults, only fills gaps', () => {
    const result = normalizeConfig({ defaults: { service: 'svc/my-svc' } });
    expect(result.defaults.service).toBe('svc/my-svc');
    expect(result.defaults.namespace).toBe(DEFAULT_CONFIG.defaults.namespace);
  });

  test('preserves activeCluster and clusters map', () => {
    const raw = {
      activeCluster: 'prod',
      clusters: { prod: { fqdn: 'prod.example.com' } }
    };
    const result = normalizeConfig(raw);
    expect(result.activeCluster).toBe('prod');
    expect(result.clusters.prod.fqdn).toBe('prod.example.com');
  });

  test('does not mutate the DEFAULT_CONFIG object', () => {
    normalizeConfig({ defaults: { service: 'svc/mutated' } });
    expect(DEFAULT_CONFIG.defaults.service).toBe('svc/tp-ingress-controller');
  });
});

describe('getEffectiveClusterConfig()', () => {
  const baseConfig = normalizeConfig({
    defaults: {
      service:   'svc/default-svc',
      namespace: 'default-ns',
      localPort:  443,
      remotePort: 443
    },
    clusters: {
      'prod-ctx': {
        service:   'svc/prod-svc',
        namespace: 'prod-ns',
        localPort:  8443
      }
    }
  });

  test('returns defaults for an unknown context', () => {
    const eff = getEffectiveClusterConfig(baseConfig, 'unknown-ctx');
    expect(eff.service).toBe('svc/default-svc');
    expect(eff.namespace).toBe('default-ns');
    expect(eff.localPort).toBe(443);
  });

  test('applies cluster override on top of defaults', () => {
    const eff = getEffectiveClusterConfig(baseConfig, 'prod-ctx');
    expect(eff.service).toBe('svc/prod-svc');
    expect(eff.namespace).toBe('prod-ns');
    expect(eff.localPort).toBe(8443);
    expect(eff.remotePort).toBe(443); // inherited from defaults
  });

  test('handles missing clusters map gracefully', () => {
    const cfg = normalizeConfig({ defaults: { service: 'svc/x' } });
    expect(() => getEffectiveClusterConfig(cfg, 'any')).not.toThrow();
  });

  test('does not mutate the config object', () => {
    const eff = getEffectiveClusterConfig(baseConfig, 'prod-ctx');
    eff.service = 'mutated';
    expect(baseConfig.clusters['prod-ctx'].service).toBe('svc/prod-svc');
  });
});
