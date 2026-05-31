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
};
