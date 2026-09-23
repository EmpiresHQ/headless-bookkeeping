import { act, fireEvent, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the preview reads are stubbed: Open original runs the real helper
// against a spied window.open and fetch (the signed-url GET).
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchDocumentPreviewObjectUrl: vi.fn(),
}));

import * as api from '../api';
import {
  clearToken,
  getToken,
  isCurrentUnauthorized,
  setToken,
  UnauthorizedError,
} from '../auth';
import { ListRow } from '../ui/List';
import { render, setShellUnauthorized } from './previewTestShell';
import { DocPreviewRow } from './DocPreviewRow';
import { DocThumbLightbox } from './DocThumbLightbox';

/** Issue #272: Open original reports inside the preview — a failure or a
 *  blocked popup is visible with its own retry, the current document and
 *  modal stay, a 401 reaches the shell, and no blank tab outlives its
 *  attempt or its scope. */

interface FakeTab {
  closed: boolean;
  navigatedTo: string | null;
  close: ReturnType<typeof vi.fn>;
  location: { href: string };
}

let tabs: FakeTab[] = [];
let popupBlocked = false;
let signCalls: { id: string; answer: (res: Response) => void }[] = [];
let unauthorized: UnauthorizedError[] = [];
let hrefBefore = '';

function fakeTab(): FakeTab {
  const tab: FakeTab = {
    closed: false,
    navigatedTo: null,
    close: vi.fn(() => {
      tab.closed = true;
    }),
    location: {} as { href: string },
  };
  Object.defineProperty(tab.location, 'href', {
    set(url: string) {
      tab.navigatedTo = url;
    },
  });
  return tab;
}

const signed = (id: string) =>
  new Response(JSON.stringify({ url: `/api/documents/${id}/shared?t=x` }), {
    status: 200,
  });
const failed503 = () =>
  new Response('{"message":"Signing fixture failed"}', {
    status: 503,
    statusText: 'Service Unavailable',
  });

/** Answer the latest (or the `at`-th) signed-url GET and let the chain
 *  settle. */
async function answerSign(res: Response, at = signCalls.length - 1) {
  const call = signCalls[at];
  await act(async () => {
    call.answer(res);
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function openPreview() {
  fireEvent.click(screen.getByText('Source document'));
  return screen.findByRole('dialog');
}

const openOriginal = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', {
    name: /Open original|Opening original/,
  });
const tryAgain = (dialog: HTMLElement) =>
  within(dialog).queryByRole('button', {
    name: /Try opening original again|Trying again…/,
  });

beforeEach(() => {
  localStorage.clear();
  setToken('tok');
  hrefBefore = window.location.href;
  tabs = [];
  popupBlocked = false;
  signCalls = [];
  unauthorized = [];
  setShellUnauthorized((e) => unauthorized.push(e));
  vi.mocked(api.fetchDocumentPreviewObjectUrl).mockImplementation(
    async (_id: number, opts: { size?: 'lg' } = {}) =>
      opts.size === 'lg' ? 'blob:lg' : 'blob:thumb',
  );
  vi.spyOn(window, 'open').mockImplementation(() => {
    if (popupBlocked) return null;
    const tab = fakeTab();
    tabs.push(tab);
    return tab as never;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const path = String(input);
    const id = /\/api\/documents\/(\d+)\/signed-url/.exec(path)?.[1];
    if (id === undefined) throw new Error(`unexpected fetch ${path}`);
    return new Promise<Response>((answer) => signCalls.push({ id, answer }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setShellUnauthorized(() => undefined);
  // The app's own window is never navigated away.
  expect(window.location.href).toBe(hrefBefore);
});

describe('Open original (DocPreviewRow)', () => {
  it('a signing failure is shown in the preview; retry opens the SAME document and keeps the modal', async () => {
    render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    fireEvent.click(openOriginal(dialog));
    expect(tabs).toHaveLength(1);
    expect(openOriginal(dialog)).toHaveAttribute('aria-disabled', 'true');
    await answerSign(failed503());

    expect(tabs[0].close).toHaveBeenCalled();
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('The original couldn’t be opened.');
    expect(screen.getByRole('dialog')).toBe(dialog);

    const retry = tryAgain(dialog)!;
    retry.focus();
    fireEvent.click(retry);
    // The retry opens its own placeholder inside its click.
    expect(tabs).toHaveLength(2);
    expect(signCalls[1].id).toBe('12');
    expect(tryAgain(dialog)).toHaveAttribute('aria-disabled', 'true');
    expect(tryAgain(dialog)).toHaveFocus();
    await answerSign(signed('12'));

    expect(tabs[1].navigatedTo).toBe('/api/documents/12/shared?t=x');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    // The retry button left while focused: focus stays in the modal.
    expect(openOriginal(dialog)).toHaveFocus();
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  it('a blocked popup never navigates the app and says how to recover', async () => {
    render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    popupBlocked = true;
    fireEvent.click(openOriginal(dialog));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(signCalls).toHaveLength(0);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Your browser blocked the new tab. Allow pop-ups for this site, then try again.',
    );

    popupBlocked = false; // the operator allowed pop-ups
    fireEvent.click(tryAgain(dialog)!);
    await answerSign(signed('12'));
    expect(tabs[0].navigatedTo).toBe('/api/documents/12/shared?t=x');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('a fast double click opens one tab and signs once', async () => {
    render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    const button = openOriginal(dialog);
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(openOriginal(dialog));
    expect(tabs).toHaveLength(1);
    expect(signCalls).toHaveLength(1);
    expect(openOriginal(dialog)).toHaveTextContent('Opening original…');
    await answerSign(signed('12'));
    expect(tabs[0].navigatedTo).toBe('/api/documents/12/shared?t=x');
    expect(openOriginal(dialog)).toHaveTextContent('Open original');
    expect(openOriginal(dialog)).not.toHaveAttribute('aria-disabled');
  });

  it('a current 401 goes to the shell, closes the placeholder and shows no local error', async () => {
    render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    fireEvent.click(openOriginal(dialog));
    await answerSign(new Response('', { status: 401 }));
    expect(tabs[0].close).toHaveBeenCalled();
    expect(unauthorized).toHaveLength(1);
    expect(isCurrentUnauthorized(unauthorized[0])).toBe(true);
    expect(getToken()).toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('a 401 of an ended session never touches the new one', async () => {
    render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    fireEvent.click(openOriginal(dialog));
    act(() => {
      clearToken();
      setToken('next-session');
    });
    await answerSign(new Response('', { status: 401 }));
    expect(tabs[0].close).toHaveBeenCalled();
    expect(tabs[0].navigatedTo).toBeNull();
    expect(unauthorized).toHaveLength(0);
    expect(getToken()).toBe('next-session');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    // Not stuck pending: the next click is a new attempt.
    expect(openOriginal(dialog)).not.toHaveAttribute('aria-disabled');
  });

  it('another tab ending the session closes the blank tab without waiting for the answer', async () => {
    render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    fireEvent.click(openOriginal(dialog));
    act(() => {
      // Another tab signed out: only localStorage moved, then its event.
      localStorage.removeItem('bk_api_token');
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'bk_api_token' }),
      );
    });
    expect(tabs[0].close).toHaveBeenCalledTimes(1);
    await answerSign(signed('12'));
    expect(tabs[0].navigatedTo).toBeNull();
    expect(unauthorized).toHaveLength(0);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it.each([
    ['success', () => signed('12')],
    ['failure', () => failed503()],
    ['401', () => new Response('', { status: 401 })],
  ])(
    'after another tab signs in, a new click opens at once; the held old GET (%s) never touches it',
    async (_label, oldAnswer) => {
      render(<DocPreviewRow documentId={12} />);
      const dialog = await openPreview();
      fireEvent.click(openOriginal(dialog));
      act(() => {
        // Another tab signed in: only localStorage moved, then its event.
        localStorage.setItem('bk_api_token', 'other-tab-session');
        window.dispatchEvent(
          new StorageEvent('storage', { key: 'bk_api_token' }),
        );
      });
      expect(tabs[0].close).toHaveBeenCalledTimes(1);
      // Not stuck behind the old, still-held request.
      expect(openOriginal(dialog)).toHaveTextContent('Open original');
      expect(openOriginal(dialog)).not.toHaveAttribute('aria-disabled');

      fireEvent.click(openOriginal(dialog));
      expect(tabs).toHaveLength(2);
      expect(signCalls).toHaveLength(2);
      expect(openOriginal(dialog)).toHaveAttribute('aria-disabled', 'true');

      // The old session's answer arrives while the new attempt is pending.
      await answerSign(oldAnswer(), 0);
      expect(tabs[0].navigatedTo).toBeNull();
      expect(tabs[1].close).not.toHaveBeenCalled();
      expect(openOriginal(dialog)).toHaveAttribute('aria-disabled', 'true');
      expect(within(dialog).queryByRole('alert')).toBeNull();
      expect(unauthorized).toHaveLength(0);
      expect(getToken()).toBe('other-tab-session');

      await answerSign(signed('12'), 1);
      expect(tabs[1].navigatedTo).toBe('/api/documents/12/shared?t=x');
      expect(openOriginal(dialog)).not.toHaveAttribute('aria-disabled');
      expect(within(dialog).queryByRole('alert')).toBeNull();
    },
  );

  it('closing the preview while pending closes the blank tab at once; the late answer is dropped', async () => {
    render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    fireEvent.click(openOriginal(dialog));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Before the (still held) response.
    expect(tabs[0].close).toHaveBeenCalledTimes(1);

    await answerSign(failed503());
    const reopened = await openPreview();
    expect(within(reopened).queryByRole('alert')).toBeNull();
    expect(openOriginal(reopened)).not.toHaveAttribute('aria-disabled');
    expect(tabs[0].navigatedTo).toBeNull();
  });

  it('a success that arrives after close does not navigate the closed placeholder', async () => {
    render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    fireEvent.click(openOriginal(dialog));
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Close preview' }),
    );
    expect(tabs[0].close).toHaveBeenCalledTimes(1);
    await answerSign(signed('12'));
    expect(tabs[0].navigatedTo).toBeNull();
  });

  it('moving to another document while pending closes the tab; the old failure never shows on the new one', async () => {
    const { rerender } = render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    fireEvent.click(openOriginal(dialog));
    rerender(<DocPreviewRow documentId={13} />);
    expect(tabs[0].close).toHaveBeenCalledTimes(1);
    await answerSign(failed503());
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull();

    // The next attempt is for the document now shown.
    fireEvent.click(openOriginal(screen.getByRole('dialog')));
    expect(signCalls[1].id).toBe('13');
    await answerSign(signed('13'));
    expect(tabs[1].navigatedTo).toBe('/api/documents/13/shared?t=x');
  });

  it('unmount while pending (e.g. sign-out) closes the blank tab at once', async () => {
    const { unmount } = render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    fireEvent.click(openOriginal(dialog));
    unmount();
    expect(tabs[0].close).toHaveBeenCalledTimes(1);
    await answerSign(signed('12'));
    expect(tabs[0].navigatedTo).toBeNull();
  });

  it('a user-closed placeholder is not replaced by anything', async () => {
    render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    fireEvent.click(openOriginal(dialog));
    tabs[0].closed = true;
    await answerSign(signed('12'));
    expect(tabs[0].navigatedTo).toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(openOriginal(dialog)).not.toHaveAttribute('aria-disabled');
  });

  it('a preview failure and an Open original failure are shown apart, each with its own retry', async () => {
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockImplementation(
      async () => {
        throw new Error('network');
      },
    );
    render(<DocPreviewRow documentId={12} />);
    const dialog = await openPreview();
    await within(dialog).findByRole('button', { name: 'Retry' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.click(openOriginal(dialog));
    await answerSign(failed503());

    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'The preview couldn’t be loaded.',
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'The original couldn’t be opened.',
    );
    // The preview's Retry reads only the preview.
    const signsBefore = signCalls.length;
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(signCalls).toHaveLength(signsBefore);
    expect(tabs).toHaveLength(1);
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
  });
});

describe('Open original (DocThumbLightbox in a navigating Inbox row)', () => {
  it('failure and retry stay in the preview; nothing reaches the row link', async () => {
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route
            path="/inbox"
            element={
              <ListRow
                to="/inbox/doc/7"
                leading={<DocThumbLightbox id={7} />}
                title="scan.png"
              />
            }
          />
          <Route path="/inbox/doc/7" element={<p>Document screen</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open document preview' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(openOriginal(dialog));
    await answerSign(failed503());
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    fireEvent.click(tryAgain(dialog)!);
    expect(signCalls[1].id).toBe('7');
    await answerSign(signed('7'));
    expect(tabs[1].navigatedTo).toBe('/api/documents/7/shared?t=x');
    expect(screen.queryByText('Document screen')).toBeNull();
    expect(screen.getByRole('dialog')).toBe(dialog);
  });
});
