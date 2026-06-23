export type MailboxChannel = 'email_sync' | 'email_push';

export interface ParsedAttachment {
  filename: string;
  contentType: string;          // MIME, lower-case
  size: number;                 // bytes
  disposition: 'attachment' | 'inline' | null;
  contentId: string | null;     // set for cid: inline parts
  content: Buffer;
}
