import request from 'supertest';
import {
  approverUpdate,
  buildCallbackUpdate,
  createInteractionE2eHarness,
  expectNagForApproval,
  type InteractionE2eHarness,
} from './interaction.e2e-support';

describe('Telegram webhook + approval lifecycle (e2e)', () => {
  let harness: InteractionE2eHarness;

  beforeEach(async () => {
    harness = await createInteractionE2eHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('403s a webhook with a wrong secret token', async () => {
    await request(harness.app.getHttpServer())
      .post('/api/channels/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'wrong')
      .send(approverUpdate)
      .expect(403);

    expect(harness.telegramApi.sentMessages).toEqual([]);
    expect(harness.telegramApi.callbackAnswers).toEqual([]);
    expect(harness.telegramApi.clearedMarkups).toEqual([]);
  });

  it('accepts a valid webhook and creates an open Conversation at thread_key=tg:999', async () => {
    await harness.seedPrivateApproverChat();

    const conversation = await harness.db
      .selectFrom('conversation')
      .selectAll()
      .where('thread_key', '=', 'tg:999')
      .executeTakeFirstOrThrow();

    expect(conversation.status).toBe('open');
    expect(conversation.channel).toBe('telegram');
    expect(harness.telegramApi.sentMessages).toEqual([
      { chat_id: 999, text: 'Could you rephrase what you need?' },
    ]);
    expect(harness.telegramApi.callbackAnswers).toEqual([]);
    expect(harness.telegramApi.clearedMarkups).toEqual([]);
  });

  it('holds, nags, and approves a sales invoice through the real Telegram callback seam', async () => {
    await harness.seedPrivateApproverChat();
    harness.telegramApi.reset();
    await harness.forceHoldPolicy();

    const invoice = await harness.createDraftSalesInvoice(
      'INV-TELEGRAM-APPROVE',
    );
    const postResult = await harness.holdSalesInvoice(invoice.id);
    expect(postResult.policy.action).toBe('hold-for-approval');
    expect(postResult.voucher).toBeNull();
    expect(postResult.invoice.status).toBe('pending');

    const approval = await harness.getPendingApprovalForInvoice(invoice.id);
    const finding = await harness.getFindingForApproval(approval.id);
    const openFindings = await harness.db
      .selectFrom('audit_finding')
      .selectAll()
      .where('status', '=', 'open')
      .execute();
    expect(openFindings).toHaveLength(1);

    await harness.secretary.notify();
    expectNagForApproval(harness.telegramApi, approval.id, finding.description);

    const outboundMessages = await harness.db
      .selectFrom('message')
      .select(['direction', 'body'])
      .execute();
    expect(outboundMessages).toEqual(
      expect.arrayContaining([
        {
          direction: 'outbound',
          body: `Approval needed — ${finding.description} (approval #${approval.id})`,
        },
      ]),
    );

    await request(harness.app.getHttpServer())
      .post('/api/channels/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'sek')
      .send(buildCallbackUpdate(approval.id, 'cb-approve', 999, 77))
      .expect(200)
      .expect({ ok: true });

    expect(harness.telegramApi.callbackAnswers).toEqual(['cb-approve']);
    expect(harness.telegramApi.clearedMarkups).toEqual([
      { chatId: 999, messageId: 77 },
    ]);

    const approved = await harness.db
      .selectFrom('approval')
      .selectAll()
      .where('id', '=', approval.id)
      .executeTakeFirstOrThrow();
    const postedInvoice = await harness.db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('id', '=', invoice.id)
      .executeTakeFirstOrThrow();
    const resolvedFinding = await harness.getFindingForApproval(approval.id);
    const vouchers = await harness.db
      .selectFrom('voucher')
      .selectAll()
      .execute();

    expect(approved.status).toBe('approved');
    expect(approved.approved_by).toBe('999');
    expect(postedInvoice.status).toBe('posted');
    expect(postedInvoice.voucher_id).not.toBeNull();
    expect(resolvedFinding.status).toBe('resolved');
    expect(resolvedFinding.transitioned_by).toBe('999');
    expect(resolvedFinding.transition_reason).toBe('Approval approved');
    expect(vouchers).toHaveLength(1);
  });

  it('holds, nags, and rejects a sales invoice through the real Telegram callback seam', async () => {
    await harness.seedPrivateApproverChat();
    harness.telegramApi.reset();
    await harness.forceHoldPolicy();

    const invoice = await harness.createDraftSalesInvoice(
      'INV-TELEGRAM-REJECT',
    );
    const postResult = await harness.holdSalesInvoice(invoice.id);
    expect(postResult.policy.action).toBe('hold-for-approval');

    const approval = await harness.getPendingApprovalForInvoice(invoice.id);
    const finding = await harness.getFindingForApproval(approval.id);

    await harness.secretary.notify();
    expectNagForApproval(harness.telegramApi, approval.id, finding.description);

    await request(harness.app.getHttpServer())
      .post('/api/channels/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'sek')
      .send(buildCallbackUpdate(approval.id, 'cb-reject', 999, 88, 'reject'))
      .expect(200)
      .expect({ ok: true });

    expect(harness.telegramApi.callbackAnswers).toEqual(['cb-reject']);
    expect(harness.telegramApi.clearedMarkups).toEqual([
      { chatId: 999, messageId: 88 },
    ]);

    const rejected = await harness.db
      .selectFrom('approval')
      .selectAll()
      .where('id', '=', approval.id)
      .executeTakeFirstOrThrow();
    const revertedInvoice = await harness.db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('id', '=', invoice.id)
      .executeTakeFirstOrThrow();
    const resolvedFinding = await harness.getFindingForApproval(approval.id);
    const vouchers = await harness.db
      .selectFrom('voucher')
      .selectAll()
      .execute();

    expect(rejected.status).toBe('rejected');
    expect(rejected.rejected_reason).toBe('Rejected via Telegram');
    expect(revertedInvoice.status).toBe('draft');
    expect(revertedInvoice.voucher_id).toBeNull();
    expect(resolvedFinding.status).toBe('resolved');
    expect(resolvedFinding.transitioned_by).toBeNull();
    expect(resolvedFinding.transition_reason).toBe('Rejected via Telegram');
    expect(vouchers).toHaveLength(0);
  });

  it('acknowledges a non-approver callback without mutating approval state', async () => {
    await harness.seedPrivateApproverChat();
    harness.telegramApi.reset();
    await harness.forceHoldPolicy();

    const invoice = await harness.createDraftSalesInvoice(
      'INV-TELEGRAM-DENIED',
    );
    await harness.holdSalesInvoice(invoice.id);
    const approval = await harness.getPendingApprovalForInvoice(invoice.id);

    await harness.secretary.notify();
    await request(harness.app.getHttpServer())
      .post('/api/channels/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'sek')
      .send(buildCallbackUpdate(approval.id, 'cb-denied', 123, 90))
      .expect(200)
      .expect({ ok: true });

    expect(harness.telegramApi.callbackAnswers).toEqual(['cb-denied']);
    expect(harness.telegramApi.clearedMarkups).toEqual([]);

    const unchangedApproval = await harness.db
      .selectFrom('approval')
      .selectAll()
      .where('id', '=', approval.id)
      .executeTakeFirstOrThrow();
    const unchangedInvoice = await harness.db
      .selectFrom('sales_invoice')
      .selectAll()
      .where('id', '=', invoice.id)
      .executeTakeFirstOrThrow();
    const openFinding = await harness.getFindingForApproval(approval.id);
    const vouchers = await harness.db
      .selectFrom('voucher')
      .selectAll()
      .execute();

    expect(unchangedApproval.status).toBe('pending');
    expect(unchangedInvoice.status).toBe('pending');
    expect(unchangedInvoice.voucher_id).toBeNull();
    expect(openFinding.status).toBe('open');
    expect(vouchers).toHaveLength(0);
  });
});
