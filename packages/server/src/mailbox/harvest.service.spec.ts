import { HarvestService } from './harvest.service';
import { FetchedMessage } from './imap-client.port';

const pdf = (name: string, size = 50_000) => ({
  filename: name, contentType: 'application/pdf', size, disposition: 'attachment' as const, contentId: null, content: Buffer.alloc(size),
});

describe('HarvestService', () => {
  let documents: { upload: jest.Mock };
  let queue: { kick: jest.Mock };
  let service: HarvestService;

  beforeEach(() => {
    documents = { upload: jest.fn().mockResolvedValue({ document: { id: 1 }, deduplicated: false }) };
    queue = { kick: jest.fn().mockResolvedValue(undefined) };
    service = new HarvestService(documents as any, queue as any);
  });

  it('uploads each harvestable attachment with the connector channel and kicks once', async () => {
    const msg: FetchedMessage = { uid: 5, subject: 'Invoice 7', bodyText: 'see attached',
      attachments: [pdf('invoice.pdf'), pdf('terms.pdf')] };
    const n = await service.harvestMessage('email_sync', msg);
    expect(n).toBe(2);
    expect(documents.upload).toHaveBeenCalledTimes(2);
    expect(documents.upload.mock.calls[0][0]).toMatchObject({ channel: 'email_sync', filename: 'invoice.pdf', sourceIdentifier: 'uid:5' });
    expect(queue.kick).toHaveBeenCalledTimes(1);
  });

  it('skips non-harvestable attachments and does not kick when nothing harvested', async () => {
    const msg: FetchedMessage = { uid: 6, subject: 'hi', bodyText: 'logo only',
      attachments: [{ filename: 'logo.png', contentType: 'image/png', size: 2000, disposition: 'inline', contentId: '<l>', content: Buffer.alloc(2000) }] };
    const n = await service.harvestMessage('email_sync', msg);
    expect(n).toBe(0);
    expect(documents.upload).not.toHaveBeenCalled();
    expect(queue.kick).not.toHaveBeenCalled();
  });

  it('still kicks once even when uploads dedup (deduplicated=true)', async () => {
    documents.upload.mockResolvedValue({ document: { id: 1 }, deduplicated: true });
    const msg: FetchedMessage = { uid: 7, subject: 'dup', bodyText: '', attachments: [pdf('invoice.pdf')] };
    const n = await service.harvestMessage('email_push', msg);
    expect(n).toBe(1);
    expect(queue.kick).toHaveBeenCalledTimes(1);
  });
});
