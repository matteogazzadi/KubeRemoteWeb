'use strict';

const { buildPortForwardArgs, normalizeConfig } = require('../src/config');

const cfg = normalizeConfig({
  defaults: {
    service:   'svc/tp-ingress-controller',
    namespace: 'tp-ingress-controller',
    localPort:  443,
    remotePort: 443
  },
  clusters: {
    'prod': {
      service:   'svc/custom-ingress',
      namespace: 'prod-ingress',
      localPort:  8443,
      remotePort: 443
    }
  }
});

describe('buildPortForwardArgs()', () => {
  test('includes port-forward subcommand as first arg', () => {
    const args = buildPortForwardArgs(cfg, 'dev');
    expect(args[0]).toBe('port-forward');
  });

  test('sets -n <namespace> for default context', () => {
    const args = buildPortForwardArgs(cfg, 'dev');
    const nIdx = args.indexOf('-n');
    expect(nIdx).toBeGreaterThan(-1);
    expect(args[nIdx + 1]).toBe('tp-ingress-controller');
  });

  test('includes correct service for default context', () => {
    const args = buildPortForwardArgs(cfg, 'dev');
    expect(args).toContain('svc/tp-ingress-controller');
  });

  test('produces localPort:remotePort string for default context', () => {
    const args = buildPortForwardArgs(cfg, 'dev');
    expect(args).toContain('443:443');
  });

  test('appends --context flag', () => {
    const args = buildPortForwardArgs(cfg, 'dev');
    expect(args).toContain('--context=dev');
  });

  test('uses cluster override values for prod context', () => {
    const args = buildPortForwardArgs(cfg, 'prod');
    expect(args).toContain('svc/custom-ingress');
    expect(args).toContain('prod-ingress');
    expect(args).toContain('8443:443');
    expect(args).toContain('--context=prod');
  });

  test('returns an array', () => {
    expect(Array.isArray(buildPortForwardArgs(cfg, 'dev'))).toBe(true);
  });
});
