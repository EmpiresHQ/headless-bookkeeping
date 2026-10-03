import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../auth';
import { buildRoutes } from './router';

/**
 * Issue #370 — the route guard's side of a blocked-POP restoration, through
 * the PRODUCTION route tree. While lib/popRestoration reports an episode
 * (browser not yet back on the router's entry), no accepted navigation may
 * write history: a clean PUSH/REPLACE is held and decided when the episode
 * ends — against the guards as they are THEN — and an answered question
 * proceeds only after it; a stranded episode (restoring failed) cancels
 * them. The controller is a controlled stand-in here, so only the guard's
 * decisions are claimed; real browser history (burst traversals, entry
 * keys, the Back/Forward trail) is checked by
 * scripts/check-pop-restoration.mjs.
 */

const episode = vi.hoisted(() => ({
  busy: false,
  stranded: false,
  ends: new Set<(restored: boolean) => void>(),
  blocked: [] as string[],
}));

vi.mock('../lib/popRestoration', () => ({
  SETTLE_MS: 150,
  popRestoration: () => ({
    blocked: (key: string) => episode.blocked.push(key),
    busy: () => episode.busy,
    onEnd: (fn: (restored: boolean) => void) => {
      if (!episode.busy || episode.stranded) {
        fn(!episode.busy);
        return () => undefined;
      }
      episode.ends.add(fn);
      return () => {
        episode.ends.delete(fn);
      };
    },
  }),
}));

/** Restored (the episode ends) or stranded (restoring failed). */
function endEpisode(restored = true) {
  if (restored) episode.busy = false;
  else episode.stranded = true;
  const fns = [...episode.ends];
  episode.ends.clear();
  act(() => fns.forEach((fn) => fn(restored)));
}

const ORG = {
  id: 1,
  country: 'EE',
  base_currency: null,
  vat_registered: true,
  vat_registration_kind: 'ordinary',
  input_vat_entitlement: 'full',
  input_vat_deduction_permille: null,
  org_type: 'company',
  created_at: 0,
  name: 'Acme OÜ',
  registry_code: null,
  vat_registration_number: null,
  iban: null,
};

function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (/\/api\/organization$/.test(url)) return json(ORG);
    if (url.includes('/api/expenses')) return json({ expenses: [] });
    if (url.includes('/api/categories')) return json({ categories: [] });
    if (url.includes('/api/triage/needs-triage')) return json({ items: [] });
    if (url.includes('/api/approvals')) return json({ approvals: [] });
    if (url.includes('/api/sales-invoices')) return json({ invoices: [] });
    if (url.includes('/api/entities')) return json({ entities: [] });
    if (url.includes('/api/documents')) return json({ documents: [] });
    if (url.includes('/api/credit-notes')) return json({ credit_notes: [] });
    if (url.includes('/admin/settings')) return json({ settings: [] });
    return json([]);
  });
}

const path = (r: {
  state: { location: { pathname: string; search: string } };
}) => r.state.location.pathname + r.state.location.search;

function renderAt(entries: string[]) {
  const router = createMemoryRouter(buildRoutes(), {
    initialEntries: entries,
    initialIndex: entries.length - 1,
  });
  const view = render(<RouterProvider router={router} />);
  // Committed location changes after the start (blocker updates repeat it).
  const committed: string[] = [];
  let last = path(router);
  router.subscribe((s) => {
    const p = s.location.pathname + s.location.search;
    if (p !== last) committed.push(p);
    last = p;
  });
  return { router, committed, unmount: view.unmount };
}

async function orgName() {
  return screen.findByLabelText('Name');
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe('route guard during a blocked-POP restoration (#370)', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
    episode.busy = false;
    episode.stranded = false;
    episode.ends.clear();
    episode.blocked = [];
    mockApi();
  });
  afterEach(() => vi.restoreAllMocks());

  it('a refused Back (dirty leave) starts an episode for its target entry', async () => {
    const { router } = renderAt(['/books', '/settings/organization']);
    fireEvent.change(await orgName(), { target: { value: 'Unsaved OÜ' } });
    void router.navigate(-1);
    await screen.findByRole('alertdialog');
    expect(episode.blocked).toHaveLength(1);
    expect(path(router)).toBe('/settings/organization');
  });

  it('a clean REPLACE is held, then goes ahead unchanged (target, state, mode) when the episode ends', async () => {
    const { router, committed } = renderAt([
      '/books',
      '/settings/organization',
    ]);
    await orgName();
    episode.busy = true;
    void router.navigate('/books?seg=draft', {
      replace: true,
      state: { mark: 370 },
    });
    await flush();
    expect(path(router)).toBe('/settings/organization');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    endEpisode();
    await waitFor(() => expect(path(router)).toBe('/books?seg=draft'));
    expect(router.state.historyAction).toBe('REPLACE');
    expect(router.state.location.state).toEqual({ mark: 370 });
    expect(committed).toEqual(['/books?seg=draft']);
  });

  it('held clean, dirty by the time the episode ends: it asks; Keep keeps route and value', async () => {
    const { router, committed } = renderAt([
      '/books',
      '/settings/organization',
    ]);
    const name = await orgName();
    episode.busy = true;
    void router.navigate('/books');
    await flush();
    fireEvent.change(name, { target: { value: 'Typed meanwhile' } });

    endEpisode();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Keep editing' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(path(router)).toBe('/settings/organization');
    expect(screen.getByLabelText('Name')).toHaveValue('Typed meanwhile');
    expect(committed).toEqual([]);
  });

  it('a dirty leave confirmed DURING the episode navigates only after it ends', async () => {
    const { router, committed } = renderAt([
      '/books',
      '/settings/organization',
    ]);
    fireEvent.change(await orgName(), { target: { value: 'Unsaved OÜ' } });
    episode.busy = true;
    void router.navigate('/inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await flush();
    expect(path(router)).toBe('/settings/organization');
    expect(committed).toEqual([]);

    endEpisode();
    await waitFor(() => expect(path(router)).toBe('/inbox'));
    expect(committed).toEqual(['/inbox']);
  });

  it('a newer navigation supersedes a held one: only the newer is ever written', async () => {
    const { router, committed } = renderAt([
      '/books',
      '/settings/organization',
    ]);
    await orgName();
    episode.busy = true;
    void router.navigate('/books');
    await flush();
    void router.navigate('/inbox');
    await flush();

    endEpisode();
    await waitFor(() => expect(path(router)).toBe('/inbox'));
    expect(committed).toEqual(['/inbox']);
  });

  it('the shell ending first drops the held navigation (no late write)', async () => {
    const { router, committed, unmount } = renderAt([
      '/books',
      '/settings/organization',
    ]);
    await orgName();
    episode.busy = true;
    void router.navigate('/books');
    await flush();
    unmount();
    expect(episode.ends.size).toBe(0);
    endEpisode();
    await flush();
    expect(committed).toEqual([]);
  });

  it('stranded (restoring failed): held and answered navigations are cancelled, new ones refused', async () => {
    const { router, committed } = renderAt([
      '/books',
      '/settings/organization',
    ]);
    const name = await orgName();
    episode.busy = true;
    void router.navigate('/books');
    await flush();

    endEpisode(false);
    await flush();
    expect(path(router)).toBe('/settings/organization');

    // Still stranded: a new clean navigation is refused at once…
    void router.navigate('/inbox');
    await flush();
    // …and a dirty leave, even when Discard is confirmed.
    fireEvent.change(name, { target: { value: 'Unsaved OÜ' } });
    void router.navigate('/books');
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await flush();
    expect(path(router)).toBe('/settings/organization');
    expect(committed).toEqual([]);
    expect([...router.state.blockers.values()].map((b) => b.state)).toEqual([
      'unblocked',
    ]);
  });
});
