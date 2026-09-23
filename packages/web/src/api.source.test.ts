import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, SessionChangedError, setToken } from './auth';
import { fetchDocumentFile, fetchDocumentPreviewBlob } from './api';

/** A response whose body read settles only when the test says so — the
 *  session can end between the headers and the bytes. */
function lateBodyResponse(type: string, headers: Record<string, string> = {}) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const res = new Response('bytes', {
    status: 200,
    headers: { 'content-type': type, ...headers },
  });
  const blob = res.blob.bind(res);
  res.blob = async () => {
    await gate;
    return blob();
  };
  return { res, release };
}

describe('document source reads (issue #257)', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('fetchDocumentFile reads /file with the Bearer token, keeps the MIME type and filename', async () => {
    const { res, release } = lateBodyResponse('application/pdf', {
      'content-disposition': 'attachment; filename="scan 5p.pdf"',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    release();
    const file = await fetchDocumentFile(9);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/documents/9/file');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok');
    expect(file.blob.type).toBe('application/pdf');
    expect(file.filename).toBe('scan 5p.pdf');
  });

  it.each([
    ['fetchDocumentFile', () => fetchDocumentFile(9)],
    [
      'fetchDocumentPreviewBlob',
      () => fetchDocumentPreviewBlob(9, { size: 'lg' }),
    ],
  ])(
    '%s: bytes that arrive after the session ended are refused',
    async (_name, read) => {
      const { res, release } = lateBodyResponse('image/png');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
      const pending = read().catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 0)); // headers are in
      clearToken();
      setToken('next-session');
      release();
      expect(await pending).toBeInstanceOf(SessionChangedError);
    },
  );
});
