import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_ID_KEY,
  clearToken,
  currentSessionId,
  setToken,
} from '../auth';
import { RecentResults } from '../shell/RecentResults';
import {
  RESULT_LOG_KEY,
  ResultLogProvider,
  clearResultLog,
  parseEntry,
  useReceipt,
  useResultLog,
  writeChain,
  type ChainSlot,
  type ResultInit,
  type ResultLog,
} from './resultLog';

let log!: ResultLog;
let receipt!: ReturnType<typeof useReceipt>;
function Probe() {
  log = useResultLog();
  receipt = useReceipt();
  return <RecentResults />;
}

function mount() {
  return render(
    <MemoryRouter>
      <ResultLogProvider>
        <Probe />
      </ResultLogProvider>
    </MemoryRouter>,
  );
}

const entry = (over: Partial<ResultInit> = {}): ResultInit => ({
  action: 'Upload',
  title: 'receipt.pdf',
  outcome: 'Stored as document #7 — processing…',
  tone: 'running',
  links: [{ label: 'Document #7', to: '/books/documents/7' }],
  ...over,
});

function stored(): { session: string; entries: Record<string, unknown>[] } {
  return JSON.parse(sessionStorage.getItem(RESULT_LOG_KEY) ?? 'null');
}

/** Another tab signs in again with the SAME token: only the session id
 *  moves (the token and this tab's auth revision do not). */
function sameTokenSignInElsewhere() {
  const newId = 'other-tab-session';
  localStorage.setItem(SESSION_ID_KEY, newId);
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: SESSION_ID_KEY, newValue: newId }),
    );
  });
}

const region = () => screen.getByRole('region', { name: 'Recent results' });

describe('result log (issue #259)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    setToken('secret-token-value');
  });
  afterEach(() => vi.restoreAllMocks());

  it('persists a recorded result for this session and shows it after a remount (reload)', () => {
    const first = mount();
    act(() => {
      log.record(entry({ tone: 'ok', outcome: 'Posted · −10.00 €' }));
    });
    expect(within(region()).getByText('Posted · −10.00 €')).toBeInTheDocument();
    first.unmount();
    mount();
    expect(within(region()).getByText('Posted · −10.00 €')).toBeInTheDocument();
    expect(
      within(region()).getByRole('link', { name: 'Document #7' }),
    ).toHaveAttribute('href', '/books/documents/7');
    // Session-bound, and never the token.
    expect(stored().session).toBe(currentSessionId());
    expect(sessionStorage.getItem(RESULT_LOG_KEY)).not.toContain(
      'secret-token-value',
    );
  });

  it('a running stage of an earlier page load is shown as interrupted, never as still running', () => {
    sessionStorage.setItem(
      RESULT_LOG_KEY,
      JSON.stringify({
        v: 1,
        session: currentSessionId(),
        entries: [
          {
            id: 'x',
            at: Date.now(),
            ...entry({ outcome: 'Draft Expense #24 created — posting…' }),
            page: 'an-earlier-page',
          },
        ],
      }),
    );
    mount();
    const r = region();
    expect(
      within(r).getByText(/Interrupted by a page reload/),
    ).toBeInTheDocument();
    expect(
      within(r).getByText(/Expense #24 created — posting…/),
    ).toBeInTheDocument();
    expect(within(r).getByText(/final outcome is unknown/)).toBeInTheDocument();
    expect(within(r).queryByText(/In progress/)).toBeNull();
    // Settled in storage too.
    expect(stored().entries[0]).toMatchObject({
      tone: 'warn',
      interrupted: true,
    });
  });

  it("another sign-in's stored log is never shown", () => {
    sessionStorage.setItem(
      RESULT_LOG_KEY,
      JSON.stringify({
        v: 1,
        session: 'someone-else',
        entries: [{ id: 'x', at: 1, ...entry({ tone: 'ok' }) }],
      }),
    );
    mount();
    expect(screen.queryByRole('region', { name: 'Recent results' })).toBeNull();
  });

  it('garbage is dropped; a corrupt or unsafe entry is dropped alone', () => {
    sessionStorage.setItem(RESULT_LOG_KEY, '{not json');
    const a = mount();
    expect(screen.queryByRole('region', { name: 'Recent results' })).toBeNull();
    expect(sessionStorage.getItem(RESULT_LOG_KEY)).toBeNull();
    a.unmount();

    const ok = { id: 'ok', at: 1, ...entry({ tone: 'ok', outcome: 'Kept' }) };
    sessionStorage.setItem(
      RESULT_LOG_KEY,
      JSON.stringify({
        v: 1,
        session: currentSessionId(),
        entries: [
          { id: 'bad-tone', at: 1, ...entry({ tone: 'weird' as never }) },
          {
            id: 'evil',
            at: 1,
            ...entry({ links: [{ label: 'x', to: '//evil.example/steal' }] }),
          },
          {
            id: 'scheme',
            at: 1,
            ...entry({ links: [{ label: 'x', to: 'javascript:alert(1)' }] }),
          },
          ok,
        ],
      }),
    );
    mount();
    expect(within(region()).getByText('Kept')).toBeInTheDocument();
    expect(within(region()).getAllByRole('listitem')).toHaveLength(1);
    expect(parseEntry({ ...ok, links: 'nope' })).toBeNull();
  });

  it('storage that refuses writes keeps results in memory and says they will not survive a reload', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    mount();
    act(() => {
      log.record(entry({ tone: 'ok', outcome: 'Posted' }));
    });
    expect(within(region()).getByText('Posted')).toBeInTheDocument();
    expect(
      within(region()).getByText(/not kept across a reload/),
    ).toBeInTheDocument();
  });

  it('storage that refuses reads starts empty without throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (key === RESULT_LOG_KEY) throw new DOMException('denied');
      return null;
    });
    expect(() => mount()).not.toThrow();
  });

  it('is bounded, dismissable one by one, and clearable', () => {
    mount();
    act(() => {
      for (let i = 1; i <= 10; i += 1)
        log.record(entry({ tone: 'ok', title: `Expense #${i}` }));
    });
    expect(stored().entries).toHaveLength(8);
    // Newest first; the earlier ones fold behind Details.
    expect(within(region()).getAllByRole('listitem')).toHaveLength(1);
    expect(within(region()).getByText('Expense #10')).toBeInTheDocument();
    fireEvent.click(
      within(region()).getByRole('button', {
        name: /Details · 7 earlier results/,
      }),
    );
    expect(within(region()).getAllByRole('listitem')).toHaveLength(8);
    fireEvent.click(
      within(region()).getByRole('button', {
        name: 'Dismiss result: Expense #10',
      }),
    );
    expect(within(region()).queryByText('Expense #10')).toBeNull();
    fireEvent.click(
      within(region()).getByRole('button', { name: 'Clear all' }),
    );
    expect(screen.queryByRole('region', { name: 'Recent results' })).toBeNull();
    expect(stored().entries).toEqual([]);
  });

  it('a chain updates ONE entry: a later stage supersedes the earlier one', () => {
    mount();
    act(() => {
      const h = log.record(entry());
      h.update({ outcome: 'Processed — loading the result…' });
      h.update({ tone: 'ok', outcome: 'Sales invoice recorded' });
    });
    expect(stored().entries).toHaveLength(1);
    expect(
      within(region()).getByText('Sales invoice recorded'),
    ).toBeInTheDocument();
  });

  it('a receipt key supersedes its earlier failure', () => {
    mount();
    act(() => {
      receipt('post:12', entry({ tone: 'error', outcome: 'not confirmed' }));
      receipt('post:12', entry({ tone: 'ok', outcome: 'Posted' }));
    });
    expect(stored().entries).toHaveLength(1);
    expect(within(region()).getByText('Posted')).toBeInTheDocument();
  });

  it('a write outside a live operation scope is dropped', () => {
    mount();
    act(() => {
      log.record(entry({ tone: 'ok' }), () => false);
    });
    expect(screen.queryByRole('region', { name: 'Recent results' })).toBeNull();
  });

  it('nothing is recorded while signed out, and sign-out clears the stored log', () => {
    mount();
    act(() => {
      log.record(entry({ tone: 'ok' }));
    });
    expect(sessionStorage.getItem(RESULT_LOG_KEY)).not.toBeNull();
    clearToken();
    clearResultLog();
    expect(sessionStorage.getItem(RESULT_LOG_KEY)).toBeNull();
    act(() => {
      log.record(entry({ tone: 'ok', outcome: 'late' }));
    });
    expect(screen.queryByText('late')).toBeNull();
    expect(sessionStorage.getItem(RESULT_LOG_KEY)).toBeNull();
  });

  describe('a same-token sign-in in another tab starts a new generation', () => {
    it('clears the old log; an OLD record function cannot create its first entry in the new one', () => {
      mount();
      act(() => {
        log.record(entry({ tone: 'ok', outcome: 'old session result' }));
      });
      const oldRecord = log.record;
      sameTokenSignInElsewhere();
      expect(screen.queryByText('old session result')).toBeNull();
      // A delayed first stage of an old-session operation.
      act(() => {
        oldRecord(entry({ tone: 'ok', outcome: 'late old first stage' }));
      });
      expect(screen.queryByText('late old first stage')).toBeNull();
      expect(sessionStorage.getItem(RESULT_LOG_KEY)).toBeNull();
      // An operation rendered in the new generation records normally.
      act(() => {
        log.record(entry({ tone: 'ok', outcome: 'new session result' }));
      });
      expect(
        within(region()).getByText('new session result'),
      ).toBeInTheDocument();
      expect(stored().session).toBe('other-tab-session');
      expect(stored().entries).toHaveLength(1);
    });

    it('an old handle cannot repopulate the new log', () => {
      mount();
      let h!: ReturnType<ResultLog['record']>;
      act(() => {
        h = log.record(entry());
      });
      sameTokenSignInElsewhere();
      let wrote = true;
      act(() => {
        wrote = h.update({ tone: 'ok', outcome: 'old final' });
      });
      expect(wrote).toBe(false);
      expect(
        screen.queryByRole('region', { name: 'Recent results' }),
      ).toBeNull();
    });

    it('an OLD receipt writer never touches the new generation entry of the same key', () => {
      mount();
      const oldReceipt = receipt;
      act(() => {
        oldReceipt(
          'approval:5',
          entry({ tone: 'error', outcome: 'old failure' }),
        );
      });
      sameTokenSignInElsewhere();
      act(() => {
        receipt('approval:5', entry({ tone: 'ok', outcome: 'new approve' }));
      });
      act(() => {
        oldReceipt('approval:5', entry({ tone: 'ok', outcome: 'old late' }));
      });
      expect(within(region()).getByText('new approve')).toBeInTheDocument();
      expect(screen.queryByText('old late')).toBeNull();
      expect(stored().entries).toHaveLength(1);
      expect(stored().entries[0]).toMatchObject({ outcome: 'new approve' });
    });

    it('a component slot written by an old generation is replaced, not reused, by a new-generation retry', () => {
      mount();
      const slot: ChainSlot = { current: null };
      const oldRecord = log.record;
      act(() => {
        writeChain(slot, oldRecord, entry({ tone: 'error', outcome: 'old' }));
      });
      sameTokenSignInElsewhere();
      act(() => {
        writeChain(
          slot,
          log.record,
          entry({ tone: 'ok', outcome: 'retry ok' }),
        );
      });
      act(() => {
        writeChain(slot, oldRecord, entry({ tone: 'ok', outcome: 'old late' }));
      });
      expect(stored().entries).toHaveLength(1);
      expect(stored().entries[0]).toMatchObject({ outcome: 'retry ok' });
    });
  });

  it('a long unbroken title is clamped when folded and shown in full when unfolded', () => {
    mount();
    const long = `${'a'.repeat(240)}.pdf`;
    act(() => {
      log.record(entry({ tone: 'ok', title: long }));
    });
    const title = within(region()).getByText(long);
    expect(title).toHaveClass('line-clamp-2');
    expect(within(region()).getByRole('listitem')).toHaveAccessibleName(
      `Upload: ${long}`,
    );
    fireEvent.click(within(region()).getByRole('button', { name: 'Details' }));
    expect(within(region()).getByText(long)).not.toHaveClass('line-clamp-2');
  });
});
