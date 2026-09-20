import { readFileSync } from 'fs';
import { join } from 'path';
import * as libxml from 'libxmljs2';

/**
 * The pinned et-gaap taxonomy version this project reports against, and the
 * canonical URL of its core (element-declaration) schema — the target of an
 * instance's `link:schemaRef`.
 *
 * Provenance, SHA-256 and licence of the vendored copy:
 * `../fixtures/xbrl/PROVENANCE.md`.
 */
export const ET_GAAP_NS = 'http://xbrl.eesti.ee/taxonomy/et-gaap_2026-01-01/';
export const ET_GAAP_SCHEMA_REF = `${ET_GAAP_NS}et-gaap-cor_2026-01-01.xsd`;

const CORE_XSD = join(
  __dirname,
  '../fixtures/xbrl/et-gaap_2026-01-01/et-gaap-cor_2026-01-01.xsd',
);

/** One concept, exactly as the official core schema declares it. */
export interface EtGaapConcept {
  /** Local name, e.g. `CashAndCashEquivalents`. */
  name: string;
  /** `xsd:element/@type`, e.g. `xbrli:monetaryItemType`. */
  type: string;
  /** `xbrli:periodType` — the rule an instance context must satisfy. */
  periodType: 'instant' | 'duration';
  /** `xbrli:balance`, when the taxonomy declares one. */
  balance: 'debit' | 'credit' | null;
  /** Abstract concepts are presentation-only and may not be reported. */
  abstract: boolean;
  substitutionGroup: string;
}

let cache: ReadonlyMap<string, EtGaapConcept> | null = null;

/**
 * Every concept the official `et-gaap_2026-01-01` core schema declares, keyed
 * by local name. Parsed from the vendored schema itself — nothing here is
 * authored locally, so a validator driven by this table is checking generated
 * instances against the taxonomy RIK actually supports.
 *
 * Note we deliberately do NOT hand the schema to libxml2's XSD compiler: the
 * core declares ~3400 global elements in one substitution group, which sends
 * `xmlSchemaParse` into minutes of CPU. Reading the declarations directly is
 * the same source of truth at a few milliseconds, and the semantic rules that
 * matter here (periodType vs context, units, decimals, identifiers) are XBRL
 * 2.1 rules that XSD cannot express in any case.
 */
export function etGaapConcepts(): ReadonlyMap<string, EtGaapConcept> {
  if (cache) return cache;
  const doc = libxml.parseXml(readFileSync(CORE_XSD, 'utf8'));
  const out = new Map<string, EtGaapConcept>();
  for (const node of doc.find('/xsd:schema/xsd:element[@name]', {
    xsd: 'http://www.w3.org/2001/XMLSchema',
  }) as libxml.Element[]) {
    const attr = (n: string): string | null => node.attr(n)?.value() ?? null;
    const name = attr('name');
    if (!name) continue;
    const periodType = attr('periodType');
    out.set(name, {
      name,
      type: attr('type') ?? '',
      periodType: periodType === 'duration' ? 'duration' : 'instant',
      balance: attr('balance') as EtGaapConcept['balance'],
      abstract: attr('abstract') === 'true',
      substitutionGroup: attr('substitutionGroup') ?? '',
    });
  }
  if (out.size === 0) {
    throw new Error(`No concepts parsed from ${CORE_XSD}`);
  }
  cache = out;
  return cache;
}
