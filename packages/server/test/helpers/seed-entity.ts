import { Kysely } from 'kysely';
import { Database } from '../../src/database/types';

let _emailCounter = 0;

/**
 * Seed a minimal entity row directly via DB for unit tests.
 * For employees/directors the email is auto-generated to avoid conflicts.
 */
export async function seedEntity(
  db: Kysely<Database>,
  opts: {
    role: 'employee' | 'director' | 'supplier' | 'customer';
    name?: string;
  },
): Promise<{ id: number; role: string; name: string }> {
  const now = Math.floor(Date.now() / 1000);
  const name = opts.name ?? `Test ${opts.role} ${++_emailCounter}`;
  const email = `test-${_emailCounter}@example.com`;

  const row = await db
    .insertInto('entity')
    .values({
      role: opts.role,
      country: 'EE',
      name,
      goods_vs_services: null,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await db
    .insertInto('entity_identifier')
    .values({
      entity_id: row.id,
      kind: 'email',
      value: email,
      confirmed: 1,
    })
    .execute();

  return { id: row.id, role: row.role, name: row.name };
}
