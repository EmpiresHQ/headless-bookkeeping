import * as libxml from 'libxmljs2';
import {
  ET_GAAP_NS,
  ET_GAAP_SCHEMA_REF,
  etGaapConcepts,
  type EtGaapConcept,
} from './et-gaap-taxonomy';

const XBRLI = 'http://www.xbrl.org/2003/instance';
const LINK = 'http://www.xbrl.org/2003/linkbase';
const XLINK = 'http://www.w3.org/1999/xlink';
const ISO4217 = 'http://www.xbrl.org/2003/iso4217';

const NS = { xbrli: XBRLI, link: LINK, xlink: XLINK };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * yyyy-mm-dd shaped AND a real day. A shape-only check would call a context
 * dated 2026-02-30 valid, which is exactly the sort of malformed context this
 * validator exists to catch.
 */
function isRealDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [, year, month, day] = m;
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    utc.getUTCFullYear() === Number(year) &&
    utc.getUTCMonth() === Number(month) - 1 &&
    utc.getUTCDate() === Number(day)
  );
}
const NCNAME_RE = /^[A-Za-z_][\w.-]*$/;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** A context's period, reduced to what XBRL 2.1 §4.7.2 cares about. */
interface ContextPeriod {
  kind: 'instant' | 'duration';
  instant?: string;
  startDate?: string;
  endDate?: string;
}

interface ContextInfo {
  id: string;
  period: ContextPeriod;
  identifier: string;
  scheme: string;
}

export interface XbrlValidationResult {
  valid: boolean;
  errors: string[];
}

function localName(n: libxml.Element): string {
  return n.name();
}

function nsHref(n: libxml.Element): string {
  return n.namespace()?.href() ?? '';
}

/**
 * Validate an et-gaap XBRL instance against the PINNED OFFICIAL TAXONOMY and
 * the XBRL 2.1 instance rules that bear on it.
 *
 * Concept existence, item type, `periodType` and `balance` all come from
 * RIK's own `et-gaap-cor_2026-01-01.xsd` (see
 * `test/fixtures/xbrl/PROVENANCE.md`), so this is taxonomy validation, not a
 * syntax check and not a check against a locally invented schema. The rules
 * enforced here are the ones XSD cannot express anyway; full XBRL 2.1
 * processor conformance (including the calculation linkbase) is covered
 * out-of-band by Arelle — see `README.md`.
 *
 * Rules, in order of the checks below:
 *  1. root `xbrli:xbrl`, and a `link:schemaRef` to the pinned taxonomy
 *  2. contexts: NCName ids, unique, non-empty scheme + identifier
 *  3. contexts: period is exactly `instant` OR `startDate`+`endDate`, both
 *     valid ISO dates, `startDate <= endDate` (XBRL 2.1 §4.7.2)
 *  4. units: NCName ids, unique, at least one measure
 *  5. facts: concept is declared by the taxonomy and is not abstract
 *  6. facts: `contextRef` resolves; `unitRef` resolves for numeric items
 *  7. facts: concept `periodType` matches its context's period kind
 *  8. monetary facts: single `iso4217:*` measure, well-formed decimal value,
 *     `decimals`/`precision` present, and a `decimals` accuracy claim the
 *     value actually honours
 *  9. no two facts of the same concept+context disagree
 */
export function validateEtGaapInstance(xml: string): XbrlValidationResult {
  const errors: string[] = [];
  const push = (m: string): void => {
    errors.push(m);
  };

  let doc: libxml.Document;
  try {
    doc = libxml.parseXml(xml);
  } catch (e) {
    return { valid: false, errors: [`not well-formed XML: ${String(e)}`] };
  }
  const root = doc.root();
  if (!root) return { valid: false, errors: ['empty document'] };

  // ── 1. Root + schemaRef ──
  if (nsHref(root) !== XBRLI || localName(root) !== 'xbrl') {
    push(`root must be {${XBRLI}}xbrl, found {${nsHref(root)}}${root.name()}`);
    return { valid: false, errors };
  }
  const schemaRefs = root.find('link:schemaRef', NS) as libxml.Element[];
  if (schemaRefs.length === 0) {
    push('missing link:schemaRef — nothing binds the instance to a taxonomy');
  }
  for (const ref of schemaRefs) {
    const href = ref.attr('href')?.value() ?? '';
    if (href !== ET_GAAP_SCHEMA_REF) {
      push(
        `link:schemaRef href ${JSON.stringify(href)} is not the pinned taxonomy ${ET_GAAP_SCHEMA_REF}`,
      );
    }
  }

  // ── 2 + 3. Contexts ──
  const contexts = new Map<string, ContextInfo>();
  for (const ctx of root.find('xbrli:context', NS) as libxml.Element[]) {
    const id = ctx.attr('id')?.value() ?? '';
    if (!NCNAME_RE.test(id)) {
      push(`context id ${JSON.stringify(id)} is not a valid NCName`);
      continue;
    }
    if (contexts.has(id)) {
      push(`duplicate context id ${id}`);
      continue;
    }

    const ident = ctx.get(
      'xbrli:entity/xbrli:identifier',
      NS,
    ) as libxml.Element | null;
    const identifier = ident?.text().trim() ?? '';
    const scheme = ident?.attr('scheme')?.value() ?? '';
    if (!ident) push(`context ${id}: missing xbrli:entity/xbrli:identifier`);
    else {
      if (identifier === '') push(`context ${id}: empty entity identifier`);
      if (scheme === '') push(`context ${id}: entity identifier has no scheme`);
    }

    const periodEl = ctx.get('xbrli:period', NS) as libxml.Element | null;
    if (!periodEl) {
      push(`context ${id}: missing xbrli:period`);
      continue;
    }
    const child = (n: string): string | null =>
      (periodEl.get(`xbrli:${n}`, NS) as libxml.Element | null)
        ?.text()
        .trim() ?? null;
    const instant = child('instant');
    const startDate = child('startDate');
    const endDate = child('endDate');
    const forever = periodEl.get(`xbrli:forever`, NS) != null;

    let period: ContextPeriod;
    if (instant !== null) {
      if (startDate !== null || endDate !== null || forever) {
        push(`context ${id}: period mixes instant with duration/forever`);
      }
      if (!isRealDate(instant))
        push(`context ${id}: instant ${JSON.stringify(instant)} is not a date`);
      period = { kind: 'instant', instant };
    } else if (startDate !== null || endDate !== null) {
      if (startDate === null || endDate === null) {
        push(
          `context ${id}: duration period needs both startDate and endDate ` +
            `(startDate=${JSON.stringify(startDate)}, endDate=${JSON.stringify(endDate)})`,
        );
      }
      if (startDate !== null && !isRealDate(startDate))
        push(
          `context ${id}: startDate ${JSON.stringify(startDate)} is not a date`,
        );
      if (endDate !== null && !isRealDate(endDate))
        push(`context ${id}: endDate ${JSON.stringify(endDate)} is not a date`);
      if (startDate !== null && endDate !== null && startDate > endDate)
        push(
          `context ${id}: startDate ${startDate} is after endDate ${endDate}`,
        );
      period = {
        kind: 'duration',
        startDate: startDate ?? '',
        endDate: endDate ?? '',
      };
    } else {
      push(
        `context ${id}: period declares neither instant nor startDate/endDate`,
      );
      continue;
    }

    contexts.set(id, { id, period, identifier, scheme });
  }

  // ── 4. Units ──
  const units = new Map<string, string[]>();
  for (const unit of root.find('xbrli:unit', NS) as libxml.Element[]) {
    const id = unit.attr('id')?.value() ?? '';
    if (!NCNAME_RE.test(id)) {
      push(`unit id ${JSON.stringify(id)} is not a valid NCName`);
      continue;
    }
    if (units.has(id)) {
      push(`duplicate unit id ${id}`);
      continue;
    }
    const measures = (unit.find('xbrli:measure', NS) as libxml.Element[]).map(
      (m) => m.text().trim(),
    );
    if (measures.length === 0) push(`unit ${id}: no xbrli:measure`);
    units.set(id, measures);
  }

  // ── 5-9. Facts ──
  const concepts = etGaapConcepts();
  const seen = new Map<string, string>();

  for (const fact of root.childNodes()) {
    if (fact.type() !== 'element') continue;
    const el = fact as libxml.Element;
    const href = nsHref(el);
    if (href === XBRLI || href === LINK) continue; // contexts, units, schemaRef
    if (href !== ET_GAAP_NS) {
      push(`fact ${el.name()} is in unexpected namespace ${href}`);
      continue;
    }

    const name = localName(el);
    const concept: EtGaapConcept | undefined = concepts.get(name);
    if (!concept) {
      push(`concept et-gaap:${name} is not declared by the pinned taxonomy`);
      continue;
    }
    if (concept.abstract) {
      push(`concept et-gaap:${name} is abstract and cannot be reported`);
      continue;
    }

    const contextRef = el.attr('contextRef')?.value() ?? '';
    const ctx = contexts.get(contextRef);
    if (!ctx) {
      push(
        `et-gaap:${name}: contextRef ${JSON.stringify(contextRef)} resolves to no context`,
      );
      continue;
    }

    // 7. periodType vs context (XBRL 2.1 §4.7.2).
    if (concept.periodType !== ctx.period.kind) {
      push(
        `et-gaap:${name} is a ${concept.periodType} concept but context ` +
          `${ctx.id} is a ${ctx.period.kind} period`,
      );
    }

    const isMonetary = concept.type === 'xbrli:monetaryItemType';
    const unitRef = el.attr('unitRef')?.value() ?? null;
    const decimals = el.attr('decimals')?.value() ?? null;
    const precision = el.attr('precision')?.value() ?? null;
    const value = el.text().trim();

    if (isMonetary) {
      // 6 + 8.
      if (unitRef === null) {
        push(`et-gaap:${name}: numeric item has no unitRef`);
      } else {
        const measures = units.get(unitRef);
        if (!measures) {
          push(
            `et-gaap:${name}: unitRef ${JSON.stringify(unitRef)} resolves to no unit`,
          );
        } else if (measures.length !== 1) {
          push(
            `et-gaap:${name}: monetary unit ${unitRef} must have exactly one measure, has ${measures.length}`,
          );
        } else {
          const [measure] = measures;
          const prefix = measure.includes(':') ? measure.split(':')[0] : '';
          const measureNs = prefix
            ? (el.namespaces() as libxml.Namespace[])
                .find((n) => n.prefix() === prefix)
                ?.href()
            : '';
          if (measureNs !== ISO4217) {
            push(
              `et-gaap:${name}: monetary unit ${unitRef} measure ${measure} is not an ISO 4217 currency`,
            );
          }
        }
      }
      if (decimals === null && precision === null) {
        push(
          `et-gaap:${name}: numeric item declares neither decimals nor precision`,
        );
      }
      if (!DECIMAL_RE.test(value)) {
        push(
          `et-gaap:${name}: ${JSON.stringify(value)} is not a valid decimal`,
        );
      } else if (decimals !== null && decimals !== 'INF') {
        const claimed = Number(decimals);
        const dp = value.includes('.') ? value.split('.')[1].length : 0;
        if (Number.isFinite(claimed) && claimed >= 0 && dp > claimed) {
          push(
            `et-gaap:${name}: value ${value} has ${dp} decimal places but claims decimals="${decimals}"`,
          );
        }
      }
    } else if (unitRef !== null) {
      push(`et-gaap:${name}: non-numeric item must not carry a unitRef`);
    }

    // 9. Same concept + context reported twice with different values.
    const key = `${name}@${contextRef}`;
    const prior = seen.get(key);
    if (prior !== undefined && prior !== value) {
      push(
        `et-gaap:${name} reported twice for context ${contextRef} with different values (${prior} vs ${value})`,
      );
    }
    seen.set(key, value);
  }

  return { valid: errors.length === 0, errors };
}
