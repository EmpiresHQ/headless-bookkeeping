import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ExpenseDocumentAttachService,
  type AttachableDocument,
  type AttachDocumentResult,
} from './expense-document-attach.service';
import {
  attachableDocumentsResponseSchema,
  attachDocumentResponseSchema,
} from '../openapi-response-schemas';

/** A positive safe integer from a path segment. */
function parseIdText(raw: string, what: string): number {
  const n = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n)) {
    throw new BadRequestException(`${what} must be a positive integer`);
  }
  return n;
}

/**
 * `document_id` exactly as the contract declares it: a JSON integer. Strings
 * (a multipart text field, "44"), arrays, booleans, objects and fractions are
 * refused, never coerced — a multipart request carries only the file part.
 */
function parseDocumentId(raw: unknown): number {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return raw;
  }
  throw new BadRequestException(
    'document_id must be a positive integer sent as JSON',
  );
}

/**
 * Late source documents for an existing expense (issue #248): the receipt
 * that arrives after the expense was entered from a bank line.
 */
@ApiTags('expenses')
@Controller('api/expenses')
export class ExpenseDocumentsController {
  constructor(private readonly attach: ExpenseDocumentAttachService) {}

  @Get(':id/attachable-documents')
  @ApiOperation({
    summary: 'List documents that can be attached to an expense',
    description:
      'Documents that may become this expense’s source right now: idle pending ' +
      'or needs_triage documents with no expense, sales invoice, allowance or ' +
      'filed-receipt use and no claimant. Empty when the expense already has a ' +
      'source. Advisory — the attach re-checks the same rule.',
  })
  @ApiParam({ name: 'id', description: 'Expense id' })
  @ApiOkResponse({ schema: attachableDocumentsResponseSchema })
  async listAttachable(
    @Param('id') id: string,
  ): Promise<{ documents: AttachableDocument[] }> {
    return {
      documents: await this.attach.listAttachable(parseIdText(id, 'id')),
    };
  }

  @Post(':id/attach-document')
  @ApiOperation({
    summary: 'Attach a source document to an existing expense',
    description:
      'Send EXACTLY ONE of: multipart/form-data `file` (a new receipt, stored ' +
      'and attached in one step — never queued for intake), or ' +
      'application/json `{"document_id": <int>}` (an existing document from ' +
      'attachable-documents). Fills an empty source only: the expense keeps ' +
      'its id, amounts, status and voucher; no ledger, VAT or period change, ' +
      'so posted/reversed expenses and locked periods are allowed. ' +
      'outcome=already_attached on an idempotent retry. 400 when both or ' +
      'neither is sent or an id is not a positive integer; 409 when the ' +
      'expense already has a source, or the document is in use or being ' +
      'processed.',
    // Declared per media type (ApiBody would give every type one schema):
    // multipart carries only the file part, JSON only document_id.
    requestBody: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            required: ['file'],
            additionalProperties: false,
            properties: {
              file: {
                type: 'string',
                format: 'binary',
                description: 'The late receipt to store and attach',
              },
            },
          },
        },
        'application/json': {
          schema: {
            type: 'object',
            required: ['document_id'],
            additionalProperties: false,
            properties: {
              document_id: {
                type: 'integer',
                minimum: 1,
                description: 'An existing document to attach',
              },
            },
          },
        },
      },
    },
  })
  @ApiParam({ name: 'id', description: 'Expense id' })
  @ApiOkResponse({ schema: attachDocumentResponseSchema })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @HttpCode(HttpStatus.OK)
  async attachDocument(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ): Promise<AttachDocumentResult> {
    const expenseId = parseIdText(id, 'id');
    // The contract is closed (additionalProperties: false): the multipart
    // variant carries only the file part, the JSON variant only document_id.
    const fields: Record<string, unknown> =
      body === undefined || body === null
        ? {}
        : typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : { '(body)': body };
    const extra = Object.keys(fields).filter((k) => k !== 'document_id');
    if (extra.length > 0) {
      throw new BadRequestException(
        `Unexpected field(s): ${extra.join(', ')} — send only a multipart file or {"document_id": <int>}`,
      );
    }
    const raw = fields.document_id;
    const hasDocumentId = 'document_id' in fields;
    if ((file !== undefined) === hasDocumentId) {
      throw new BadRequestException(
        'Send exactly one of a multipart file or a document_id',
      );
    }
    if (file !== undefined) {
      return this.attach.attachNewFile(expenseId, {
        buffer: file.buffer,
        filename: file.originalname,
        mimeType: file.mimetype,
      });
    }
    return this.attach.attachExisting(expenseId, parseDocumentId(raw));
  }
}
