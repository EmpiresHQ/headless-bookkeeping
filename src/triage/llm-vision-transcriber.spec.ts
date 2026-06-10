import { LlmVisionTranscriber } from './llm-vision-transcriber';
import { AgentConfigService } from '../ai/agent-config.service';

describe('LlmVisionTranscriber', () => {
  const image = { buffer: Buffer.from('PNGDATA'), mimeType: 'image/png' };
  let fetchMock: jest.Mock;

  function withConfig(cfg: unknown): AgentConfigService {
    return {
      resolveModelConfig: () => Promise.resolve(cfg),
      resolveInstructions: () =>
        Promise.resolve('Transcribe this document to markdown.'),
    } as unknown as AgentConfigService;
  }
  function chatResponse(content: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => jest.restoreAllMocks());

  it('POSTs a vision chat request and returns the message content', async () => {
    fetchMock.mockResolvedValue(chatResponse('# Receipt\nBolt €15.25'));
    const t = new LlmVisionTranscriber(
      withConfig({
        id: 'rednote/dots.ocr',
        url: 'http://litellm:4000/v1',
        apiKey: 'k',
      }),
    );
    const out = await t.transcribeImage(image);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.markdown).toBe('# Receipt\nBolt €15.25');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://litellm:4000/v1/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer k',
    );
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: {
        content: { type: string; image_url?: { url: string } }[];
      }[];
    };
    expect(body.model).toBe('rednote/dots.ocr');
    const parts = body.messages[0].content;
    expect(parts.find((p) => p.type === 'text')).toBeDefined();
    const img = parts.find((p) => p.type === 'image_url');
    expect(img?.image_url?.url).toBe(
      `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`,
    );
  });

  it('maps a bare-string model config (no base url) to provider-unavailable', async () => {
    const t = new LlmVisionTranscriber(withConfig('openai/gpt-4o-mini'));
    const out = await t.transcribeImage(image);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('provider-unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps empty content to unreadable', async () => {
    fetchMock.mockResolvedValue(chatResponse('   '));
    const t = new LlmVisionTranscriber(
      withConfig({ id: 'm/x', url: 'http://h/v1', apiKey: 'k' }),
    );
    const out = await t.transcribeImage(image);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('maps HTTP 5xx to transient and 4xx to unreadable', async () => {
    const t = new LlmVisionTranscriber(
      withConfig({ id: 'm/x', url: 'http://h/v1', apiKey: 'k' }),
    );
    fetchMock.mockResolvedValue(chatResponse(null, 503));
    expect(
      ((await t.transcribeImage(image)) as { category: string }).category,
    ).toBe('transient');
    fetchMock.mockResolvedValue(chatResponse(null, 400));
    expect(
      ((await t.transcribeImage(image)) as { category: string }).category,
    ).toBe('unreadable');
  });

  it('maps a connection error to provider-unavailable and a timeout to transient', async () => {
    const t = new LlmVisionTranscriber(
      withConfig({ id: 'm/x', url: 'http://h/v1', apiKey: 'k' }),
    );
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(
      ((await t.transcribeImage(image)) as { category: string }).category,
    ).toBe('provider-unavailable');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValue(abort);
    expect(
      ((await t.transcribeImage(image)) as { category: string }).category,
    ).toBe('transient');
  });
});
