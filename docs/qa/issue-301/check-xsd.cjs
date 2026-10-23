// Validate actual downloaded bytes against the repository's pinned KMD XSD.
const fs = require('node:fs'),
  xml = require('libxmljs2'),
  crypto = require('node:crypto');
const schemaPath = 'packages/server/test/fixtures/vatdeclaration.xsd',
  schemaBytes = fs.readFileSync(schemaPath),
  schema = xml.parseXml(schemaBytes.toString());
const files = fs.readdirSync(__dirname).filter((f) => /^\d+-.+\.xml$/.test(f));
const checks = files.map((file) => {
  const doc = xml.parseXml(fs.readFileSync(__dirname + '/' + file).toString());
  const valid = doc.validate(schema);
  return { file, valid, errors: doc.validationErrors.map((e) => e.message) };
});
const result = {
  schemaPath,
  schemaSha256: crypto.createHash('sha256').update(schemaBytes).digest('hex'),
  checks,
};
fs.writeFileSync(
  __dirname + '/xsd-checks.json',
  JSON.stringify(result, null, 2) + '\n',
);
console.log(result);
if (checks.some((c) => !c.valid)) process.exitCode = 1;
