const integerSchema = { type: 'integer' };
const nullableIntegerSchema = {
  type: 'integer',
  nullable: true,
};
const numberSchema = { type: 'number' };
const nullableNumberSchema = {
  type: 'number',
  nullable: true,
};
const stringSchema = { type: 'string' };
const nullableStringSchema = {
  type: 'string',
  nullable: true,
};
const nullableBooleanSchema = {
  type: 'boolean',
  nullable: true,
};

export const expenseResponseSchema = {
  type: 'object',
  required: [
    'id',
    'document_id',
    'supplier_id',
    'category',
    'gross_amount',
    'vat_amount',
    'currency',
    'tax_point_date',
    'status',
    'voucher_id',
    'document_vat_marking',
    'supplier_invoice_number',
    'asset_name',
    'asset_useful_life_years',
    'asset_residual_value_minor',
    'claimant_id',
    'company_addressed_receipt',
    'ai_confidence',
    'ai_document_type',
    'ai_kind',
    'created_at',
    'updated_at',
  ],
  properties: {
    id: integerSchema,
    document_id: nullableIntegerSchema,
    supplier_id: nullableIntegerSchema,
    category: stringSchema,
    gross_amount: numberSchema,
    vat_amount: numberSchema,
    currency: stringSchema,
    tax_point_date: stringSchema,
    status: {
      type: 'string',
      enum: ['draft', 'pending', 'posted', 'reversed'],
    },
    voucher_id: nullableIntegerSchema,
    document_vat_marking: nullableStringSchema,
    supplier_invoice_number: nullableStringSchema,
    asset_name: nullableStringSchema,
    asset_useful_life_years: nullableIntegerSchema,
    asset_residual_value_minor: nullableIntegerSchema,
    claimant_id: nullableIntegerSchema,
    company_addressed_receipt: nullableBooleanSchema,
    ai_confidence: nullableNumberSchema,
    ai_document_type: nullableStringSchema,
    ai_kind: nullableStringSchema,
    created_at: integerSchema,
    updated_at: integerSchema,
  },
};

const documentResponseSchema = {
  type: 'object',
  required: [
    'id',
    'hash',
    'filename',
    'mime_type',
    'size_bytes',
    'storage_path',
    'status',
    'processing_since',
    'created_at',
    'claimant_id',
    'preview_path',
  ],
  properties: {
    id: integerSchema,
    hash: stringSchema,
    filename: stringSchema,
    mime_type: stringSchema,
    size_bytes: integerSchema,
    storage_path: nullableStringSchema,
    status: {
      type: 'string',
      enum: ['pending', 'triaged', 'needs_triage', 'processed', 'error'],
    },
    processing_since: nullableIntegerSchema,
    created_at: integerSchema,
    claimant_id: nullableIntegerSchema,
    preview_path: nullableStringSchema,
  },
};

const documentSourceResponseSchema = {
  type: 'object',
  required: [
    'id',
    'document_id',
    'channel',
    'source_identifier',
    'received_at',
    'captured_at',
    'precheck_json',
  ],
  properties: {
    id: integerSchema,
    document_id: integerSchema,
    channel: {
      type: 'string',
      enum: [
        'upload',
        'telegram',
        'email',
        'drive',
        'ios_photo_library',
        'email_sync',
        'email_push',
      ],
    },
    source_identifier: nullableStringSchema,
    received_at: integerSchema,
    captured_at: nullableIntegerSchema,
    precheck_json: nullableStringSchema,
  },
};

export const documentWithSourcesResponseSchema = {
  ...documentResponseSchema,
  required: [...documentResponseSchema.required, 'sources'],
  properties: {
    ...documentResponseSchema.properties,
    sources: {
      type: 'array',
      items: documentSourceResponseSchema,
    },
  },
};

export const documentArchiveRowResponseSchema = {
  ...documentResponseSchema,
  required: [
    ...documentResponseSchema.required,
    'channel',
    'reason',
    'reason_type',
    'expense_id',
    'supplier_name',
    'claimant_name',
    'expense_status',
  ],
  properties: {
    ...documentResponseSchema.properties,
    channel: {
      type: 'string',
      nullable: true,
      enum: [
        'upload',
        'telegram',
        'email',
        'drive',
        'ios_photo_library',
        'email_sync',
        'email_push',
      ],
    },
    reason: nullableStringSchema,
    reason_type: nullableStringSchema,
    expense_id: nullableIntegerSchema,
    supplier_name: nullableStringSchema,
    claimant_name: nullableStringSchema,
    expense_status: {
      type: 'string',
      nullable: true,
      enum: ['draft', 'pending', 'posted', 'reversed'],
    },
  },
};

export const reportingPeriodResponseSchema = {
  type: 'object',
  required: [
    'id',
    'name',
    'start_date',
    'end_date',
    'status',
    'filed_at',
    'vat_report_snapshot_id',
    'created_at',
  ],
  properties: {
    id: integerSchema,
    name: stringSchema,
    start_date: stringSchema,
    end_date: stringSchema,
    status: {
      type: 'string',
      enum: ['open', 'locked'],
    },
    filed_at: nullableIntegerSchema,
    vat_report_snapshot_id: nullableIntegerSchema,
    created_at: integerSchema,
  },
};

export const expensesListResponseSchema = {
  type: 'object',
  required: ['expenses'],
  properties: {
    expenses: {
      type: 'array',
      items: expenseResponseSchema,
    },
  },
};

export const documentsListResponseSchema = {
  type: 'object',
  required: ['documents'],
  properties: {
    documents: {
      type: 'array',
      items: documentArchiveRowResponseSchema,
    },
  },
};

export const reportingPeriodsListResponseSchema = {
  type: 'object',
  required: ['reportingPeriods'],
  properties: {
    reportingPeriods: {
      type: 'array',
      items: reportingPeriodResponseSchema,
    },
  },
};
