import { Injectable } from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service';
import { IntakeQueueWorker } from '../intake-queue/intake-queue.worker';
import { isHarvestable } from './attachment-filter';
import { MailboxChannel } from './types';
import { FetchedMessage } from './imap-client.port';

@Injectable()
export class HarvestService {
  constructor(
    private readonly documents: DocumentsService,
    private readonly queue: IntakeQueueWorker,
  ) {}

  async harvestMessage(
    channel: MailboxChannel,
    msg: FetchedMessage,
  ): Promise<number> {
    let harvested = 0;
    for (const att of msg.attachments) {
      if (!isHarvestable(att)) continue;
      await this.documents.upload({
        buffer: att.content,
        filename: att.filename,
        mimeType: att.contentType,
        channel,
        sourceIdentifier: `uid:${msg.uid}`,
      });
      harvested += 1;
    }
    if (harvested > 0) {
      // upload() does NOT auto-enqueue (verified against merged main); kick the
      // serialized queue so OCR/triage starts promptly instead of at the next sweep.
      await this.queue.kick();
    }
    return harvested;
  }
}
