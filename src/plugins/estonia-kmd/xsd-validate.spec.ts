import { validateAgainstKmdXsd } from './xsd-validate';
import { readFileSync } from 'fs';
import { join } from 'path';

const xsd = readFileSync(join(__dirname, '../../../test/fixtures/vatdeclaration.xsd'), 'utf8');

it('rejects a malformed document', () => {
  const bad = '<vatDeclaration><wrong/></vatDeclaration>';
  const res = validateAgainstKmdXsd(bad, xsd);
  expect(res.valid).toBe(false);
});

it('accepts a minimal schema-valid document', () => {
  const ok = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<vatDeclaration>',
    '<taxPayerRegCode>EE100000001</taxPayerRegCode>',
    '<year>2026</year>',
    '<month>5</month>',
    '<declarationType>1</declarationType>',
    '<version>KMD6</version>',
    '</vatDeclaration>',
  ].join('');
  const res = validateAgainstKmdXsd(ok, xsd);
  expect(res.errors).toEqual([]);
  expect(res.valid).toBe(true);
});
