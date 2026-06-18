'use strict';

const { buildHostResolverRules, normalizeConfig } = require('../src/config');

describe('buildHostResolverRules()', () => {
  test('returns null when no FQDN configured', () => {
    const cfg = normalizeConfig({});
    expect(buildHostResolverRules(cfg, 'ctx')).toBeNull();
  });

  test('returns MAP rule for default fqdn', () => {
    const cfg = normalizeConfig({ defaults: { fqdn: 'my-cluster.example.com' } });
    expect(buildHostResolverRules(cfg, 'ctx')).toBe('MAP my-cluster.example.com 127.0.0.1');
  });

  test('returns MAP rule for cluster-specific fqdn', () => {
    const cfg = normalizeConfig({
      clusters: { 'prod': { fqdn: 'prod.k8s.internal' } }
    });
    expect(buildHostResolverRules(cfg, 'prod')).toBe('MAP prod.k8s.internal 127.0.0.1');
  });

  test('cluster fqdn takes precedence over default fqdn', () => {
    const cfg = normalizeConfig({
      defaults:  { fqdn: 'default.example.com' },
      clusters:  { 'prod': { fqdn: 'prod.example.com' } }
    });
    expect(buildHostResolverRules(cfg, 'prod')).toBe('MAP prod.example.com 127.0.0.1');
    expect(buildHostResolverRules(cfg, 'dev')).toBe('MAP default.example.com 127.0.0.1');
  });

  test('returns null when cluster overrides fqdn to empty string', () => {
    const cfg = normalizeConfig({
      defaults: { fqdn: 'default.example.com' },
      clusters: { 'prod': { fqdn: '' } }
    });
    expect(buildHostResolverRules(cfg, 'prod')).toBeNull();
  });
});
