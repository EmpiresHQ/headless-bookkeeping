import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { relativeTime } from './relativeTime';

describe('relativeTime', () => {
  const NOW = 1_700_000_000; // fixed epoch for deterministic tests

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns seconds ago for diff < 60s', () => {
    expect(relativeTime(NOW - 30)).toBe('30s ago');
  });

  it('returns minutes ago for diff < 1h', () => {
    expect(relativeTime(NOW - 90)).toBe('1m ago');
    expect(relativeTime(NOW - 3599)).toBe('59m ago');
  });

  it('returns hours ago for diff < 24h', () => {
    expect(relativeTime(NOW - 3600)).toBe('1h ago');
    expect(relativeTime(NOW - 7200)).toBe('2h ago');
  });

  it('returns days ago for diff < 30d', () => {
    expect(relativeTime(NOW - 86400)).toBe('1d ago');
    expect(relativeTime(NOW - 86400 * 7)).toBe('7d ago');
  });

  it('returns months ago for diff < 365d', () => {
    expect(relativeTime(NOW - 86400 * 30)).toBe('1mo ago');
    expect(relativeTime(NOW - 86400 * 60)).toBe('2mo ago');
  });

  it('returns years ago for diff >= 365d', () => {
    expect(relativeTime(NOW - 86400 * 365)).toBe('1y ago');
    expect(relativeTime(NOW - 86400 * 730)).toBe('2y ago');
  });
});
