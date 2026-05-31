export type CorrectionParams = {
  objectType: 'expense' | 'sales_invoice';
  objectId: number;
  status: string;
  voucherId: number | null;
  request: CorrectionRequest;
  updateDraft: (patch: {
    gross_amount?: number;
    vat_amount?: number;
    category?: string;
  }) => Promise<unknown>;
  patchAmounts: (patch: {
    gross_amount?: number;
    vat_amount?: number;
    category?: string;
  }) => Promise<unknown>;
  generateDraftVoucher: () => Promise<DraftVoucher>;
  markReversed: (voucherId: number) => Promise<void>;
};
