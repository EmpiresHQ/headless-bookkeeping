import { Injectable, Logger } from '@nestjs/common';
import { AgentConfigService } from '../ai/agent-config.service';
import { OcrOutcome } from './document-transcriber.port';

/** One raster image to transcribe. */
export interface OcrImage {
  buffer: Buffer;
  mimeType: string;
}

const REQUEST_TIMEOUT_MS = 600_000;

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Transcribes a single image to markdown via an OpenAI-compatible vision
 * endpoint (LiteLLM proxying dots.ocr). Config (base URL, key, model) is reused
 * from the `ocr` agent profile — `ai_base_url`/`ai_api_key` + `ai_model.ocr`.
 * Not a DocumentTranscriber: the router calls this for image/* and for each
 * rasterised PDF page. Never throws — all faults become a typed OcrFailure.
 */
@Injectable()
export class LlmVisionTranscriber {
  private readonly logger = new Logger(LlmVisionTranscriber.name);

  constructor(private readonly config: AgentConfigService) {}

  async transcribeImage(image: OcrImage): Promise<OcrOutcome> {
    const model = await this.config.resolveModelConfig('ocr');
    if (typeof model === 'string') {
      // No ai_base_url configured → no endpoint to reach.
      this.logger.warn(
        'ai_base_url unset — OCR vision endpoint not configured',
      );
      return {
        ok: false,
        category: 'provider-unavailable',
        detail: 'OCR vision endpoint not configured (ai_base_url unset)',
      };
    }

    const instructions = await this.config.resolveInstructions('ocr');
    const b64 = image.buffer.toString('base64');
    const payload = {
      model: model.id,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instructions },
            {
              type: 'image_url',
              image_url: { url: `data:${image.mimeType};base64,${b64}` },
            },
          ],
        },
      ],
    };

    let response: Response;
    try {
      response = await fetch(`${model.url}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const timedOut = err.name === 'AbortError' || err.name === 'TimeoutError';
      const category = timedOut ? 'transient' : 'provider-unavailable';
      this.logger.warn(
        `OCR endpoint unreachable (${category}): ${err.message}`,
      );
      return { ok: false, category, detail: err.message };
    }

    if (!response.ok) {
      const category = response.status >= 500 ? 'transient' : 'unreadable';
      const detail = `OCR endpoint returned HTTP ${response.status}`;
      this.logger.warn(`${detail} (${category})`);
      return { ok: false, category, detail };
    }

    let body: ChatCompletionResponse;
    try {
      body = (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        ok: false,
        category: 'transient',
        detail: `OCR endpoint returned a non-JSON body: ${err.message}`,
      };
    }

    const markdown = body.choices?.[0]?.message?.content ?? '';
    if (markdown.trim().length === 0) {
      return {
        ok: false,
        category: 'unreadable',
        detail: 'OCR endpoint returned empty content',
      };
    }
    return { ok: true, markdown };
  }
}
