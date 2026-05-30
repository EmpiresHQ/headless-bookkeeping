export type DocumentStatus = 'pending' | 'triaged' | 'processed' | 'error';

export type Channel = 'upload' | 'telegram' | 'email' | 'drive';

export interface Document {
  id: number;
  hash: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  status: DocumentStatus;
  created_at: number;
}

export interface DocumentSource {
  id: number;
  document_id: number;
  channel: Channel;
  source_identifier: string | null;
  received_at: number;
}

export interface DocumentWithSources extends Document {
  sources: DocumentSource[];
}

export interface UploadDocumentInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  channel: Channel;
  sourceIdentifier?: string | null;
}

export interface UploadDocumentResult {
  document: Document;
  deduplicated: boolean;
}
