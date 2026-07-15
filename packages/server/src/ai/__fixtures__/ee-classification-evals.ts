/**
 * EE Pass-2 classification eval fixtures.
 *
 * Case zero is the REAL production incident (2026-07-15): supplier "Mobile
 * Trade OÜ" emailed an order confirmation (Tellimus nr 28965) AND the actual
 * invoice (Arve nr 2599) for ONE €52.00 purchase. The model classified BOTH as
 * `invoice`/`new_expense` (confidence 0.95 and 1.0) and the pipeline auto-posted
 * both — double-booking the same purchase, with a VAT mismatch (10.00 vs 10.06)
 * because the order rounds to whole euros while the invoice computes 24% exactly.
 *
 * The `markdown` fields below are the VERBATIM OCR artifacts captured on prod
 * (data/artifacts/ocr/139.md and 141.md) — do not paraphrase them; they are the
 * exact input that produced the misclassification.
 *
 * `postable: false` means the intake router must NOT auto-post this document
 * (it should park to needs_triage). `postable: true` means it is a primary tax
 * document that may auto-post when confidence clears the threshold.
 */

/** The document_type labels this eval asserts against (superset incl. Task 1's additions). */
export type EvalDocumentType =
  | 'invoice'
  | 'receipt'
  | 'bank_statement'
  | 'credit_note'
  | 'order_confirmation'
  | 'proforma'
  | 'other';

export interface ClassificationEvalCase {
  name: string;
  /** Verbatim OCR markdown fed to Pass-2. */
  markdown: string;
  expect: {
    document_type: EvalDocumentType;
    /** Optional expected `kind`; omitted when only document_type matters. */
    kind?: 'new_expense' | 'not_a_document' | 'unknown';
    /** Must the router refrain from auto-posting this? */
    postable: boolean;
  };
  note?: string;
}

// ── Case zero: the real incident (verbatim prod OCR) ─────────────────────────

/** data/artifacts/ocr/139.md — the ORDER CONFIRMATION (Tellimus). Non-postable. */
const INCIDENT_ORDER_TELLIMUS = `Mobile Trade OÜ
Tellimuse nr.: 28965
Kuupäev: 15.07.2026
Tellija nimi: Aleksei Revin
Tellija e-posti aadress: info@4j.ee
Makse staatus: Makstud
Valuuta: EUR
Tooteid kokku: 1

Arve saaja:
override OÜ
Aleksei Revin
Alasi 5-30
11713 Tallinn
Harjumaa
Eesti
E-post: info@4j.ee
Telefon: 53012200
Kauba saaja:
override OÜ
Aleksei Revin
Alasi 5-30
11713 Tallinn
Harjumaa
Eesti
E-post: info@4j.ee
Telefon: 53012200

  Kood Nimetus Hind Kogus Summa
1 3083 Xiaomi TV Stick 4K (2nd Gen)
Tootekood: 3083
EAN Kood: 6941948707108
Tarneaeg: Esinduses kohal
52 1 52
2   Transport (Tulen ise esindusse / maksmine
pangalingiga või pangaülekandega)
0 1 0
Kokku: 42 €
Käibemaks: 10 €
Kokku tasuda: 52 €
Powered by TCPDF (www.tcpdf.org)
ShopRoller.com

Mobile Trade OÜ
Aia 7
10111 Tallinn
Eesti
Tel.: +3725086060
E-post: info@mobiletrade.ee
KMKR Nr: EE101079244
Reg. Nr: 11027195
Pank: Swedbank AS
IBAN: EE612200221050972938
SWIFT: HABAEE2X
Pank: LHV Pank AS
IBAN: EE567700771002094453
SWIFT: LHVBEE22`;

/** data/artifacts/ocr/141.md — the real INVOICE (Arve). Postable primary document. */
const INCIDENT_INVOICE_ARVE = `Arve saaja
override OÜ
Arvenr2599/Tellimus nr.28965
Kuupäev
Maksetähtpäev
Viivis
15.07.2026
22.07.2026
0,1% päevas
Alasi tn 5-30
Tallinn
11713 Harjumaa
Rg-kood 17499653
KMKR nr EE102983355
MobileTradeOÜ
Aia tn 7
Tallinn
10111 Harjumaa
Rg-kood 11027195
KMKR nr EE101079244
Kirjeldus Kogus Ühik Hind km-ga Hind km-ta Summa km-ta
Xiaomi TV Stick 4K (2nd Gen) 1 tk 52,00 41,94 41,94
Seerianumber: 66444-800000068039
Garantii 12 kuud
Summa km-ta 24% 41,94
Käibemaks 24% 10,06
Arvekokku (EUR) 52,00
Arve väljastas: Andrus Jõgeva Võttis vastu:
Telefon +372 631 1699
Mobiil +372 508 6060
E-post info@mobiletrade.ee
LHV Pank IBAN EE567700771002094453
SWIFT LHVBEE22
Swedbank IBAN EE612200221050972938
SWIFT HABAEE2X`;

export const EE_CLASSIFICATION_EVALS: ClassificationEvalCase[] = [
  {
    name: 'incident: Tellimus (order confirmation) must NOT post',
    markdown: INCIDENT_ORDER_TELLIMUS,
    expect: { document_type: 'order_confirmation', postable: false },
    note:
      'Real prod doc 139. Titled "Tellimuse nr.", marked "Makstud", VAT rounded ' +
      'to whole euros (Kokku 42 / Käibemaks 10). This is the file that was wrongly ' +
      'auto-posted as an expense.',
  },
  {
    name: 'incident: Arve (real invoice) posts as new_expense',
    markdown: INCIDENT_INVOICE_ARVE,
    expect: { document_type: 'invoice', kind: 'new_expense', postable: true },
    note:
      'Real prod doc 141. "Arve nr 2599 / Tellimus nr. 28965", has Maksetähtpäev ' +
      'and an exact 24% breakdown (41,94 + 10,06 = 52,00). This is the primary ' +
      'tax document — the one that SHOULD book.',
  },
  {
    name: 'over-hardening guard: an Arve that references an order number stays an invoice',
    markdown: `Arve nr 3000 / Tellimus nr. 12345
Kuupäev 15.07.2026
Maksetähtpäev 29.07.2026
Müüja: Example OÜ  KMKR nr EE100000001
Ostja: override OÜ  KMKR nr EE102983355
Kirjeldus Kogus Hind km-ta Summa km-ta
USB-C kaabel 2 tk 5,00 10,00
Summa km-ta 24% 10,00
Käibemaks 24% 2,40
Arve kokku (EUR) 12,40`,
    expect: { document_type: 'invoice', kind: 'new_expense', postable: true },
    note:
      'The invoice mentioning its order number in the header must NOT be dragged ' +
      'to order_confirmation — this is the recall-collapse guard for prompt hardening.',
  },
  {
    name: 'ettemaksuarve (prepayment/proforma) must NOT post',
    markdown: `ETTEMAKSUARVE nr EA-77
Kuupäev 15.07.2026
Müüja: Example OÜ  KMKR nr EE100000001
Ostja: override OÜ
Kirjeldus: Ettemaks tellimuse 555 eest
Summa km-ta 24% 100,00
Käibemaks 24% 24,00
Kokku tasuda (EUR) 124,00
Palun tasuda enne kauba väljastamist.`,
    expect: { document_type: 'proforma', postable: false },
    note: 'Prepayment invoice — not the final tax document; park it.',
  },
  {
    name: 'pakkumine (quote) must NOT post',
    markdown: `HINNAPAKKUMINE nr P-2026-014
Kuupäev 15.07.2026
Kehtib kuni 30.07.2026
Müüja: Example OÜ
Toode: Sülearvuti Dell XPS 13
Hind km-ta 900,00  Käibemaks 24% 216,00  Kokku 1116,00
See on mittesiduv hinnapakkumine, mitte arve.`,
    expect: { document_type: 'proforma', postable: false },
    note: 'A quote is not an accounting document to post.',
  },
  {
    name: 'saateleht (delivery note) is not an accounting document',
    markdown: `SAATELEHT nr SL-908
Kuupäev 15.07.2026
Saatja: Example OÜ
Saaja: override OÜ, Alasi tn 5-30, Tallinn
Kaup: Xiaomi TV Stick 4K (2nd Gen) — 1 tk
Kohaletoimetamise kinnitus. Summasid ei kuvata.`,
    expect: { document_type: 'other', kind: 'not_a_document', postable: false },
    note: 'Delivery note with no payable amount — not_a_document.',
  },
];
