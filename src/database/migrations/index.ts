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
};
