import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  importBankStatement: vi.fn(),
  getBankImportStatus: vi.fn(),
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
}));

import * as api from '../api';
import { HttpError, SESSION_ID_KEY, clearToken, setToken } from '../auth';
import { ImportScreen } from './ImportScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import {
  IMPORT_JOB_KEY,
  readImportPointer,
  writeImportPointer,
} from './importResume';

/** One page load: a fresh QueryClient + router (a refresh is a second
 *  call after cleanup()). */
function renderScreen(url = '/bank/import') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/bank/import', element: <ImportScreen /> },
      { path: '/bank', element: <p>bank list</p> },
      { path: '/bank/statements/:id', element: <p>statement screen</p> },
    ],
    { initialEntries: ['/bank', url], initialIndex: 1 },
  );
  render(
    <QueryClientProvider client={client}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return router;
}

const where = (router: ReturnType<typeof renderScreen>) =>
  router.state.location.pathname + router.state.location.search;

const pickFile = () => {
  const file = new File(['date;amount'], 'june.csv', { type: 'text/csv' });
  fireEvent.change(screen.getByLabelText('Statement file'), {
    target: { files: [file] },
  });
};

const upload = () => {
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: /import statement/i }));
};

const job = (id: number, status: string, extra: object = {}) => ({
  id,
  status,
  account_code: 'BANK_EUR',
  statement_id: null,
  error: null,
  ...extra,
});

const goTo = (router: ReturnType<typeof renderScreen>, to: string) =>
  act(() => router.navigate(to));

describe('ImportScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    setToken('test-token');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('submits the file + account code, moves to the job URL (replace) and shows the done stepper', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 7 });
    vi.mocked(api.getBankImportStatus).mockResolvedValue(
      job(7, 'done', { statement_id: 5 }),
    );
    const router = renderScreen();
    upload();
    expect(await screen.findByText('Statement created')).toBeInTheDocument();
    const open = await screen.findByRole('link', { name: /open statement/i });
    expect(open).toHaveAttribute('href', '/bank/statements/5');
    expect(api.importBankStatement).toHaveBeenCalledWith(
      expect.any(File),
      'BANK_EUR',
    );
    expect(where(router)).toBe('/bank/import?job=7');
    expect(screen.getByText('#7')).toBeInTheDocument();
    // replace: Back leaves the import, it does not reopen an empty form.
    await act(() => router.navigate(-1));
    expect(where(router)).toBe('/bank');
  });

  it('a refresh on the job URL resumes observing the running import', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 41 });
    vi.mocked(api.getBankImportStatus).mockResolvedValue(job(41, 'running'));
    renderScreen();
    upload();
    await screen.findByText(/can take a minute/);
    cleanup(); // reload: component state and query cache are gone
    renderScreen('/bank/import?job=41');
    expect(await screen.findByText(/can take a minute/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Statement file')).toBeNull();
    expect(api.getBankImportStatus).toHaveBeenLastCalledWith(41);
    expect(api.importBankStatement).toHaveBeenCalledTimes(1);
  });

  it('leaving and returning to /bank/import resumes the job, also after it finished while away', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 41 });
    vi.mocked(api.getBankImportStatus).mockResolvedValue(job(41, 'running'));
    const router = renderScreen();
    upload();
    await screen.findByText(/can take a minute/);
    await goTo(router, '/bank');
    vi.mocked(api.getBankImportStatus).mockResolvedValue(
      job(41, 'done', { statement_id: 9 }),
    );
    await goTo(router, '/bank/import');
    expect(
      await screen.findByRole('link', { name: /open statement/i }),
    ).toHaveAttribute('href', '/bank/statements/9');
    expect(where(router)).toBe('/bank/import?job=41');
    // Seeing the result is not acknowledging it: another return still shows it.
    await goTo(router, '/bank');
    await goTo(router, '/bank/import');
    expect(
      await screen.findByRole('link', { name: /open statement/i }),
    ).toBeInTheDocument();
    expect(readImportPointer()).toBe(41);
  });

  it('New import acknowledges a done job: the pointer is cleared and the form opens', async () => {
    writeImportPointer(7);
    vi.mocked(api.getBankImportStatus).mockResolvedValue(
      job(7, 'done', { statement_id: 5 }),
    );
    const router = renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: /new import/i }));
    expect(screen.getByLabelText('Statement file')).toBeInTheDocument();
    expect(readImportPointer()).toBeNull();
    await goTo(router, '/bank');
    await goTo(router, '/bank/import');
    expect(screen.getByLabelText('Statement file')).toBeInTheDocument();
  });

  it('Open statement acknowledges the done job', async () => {
    writeImportPointer(7);
    vi.mocked(api.getBankImportStatus).mockResolvedValue(
      job(7, 'done', { statement_id: 5 }),
    );
    renderScreen();
    fireEvent.click(
      await screen.findByRole('link', { name: /open statement/i }),
    );
    expect(await screen.findByText('statement screen')).toBeInTheDocument();
    expect(readImportPointer()).toBeNull();
  });

  it('shows the explicit failure state with the server error; Try again acknowledges and opens the form', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 8 });
    vi.mocked(api.getBankImportStatus).mockResolvedValue(
      job(8, 'failed', { error: 'LLM mapping failed: unrecognizable columns' }),
    );
    renderScreen();
    upload();
    expect(
      await screen.findByText('LLM mapping failed: unrecognizable columns'),
    ).toBeInTheDocument();
    expect(readImportPointer()).toBe(8);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByLabelText('Statement file')).toBeInTheDocument();
    expect(readImportPointer()).toBeNull();
  });

  it('disables submit until a file is chosen', () => {
    renderScreen();
    expect(
      screen.getByRole('button', { name: /import statement/i }),
    ).toBeDisabled();
  });

  it('a status-check failure is not an import failure: no ✕, no Start over, no re-upload path', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 9 });
    vi.mocked(api.getBankImportStatus).mockRejectedValue(
      new HttpError(503, '503 Service Unavailable: status endpoint down'),
    );
    renderScreen();
    upload();
    expect(
      await screen.findByText('503 Service Unavailable: status endpoint down'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Couldn’t check the status of import #9/),
    ).toBeInTheDocument();
    expect(screen.getByText(/don’t upload the file again/)).toBeInTheDocument();
    expect(screen.queryByText('✕')).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: /start over|try again|new import/i,
      }),
    ).toBeNull();
    expect(screen.queryByLabelText('Statement file')).toBeNull();
    expect(readImportPointer()).toBe(9);
  });

  it('"Check again" refetches the status endpoint and recovers into the done state', async () => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 9 });
    vi.mocked(api.getBankImportStatus)
      .mockRejectedValueOnce(new Error('status endpoint down'))
      .mockResolvedValue(job(9, 'done', { statement_id: 12 }));
    renderScreen();
    upload();
    await screen.findByText('status endpoint down');
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByText('Statement created')).toBeInTheDocument();
    expect(api.getBankImportStatus).toHaveBeenCalledTimes(2);
  });

  it('a status error after a running answer keeps the last known status', async () => {
    writeImportPointer(9);
    vi.mocked(api.getBankImportStatus)
      .mockResolvedValueOnce(job(9, 'running'))
      .mockRejectedValue(new Error('status endpoint down'));
    renderScreen('/bank/import?job=9');
    await screen.findByText(/can take a minute/);
    // The 1.5 s poll hits the failing endpoint.
    expect(
      await screen.findByText('status endpoint down', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Last known status: running.')).toBeInTheDocument();
    expect(screen.queryByText('✕')).toBeNull();
    expect(screen.queryByLabelText('Statement file')).toBeNull();
  });

  it('a 404 is neutral: not an import failure, pointer kept, Check again / Back to Bank / explicit Forget', async () => {
    writeImportPointer(41);
    vi.mocked(api.getBankImportStatus).mockRejectedValue(
      new HttpError(404, '404 Not Found: Import job 41 not found'),
    );
    const router = renderScreen();
    expect(
      await screen.findByText('The server did not find import #41.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not mean the import failed/),
    ).toBeInTheDocument();
    expect(screen.queryByText('✕')).toBeNull();
    expect(screen.queryByText(/Import failed/)).toBeNull();
    expect(screen.getByRole('link', { name: /back to bank/i })).toHaveAttribute(
      'href',
      '/bank',
    );
    expect(readImportPointer()).toBe(41);
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    await waitFor(() =>
      expect(api.getBankImportStatus).toHaveBeenCalledTimes(2),
    );
    fireEvent.click(
      screen.getByRole('button', { name: /forget this import/i }),
    );
    // Forget leads back to Bank, not straight into a re-upload form.
    expect(await screen.findByText('bank list')).toBeInTheDocument();
    expect(where(router)).toBe('/bank');
    expect(readImportPointer()).toBeNull();
  });

  it('a job opened by a direct link is remembered once observed: link → Bank → Import resumes it', async () => {
    vi.mocked(api.getBankImportStatus).mockResolvedValue(
      job(41, 'failed', { error: 'bad columns' }),
    );
    const router = renderScreen('/bank/import?job=41');
    expect(await screen.findByText('bad columns')).toBeInTheDocument();
    await waitFor(() => expect(readImportPointer()).toBe(41));
    await goTo(router, '/bank');
    await goTo(router, '/bank/import');
    expect(await screen.findByText('bad columns')).toBeInTheDocument();
    expect(where(router)).toBe('/bank/import?job=41');
  });

  it('a direct link never replaces the job the tab already remembers', async () => {
    writeImportPointer(41);
    vi.mocked(api.getBankImportStatus).mockResolvedValue(
      job(5, 'done', { statement_id: 3 }),
    );
    renderScreen('/bank/import?job=5');
    await screen.findByRole('link', { name: /open statement/i });
    expect(readImportPointer()).toBe(41);
  });

  it('a status answer that lands after the session changed is not remembered under the new session', async () => {
    let answer!: (v: ReturnType<typeof job>) => void;
    vi.mocked(api.getBankImportStatus).mockReturnValue(
      new Promise((r) => (answer = r)),
    );
    renderScreen('/bank/import?job=41');
    await waitFor(() => expect(api.getBankImportStatus).toHaveBeenCalled());
    setToken('another-sign-in'); // new session id + revision
    await act(async () => answer(job(41, 'running')));
    await screen.findByText(/can take a minute/);
    expect(readImportPointer()).toBeNull();
    expect(sessionStorage.getItem(IMPORT_JOB_KEY)).toBeNull();
  });

  it('an invalid explicit ?job shows an invalid-link state and never suppresses the tab’s resume', async () => {
    writeImportPointer(41);
    vi.mocked(api.getBankImportStatus).mockResolvedValue(job(41, 'running'));
    const router = renderScreen('/bank/import?job=abc');
    expect(
      screen.getByText(/This import link is not valid/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Statement file')).toBeNull();
    expect(api.getBankImportStatus).not.toHaveBeenCalled();
    expect(readImportPointer()).toBe(41);
    fireEvent.click(
      screen.getByRole('link', { name: /go to import statement/i }),
    );
    expect(await screen.findByText(/can take a minute/)).toBeInTheDocument();
    expect(where(router)).toBe('/bank/import?job=41');
  });

  it('an empty ?job= is invalid too', () => {
    renderScreen('/bank/import?job=');
    expect(
      screen.getByText(/This import link is not valid/),
    ).toBeInTheDocument();
  });

  it('a pointer of another sign-in is not resumed', () => {
    writeImportPointer(41);
    clearToken();
    setToken('next-user');
    renderScreen();
    expect(screen.getByLabelText('Statement file')).toBeInTheDocument();
    expect(sessionStorage.getItem(IMPORT_JOB_KEY)).toBeNull();
    expect(api.getBankImportStatus).not.toHaveBeenCalled();
  });

  it('a pointer whose shared session id another tab replaced is not resumed', () => {
    writeImportPointer(41);
    localStorage.setItem(SESSION_ID_KEY, 'other-tab-session');
    renderScreen();
    expect(screen.getByLabelText('Statement file')).toBeInTheDocument();
  });

  it('with storage unavailable an accepted upload still moves to the job URL', async () => {
    const denied = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('sessionStorage', {
      getItem: denied,
      setItem: denied,
      removeItem: denied,
    });
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 41 });
    vi.mocked(api.getBankImportStatus).mockResolvedValue(job(41, 'running'));
    const router = renderScreen();
    upload();
    expect(await screen.findByText(/can take a minute/)).toBeInTheDocument();
    expect(where(router)).toBe('/bank/import?job=41');
  });

  it('a failed upload keeps the file and account code, and does not claim to know the outcome', async () => {
    vi.mocked(api.importBankStatement).mockRejectedValue(
      new TypeError('Failed to fetch'),
    );
    const router = renderScreen();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'BANK_USD' },
    });
    upload();
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
    expect(
      screen.getByText(/check the statements list before uploading again/),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('BANK_USD');
    expect(
      screen.getByRole('button', { name: /import statement/i }),
    ).toBeEnabled();
    expect(where(router)).toBe('/bank/import');
    expect(readImportPointer()).toBeNull();
  });

  it('an upload accepted after the session changed neither writes the pointer nor navigates', async () => {
    let accept!: (v: { jobId: number }) => void;
    vi.mocked(api.importBankStatement).mockReturnValue(
      new Promise((r) => (accept = r)),
    );
    const router = renderScreen();
    upload();
    setToken('another-sign-in');
    await act(async () => accept({ jobId: 77 }));
    expect(readImportPointer()).toBeNull();
    expect(sessionStorage.getItem(IMPORT_JOB_KEY)).toBeNull();
    expect(where(router)).toBe('/bank/import');
    expect(api.getBankImportStatus).not.toHaveBeenCalled();
  });
});
