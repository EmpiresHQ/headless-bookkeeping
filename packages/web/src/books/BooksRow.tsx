import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { POSITION_ROW } from '../lib/listPosition';
import { READABLE, ROW_BODY, ROW_IDENTITY, ROW_TRAILING } from '../ui/List';

/**
 * Books list rows with readable desktop columns (issue #283).
 *
 * ONE DOM for every width — no second (hidden) copy of the row, the link or
 * its text. Below `xl` (1280px) it is the familiar ListRow card: title,
 * " · "-joined meta line, amount over status on the right (#275 wrapping).
 * From `xl` the wrappers turn `display: contents` and the link itself
 * becomes a grid, so title, every meta cell, amount and status line up
 * under a per-group column header. Each segment names its columns once
 * (`BooksColumns`), used by both the header and every row — the tracks are
 * fixed/fr only, never content-sized, so separate row grids still align.
 *
 * Only the cells' separators and label prefixes differ by width
 * (`xl:hidden` / `xl:sr-only`): the link's accessible name stays the same
 * text as the stacked row. The link is never `display: contents` (it keeps
 * its box, focus ring and stretched ::after), and `leading` stays a SIBLING
 * of the link, exactly as ListRow (#246).
 */

export interface BooksColumns {
  /** Literal Tailwind `xl:grid-cols-[…]` class (title, meta…, [amount],
   *  status, chevron) — a literal, so the build sees it. */
  grid: string;
  /** Header labels, one per track except the chevron. */
  labels: readonly string[];
  /** Index of the right-aligned amount column in `labels`, if any. */
  amountAt?: number;
  /** Width of the `leading` slot at xl (e.g. the document thumbnail). */
  leading?: string;
}

/** One meta cell: an always-present grid cell at xl (an empty value keeps
 *  its column), joined into the stacked subtitle below xl. `prefix` is
 *  spoken and shown on the card, but only spoken in columns — the header
 *  already names it. */
export interface BooksCell {
  key: string;
  value: ReactNode;
  prefix?: string;
  /** Shown in its column only: the stacked card already shows this value
   *  as its fallback title, so the card does not repeat it. */
  xlOnly?: boolean;
}

const ROW_CLS =
  'relative flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0 xl:py-2.5';

/** Columns header for one ListGroup (xl only). Visual: the rows' own text
 *  already carries every value (and prefix) for assistive tech. */
export function BooksColumnsHeader({ columns }: { columns: BooksColumns }) {
  return (
    <div
      aria-hidden
      data-books-columns
      className="hidden items-center gap-3 border-b border-line px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2 xl:flex"
    >
      {columns.leading != null && (
        <span className={`flex-none ${columns.leading}`} />
      )}
      <div className={`min-w-0 flex-1 xl:grid xl:gap-x-4 ${columns.grid}`}>
        {columns.labels.map((l, i) => (
          <span
            key={l}
            className={`min-w-0 ${i === columns.amountAt ? 'text-right' : ''}`}
          >
            {l}
          </span>
        ))}
        <span />
      </div>
    </div>
  );
}

export function BooksRow({
  to,
  columns,
  leading,
  title,
  titleXl,
  cells,
  amount,
  status,
}: {
  to: string;
  columns: BooksColumns;
  leading?: ReactNode;
  title: ReactNode;
  /** The first column's own value when `title` is a fallback from another
   *  column (e.g. "No supplier" where the card is titled by the category):
   *  the card keeps its familiar title, the column keeps its meaning. Only
   *  one of the two is displayed (and exposed) at a width. */
  titleXl?: ReactNode;
  cells: readonly BooksCell[];
  /** Right-aligned exact amount (rows with trailing figures). */
  amount?: ReactNode;
  /** Status chip: under the amount on the card; its own column at xl. With
   *  no amount it sits under the identity, as ListRow's `chip`. */
  status: ReactNode;
}) {
  let shown = 0;
  const meta = cells.map((c) => {
    const empty = c.value == null || c.value === '';
    const onCard = !empty && c.xlOnly !== true;
    const sep = onCard && shown++ > 0;
    return (
      <span
        key={c.key}
        data-books-cell={c.key}
        className={`min-w-0 ${onCard ? '' : 'hidden xl:block'}`}
      >
        {sep && <span className="xl:hidden"> · </span>}
        {c.prefix != null && !empty && (
          <span className="xl:sr-only">{c.prefix} </span>
        )}
        {c.value}
      </span>
    );
  });
  const statusCell = <div className="mt-0.5 min-w-0 xl:mt-0">{status}</div>;
  return (
    <div className={ROW_CLS}>
      {leading != null && (
        <div className={`flex-none ${columns.leading ?? ''}`}>{leading}</div>
      )}
      <Link
        to={to}
        {...{ [POSITION_ROW]: '' }}
        className={`flex min-w-0 flex-1 items-center gap-3 after:absolute after:inset-0 xl:grid xl:gap-x-4 ${columns.grid}`}
      >
        <div className={`${ROW_BODY} xl:contents`}>
          <div className={`${ROW_IDENTITY} xl:contents`}>
            <div
              data-books-title
              className="min-w-0 text-[14.5px] font-semibold"
            >
              {titleXl == null ? (
                title
              ) : (
                <>
                  <span className="xl:hidden">{title}</span>
                  <span className="hidden font-normal italic text-ink-2 xl:inline">
                    {titleXl}
                  </span>
                </>
              )}
            </div>
            <div
              data-books-meta
              className="text-[12.5px] text-ink-2 xl:contents xl:text-[13px]"
            >
              {meta}
            </div>
            {amount == null && statusCell}
          </div>
          {amount != null && (
            <div className={`${ROW_TRAILING} xl:contents`}>
              {/* Amount track: sized for ordinary figures (9rem), and an
                  unbroken huge one (9007199254740991 cents) wraps INSIDE its
                  own cell — never over Status. Every digit and the currency
                  stay visible. */}
              <div className={`min-w-0 xl:text-right ${READABLE}`}>
                {amount}
              </div>
              {statusCell}
            </div>
          )}
        </div>
        <span aria-hidden className="flex-none text-base text-chevron">
          ›
        </span>
      </Link>
    </div>
  );
}
