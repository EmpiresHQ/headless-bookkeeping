import type { Kysely } from 'kysely';
import type { Database } from '../../database/types';
import type { CorrectionRequest } from '../types';
import type { DraftVoucher } from '../../ledger/voucher/types';
import type { BusinessObjectStatus } from '../../common/types/business-object-status';

type AmountPatch = {
  gross_amount?: number;
  vat_amount?: number;
  category?: string;
};

export type CorrectionParams = {
  objectType: 'expense' | 'sales_invoice';
  objectId: number;
  status: BusinessObjectStatus;
  voucherId: number | null;
  request: CorrectionRequest;
  // Draft/pending branch: edit the draft in place, then regenerate its voucher.
  updateDraft: (patch: AmountPatch) => Promise<unknown>;
  generateDraftVoucher: () => Promise<DraftVoucher>;
  // Posted branch (atomic correction): build the corrected draft from the
  // patched-in-memory object WITHOUT persisting, then persist the patch and the
  // reversed/voucher_id status update inside the posting transaction (trx).
  previewPatchedDraft: (patch: AmountPatch) => Promise<DraftVoucher>;
  patchAmountsTx: (trx: Kysely<Database>, patch: AmountPatch) => Promise<void>;
};
