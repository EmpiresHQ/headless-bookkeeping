import { isHarvestable } from './attachment-filter';
import { ParsedAttachment } from './types';

const base: ParsedAttachment = {
  filename: 'invoice.pdf',
  contentType: 'application/pdf',
  size: 50_000,
  disposition: 'attachment',
  contentId: null,
  content: Buffer.alloc(50_000),
};

describe('isHarvestable', () => {
  it('accepts a real PDF attachment', () => {
    expect(isHarvestable(base)).toBe(true);
  });
  it('accepts a real photo attachment', () => {
    expect(
      isHarvestable({
        ...base,
        filename: 'receipt.jpg',
        contentType: 'image/jpeg',
      }),
    ).toBe(true);
  });
  it('rejects an inline cid image (email signature/logo)', () => {
    expect(
      isHarvestable({
        ...base,
        filename: 'logo.png',
        contentType: 'image/png',
        disposition: 'inline',
        contentId: '<logo@x>',
      }),
    ).toBe(false);
  });
  it('rejects a tiny image (< 20 KB)', () => {
    expect(
      isHarvestable({
        ...base,
        filename: 'sig.png',
        contentType: 'image/png',
        size: 4_000,
        content: Buffer.alloc(4_000),
      }),
    ).toBe(false);
  });
  it('rejects a calendar invite', () => {
    expect(
      isHarvestable({
        ...base,
        filename: 'meeting.ics',
        contentType: 'text/calendar',
      }),
    ).toBe(false);
  });
  it('rejects a vcard', () => {
    expect(
      isHarvestable({
        ...base,
        filename: 'card.vcf',
        contentType: 'text/vcard',
      }),
    ).toBe(false);
  });
  it('keeps a large PDF even if disposition header is missing', () => {
    expect(isHarvestable({ ...base, disposition: null })).toBe(true);
  });
  it('rejects a large PDF if disposition is inline', () => {
    expect(
      isHarvestable({ ...base, disposition: 'inline', contentId: null }),
    ).toBe(false);
  });
  // Gmail stamps a Content-ID (<f_xxxxxxxx>) on EVERY attachment sent from the
  // web UI, including ordinary ones. Rejecting on contentId alone silently drops
  // every human-sent invoice while automated senders (which omit it) get through.
  it('accepts a PDF attachment that also carries a contentId (Gmail web)', () => {
    expect(
      isHarvestable({
        ...base,
        disposition: 'attachment',
        contentId: '<f_mrem2ni90>',
      }),
    ).toBe(true);
  });
  it('rejects a cid part with no disposition (embedded logo)', () => {
    expect(
      isHarvestable({
        ...base,
        filename: 'logo.png',
        contentType: 'image/png',
        disposition: null,
        contentId: '<logo@example.com>',
      }),
    ).toBe(false);
  });
});
