import { Migration } from 'kysely/migration';
import * as m001 from './001_create_organization';
import * as m002 from './002_create_account';
import * as m003 from './003_create_voucher';
import * as m004 from './004_create_voucher_line';
import * as m005 from './005_create_voucher_line_indexes';
import * as m006 from './006_create_expenses';
import * as m007 from './007_create_sales_invoices';
import * as m008 from './008_create_overrides';
import * as m009 from './009_create_policy_config';
import * as m010 from './010_create_document';
import * as m011 from './011_create_reporting_period';
import * as m012 from './012_create_voucher_sequence';
import * as m013 from './013_create_entity';
import * as m014 from './014_create_bank_statement';
import * as m015 from './015_add_document_vat_marking';
import * as m016 from './016_create_reconciliation_match';
import * as m017 from './017_add_org_type';
import * as m018 from './018_create_audit_finding';
import * as m019 from './019_create_approval';
import * as m020 from './020_create_vat_report';
import * as m023 from './023_create_conversation';
import * as m024 from './024_add_dividend_accounts';
import * as m025 from './025_create_api_token';
import * as m026 from './026_add_ocr_markdown_artifact_kind';
import * as m027 from './027_add_ai_proposal';
import * as m028 from './028_create_setting';
import * as m029 from './029_add_finding_transition_audit';
import * as m030 from './030_add_document_needs_triage_status';
import * as m031 from './031_unique_reconciliation_match_pair';
import * as m032 from './032_add_artifact_crc32';
import * as m033 from './033_create_audit_log';
import * as m034 from './034_add_distribution_tax_account';
import * as m035 from './035_create_bank_import_job';
import * as m036 from './036_add_supplier_invoice_number';
import * as m037 from './037_add_org_declarant_identity';
import * as m038 from './038_create_credit_note';
import * as m039 from './039_add_document_pending_triage_result';
import * as m040 from './040_add_reconciliation_match_status_signal';
import * as m041 from './041_approval_object_type_reconciliation_match';
import * as m042 from './042_add_reconciliation_match_fx_voucher_id';
import * as m043 from './043_add_approval_policy_reason';
import * as m044 from './044_add_document_processing_since';
import * as m045 from './045_widen_entity_identifier_kind';
import * as m046 from './046_add_fixed_asset_accounts';
import * as m047 from './047_create_fixed_asset';
import * as m050 from './050_create_statutory_submission_event';

export const migrations: Record<string, Migration> = {
  '001_create_organization': m001,
  '002_create_account': m002,
  '003_create_voucher': m003,
  '004_create_voucher_line': m004,
  '005_create_voucher_line_indexes': m005,
  '006_create_expenses': m006,
  '007_create_sales_invoices': m007,
  '008_create_overrides': m008,
  '009_create_policy_config': m009,
  '010_create_document': m010,
  '011_create_reporting_period': m011,
  '012_create_voucher_sequence': m012,
  '013_create_entity': m013,
  '014_create_bank_statement': m014,
  '015_add_document_vat_marking': m015,
  '016_create_reconciliation_match': m016,
  '017_add_org_type': m017,
  '018_create_audit_finding': m018,
  '019_create_approval': m019,
  '020_create_vat_report': m020,
  '023_create_conversation': m023,
  '024_add_dividend_accounts': m024,
  '025_create_api_token': m025,
  '026_add_ocr_markdown_artifact_kind': m026,
  '027_add_ai_proposal': m027,
  '028_create_setting': m028,
  '029_add_finding_transition_audit': m029,
  '030_add_document_needs_triage_status': m030,
  '031_unique_reconciliation_match_pair': m031,
  '032_add_artifact_crc32': m032,
  '033_create_audit_log': m033,
  '034_add_distribution_tax_account': m034,
  '035_create_bank_import_job': m035,
  '036_add_supplier_invoice_number': m036,
  '037_add_org_declarant_identity': m037,
  '038_create_credit_note': m038,
  '039_add_document_pending_triage_result': m039,
  '040_add_reconciliation_match_status_signal': m040,
  '041_approval_object_type_reconciliation_match': m041,
  '042_add_reconciliation_match_fx_voucher_id': m042,
  '043_add_approval_policy_reason': m043,
  '044_add_document_processing_since': m044,
  '045_widen_entity_identifier_kind': m045,
  '046_add_fixed_asset_accounts': m046,
  '047_create_fixed_asset': m047,
  '050_create_statutory_submission_event': m050,
};
