import { useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSeg } from '../lib/useSeg';
import { useSheet } from '../lib/useSheet';
import { LargeTitleHeader } from '../shell/Headers';
import { SearchInput } from '../ui/SearchInput';
import { SegmentedControl } from '../ui/SegmentedControl';
import { UploadDocumentSheet } from '../upload/UploadDocumentSheet';
import { BooksCreate } from './BooksEmpty';
import { DateOrderControls } from './DateOrderControls';
import { CreateMenu, NewExpenseSheet, NewInvoiceSheet } from './create';
import { CreditNotesSegment } from './CreditNotesSegment';
import { DocumentsSegment } from './DocumentsSegment';
import { ExpensesSegment } from './ExpensesSegment';
import {
  BOOKS_ORDER,
  BOOKS_SEARCH,
  BooksResetSignal,
  SEGMENT_PARAMS,
  useSetFilterParam,
} from './filters';
import { parseBooksOrder } from './listOrder';
import { InvoicesSegment } from './InvoicesSegment';

const SEGMENTS = ['expenses', 'invoices', 'documents', 'credit-notes'] as const;
type Segment = (typeof SEGMENTS)[number];

export function BooksScreen() {
  const [params] = useSearchParams();
  const [seg, switchSeg] = useSeg<Segment>(
    SEGMENTS,
    'expenses',
    SEGMENT_PARAMS,
  );
  // Tapping the segment already on screen is not a switch: it must not drop
  // its filters (useSeg clears the segment params on every write).
  const setSeg = (next: Segment) => {
    if (next !== seg) switchSeg(next);
  };
  const q = params.get('q') ?? '';
  const search = BOOKS_SEARCH[seg];
  // ?from= ?to= ?sort= survive a segment switch like ?q= (#279), parsed for
  // the segment on screen (its date field, whether it has amounts).
  const order = parseBooksOrder(params, BOOKS_ORDER[seg]);
  const scopeId = useId();
  const setParam = useSetFilterParam();
  const [createOpen, setCreateOpen] = useState(false);
  const expenseSheet = useSheet();
  const invoiceSheet = useSheet();
  const uploadSheet = useSheet();
  const sheetOf = {
    expense: expenseSheet,
    invoice: invoiceSheet,
    upload: uploadSheet,
  } as const;

  // ?q= survives a segment switch (a counterparty name is useful across
  // segments); each segment's summary then says what the search looks at
  // there (#276). Replace-history, the entry's state kept.
  const setQ = (next: string) => setParam('q', next === '' ? null : next);
  // Counts Resets, so the date inputs also drop an incomplete native entry
  // that never reached the URL (#279) — no remount, typing is untouched.
  const [resets, setResets] = useState(0);
  const [signalReset] = useState(() => () => setResets((n) => n + 1));

  return (
    <BooksResetSignal.Provider value={signalReset}>
      <div className="mx-auto max-w-3xl pb-6">
        <LargeTitleHeader
          title="Books"
          trailing={
            <button
              type="button"
              aria-label="Add to the books"
              onClick={() => setCreateOpen(true)}
              className="-m-1.5 flex h-11 w-11 items-center justify-center"
            >
              {/* 44px touch box, 32px visual (#273); the -m-1.5 overhang sits
                in header padding so the title row keeps its height. */}
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-lg font-bold text-white">
                +
              </span>
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
            placeholder={search.placeholder}
            aria-label={`Search ${search.noun}`}
            aria-describedby={scopeId}
          />
          <span id={scopeId} className="sr-only">
            Matches {search.scope}.
          </span>
          <DateOrderControls
            segment={seg}
            state={order}
            params={params}
            resets={resets}
          />
        </div>
        {/* An empty segment's create action opens the same sheet as the +
          menu (#280). */}
        <BooksCreate.Provider value={(kind) => sheetOf[kind].open()}>
          {seg === 'expenses' && <ExpensesSegment q={q} order={order} />}
          {seg === 'invoices' && <InvoicesSegment q={q} order={order} />}
          {seg === 'documents' && <DocumentsSegment q={q} order={order} />}
          {seg === 'credit-notes' && <CreditNotesSegment q={q} order={order} />}
        </BooksCreate.Provider>

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
          <UploadDocumentSheet
            key={`upload-${uploadSheet.epoch}`}
            open={uploadSheet.isOpen}
            onOpenChange={(o) => !o && uploadSheet.close()}
          />
        )}
      </div>
    </BooksResetSignal.Provider>
  );
}
