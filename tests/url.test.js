'use strict';

const { normalizeUrl } = require('../src/config');

describe('normalizeUrl()', () => {
  test('returns null for empty string', () => {
    expect(normalizeUrl('')).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    expect(normalizeUrl('   ')).toBeNull();
  });

  test('returns null for null/undefined', () => {
    expect(normalizeUrl(null)).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
  });

  test('prepends https:// when no scheme present', () => {
    expect(normalizeUrl('my-cluster.example.com')).toBe('https://my-cluster.example.com');
  });

  test('prepends https:// to a path-only URL', () => {
    expect(normalizeUrl('my-cluster.example.com/web-app')).toBe('https://my-cluster.example.com/web-app');
  });

  test('keeps existing https:// scheme', () => {
    expect(normalizeUrl('https://my-cluster.example.com')).toBe('https://my-cluster.example.com');
  });

  test('keeps existing http:// scheme', () => {
    expect(normalizeUrl('http://my-cluster.example.com')).toBe('http://my-cluster.example.com');
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeUrl('  https://my-cluster.example.com  ')).toBe('https://my-cluster.example.com');
  });

  test('is case-insensitive for scheme detection', () => {
    expect(normalizeUrl('HTTPS://my-cluster.example.com')).toBe('HTTPS://my-cluster.example.com');
  });
});
