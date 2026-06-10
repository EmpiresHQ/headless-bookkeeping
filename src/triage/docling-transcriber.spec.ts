import { DoclingTranscriber } from './docling-transcriber';
import { TranscribableFile } from './document-transcriber.port';

describe('DoclingTranscriber', () => {
  const file: TranscribableFile = {
    buffer: Buffer.from('%PDF-1.4 fake'),
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
  };
  const ENV = process.env.DOCLING_BASE_URL;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.DOCLING_BASE_URL = 'http://docling:5001';
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    if (ENV === undefined) delete process.env.DOCLING_BASE_URL;
    else process.env.DOCLING_BASE_URL = ENV;
    jest.restoreAllMocks();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  it('POSTs a multipart convert request and returns the markdown on success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        document: { md_content: '# Invoice\nAcme Ltd' },
        status: 'success',
        errors: [],
      }),
    );
    const out = await new DoclingTranscriber().transcribe(file);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.markdown).toBe('# Invoice\nAcme Ltd');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://docling:5001/v1/convert/file');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('to_formats')).toBe('md');
    expect(form.get('files')).toBeInstanceOf(Blob);
  });

  it('accepts partial_success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        document: { md_content: '# x' },
        status: 'partial_success',
        errors: [],
      }),
    );
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(true);
  });

  it('maps empty md_content to unreadable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        document: { md_content: '   ' },
        status: 'success',
        errors: [],
      }),
    );
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('maps status=failure to unreadable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        document: { md_content: '' },
        status: 'failure',
        errors: ['bad pdf'],
      }),
    );
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('maps HTTP 4xx to unreadable', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 422));
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('maps HTTP 5xx to transient', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('transient');
  });

  it('maps a connection error to provider-unavailable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('provider-unavailable');
  });

  it('maps a timeout (AbortError) to transient', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValue(abort);
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('transient');
  });

  it('maps a missing DOCLING_BASE_URL to provider-unavailable without calling fetch', async () => {
    delete process.env.DOCLING_BASE_URL;
    const out = await new DoclingTranscriber().transcribe(file);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('provider-unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
