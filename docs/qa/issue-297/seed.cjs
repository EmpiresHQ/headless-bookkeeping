// SYNTHETIC local QA fixtures. Never points at a production database.
const Database = require('better-sqlite3');
const { createHash } = require('node:crypto');
if (!process.argv[2]?.includes('/issue-297/.qa-data/'))
  throw Error('isolated path required');
const db = new Database(process.argv[2]);
const stem =
  'Baltic Sea Freight Forwarding, Warehousing, Customs Brokerage and Industrial Equipment Leasing Cooperative of Harju County Enterprises with Subsidiaries in Tartu, Pärnu and Narva, Registered Office Tallinn, Estonia OÜ';
const names = {
  1: 'SYNTHETIC Põhja-Eesti Raamatupidamis- ja Maksunõustamisteenuste Keskus ning Partnerid Rahvusvaheline Esindus Tallinnas',
  2: 'SYNTHETIC ' + [stem, stem, stem].join(' — '),
  3:
    'SYNTHETIC-UnbrokenSupplierRegistrationIdentifier' +
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(4),
  4: 'SYNTHETIC Customer',
};
db.transaction(() => {
  db.prepare('insert into api_token(token_hash,label) values (?,?)').run(
    createHash('sha256').update('synthetic-297-only').digest('hex'),
    'synthetic QA only',
  );
  const entity = db.prepare(
    'insert into entity(id,role,country,name,created_at,updated_at) values (?,?,?,?,?,?)',
  );
  const identifier = db.prepare(
    "insert into entity_identifier(entity_id,kind,value,confirmed) values (?,'registration_key',?,1)",
  );
  for (const [id, name] of Object.entries(names)) {
    entity.run(
      Number(id),
      id === '4' ? 'customer' : 'supplier',
      'EE',
      name,
      1792600000,
      1792600000,
    );
    identifier.run(
      Number(id),
      'SYNTHETIC-REGISTRATION-297-' + id + '-LONG-MEANINGFUL-SUFFIX',
    );
  }
  db.prepare(
    "insert into expense(id,supplier_id,category,gross_amount,vat_amount,currency,tax_point_date,status,supplier_invoice_number) values (297,1,'software',999999999,0,'USD','2026-10-22','draft',?)",
  ).run(
    'SYNTHETIC-INVOICE-297-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-LONG-MEANINGFUL-SUFFIX',
  );
})();
console.log(
  JSON.stringify(
    {
      synthetic: true,
      names: Object.fromEntries(
        Object.entries(names).map(([id, name]) => [
          id,
          { name, length: name.length },
        ]),
      ),
      expenses: 1,
      amount: '9999999.99 USD',
      foreignKeyCheck: db.pragma('foreign_key_check'),
    },
    null,
    2,
  ),
);
