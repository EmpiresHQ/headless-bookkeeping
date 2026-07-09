import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useSeg } from './useSeg';

const SEGS = ['all', 'open', 'done'] as const;

function Probe({ clear }: { clear?: readonly string[] }) {
  const [seg, setSeg] = useSeg(SEGS, 'all', clear);
  const location = useLocation();
  return (
    <div>
      <span data-testid="seg">{seg}</span>
      <span data-testid="search">{location.search}</span>
      <button onClick={() => setSeg('done')}>go-done</button>
    </div>
  );
}

const mount = (initial: string, clear?: readonly string[]) =>
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Probe clear={clear} />
    </MemoryRouter>,
  );

describe('useSeg (shared ?seg= + legacy ?tab= alias)', () => {
  it('reads ?seg=', () => {
    mount('/x?seg=open');
    expect(screen.getByTestId('seg').textContent).toBe('open');
  });

  it('accepts legacy ?tab= as an alias', () => {
    mount('/x?tab=open');
    expect(screen.getByTestId('seg').textContent).toBe('open');
  });

  it('falls back on unknown values (?seg wins over ?tab)', () => {
    mount('/x?seg=bogus');
    expect(screen.getByTestId('seg').textContent).toBe('all');
  });

  it('write round-trip: sets seg, drops tab, clears listed params, PRESERVES the rest', () => {
    mount('/x?tab=open&q=milk&status=draft', ['status']);
    fireEvent.click(screen.getByText('go-done'));
    expect(screen.getByTestId('seg').textContent).toBe('done');
    const search = new URLSearchParams(
      screen.getByTestId('search').textContent ?? '',
    );
    expect(search.get('seg')).toBe('done');
    expect(search.get('tab')).toBeNull();
    expect(search.get('status')).toBeNull();
    expect(search.get('q')).toBe('milk');
  });
});
