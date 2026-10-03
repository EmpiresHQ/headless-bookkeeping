import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getToken,
  HttpError,
  isCurrentUnauthorized,
  setToken,
  UnauthorizedError,
} from './auth';
import { openSignedDocument, PopupBlockedError } from './api';

/** A placeholder tab window.open hands back: records where it was sent. */
function fakeTab({ setterThrows = false } = {}) {
  const tab = {
    closed: false,
    navigatedTo: null as string | null,
    close: vi.fn(() => {
      tab.closed = true;
    }),
    location: {} as { href: string },
  };
  Object.defineProperty(tab.location, 'href', {
    set(url: string) {
      if (setterThrows) throw new Error('navigation refused');
      tab.navigatedTo = url;
    },
  });
  return tab;
}

/** A fetch whose answer the test releases. */
function heldFetch() {
  let answer!: (res: Response) => void;
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => new Promise<Response>((r) => (answer = r)));
  return { fetchMock, answer: (res: Response) => answer(res) };
}

const signed = () =>
  new Response(JSON.stringify({ url: '/api/documents/7/shared?t=x' }), {
    status: 200,
  });

describe('openSignedDocument (issue #272)', () => {
  let hrefBefore: string;
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
    hrefBefore = window.location.href;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // The current window is never navigated on any path.
    expect(window.location.href).toBe(hrefBefore);
  });

  it('opens the placeholder synchronously, then points it at the signed URL', async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as never);
    const { fetchMock, answer } = heldFetch();
    const p = openSignedDocument(7);
    // Before any await: still inside the click's user activation.
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/documents/7/signed-url');
    answer(signed());
    expect(await p).toBe('opened');
    expect(tab.navigatedTo).toBe('/api/documents/7/shared?t=x');
    expect(tab.close).not.toHaveBeenCalled();
  });

  it('a blocked popup rejects without signing anything or navigating this window', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(openSignedDocument(7)).rejects.toBeInstanceOf(
      PopupBlockedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a signing failure closes the placeholder and rethrows', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"Signing fixture failed"}', { status: 503 }),
    );
    await expect(openSignedDocument(7)).rejects.toBeInstanceOf(HttpError);
    expect(tab.close).toHaveBeenCalled();
    expect(tab.navigatedTo).toBeNull();
  });

  it('a current 401 closes the placeholder and surfaces the current UnauthorizedError', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 401 }),
    );
    const e = await openSignedDocument(7).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(UnauthorizedError);
    expect(isCurrentUnauthorized(e)).toBe(true);
    expect(getToken()).toBeNull();
    expect(tab.close).toHaveBeenCalled();
  });

  it('a navigation that throws still closes the placeholder', async () => {
    const tab = fakeTab({ setterThrows: true });
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(signed());
    await expect(openSignedDocument(7)).rejects.toThrow('navigation refused');
    expect(tab.close).toHaveBeenCalled();
  });

  it('abort closes the placeholder at once, without waiting for the network, and drops the link', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    const { answer } = heldFetch();
    const scope = new AbortController();
    const p = openSignedDocument(7, { signal: scope.signal });
    scope.abort();
    expect(tab.close).toHaveBeenCalledTimes(1); // response still held
    answer(signed());
    expect(await p).toBe('abandoned');
    expect(tab.navigatedTo).toBeNull();
  });

  it('a scope that is no longer current is not navigated', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(signed());
    expect(await openSignedDocument(7, { isCurrent: () => false })).toBe(
      'abandoned',
    );
    expect(tab.close).toHaveBeenCalled();
    expect(tab.navigatedTo).toBeNull();
  });

  it('a placeholder the user closed meanwhile is left alone', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    const { answer } = heldFetch();
    const p = openSignedDocument(7);
    tab.closed = true; // the user closed the blank tab
    answer(signed());
    expect(await p).toBe('abandoned');
    expect(tab.navigatedTo).toBeNull();
  });
});
