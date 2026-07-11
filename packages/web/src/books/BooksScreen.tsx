import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSeg } from '../lib/useSeg';
import { useSheet } from '../lib/useSheet';
import { LargeTitleHeader } from '../shell/Headers';
import { SearchInput } from '../ui/SearchInput';
import { SegmentedControl } from '../ui/SegmentedControl';
import {
  CreateMenu,
  NewExpenseSheet,
  NewInvoiceSheet,
  UploadSheet,
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
  const expenseSheet = useSheet();
  const invoiceSheet = useSheet();
  const uploadSheet = useSheet();
  const sheetOf = {
    expense: expenseSheet,
    invoice: invoiceSheet,
    upload: uploadSheet,
  } as const;

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
          sheetOf[kind].open();
        }}
      />
      {/* Sheets reset by REMOUNT-ON-OPEN (epoch key) — mounted from first
          open so vaul runs its close lifecycle (Plan 07 Task 7). */}
      {expenseSheet.epoch > 0 && (
        <NewExpenseSheet
          key={`expense-${expenseSheet.epoch}`}
          open={expenseSheet.isOpen}
          onOpenChange={(o) => !o && expenseSheet.close()}
        />
      )}
      {invoiceSheet.epoch > 0 && (
        <NewInvoiceSheet
          key={`invoice-${invoiceSheet.epoch}`}
          open={invoiceSheet.isOpen}
          onOpenChange={(o) => !o && invoiceSheet.close()}
        />
      )}
      {uploadSheet.epoch > 0 && (
        <UploadSheet
          key={`upload-${uploadSheet.epoch}`}
          open={uploadSheet.isOpen}
          onOpenChange={(o) => !o && uploadSheet.close()}
        />
      )}
    </div>
  );
}
