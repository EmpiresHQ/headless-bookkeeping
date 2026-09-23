import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_ID_KEY, TOKEN_KEY, getToken, setToken } from '../auth';
import { toastOk } from '../ui/toast';
import { buildRoutes } from './router';

/**
 * Issue #285 — why the token gate is showing, and what a sign-in change
 * (here or in another tab) leaves on screen, through the PRODUCTION route
 * tree. The fixture server answers per Bearer token: `alpha` and `beta`
 * are two owners' valid tokens, anything else is a 401. Another tab is
 * simulated the way a browser delivers it: storage already written, then a
 * `storage` event.
 */

const DEEP = '/settings/organization?source=auth-review#facts';

const org = (name: string) => ({
  id: 1,
  country: 'EE',
  base_currency: null,
  vat_registered: true,
  vat_registration_kind: 'ordinary',
  input_vat_entitlement: 'full',
  input_vat_deduction_permille: null,
  org_type: 'company',
  created_at: 0,
  name,
  registry_code: null,
  vat_registration_number: null,
  iban: null,
});

type Probe = 'answer' | 'hold' | 503 | 'network';
let probe: Probe = 'answer';
let heldProbes: ((r: Response) => void)[] = [];
let probes: string[] = [];
let orgRequests = 0;
let alphaVersion = 1;
let holdOrg = false;
let heldOrg: (() => void)[] = [];
let expire: string | null = null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    const token = auth.replace(/^Bearer /, '');
    const valid = (token === 'alpha' || token === 'beta') && token !== expire;
    if (url === '/api/entities' && init?.cache === 'no-store') {
      probes.push(token);
      if (probe === 'network') return Promise.reject(new TypeError('offline'));
      if (probe === 503) return Promise.resolve(json({ message: 'down' }, 503));
      const reply = valid
        ? json({ entities: [] })
        : json({ message: 'Invalid or revoked API token' }, 401);
      if (probe === 'hold') {
        return new Promise<Response>((resolve) =>
          heldProbes.push(() => resolve(reply)),
        );
      }
      return Promise.resolve(reply);
    }
    if (!valid) {
      return Promise.resolve(
        json({ message: 'Invalid or revoked API token' }, 401),
      );
    }
    if (/\/api\/organization$/.test(url)) {
      orgRequests += 1;
      const name = token === 'alpha' ? `Alpha OÜ v${alphaVersion}` : 'Beta OÜ';
      const reply = json(org(name));
      if (holdOrg) {
        return new Promise<Response>((resolve) =>
          heldOrg.push(() => resolve(reply)),
        );
      }
      return Promise.resolve(reply);
    }
    if (url.includes('/api/triage/needs-triage'))
      return Promise.resolve(json({ items: [] }));
    if (url.includes('/api/approvals'))
      return Promise.resolve(json({ approvals: [] }));
    if (url.includes('/api/entities'))
      return Promise.resolve(json({ entities: [] }));
    if (url.includes('/admin/settings'))
      return Promise.resolve(json({ settings: [] }));
    return Promise.resolve(json([]));
  });
}

function renderAt(entry: string) {
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [entry] });
  render(<RouterProvider router={router} />);
  return router;
}

const where = (r: ReturnType<typeof renderAt>) => {
  const { pathname, search, hash } = r.state.location;
  return pathname + search + hash;
};

const tokenInput = () => screen.getByLabelText('API token');
const gateTitle = () => screen.getByRole('heading', { level: 1 });

function type(token: string) {
  fireEvent.change(tokenInput(), { target: { value: token } });
}
const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: /Sign in|Try again/ }));

async function orgName() {
  return (await screen.findByLabelText('Name')) as HTMLInputElement;
}

/** Another tab wrote storage; this tab now receives the events. */
function otherTab(write: () => void, keys: (string | null)[]) {
  write();
  act(() => {
    for (const key of keys) {
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }
  });
}
const otherTabSignsIn = (token: string, id: string) =>
  otherTab(() => {
    localStorage.setItem(SESSION_ID_KEY, id);
    localStorage.setItem(TOKEN_KEY, token);
  }, [SESSION_ID_KEY, TOKEN_KEY]);
const otherTabSignsOut = () =>
  otherTab(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_ID_KEY);
  }, [TOKEN_KEY, SESSION_ID_KEY]);

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  probe = 'answer';
  heldProbes = [];
  probes = [];
  orgRequests = 0;
  alphaVersion = 1;
  holdOrg = false;
  heldOrg = [];
  expire = null;
  mockApi();
});
afterEach(() => {
  heldProbes.forEach((release) => release(json({}, 500)));
  heldOrg.forEach((release) => release());
  vi.restoreAllMocks();
});

describe('first entry and a rejected token (#285)', () => {
  it('a deep link asks to sign in; a rejected token says so, keeps the masked value, stores nothing; a corrected one opens the deep link', async () => {
    const router = renderAt(DEEP);
    expect(gateTitle()).toHaveTextContent('Sign in');
    expect(screen.queryByRole('alert')).toBeEmptyDOMElement();

    type('alhpa');
    submit();
    expect(
      await screen.findByText(/That token was not accepted/),
    ).toBeInTheDocument();
    expect(tokenInput()).toHaveValue('alhpa');
    expect(tokenInput()).toHaveAttribute('type', 'password');
    expect(tokenInput()).toHaveAttribute('aria-invalid', 'true');
    expect(getToken()).toBeNull();
    expect(where(router)).toBe(DEEP);
    // The copy is ours, never the server's text or the token.
    expect(document.body.textContent).not.toMatch(/alhpa|revoked API token/);

    type('alpha');
    submit();
    expect((await orgName()).value).toBe('Alpha OÜ v1');
    expect(getToken()).toBe('alpha');
    expect(where(router)).toBe(DEEP);
    expect(probes).toEqual(['alhpa', 'alpha']);
  });

  it.each([
    ['a 503', 503 as const],
    ['a network failure', 'network' as const],
  ])(
    '%s is "could not verify", not a rejection: value kept, nothing stored, Try again signs in',
    async (_label, failure) => {
      const router = renderAt(DEEP);
      probe = failure;
      type('alpha');
      submit();
      expect(
        await screen.findByText(/Could not verify access right now/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/not accepted/)).toBeNull();
      expect(tokenInput()).toHaveValue('alpha');
      expect(tokenInput()).not.toHaveAttribute('aria-invalid');
      expect(getToken()).toBeNull();

      probe = 'answer';
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect((await orgName()).value).toBe('Alpha OÜ v1');
      expect(where(router)).toBe(DEEP);
    },
  );

  it('an unknown address asks to sign in, then says not found at the same address (#291)', async () => {
    const unknown = '/bookz?q=fixture#part';
    const router = renderAt(unknown);
    expect(gateTitle()).toHaveTextContent('Sign in');
    type('alpha');
    submit();
    expect(
      await screen.findByRole('heading', {
        name: 'This address does not open a screen',
      }),
    ).toBeInTheDocument();
    expect(getToken()).toBe('alpha');
    expect(where(router)).toBe(unknown);
  });

  it('while checking: one request for a double submit, the value cannot change, Cancel unlocks and a late answer is ignored', async () => {
    renderAt(DEEP);
    probe = 'hold';
    type('alpha');
    act(() => {
      submit();
      submit();
    });
    await waitFor(() => expect(heldProbes).toHaveLength(1));
    expect(tokenInput()).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(tokenInput()).not.toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();

    await act(async () => heldProbes[0](json({ entities: [] })));
    await settle();
    expect(getToken()).toBeNull();
    expect(screen.getByLabelText('API token')).toBeInTheDocument();
    expect(probes).toHaveLength(1);
  });

  it('an orphan session id left without a token does not block signing in', async () => {
    localStorage.setItem(SESSION_ID_KEY, 'orphan');
    renderAt(DEEP);
    type('alpha');
    submit();
    expect((await orgName()).value).toBe('Alpha OÜ v1');
    expect(localStorage.getItem(SESSION_ID_KEY)).not.toBe('orphan');
  });
});

describe('access that ends after sign-in (#285)', () => {
  it('a 401 for accepted access says access ended (not "rejected"), blank input, same deep link, the token never shown', async () => {
    setToken('alpha');
    const router = renderAt(DEEP);
    expect((await orgName()).value).toBe('Alpha OÜ v1');

    expire = 'alpha';
    await act(() => router.navigate('/settings/mailbox?x=1#y'));
    // A later query of the accepted session answers 401.
    await waitFor(() => expect(gateTitle()).toHaveTextContent('Access ended'));
    expect(
      screen.getByText(/no longer accepts the token this browser was using/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not accepted/)).toBeNull();
    expect(tokenInput()).toHaveValue('');
    expect(where(router)).toBe('/settings/mailbox?x=1#y');
    expect(document.body.textContent).not.toMatch(/alpha/i);
    expect(getToken()).toBeNull();
  });

  it('a stored token the server no longer accepts: access ended, then a new token opens the same address', async () => {
    setToken('stale');
    const router = renderAt(DEEP);
    await waitFor(() => expect(gateTitle()).toHaveTextContent('Access ended'));
    type('beta');
    submit();
    expect((await orgName()).value).toBe('Beta OÜ');
    expect(where(router)).toBe(DEEP);
  });

  it('explicit sign-out says so', async () => {
    setToken('alpha');
    renderAt(DEEP);
    await orgName();
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]);
    await waitFor(() => expect(gateTitle()).toHaveTextContent('Signed out'));
    expect(screen.getByText(/You signed out/)).toBeInTheDocument();
  });
});

describe('sign-in changes in another tab (#285)', () => {
  it('sign-out there: back to the gate with that reason, nothing of the owner left', async () => {
    setToken('alpha');
    const router = renderAt(DEEP);
    await orgName();
    otherTabSignsOut();
    expect(
      await screen.findByText(/signed out in another tab/),
    ).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/Alpha/)).toBeNull();
    expect(where(router)).toBe(DEEP);
  });

  it('a different token there: the whole shell is replaced — the previous owner’s data is never shown under it', async () => {
    setToken('alpha');
    const router = renderAt(DEEP);
    expect((await orgName()).value).toBe('Alpha OÜ v1');
    act(() => {
      toastOk('Posted · Alpha receipt');
    });
    expect(await screen.findByText('Posted · Alpha receipt')).toBeVisible();
    holdOrg = true;
    otherTabSignsIn('beta', 'tab-2-session');
    // At the swap itself — not after an exit animation.
    expect(screen.queryByText('Posted · Alpha receipt')).toBeNull();
    expect(screen.queryByDisplayValue(/Alpha/)).toBeNull();
    // The new shell says why it changed.
    expect(
      await screen.findByText(/signed in again in another tab/),
    ).toBeInTheDocument();
    await waitFor(() => expect(heldOrg).toHaveLength(1));
    await act(async () => heldOrg[0]());
    expect((await orgName()).value).toBe('Beta OÜ');
    expect(where(router)).toBe(DEEP);
    expect(getToken()).toBe('beta');
    expect(localStorage.getItem(SESSION_ID_KEY)).toBe('tab-2-session');
  });

  it('the same token signed in anew there (only the session id changes): fresh data, not the old cache', async () => {
    setToken('alpha');
    renderAt(DEEP);
    expect((await orgName()).value).toBe('Alpha OÜ v1');
    const before = orgRequests;
    alphaVersion = 2;
    holdOrg = true;
    otherTabSignsIn('alpha', 'tab-2-session');
    await waitFor(() => expect(orgRequests).toBe(before + 1));
    expect(screen.queryByDisplayValue(/Alpha OÜ v1/)).toBeNull();
    await act(async () => heldOrg[0]());
    expect((await orgName()).value).toBe('Alpha OÜ v2');
    // Observing wrote nothing: the other tab's sign-in stays as it was.
    expect(localStorage.getItem(SESSION_ID_KEY)).toBe('tab-2-session');
  });

  it('a legacy token adopted without an id, then a same-token sign-in there: replaced, not mistaken for the lazy id', async () => {
    renderAt(DEEP);
    // Another tab holds a token stored before ids existed (no id written).
    otherTab(() => localStorage.setItem(TOKEN_KEY, 'alpha'), [TOKEN_KEY]);
    expect((await orgName()).value).toBe('Alpha OÜ v1');
    // This tab's own requests minted the id (no event here for that).
    const minted = localStorage.getItem(SESSION_ID_KEY);
    expect(minted).toEqual(expect.any(String));

    const before = orgRequests;
    alphaVersion = 2;
    holdOrg = true;
    otherTabSignsIn('alpha', 'tab-2-session');
    await waitFor(() => expect(orgRequests).toBe(before + 1));
    expect(screen.queryByDisplayValue(/Alpha OÜ v1/)).toBeNull();
    await act(async () => heldOrg[0]());
    expect((await orgName()).value).toBe('Alpha OÜ v2');
  });

  it('events that change nothing (a repeated write, an unrelated key) leave the shell alone', async () => {
    setToken('alpha');
    renderAt(DEEP);
    await orgName();
    const before = orgRequests;
    otherTab(() => undefined, [TOKEN_KEY, SESSION_ID_KEY, 'unrelated']);
    await settle();
    expect(orgRequests).toBe(before);
    expect(screen.getByLabelText('Name')).toHaveValue('Alpha OÜ v1');
  });

  it('while this tab checks a token, a sign-in and sign-out there voids the check: unlocked at once, the late acceptance signs nothing in', async () => {
    renderAt(DEEP);
    probe = 'hold';
    type('alpha');
    submit();
    await waitFor(() => expect(heldProbes).toHaveLength(1));

    // In and out again before this tab hears of it: storage ends as it began.
    otherTab(() => {
      localStorage.setItem(SESSION_ID_KEY, 'tab-2-session');
      localStorage.setItem(TOKEN_KEY, 'beta');
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(SESSION_ID_KEY);
    }, [SESSION_ID_KEY, TOKEN_KEY, TOKEN_KEY, SESSION_ID_KEY]);

    expect(
      screen.getByText(/sign-in changed in another tab/),
    ).toBeInTheDocument();
    expect(tokenInput()).not.toHaveAttribute('readonly');
    expect(tokenInput()).toHaveValue('alpha');

    await act(async () => heldProbes[0](json({ entities: [] })));
    await settle();
    expect(getToken()).toBeNull();
    expect(screen.getByLabelText('API token')).toBeInTheDocument();

    // A deliberate new attempt works.
    probe = 'answer';
    submit();
    expect((await orgName()).value).toBe('Alpha OÜ v1');
  });

  it('signed out: another context signs in AND out again, no event delivered — the old check’s 200 signs nothing in', async () => {
    renderAt(DEEP);
    probe = 'hold';
    type('alpha');
    submit();
    await waitFor(() => expect(heldProbes).toHaveLength(1));

    // A separate instance of the auth module (its own revision), sharing
    // this browser's storage: exactly what another tab runs.
    vi.resetModules();
    const other = await import('../auth');
    other.setToken('beta');
    other.clearToken();
    expect(getToken()).toBeNull();
    expect(localStorage.getItem(SESSION_ID_KEY)).toBeNull();

    await act(async () => heldProbes[0](json({ entities: [] })));
    await settle();
    expect(getToken()).toBeNull();
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(
      screen.getByText(/sign-in changed in another tab/),
    ).toBeInTheDocument();
    expect(tokenInput()).not.toHaveAttribute('readonly');
  });

  it('a check that settles after another tab signed in, before its event arrives, stores nothing over it and says why', async () => {
    renderAt(DEEP);
    probe = 'hold';
    type('alpha');
    submit();
    await waitFor(() => expect(heldProbes).toHaveLength(1));
    localStorage.setItem(SESSION_ID_KEY, 'tab-2-session');
    localStorage.setItem(TOKEN_KEY, 'beta');
    await act(async () => heldProbes[0](json({ entities: [] })));
    expect(
      await screen.findByText(/sign-in changed in another tab/),
    ).toBeInTheDocument();
    expect(getToken()).toBe('beta');
    expect(localStorage.getItem(SESSION_ID_KEY)).toBe('tab-2-session');
    // The event then arrives: that sign-in is adopted.
    otherTab(() => undefined, [SESSION_ID_KEY, TOKEN_KEY]);
    expect((await orgName()).value).toBe('Beta OÜ');
  });

  it('a sign-in there while this tab waits at the gate is adopted at the same address', async () => {
    const router = renderAt(DEEP);
    otherTabSignsIn('beta', 'tab-2-session');
    expect((await orgName()).value).toBe('Beta OÜ');
    expect(where(router)).toBe(DEEP);
    expect(localStorage.getItem(SESSION_ID_KEY)).toBe('tab-2-session');
  });
});
