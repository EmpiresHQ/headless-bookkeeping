import type { DocumentDetails } from '../api';
import { KeyValue, ListGroup } from '../ui/List';
import { absoluteDateFromIso, vatRatePct } from './format';
import { signedEuros } from '../lib/money';

export function TriageDocumentContext({
  details,
}: {
  details: DocumentDetails | undefined;
}) {
  const classification = details?.classification;
  const ocr = details?.ocr;

  return (
    <>
      {classification?.ok === true && (
        <ListGroup label="Extracted facts">
          <KeyValue
            k="Amount"
            v={signedEuros(-classification.result.gross_amount)}
          />
          <KeyValue
            k="VAT"
            v={formatVat(
              classification.result.gross_amount,
              classification.result.vat_amount,
            )}
          />
          <KeyValue
            k="Date"
            v={absoluteDateFromIso(classification.result.tax_point_date)}
          />
          <KeyValue k="Category" v={classification.result.category || '—'} />
          <KeyValue
            k="AI confidence"
            v={
              <span
                className={
                  classification.result.confidence >= 0.9
                    ? 'text-ok'
                    : 'text-warn'
                }
              >
                {classification.result.confidence.toFixed(2)}
              </span>
            }
          />
        </ListGroup>
      )}
      {ocr?.ok === true && (
        <details className="mx-3.5 mb-3 rounded-lg bg-surface px-3.5 py-3">
          <summary className="cursor-pointer text-[13px] font-semibold">
            OCR text
          </summary>
          <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-[12px] text-ink-2">
            {ocr.markdown}
          </pre>
        </details>
      )}
    </>
  );
}

function formatVat(gross: number, vat: number): string {
  const rate = vatRatePct(gross, vat);
  return rate === null
    ? `${(vat / 100).toFixed(2)} €`
    : `${(vat / 100).toFixed(2)} € (${rate}%)`;
}
