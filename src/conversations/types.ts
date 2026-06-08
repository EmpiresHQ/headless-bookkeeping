// Conversation status: open → closed (ADR-0016/ADR-0018).
export type ConversationStatus = 'open' | 'closed';

// Message direction within a Conversation.
export type MessageDirection = 'inbound' | 'outbound';

// Artifact kind: inbound attachment (→ Document), outbound output, or OCR markdown.
export type ArtifactKind = 'inbound_attachment' | 'outbound_output' | 'ocr_markdown';

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
  created_at: number;
}

// Conversation with its Messages and Artifacts hydrated.
export interface ConversationWithDetails extends Conversation {
  messages: Message[];
  artifacts: Artifact[];
}

// Input for resolve(): deterministic lookup by channel + thread keys.
export interface ResolveInput {
  channel: ConversationChannel;
  thread_key: string;
  threading_keys?: string | null;
}

// Input for appendMessage().
export interface AppendMessageInput {
  conversation_id: number;
  direction: MessageDirection;
  sender: string;
  body: string;
  threading_keys?: string | null;
  dkim_spf_pass?: boolean | null;
}

// Input for attachArtifact().
export interface AttachArtifactInput {
  conversation_id: number;
  kind: ArtifactKind;
  storage_path: string;
  document_id?: number | null;
}

// Input for associate(): M:N link to a business object.
export interface AssociateInput {
  conversation_id: number;
  object_type: BusinessObjectType;
  object_id: number;
}

// Input for associateDocument(): M:N link to a Document.
export interface AssociateDocumentInput {
  conversation_id: number;
  document_id: number;
}
