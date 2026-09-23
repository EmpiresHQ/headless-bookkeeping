import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_ID_KEY, TOKEN_KEY, clearToken, setToken } from '../auth';
import {
  IMPORT_JOB_KEY,
  clearImportPointer,
  parseJobId,
  readImportPointer,
  watchImportPointerSession,
  writeImportPointer,
} from './importResume';

describe('import resume pointer (#254)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('parses only positive safe integers', () => {
    expect(parseJobId('41')).toBe(41);
    expect(parseJobId(41)).toBe(41);
    for (const bad of [
      '',
      '0',
      '-1',
      '4.1',
      '041',
      'abc',
      '1e3',
      ' 41',
      '99999999999999999999',
      0,
      -3,
      1.5,
      null,
    ]) {
      expect(parseJobId(bad)).toBeNull();
    }
  });

  it('round-trips a job id without storing anything token-derived', () => {
    writeImportPointer(41);
    expect(readImportPointer()).toBe(41);
    const stored = sessionStorage.getItem(IMPORT_JOB_KEY) ?? '';
    expect(stored).not.toContain('tok');
  });

  it('is void after sign-out, a new sign-in here, or another tab’s sign-in', () => {
    writeImportPointer(41);
    clearToken();
    expect(readImportPointer()).toBeNull();
    expect(sessionStorage.getItem(IMPORT_JOB_KEY)).toBeNull();

    setToken('tok');
    writeImportPointer(42);
    setToken('tok'); // same token, new sign-in
    expect(readImportPointer()).toBeNull();

    writeImportPointer(43);
    // Another tab signed in: the shared session id changed underneath.
    localStorage.setItem(SESSION_ID_KEY, 'other-tab-session');
    localStorage.setItem(TOKEN_KEY, 'other');
    expect(readImportPointer()).toBeNull();
  });

  it('drops malformed or foreign entries', () => {
    for (const raw of ['nope', '{}', '{"jobId":"x","session":"s"}', '41']) {
      sessionStorage.setItem(IMPORT_JOB_KEY, raw);
      expect(readImportPointer()).toBeNull();
      expect(sessionStorage.getItem(IMPORT_JOB_KEY)).toBeNull();
    }
  });

  it('clearing for an older job keeps a newer job’s pointer', () => {
    writeImportPointer(42);
    clearImportPointer(41);
    expect(readImportPointer()).toBe(42);
    clearImportPointer(42);
    expect(readImportPointer()).toBeNull();
  });

  it('another tab changing the token, the session id or clearing storage voids it', () => {
    const stop = watchImportPointerSession();
    for (const key of [TOKEN_KEY, SESSION_ID_KEY, null]) {
      writeImportPointer(41);
      window.dispatchEvent(new StorageEvent('storage', { key }));
      expect(sessionStorage.getItem(IMPORT_JOB_KEY)).toBeNull();
    }
    writeImportPointer(41);
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    expect(readImportPointer()).toBe(41);
    stop();
    window.dispatchEvent(new StorageEvent('storage', { key: TOKEN_KEY }));
    expect(readImportPointer()).toBe(41);
  });

  it('never throws when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    vi.stubGlobal('sessionStorage', broken);
    expect(() => writeImportPointer(41)).not.toThrow();
    expect(readImportPointer()).toBeNull();
    expect(() => clearImportPointer()).not.toThrow();
    expect(() => clearImportPointer(41)).not.toThrow();
  });
});
