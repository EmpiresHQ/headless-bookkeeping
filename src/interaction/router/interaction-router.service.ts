// src/interaction/router/interaction-router.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConversationsService } from '../../conversations/conversations.service';
import { DocumentsService } from '../../documents/documents.service';
import { InteractionConfigService } from '../config/interaction-config.service';
import { PrincipalResolverService } from '../principal/principal-resolver.service';
import { canConverse, ingestDecision } from '../principal/interaction-gate';
import { IntentClassifierService } from './intent-classifier.service';
import { FlowDispatcher } from './flow-dispatcher';
import { TransportRegistryService } from '../transport/transport-registry.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { Channel } from '../../documents/types';
import { InteractionChannel, UnifiedEnvelope } from '../envelope/types';
import { ActionIntent, RoutedIntent, RouterOutcome } from './types';

const ACTION_INTENTS: readonly ActionIntent[] = [
  'create_sales_invoice',
  'approve',
  'reject',
  'correct',
];

function asActionIntent(value: string): ActionIntent | null {
  return ACTION_INTENTS.find((intent) => intent === value) ?? null;
}

/** Map the interaction channel to the document-upload channel. */
function uploadChannelFor(channel: InteractionChannel): Channel {
  switch (channel) {
    case 'telegram':
      return 'telegram';
    case 'email':
      return 'email';
    case 'slack':
    case 'api':
      return 'upload';
  }
}

@Injectable()
export class InteractionRouterService {
  private readonly logger = new Logger(InteractionRouterService.name);

  constructor(
    private readonly conversations: ConversationsService,
    private readonly documents: DocumentsService,
    private readonly config: InteractionConfigService,
    private readonly principals: PrincipalResolverService,
    private readonly classifier: IntentClassifierService,
    private readonly dispatcher: FlowDispatcher,
    private readonly transports: TransportRegistryService,
    private readonly audit: AuditLogService,
  ) {}

  async handle(envelope: UnifiedEnvelope): Promise<RouterOutcome> {
    // 1. Deterministic Conversation resolution (by channel + thread key).
    const conversation = await this.conversations.resolve({
      channel: envelope.channel,
      thread_key: envelope.convKey,
    });

    // 2. Persist the inbound turn (text or a button-tap marker).
    await this.conversations.appendMessage({
      conversation_id: conversation.id,
      direction: 'inbound',
      sender: envelope.sender,
      body:
        envelope.message ??
        `[callback:${envelope.metadata.callbackData ?? ''}]`,
    });

    // 3. Resolve the Principal once, in the core.
    const principal = await this.principals.resolve(envelope);

    // 4. Ingest track (independent of conversing).
    let ingested = 0;
    if (envelope.attachments.length > 0) {
      const policy = await this.config.getIngestPolicy();
      const decision = ingestDecision(principal, policy);
      if (decision === 'accept') {
        for (const att of envelope.attachments) {
          const { document } = await this.documents.upload({
            buffer: att.buffer,
            filename: att.filename,
            mimeType: att.mimeType,
            channel: uploadChannelFor(envelope.channel),
          });
          if (document.storage_path === null) {
            throw new Error(
              `uploaded document ${document.id} has no storage_path`,
            );
          }
          await this.conversations.attachArtifact({
            conversation_id: conversation.id,
            kind: 'inbound_attachment',
            storage_path: document.storage_path,
            document_id: document.id,
          });
          await this.conversations.associateDocument({
            conversation_id: conversation.id,
            document_id: document.id,
          });
          ingested += 1;
        }
      } else {
        this.logger.log(`ingest ${decision} for ${principal.role} sender`);
      }
      await this.audit.record({
        actor: principal.senderId,
        action: 'interaction.ingest',
        outcome: decision,
        target_type: 'conversation',
        target_id: conversation.id,
        detail: { count: envelope.attachments.length },
      });
    }

    // 5. Deterministic button tap → pre-classified action (no LLM).
    const callbackData = envelope.metadata.callbackData;
    if (callbackData) {
      const intent = this.intentFromCallback(callbackData);
      await this.audit.record({
        actor: principal.senderId,
        action: 'interaction.action_point.commit',
        outcome: 'accepted',
        target_type: 'conversation',
        target_id: conversation.id,
        detail: { callbackData },
      });
      const dispatched = await this.dispatch(intent, conversation.id, envelope);
      return {
        conversation_id: conversation.id,
        gated_in: true,
        ingested,
        intent,
        dispatched,
      };
    }

    // 6. No message, or sender may not converse → stop after ingest.
    if (!envelope.message || !canConverse(principal)) {
      if (envelope.message && !canConverse(principal)) {
        await this.audit.record({
          actor: principal.senderId,
          action: 'interaction.gate.converse_denied',
          outcome: 'denied',
          target_type: 'conversation',
          target_id: conversation.id,
        });
      }
      return {
        conversation_id: conversation.id,
        gated_in: canConverse(principal),
        ingested,
        intent: null,
        dispatched: false,
      };
    }

    // 7. Classify, then clarify-or-dispatch.
    const intent = await this.classifier.classify(envelope.message);
    const dispatched = await this.dispatch(intent, conversation.id, envelope);
    return {
      conversation_id: conversation.id,
      gated_in: true,
      ingested,
      intent,
      dispatched,
    };
  }

  private intentFromCallback(callbackData: string): RoutedIntent {
    const [head, ref] = callbackData.split(':');
    const actionIntent = asActionIntent(head);
    if (actionIntent) {
      return {
        kind: 'action',
        actionIntent,
        fields: { ref: ref ?? '' },
      };
    }
    return { kind: 'clarify', question: 'That button is no longer valid.' };
  }

  /** Returns true when a flow handled it; a clarify is sent over the transport instead. */
  private async dispatch(
    intent: RoutedIntent,
    conversationId: number,
    envelope: UnifiedEnvelope,
  ): Promise<boolean> {
    if (intent.kind === 'clarify') {
      await this.sendOutbound(envelope, conversationId, intent.question);
      return false;
    }
    const result = await this.dispatcher.dispatch(intent, {
      conversation_id: conversationId,
    });
    if (result.reply) {
      await this.sendOutbound(envelope, conversationId, result.reply);
    }
    return true;
  }

  private async sendOutbound(
    envelope: UnifiedEnvelope,
    conversationId: number,
    text: string,
  ): Promise<void> {
    await this.transports.send({
      channel: envelope.channel,
      convKey: envelope.convKey,
      text,
    });
    await this.conversations.appendMessage({
      conversation_id: conversationId,
      direction: 'outbound',
      sender: 'system',
      body: text,
    });
  }
}
