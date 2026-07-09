import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSeg } from '../lib/useSeg';
import { LargeTitleHeader } from '../shell/Headers';
import { SearchInput } from '../ui/SearchInput';
import { SegmentedControl } from '../ui/SegmentedControl';
import {
  CreateMenu,
  NewExpenseSheet,
  NewInvoiceSheet,
  UploadSheet,
  type CreateKind,
} from './create';
import { CreditNotesSegment } from './CreditNotesSegment';
import { DocumentsSegment } from './DocumentsSegment';
import { ExpensesSegment } from './ExpensesSegment';
import { InvoicesSegment } from './InvoicesSegment';

const SEGMENTS = ['expenses', 'invoices', 'documents', 'credit-notes'] as const;
type Segment = (typeof SEGMENTS)[number];

/** Params owned by individual segments — dropped on segment switch (a Draft
 *  filter has no meaning on Documents); ?q= survives. */
const SEGMENT_PARAMS = ['status', 'nodoc', 'dstatus'] as const;

export function BooksScreen() {
  const [params, setParams] = useSearchParams();
  const [seg, setSeg] = useSeg<Segment>(SEGMENTS, 'expenses', SEGMENT_PARAMS);
  const q = params.get('q') ?? '';
  const [createOpen, setCreateOpen] = useState(false);
  const [sheet, setSheet] = useState<CreateKind | null>(null);

  const setQ = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === '') p.delete('q');
    else p.set('q', next);
    setParams(p, { replace: true });
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader
        title="Books"
        trailing={
          <button
            type="button"
            aria-label="Add to the books"
            onClick={() => setCreateOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-lg font-bold text-white"
          >
            +
          </button>
        }
      />
      <div className="space-y-2.5 px-4 pb-3">
        <SegmentedControl
          options={[
            { value: 'expenses' as const, label: 'Expenses' },
            { value: 'invoices' as const, label: 'Invoices' },
            { value: 'documents' as const, label: 'Documents' },
            { value: 'credit-notes' as const, label: 'Credit notes' },
          ]}
          value={seg}
          onChange={setSeg}
        />
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="Counterparty, amount, category…"
        />
      </div>
      {seg === 'expenses' && <ExpensesSegment q={q} />}
      {seg === 'invoices' && <InvoicesSegment q={q} />}
      {seg === 'documents' && <DocumentsSegment q={q} />}
      {seg === 'credit-notes' && <CreditNotesSegment q={q} />}

      <CreateMenu
        open={createOpen}
        onOpenChange={setCreateOpen}
        onPick={(kind) => {
          setCreateOpen(false);
          setSheet(kind);
        }}
      />
      {/* Sheets reset by REMOUNT — rendered only while open. */}
      {sheet === 'expense' && (
        <NewExpenseSheet open onOpenChange={(o) => !o && setSheet(null)} />
      )}
      {sheet === 'invoice' && (
        <NewInvoiceSheet open onOpenChange={(o) => !o && setSheet(null)} />
      )}
      {sheet === 'upload' && (
        <UploadSheet open onOpenChange={(o) => !o && setSheet(null)} />
      )}
    </div>
  );
}
