import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SearchInput } from './SearchInput';

function Controlled(props: { labelled?: boolean }) {
  const [q, setQ] = useState('');
  return (
    <>
      <span id="lbl">Supplier</span>
      <span id="hint">Matches name and reg. code</span>
      {props.labelled ? (
        <SearchInput
          value={q}
          onChange={setQ}
          aria-labelledby="lbl"
          aria-describedby="hint"
          placeholder="Search suppliers…"
        />
      ) : (
        <SearchInput
          value={q}
          onChange={setQ}
          aria-label="Search suppliers"
          placeholder="Search suppliers…"
        />
      )}
    </>
  );
}

describe('SearchInput (#287)', () => {
  it('keeps its explicit name after typing replaces the placeholder', async () => {
    render(<Controlled />);
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search suppliers' }),
      'wolt',
    );
    expect(
      screen.getByRole('searchbox', { name: 'Search suppliers' }),
    ).toHaveValue('wolt');
  });

  it("keeps a caller's aria-labelledby and aria-describedby", async () => {
    render(<Controlled labelled />);
    const box = screen.getByRole('searchbox', { name: 'Supplier' });
    await userEvent.type(box, 'x');
    expect(box).toHaveAccessibleName('Supplier');
    expect(box).toHaveAccessibleDescription('Matches name and reg. code');
  });

  it('refuses to compile without a name', () => {
    // @ts-expect-error — a placeholder alone is not an accessible name.
    const el = <SearchInput value="" onChange={() => {}} placeholder="x" />;
    expect(el).toBeTruthy();
  });
});
