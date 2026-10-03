import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Issue #203: an append-only cache of AUTHORITATIVE, DATE-SPECIFIC reference
 * rates, replacing the plugin's hardcoded placeholder map.
 *
 * One row is one publication: on `rate_date`, `source` published that 1
 * `base_currency` buys `rate` units of `quote_currency`. Rows are written as
 * observed, in the authority's own quotation convention; inversion and cross
 * rates are derived at read time, never stored pre-chewed.
 *
 * Why persist at all, when the posted line already carries its rate: a posting
 * must not depend on the network being up twice for the same answer, and an
 * upstream revision must not be able to revalue history. The UNIQUE key makes
 * the cache insert-once — a second fetch of an already-known
 * (source, pair, date) is ignored and logged, so what was posted stays
 * explicable by what is stored.
 *
 * Note the cache is NOT the record of what was applied: that is the
 * provenance persisted on `voucher_line` (migration 073). This table is
 * evidence, the voucher line is the fact.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('fx_reference_rate')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    // The publishing authority, e.g. 'ECB'. Part of the identity of an
    // observation: two authorities may publish different rates for one day and
    // neither is "the" rate — the country plugin picks which one governs.
    .addColumn('source', 'text', (col) => col.notNull())
    .addColumn('base_currency', 'text', (col) => col.notNull())
    .addColumn('quote_currency', 'text', (col) => col.notNull())
    // The authority's publication date (YYYY-MM-DD), NOT the date of the
    // transaction that used it. A weekend transaction legitimately applies a
    // Friday rate_date; that difference is the whole point of storing it.
    .addColumn('rate_date', 'text', (col) => col.notNull())
    .addColumn('rate', 'real', (col) => col.notNull().check(sql`rate > 0`))
    .addColumn('fetched_at', 'integer', (col) => col.notNull())
    .addUniqueConstraint('fx_reference_rate_observation_unique', [
      'source',
      'base_currency',
      'quote_currency',
      'rate_date',
    ])
    .execute();

  // The read is always "the newest publication at or before date D for this
  // pair" — an ordered range scan over exactly this prefix.
  await db.schema
    .createIndex('fx_reference_rate_lookup')
    .ifNotExists()
    .on('fx_reference_rate')
    .columns(['source', 'base_currency', 'quote_currency', 'rate_date'])
    .execute();

  // A cached observation is immutable, for the same reason a posted line is:
  // if yesterday's fetch could be overwritten by today's, a posted voucher
  // would stop being explicable by the stored evidence. Corrections to an
  // upstream figure arrive as a NEW rate_date, or are handled by an
  // append-only correction voucher — never by editing history in place.
  // What the cache CANNOT say on its own: whether a date was ever asked
  // about. An observation dated Friday does not tell us whether Monday's
  // publication exists and we simply have not looked — and answering a Monday
  // question from a Friday row we happened to hold would silently recreate
  // exactly the date-blind behaviour #203 removes, for a whole lookback window.
  //
  // So a probe records the closed window [from_date, to_date] the authority
  // was actually asked about. A cached answer is only used for a date that
  // some probe covers; anything else goes upstream first.
  //
  // `to_date` is clamped by the writer to strictly before the current day: a
  // window ending today would freeze a "nothing published yet" answer taken at
  // 10:00 and keep serving it after the 16:00 CET publication. Today is never
  // settled, so it is never recorded as covered.
  await db.schema
    .createTable('fx_rate_probe')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('source', 'text', (col) => col.notNull())
    .addColumn('base_currency', 'text', (col) => col.notNull())
    .addColumn('quote_currency', 'text', (col) => col.notNull())
    .addColumn('from_date', 'text', (col) => col.notNull())
    .addColumn('to_date', 'text', (col) => col.notNull())
    .addColumn('probed_at', 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('fx_rate_probe_lookup')
    .ifNotExists()
    .on('fx_rate_probe')
    .columns(['source', 'base_currency', 'quote_currency', 'to_date'])
    .execute();

  await sql`
    CREATE TRIGGER fx_reference_rate_block_update
    BEFORE UPDATE ON fx_reference_rate
    BEGIN
      SELECT RAISE(ABORT, 'fx_reference_rate observations are immutable (issue #203)');
    END;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS fx_reference_rate_block_update`.execute(db);
  await db.schema.dropTable('fx_rate_probe').ifExists().execute();
  await db.schema.dropTable('fx_reference_rate').ifExists().execute();
}
