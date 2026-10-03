import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { POSITION_ROW } from '../lib/listPosition';
import { AmountText } from '../ui/AmountText';
import { Chip } from '../ui/Chip';
import { BooksColumnsHeader, BooksRow, type BooksColumns } from './BooksRow';

/**
 * Issue #283 — Books rows: ONE DOM that is the stacked card below xl and
 * aligned columns from xl. These pin structure and content (one link per
 * row, the leading control outside it (#246), a column header for sighted
 * users only, every value in its own cell); layout, alignment and wrapping
 * are checked in a real browser.
 */

const COLUMNS: BooksColumns = {
  grid: 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(9rem,1fr)_5.5rem_0.75rem]',
  labels: ['Supplier', 'Invoice no.', 'Amount', 'Status'],
  amountAt: 2,
  leading: 'xl:w-9',
};

function mount(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe('BooksRow (issue #283)', () => {
  it('one link per row, same accessible text as the card, the grid on the link itself', () => {
    mount(
      <BooksRow
        to="/books/expenses/1"
        columns={COLUMNS}
        title="Fixture supplier"
        cells={[
          { key: 'number', value: 'DESKTOP-1', prefix: 'Invoice no.' },
          { key: 'date', value: '10 Sep' },
        ]}
        amount={<AmountText cents={-2345} currency="EUR" />}
        status={<Chip>draft</Chip>}
      />,
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    const link = links[0];
    expect(link).toHaveAttribute('href', '/books/expenses/1');
    expect(link).toHaveAttribute(POSITION_ROW);
    // Card text: separators and the label prefix (spoken in columns too).
    expect(link.querySelector('[data-books-meta]')?.textContent).toBe(
      'Invoice no. DESKTOP-1 · 10 Sep',
    );
    expect(link).toHaveTextContent(
      /Fixture supplier.*Invoice no\. DESKTOP-1 · 10 Sep.*−23\.45 €.*draft/,
    );
  });

  it('keeps an empty column in place and hides it only on the card', () => {
    mount(
      <BooksRow
        to="/books/expenses/2"
        columns={COLUMNS}
        title="Fixture supplier"
        cells={[
          { key: 'number', value: null, prefix: 'Invoice no.' },
          { key: 'date', value: '10 Sep' },
        ]}
        amount={<AmountText cents={-1} currency="EUR" />}
        status={<Chip>draft</Chip>}
      />,
    );
    // The empty column's cell is still there (alignment), with no text.
    const empty = document.querySelector('[data-books-cell="number"]')!;
    expect(empty.textContent).toBe('');
    // The first shown cell has no leading separator.
    expect(
      document.querySelector('[data-books-cell="date"]')?.textContent,
    ).toBe('10 Sep');
  });

  it('a fallback title keeps the card familiar and the column honest', () => {
    mount(
      <BooksRow
        to="/books/expenses/3"
        columns={COLUMNS}
        title="fuel"
        titleXl="No supplier"
        cells={[{ key: 'category', value: 'fuel', xlOnly: true }]}
        status={<Chip>draft</Chip>}
      />,
    );
    // Both titles live in the one title cell (one per width), inside the
    // row's single link; the category column keeps its value.
    const title = document.querySelector<HTMLElement>('[data-books-title]')!;
    expect(within(title).getByText('fuel')).toBeInTheDocument();
    expect(within(title).getByText('No supplier')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(
      document.querySelector('[data-books-cell="category"]'),
    ).toHaveTextContent('fuel');
  });

  it('the maximum safe amount stays whole, in its own cell', () => {
    mount(
      <BooksRow
        to="/books/expenses/4"
        columns={COLUMNS}
        title="Fixture supplier"
        cells={[]}
        amount={<AmountText cents={-9007199254740991} currency="EUR" />}
        status={<Chip>draft</Chip>}
      />,
    );
    const amount = screen.getByText(/90071992547409\.91/);
    expect(amount).toHaveTextContent('−90071992547409.91 €');
    // Exact amount and currency, in a cell separate from Status.
    expect(amount.parentElement).not.toContainElement(
      screen.getByText('draft'),
    );
  });

  it('the leading control stays a sibling of the link (#246)', () => {
    mount(
      <BooksRow
        to="/books/documents/9"
        columns={COLUMNS}
        leading={<button type="button">Preview</button>}
        title="arve.pdf"
        cells={[]}
        status={<Chip>processed</Chip>}
      />,
    );
    const preview = screen.getByRole('button', { name: 'Preview' });
    expect(preview.closest('a')).toBeNull();
    expect(screen.getByRole('link')).not.toContainElement(preview);
  });

  it('the column header is visual only and matches the tracks', () => {
    mount(<BooksColumnsHeader columns={COLUMNS} />);
    const header = document.querySelector('[data-books-columns]')!;
    expect(header).toHaveAttribute('aria-hidden', 'true');
    expect(
      [...header.querySelectorAll('span')]
        .map((s) => s.textContent)
        .filter(Boolean),
    ).toEqual(COLUMNS.labels);
  });
});
