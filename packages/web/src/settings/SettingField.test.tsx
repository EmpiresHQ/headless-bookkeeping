import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getSettings: vi.fn(),
  setSetting: vi.fn(),
  deleteSetting: vi.fn(),
}));
import { deleteSetting, getSettings, setSetting, type Setting } from '../api';
import { HttpError } from '../auth';
import { settingsKeys } from '../queries/settings';
import { AppToaster } from '../ui/toast';
import { SettingField, type SettingDef } from './SettingField';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

const MODEL: SettingDef = {
  key: 'ai_model',
  label: 'Global model',
  placeholder: 'openai/gpt-4o-mini',
  unset: 'Agents use the built-in default model.',
};
const OCR: SettingDef = {
  key: 'ai_model.ocr',
  label: 'Model — OCR',
  unset: 'Uses the Global model.',
};
const KEY: SettingDef = {
  key: 'ai_api_key',
  label: 'API key',
  secret: true,
  unset: 'No key is sent.',
};
// Test-only fake credential.
const FAKE_SECRET = 'sk-test-FAKE-0000';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(defs: SettingDef[] = [MODEL]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        {defs.map((d) => (
          <SettingField key={d.key} def={d} />
        ))}
        <AppToaster />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const input = (label = 'Global model') => screen.getByLabelText(label);
const type = (v: string, label = 'Global model') =>
  fireEvent.change(input(label), { target: { value: v } });
const status = (key = 'ai_model') =>
  screen.getByTestId(`setting-status-${key}`);
const saveBtn = (label = 'Global model') =>
  screen.getByRole('button', { name: `Save ${label}` });
const clearBtn = (label = 'Global model') =>
  screen.getByRole('button', { name: `Clear ${label}` });
/** The page-unload guard is the durable dirty signal (issue #250). */
const unloadAsks = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

function listOnce(rows: Setting[]) {
  vi.mocked(getSettings).mockResolvedValueOnce(rows);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSettings).mockResolvedValue([]);
});

describe('SettingField — save', () => {
  it('saves the trimmed draft to its own key and reports the acknowledged value', async () => {
    vi.mocked(setSetting).mockResolvedValue({
      key: 'ai_model',
      value: 'openai/gpt-5',
    });
    vi.mocked(getSettings)
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ key: 'ai_model', value: 'openai/gpt-5' }]);
    mount();
    await waitFor(() => expect(status()).toHaveTextContent('Nothing stored.'));
    type('  openai/gpt-5  ');
    expect(status()).toHaveTextContent(
      'Unsaved edit — Save stores this field only. Nothing stored yet.',
    );
    expect(unloadAsks()).toBe(true);
    fireEvent.click(saveBtn());
    expect(setSetting).toHaveBeenCalledWith('ai_model', 'openai/gpt-5');
    expect(await screen.findByText('Global model saved')).toBeInTheDocument();
    await waitFor(() => expect(status()).toHaveTextContent('Saved.'));
    expect(input()).toHaveValue('openai/gpt-5');
    expect(unloadAsks()).toBe(false);
    // Saving the stored value again would change nothing.
    expect(saveBtn()).toBeDisabled();
  });

  it('empty draft: Save disabled; nothing stored: Clear disabled and the per-key fallback is stated', async () => {
    mount();
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Nothing stored. Agents use the built-in default model.',
      ),
    );
    expect(saveBtn()).toBeDisabled();
    expect(clearBtn()).toBeDisabled();
    // The status describes the input for assistive tech.
    expect(input().getAttribute('aria-describedby')).toContain(status().id);
  });

  it('each field is dirty and saved independently', async () => {
    vi.mocked(setSetting).mockResolvedValue({
      key: 'ai_model.ocr',
      value: 'dots/ocr',
    });
    mount([MODEL, OCR]);
    await waitFor(() => expect(saveBtn()).toBeDisabled());
    type('openai/a');
    type('dots/ocr', 'Model — OCR');
    fireEvent.click(saveBtn('Model — OCR'));
    await waitFor(() =>
      expect(status('ai_model.ocr')).toHaveTextContent('Saved.'),
    );
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith('ai_model.ocr', 'dots/ocr');
    // The other field's edit is untouched and still unsaved.
    expect(input()).toHaveValue('openai/a');
    expect(status()).toHaveTextContent('Unsaved edit');
    expect(unloadAsks()).toBe(true);
  });

  it('a save whose outcome is unknown (network) is "not confirmed", keeps the input and re-reads', async () => {
    vi.mocked(setSetting).mockRejectedValue(new TypeError('Failed to fetch'));
    listOnce([{ key: 'ai_model', value: 'openai/old' }]);
    // The re-read shows the write did NOT land.
    vi.mocked(getSettings).mockResolvedValue([
      { key: 'ai_model', value: 'openai/old' },
    ]);
    mount();
    await waitFor(() => expect(input()).toHaveValue('openai/old'));
    type('openai/new');
    fireEvent.click(saveBtn());
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Save not confirmed — Failed to fetch. It may or may not have been stored; your input is kept.',
      ),
    );
    expect(status()).not.toHaveTextContent('Not saved');
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expect(input()).toHaveValue('openai/new');
    expect(unloadAsks()).toBe(true);
  });

  it('an unconfirmed save that the re-read shows DID land ends as stored, not failed', async () => {
    vi.mocked(setSetting).mockRejectedValue(
      new HttpError(502, '502 Bad Gateway: upstream'),
    );
    listOnce([{ key: 'ai_model', value: 'openai/old' }]);
    vi.mocked(getSettings).mockResolvedValue([
      { key: 'ai_model', value: 'openai/new' },
    ]);
    mount();
    await waitFor(() => expect(input()).toHaveValue('openai/old'));
    type('openai/new');
    fireEvent.click(saveBtn());
    await waitFor(() =>
      expect(status()).toHaveTextContent('Stored on the server.'),
    );
    expect(input()).toHaveValue('openai/new');
    expect(unloadAsks()).toBe(false);
  });

  it('while the FIRST settings read is in flight Save waits; the typed draft survives the read landing', async () => {
    const first = deferred<Setting[]>();
    vi.mocked(getSettings).mockReturnValueOnce(first.promise);
    vi.mocked(setSetting).mockResolvedValue({
      key: 'public_api_url',
      value: 'https://new',
    });
    const URL_DEF: SettingDef = {
      key: 'public_api_url',
      label: 'Public API URL',
      unset: 'The env var applies.',
    };
    mount([URL_DEF]);
    expect(status('public_api_url')).toHaveTextContent(
      'Loading the stored value… Save waits until it is known.',
    );
    type('https://new', 'Public API URL');
    expect(saveBtn('Public API URL')).toBeDisabled();
    expect(clearBtn('Public API URL')).toBeDisabled();
    expect(unloadAsks()).toBe(true);
    await act(async () => {
      first.resolve([{ key: 'public_api_url', value: 'https://old' }]);
      await first.promise;
    });
    // The read does not replace what was typed; it becomes the comparison.
    expect(input('Public API URL')).toHaveValue('https://new');
    await waitFor(() =>
      expect(status('public_api_url')).toHaveTextContent(
        'Unsaved edit — Save stores this field only. Stored now: “https://old”.',
      ),
    );
    fireEvent.click(saveBtn('Public API URL'));
    await waitFor(() =>
      expect(status('public_api_url')).toHaveTextContent('Saved.'),
    );
    expect(setSetting).toHaveBeenCalledWith('public_api_url', 'https://new');
  });

  it('first read failed: Retry loads it, the typed draft is kept', async () => {
    vi.mocked(getSettings)
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue([{ key: 'ai_model', value: 'openai/old' }]);
    mount();
    await waitFor(() =>
      expect(status()).toHaveTextContent('Stored value unknown'),
    );
    type('openai/typed');
    expect(saveBtn()).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry loading Global model' }),
    );
    await waitFor(() =>
      expect(status()).toHaveTextContent('Stored now: “openai/old”.'),
    );
    expect(input()).toHaveValue('openai/typed');
    expect(saveBtn()).toBeEnabled();
  });

  it('a rejected save says so inline, keeps the input and stays unsaved', async () => {
    vi.mocked(setSetting).mockRejectedValue(
      new HttpError(400, 'Invalid value for setting ai_model'),
    );
    mount();
    await waitFor(() => expect(saveBtn()).toBeDisabled());
    type('x');
    fireEvent.click(saveBtn());
    // Toast carries the server text verbatim; the field line says it too.
    expect(
      await screen.findByText('Invalid value for setting ai_model'),
    ).toBeInTheDocument();
    expect(status()).toHaveTextContent(
      'Not saved — Invalid value for setting ai_model. Your input is kept.',
    );
    expect(input()).toHaveValue('x');
    expect(unloadAsks()).toBe(true);
    expect(saveBtn()).toBeEnabled();
    // The next edit replaces the failure with the live unsaved status.
    type('xy');
    expect(status()).toHaveTextContent('Unsaved edit');
  });

  it('typing during a pending save keeps the newer input, unsaved, through the response and refetch', async () => {
    const put = deferred<{ key: string; value: string }>();
    vi.mocked(setSetting).mockReturnValue(put.promise);
    listOnce([{ key: 'ai_model', value: 'openai/old' }]);
    vi.mocked(getSettings).mockResolvedValue([
      { key: 'ai_model', value: 'openai/sent' },
    ]);
    mount();
    await waitFor(() => expect(input()).toHaveValue('openai/old'));
    type('openai/sent');
    fireEvent.click(saveBtn());
    expect(status()).toHaveTextContent('Saving…');
    // Still editable while saving (inline form, issue #250/#251).
    expect(input()).toBeEnabled();
    type('openai/newer');
    expect(status()).toHaveTextContent(
      'Saving… Your newer edit is not included and stays unsaved.',
    );
    await act(async () => {
      put.resolve({ key: 'ai_model', value: 'openai/sent' });
      await put.promise;
    });
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(status()).toHaveTextContent('Stored now: “openai/sent”.'),
    );
    expect(status()).toHaveTextContent('Unsaved edit');
    expect(input()).toHaveValue('openai/newer');
    expect(unloadAsks()).toBe(true);
  });

  it('a save followed by a failed reload shows the acknowledged value, qualified', async () => {
    vi.mocked(setSetting).mockResolvedValue({
      key: 'ai_model',
      value: 'openai/new',
    });
    listOnce([{ key: 'ai_model', value: 'openai/old' }]);
    vi.mocked(getSettings).mockRejectedValue(new Error('503'));
    mount();
    await waitFor(() => expect(input()).toHaveValue('openai/old'));
    type('openai/new');
    fireEvent.click(saveBtn());
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Saved. Clear deletes the stored value; then: Agents use the built-in default model. Settings could not be reloaded; this is the change the server confirmed.',
      ),
    );
    expect(input()).toHaveValue('openai/new');
    expect(saveBtn()).toBeDisabled();
    expect(unloadAsks()).toBe(false);
  });

  it('a list fetch already running when the save lands never reverts the field', async () => {
    const stale = deferred<Setting[]>();
    const fresh = deferred<Setting[]>();
    vi.mocked(setSetting).mockResolvedValue({
      key: 'ai_model',
      value: 'openai/new',
    });
    listOnce([{ key: 'ai_model', value: 'openai/old' }]);
    const qc = mount();
    await waitFor(() => expect(input()).toHaveValue('openai/old'));
    vi.mocked(getSettings)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    // A background refetch starts, reading the pre-save row…
    act(() => {
      void qc.invalidateQueries({ queryKey: settingsKeys.admin });
    });
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    type('openai/new');
    fireEvent.click(saveBtn());
    await waitFor(() => expect(status()).toHaveTextContent('Saved.'));
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(3));
    // …and answers after the save; the save's own reload then fails.
    await act(async () => {
      stale.resolve([{ key: 'ai_model', value: 'openai/old' }]);
      fresh.reject(new Error('503'));
      await Promise.allSettled([stale.promise, fresh.promise]);
    });
    await waitFor(() =>
      expect(status()).toHaveTextContent('Settings could not be reloaded'),
    );
    expect(input()).toHaveValue('openai/new');
    expect(status()).toHaveTextContent('Saved.');
    expect(unloadAsks()).toBe(false);
  });
});

describe('SettingField — clear', () => {
  it('DELETE then a failed reload: field empties, Clear disables, status says removed (not a GET-verified fallback)', async () => {
    vi.mocked(deleteSetting).mockResolvedValue({
      key: 'ai_model',
      deleted: true,
    });
    listOnce([{ key: 'ai_model', value: 'openai/model-a' }]);
    vi.mocked(getSettings).mockRejectedValue(new Error('Service Unavailable'));
    mount();
    await waitFor(() => expect(input()).toHaveValue('openai/model-a'));
    fireEvent.click(clearBtn());
    expect(deleteSetting).toHaveBeenCalledWith('ai_model');
    expect(await screen.findByText('Global model cleared')).toBeInTheDocument();
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Stored value removed. Agents use the built-in default model. Settings could not be reloaded; this is the change the server confirmed.',
      ),
    );
    expect(input()).toHaveValue('');
    expect(clearBtn()).toBeDisabled();
    expect(unloadAsks()).toBe(false);
  });

  it('Clear while dirty removes the stored value but keeps the edit, unsaved', async () => {
    vi.mocked(deleteSetting).mockResolvedValue({
      key: 'ai_model',
      deleted: true,
    });
    listOnce([{ key: 'ai_model', value: 'openai/a' }]);
    vi.mocked(getSettings).mockResolvedValue([]);
    mount();
    await waitFor(() => expect(input()).toHaveValue('openai/a'));
    type('openai/b');
    fireEvent.click(clearBtn());
    expect(status()).toHaveTextContent(
      'Removing the stored value… Your edit is not saved yet.',
    );
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Unsaved edit — Save stores this field only. Nothing stored yet. Agents use the built-in default model.',
      ),
    );
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expect(input()).toHaveValue('openai/b');
    expect(clearBtn()).toBeDisabled();
    expect(unloadAsks()).toBe(true);
  });

  it('typing during a pending Clear keeps the newer input', async () => {
    const del = deferred<{ key: string; deleted: true }>();
    vi.mocked(deleteSetting).mockReturnValue(del.promise);
    listOnce([{ key: 'ai_model', value: 'openai/a' }]);
    vi.mocked(getSettings).mockResolvedValue([]);
    mount();
    await waitFor(() => expect(input()).toHaveValue('openai/a'));
    fireEvent.click(clearBtn());
    expect(status()).toHaveTextContent('Removing the stored value…');
    type('openai/c');
    expect(status()).toHaveTextContent(
      'Your newer edit is not included and stays unsaved.',
    );
    await act(async () => {
      del.resolve({ key: 'ai_model', deleted: true });
      await del.promise;
    });
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expect(input()).toHaveValue('openai/c');
    expect(status()).toHaveTextContent('Unsaved edit');
    expect(unloadAsks()).toBe(true);
  });

  it('states what Clear leads to BEFORE it is pressed', async () => {
    listOnce([{ key: 'ai_model', value: 'openai/a' }]);
    mount();
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Stored on the server. Clear deletes the stored value; then: Agents use the built-in default model.',
      ),
    );
    type('openai/b');
    expect(status()).toHaveTextContent(
      'Stored now: “openai/a”. Clear deletes the stored value; then: Agents use the built-in default model.',
    );
  });

  it('an unconfirmed Clear says so, keeps the last known value and re-reads', async () => {
    vi.mocked(deleteSetting).mockRejectedValue(
      new TypeError('Failed to fetch'),
    );
    listOnce([{ key: 'ai_model', value: 'openai/a' }]);
    vi.mocked(getSettings).mockRejectedValue(new Error('503'));
    mount();
    await waitFor(() => expect(input()).toHaveValue('openai/a'));
    fireEvent.click(clearBtn());
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Clear not confirmed — Failed to fetch. The stored value may or may not have been removed.',
      ),
    );
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expect(input()).toHaveValue('openai/a');
    expect(clearBtn()).toBeEnabled();
  });

  it('a refused Clear says so and keeps the stored value current', async () => {
    vi.mocked(deleteSetting).mockRejectedValue(new HttpError(400, 'nope'));
    listOnce([{ key: 'ai_model', value: 'openai/a' }]);
    mount();
    await waitFor(() => expect(input()).toHaveValue('openai/a'));
    fireEvent.click(clearBtn());
    await waitFor(() =>
      expect(status()).toHaveTextContent('Not cleared — nope.'),
    );
    expect(input()).toHaveValue('openai/a');
    expect(clearBtn()).toBeEnabled();
    expect(unloadAsks()).toBe(false);
  });
});

describe('SettingField — what is known about the stored value', () => {
  it('never shows a secret in status, toasts or page text', async () => {
    vi.mocked(setSetting).mockResolvedValue({
      key: 'ai_api_key',
      value: 'sk-test-FAKE-1111',
    });
    listOnce([{ key: 'ai_api_key', value: FAKE_SECRET }]);
    vi.mocked(getSettings).mockResolvedValue([
      { key: 'ai_api_key', value: 'sk-test-FAKE-1111' },
    ]);
    mount([KEY]);
    await waitFor(() => expect(input('API key')).toHaveValue(FAKE_SECRET));
    expect(input('API key')).toHaveAttribute('type', 'password');
    type('sk-test-FAKE-1111', 'API key');
    expect(status('ai_api_key')).toHaveTextContent(
      'Stored now: a hidden value.',
    );
    fireEvent.click(saveBtn('API key'));
    expect(await screen.findByText('API key saved')).toBeInTheDocument();
    await waitFor(() =>
      expect(status('ai_api_key')).toHaveTextContent('Saved.'),
    );
    expect(document.body.textContent).not.toContain('FAKE');
  });

  it('while loading: says so and offers no Clear', async () => {
    vi.mocked(getSettings).mockReturnValue(new Promise(() => undefined));
    mount();
    expect(status()).toHaveTextContent('Loading the stored value…');
    expect(clearBtn()).toBeDisabled();
  });

  it('first load failed: the stored value is unknown, not "nothing stored"', async () => {
    vi.mocked(getSettings).mockRejectedValue(new Error('503'));
    mount();
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Stored value unknown — settings could not be loaded.',
      ),
    );
    expect(status()).not.toHaveTextContent('Nothing stored');
    expect(clearBtn()).toBeDisabled();
  });

  it('a failed background refetch qualifies the last known value', async () => {
    listOnce([{ key: 'ai_model', value: 'openai/a' }]);
    vi.mocked(getSettings).mockRejectedValue(new Error('503'));
    const qc = mount();
    await waitFor(() => expect(input()).toHaveValue('openai/a'));
    await act(() =>
      qc.refetchQueries({ queryKey: settingsKeys.admin }).catch(() => {}),
    );
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Stored on the server. Clear deletes the stored value; then: Agents use the built-in default model. Could not refresh — this is the last known value.',
      ),
    );
  });

  it('adopts a background value change ONLY while the draft is untouched', async () => {
    listOnce([{ key: 'ai_model', value: 'one' }]);
    const qc = mount();
    await waitFor(() => expect(input()).toHaveValue('one'));
    act(() =>
      qc.setQueryData(settingsKeys.admin, [{ key: 'ai_model', value: 'two' }]),
    );
    await waitFor(() => expect(input()).toHaveValue('two'));
    type('operator-draft');
    act(() =>
      qc.setQueryData(settingsKeys.admin, [
        { key: 'ai_model', value: 'three' },
      ]),
    );
    expect(input()).toHaveValue('operator-draft');
    await waitFor(() =>
      expect(status()).toHaveTextContent('Stored now: “three”.'),
    );
  });

  it('confirmed writes survive leaving and returning while reads keep failing; other drafts are untouched', async () => {
    vi.mocked(deleteSetting).mockResolvedValue({
      key: 'ai_model',
      deleted: true,
    });
    vi.mocked(setSetting).mockResolvedValue({
      key: 'ai_model.ocr',
      value: 'dots/new',
    });
    listOnce([
      { key: 'ai_model', value: 'openai/model-a' },
      { key: 'ai_model.ocr', value: 'dots/old' },
      { key: 'ai_api_key', value: FAKE_SECRET },
    ]);
    vi.mocked(getSettings).mockRejectedValue(new Error('Service Unavailable'));
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = (show: boolean) => (
      <QueryClientProvider client={qc}>
        <UnsavedChangesProvider onUnauthorized={() => undefined}>
          {show &&
            [MODEL, OCR, KEY].map((d) => <SettingField key={d.key} def={d} />)}
          <AppToaster />
        </UnsavedChangesProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(ui(true));
    await waitFor(() => expect(input()).toHaveValue('openai/model-a'));
    // An independent unsaved draft in another field…
    type('sk-test-FAKE-draft', 'API key');
    // …while two other keys are written concurrently, both acknowledged.
    type('dots/new', 'Model — OCR');
    fireEvent.click(clearBtn());
    fireEvent.click(saveBtn('Model — OCR'));
    await waitFor(() =>
      expect(status()).toHaveTextContent('Stored value removed.'),
    );
    await waitFor(() =>
      expect(status('ai_model.ocr')).toHaveTextContent('Saved.'),
    );
    await waitFor(() =>
      expect(status()).toHaveTextContent('Settings could not be reloaded'),
    );
    expect(input('API key')).toHaveValue('sk-test-FAKE-draft');
    expect(status('ai_api_key')).toHaveTextContent('Unsaved edit');
    // Leave (the draft is discarded deliberately by reverting it) …
    type(FAKE_SECRET, 'API key');
    expect(unloadAsks()).toBe(false);
    rerender(ui(false));
    // … and come back with the settings read still failing.
    rerender(ui(true));
    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'Could not refresh — this is the last known value.',
      ),
    );
    expect(input()).toHaveValue('');
    expect(status()).toHaveTextContent('Nothing stored.');
    expect(clearBtn()).toBeDisabled();
    expect(input('Model — OCR')).toHaveValue('dots/new');
    expect(saveBtn('Model — OCR')).toBeDisabled();
    // Keys nobody wrote keep their last loaded value (no one-row list).
    expect(input('API key')).toHaveValue(FAKE_SECRET);
    expect(unloadAsks()).toBe(false);
    expect(document.body.textContent).not.toContain('FAKE');
  });
});
