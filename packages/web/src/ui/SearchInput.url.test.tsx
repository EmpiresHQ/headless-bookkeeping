import { render, screen, waitFor } from '@testing-library/react';
import {
  RouterProvider,
  createMemoryRouter,
  useSearchParams,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSetFilterParam } from '../books/filters';
import { SearchInput } from './SearchInput';

/** The list searches (Books, Inbox, Bank statement) keep their text in ?q=. */
function UrlSearch() {
  const [params] = useSearchParams();
  const setParam = useSetFilterParam();
  return (
    <SearchInput
      aria-label="Search"
      value={params.get('q') ?? ''}
      onChange={(v) => setParam('q', v === '' ? null : v)}
    />
  );
}

const setValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)!.set!;

/** A browser key: the new character lands on whatever the field shows now,
 *  one native input event, no act() — so work React defers (a router
 *  transition) has NOT run before the next key, as with fast typing. */
function key(box: HTMLInputElement, ch: string) {
  setValue.call(box, box.value + ch);
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SearchInput bound to ?q= (#303)', () => {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  let actEnv: boolean | undefined;
  beforeEach(() => {
    actEnv = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = false;
  });
  afterEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = actEnv;
  });

  it('keeps every key typed before the router commits the last one', async () => {
    const router = createMemoryRouter([{ path: '/', element: <UrlSearch /> }], {
      initialEntries: ['/?seg=expenses'],
    });
    render(<RouterProvider router={router} />);
    const box = screen.getByRole<HTMLInputElement>('searchbox', {
      name: 'Search',
    });
    for (const ch of '1234.56') key(box, ch);
    expect(box).toHaveValue('1234.56');
    await waitFor(() =>
      expect(router.state.location.search).toBe('?seg=expenses&q=1234.56'),
    );
    expect(box).toHaveValue('1234.56');
  });

  it('follows ?q= changed from outside the field (Reset, Back)', async () => {
    const router = createMemoryRouter([{ path: '/', element: <UrlSearch /> }], {
      initialEntries: ['/?q=old'],
    });
    render(<RouterProvider router={router} />);
    const box = screen.getByRole<HTMLInputElement>('searchbox', {
      name: 'Search',
    });
    expect(box).toHaveValue('old');
    key(box, 'x');
    await waitFor(() => expect(router.state.location.search).toBe('?q=oldx'));
    await router.navigate('/');
    await waitFor(() => expect(box).toHaveValue(''));
    await router.navigate('/?q=next');
    await waitFor(() => expect(box).toHaveValue('next'));
  });
});
