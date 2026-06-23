import { ParsedAttachment } from './types';

const DOC_MIME = /^(application\/pdf|image\/(jpeg|png|heic|heif|tiff|webp))$/;
const MIN_IMAGE_BYTES = 20_000; // drop logos / signatures / tiny images

export function isHarvestable(att: ParsedAttachment): boolean {
  const mime = att.contentType.toLowerCase();
  if (!DOC_MIME.test(mime)) return false;        // only PDFs and photos
  if (att.disposition === 'inline' || att.contentId) return false; // cid logos/signatures
  if (mime.startsWith('image/') && att.size < MIN_IMAGE_BYTES) return false; // tiny image
  return true;
}
