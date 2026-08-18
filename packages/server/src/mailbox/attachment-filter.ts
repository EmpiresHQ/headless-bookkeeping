import { ParsedAttachment } from './types';

const DOC_MIME = /^(application\/pdf|image\/(jpeg|png|heic|heif|tiff|webp))$/;
const MIN_IMAGE_BYTES = 20_000; // drop logos / signatures / tiny images

export function isHarvestable(att: ParsedAttachment): boolean {
  const mime = att.contentType.toLowerCase();
  if (!DOC_MIME.test(mime)) return false; // only PDFs and photos
  // Drop embedded parts (logos, signatures): anything explicitly inline, plus
  // cid-bearing parts that were never marked as an attachment. An explicit
  // `attachment` disposition wins over the presence of a Content-ID — Gmail's
  // web UI stamps one on every attachment it sends, so keying off contentId
  // alone silently discarded every human-sent invoice.
  if (att.disposition === 'inline') return false;
  if (att.contentId && att.disposition !== 'attachment') return false;
  if (mime.startsWith('image/') && att.size < MIN_IMAGE_BYTES) return false; // tiny image
  return true;
}
