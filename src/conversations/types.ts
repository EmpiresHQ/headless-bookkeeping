import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Conversation status: open → closed (ADR-0016/ADR-0018).
export type ConversationStatus = 'open' | 'closed';

// Message direction within a Conversation.
export type MessageDirection = 'inbound' | 'outbound';

// Artifact kind: inbound attachment (→ Document), outbound output, or OCR markdown.
export type ArtifactKind =
  | 'inbound_attachment'
  | 'outbound_output'
  | 'ocr_markdown';

// Channel for Conversation resolution.
export type ConversationChannel = 'telegram' | 'email' | 'slack' | 'api';

// Business object types that can be associated with a Conversation.
export type BusinessObjectType = 'expense' | 'sales_invoice';

// The durable, auditable thread of Messages on a single channel.
export interface Conversation {
  id: number;
  channel: ConversationChannel;
  thread_key: string;
  status: ConversationStatus;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

// One turn in a Conversation.
export interface Message {
  id: number;
  conversation_id: number;
  direction: MessageDirection;
  sender: string;
  body: string;
  threading_keys: string | null;
  dkim_spf_pass: boolean | null;
  created_at: number;
}

// A file bound to a Conversation.
export interface Artifact {
  id: number;
  conversation_id: number;
  kind: ArtifactKind;
  document_id: number | null;
  storage_path: string;
  crc32: number | null;
  created_at: number;
}

// Conversation with its Messages and Artifacts hydrated.
export interface ConversationWithDetails extends Conversation {
  messages: Message[];
  artifacts: Artifact[];
}

// Input for resolve(): deterministic lookup by channel + thread keys.
export const resolveSchema = z.object({
  channel: z.enum(['telegram', 'email', 'slack', 'api']),
  thread_key: z.string(),
  threading_keys: z.string().nullable().optional(),
});

export class ResolveInput extends createZodDto(resolveSchema) {}

// Input for appendMessage().
export const appendMessageSchema = z.object({
  conversation_id: z.number().int(),
  direction: z.enum(['inbound', 'outbound']),
  sender: z.string(),
  body: z.string(),
  threading_keys: z.string().nullable().optional(),
  dkim_spf_pass: z.boolean().nullable().optional(),
});

export class AppendMessageInput extends createZodDto(appendMessageSchema) {}

// Input for attachArtifact().
export const attachArtifactSchema = z.object({
  conversation_id: z.number().int(),
  kind: z.enum(['inbound_attachment', 'outbound_output', 'ocr_markdown']),
  storage_path: z.string(),
  document_id: z.number().int().nullable().optional(),
  crc32: z.number().nullable().optional(),
});

export class AttachArtifactInput extends createZodDto(attachArtifactSchema) {}

// Input for associate(): M:N link to a business object.
export const associateSchema = z.object({
  conversation_id: z.number().int(),
  object_type: z.enum(['expense', 'sales_invoice']),
  object_id: z.number().int(),
});

export class AssociateInput extends createZodDto(associateSchema) {}

// Input for associateDocument(): M:N link to a Document.
export const associateDocumentSchema = z.object({
  conversation_id: z.number().int(),
  document_id: z.number().int(),
});

export class AssociateDocumentInput extends createZodDto(
  associateDocumentSchema,
) {}
