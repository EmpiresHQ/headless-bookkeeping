import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function keyBuf(keyHex: string): Buffer {
  const buf = Buffer.from(keyHex, 'hex');
  if (buf.length !== 32)
    throw new Error(
      'MAILBOX_SECRET_KEY must be a 32-byte hex string (64 hex chars)',
    );
  return buf;
}

export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf(keyHex), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(cipher: string, keyHex: string): string {
  const [ivB, tagB, ctB] = cipher.split('.');
  if (!ivB || !tagB || !ctB) throw new Error('malformed cipher');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyBuf(keyHex),
    Buffer.from(ivB, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
