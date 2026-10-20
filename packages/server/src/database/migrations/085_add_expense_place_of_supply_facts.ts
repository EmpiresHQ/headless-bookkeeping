import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * Issue #403: the place-of-supply facts a LOCAL foreign purchase's treatment
 * turns on — the purchase-side mirror of the sales facts (migration 076,
 * issue #209).
 *
 * A local-consumption purchase (accommodation, a restaurant meal) is taxed
 * WHERE it is physically carried out (Art. 47 — immovable property, where the
 * property is; Art. 55 — restaurant and catering, where physically carried
 * out; Directive 2006/112/EC). The RULE names the criterion, but the criterion
 * alone does not fix the LOCATION: a Danish supplier may operate a hotel in
 * Tallinn or cater in Estonia, and foreign VAT printed on a document does not
 * prove where the supply happened. Both facts are therefore recorded
 * separately and explicitly:
 *
 *   - `service_place_rule` — WHICH rule governs this purchase's services
 *     ('general', the residual default / NULL, or a declared exception such as
 *     'immovable_property' / 'restaurant_catering');
 *   - `place_of_supply_country` — the ISO country where the supply was
 *     physically performed / the property stands, when the rule's location is
 *     what decides the treatment.
 *
 * A declared local-consumption exception WITHOUT a recorded country is an
 * INCOMPLETE declaration — the EE plugin holds with the missing fact named
 * rather than guessing the location (issue #403). A general rule (or NULL)
 * never asks: the residual rule governs, exactly as before these columns
 * existed. NULLable both: an insert that states neither keeps the treatment
 * it always had.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('expense')
    .addColumn('service_place_rule', 'text', (col) =>
      col.check(
        sql`service_place_rule IS NULL OR service_place_rule IN ('general', 'immovable_property', 'passenger_transport', 'cultural_artistic_sporting_admission', 'restaurant_catering', 'short_term_hire_of_means_of_transport', 'electronically_supplied_to_consumer', 'other_special')`,
      ),
    )
    .execute();
  await db.schema
    .alterTable('expense')
    .addColumn('place_of_supply_country', 'text', (col) =>
      col.check(
        sql`place_of_supply_country IS NULL OR (length(place_of_supply_country) = 2 AND upper(place_of_supply_country) = place_of_supply_country)`,
      ),
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('expense')
    .dropColumn('place_of_supply_country')
    .execute();
  await db.schema
    .alterTable('expense')
    .dropColumn('service_place_rule')
    .execute();
}
