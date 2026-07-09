import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  setSetting: vi.fn(),
  deleteSetting: vi.fn(),
}));
import { deleteSetting, setSetting } from '../api';
import { AppToaster } from '../ui/toast';
import { SettingField } from './SettingField';

const DEF = {
  key: 'ai_model',
  label: 'Global model',
  placeholder: 'openai/gpt-4o-mini',
};

function mount(current = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SettingField def={DEF} current={current} />
      <AppToaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('SettingField', () => {
  it('saves the trimmed draft to the exact key', async () => {
    vi.mocked(setSetting).mockResolvedValue({
      key: 'ai_model',
      value: 'openai/gpt-5',
    });
    mount('');
    fireEvent.change(screen.getByLabelText('Global model'), {
      target: { value: '  openai/gpt-5  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Global model' }));
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith('ai_model', 'openai/gpt-5'),
    );
    expect(await screen.findByText('Global model saved')).toBeInTheDocument();
  });

  it('Save disabled on an empty draft (server nonEmpty validator); Clear disabled when unset', () => {
    mount('');
    expect(
      screen.getByRole('button', { name: 'Save Global model' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Clear Global model' }),
    ).toBeDisabled();
  });

  it('Clear DELETEs the key when a value exists', async () => {
    vi.mocked(deleteSetting).mockResolvedValue({
      key: 'ai_model',
      deleted: true,
    });
    mount('openai/gpt-4o-mini');
    fireEvent.click(screen.getByRole('button', { name: 'Clear Global model' }));
    await waitFor(() => expect(deleteSetting).toHaveBeenCalledWith('ai_model'));
  });

  it('surfaces the registry 400 verbatim', async () => {
    vi.mocked(setSetting).mockRejectedValue(
      new Error('Invalid value for setting public_api_url'),
    );
    mount('');
    fireEvent.change(screen.getByLabelText('Global model'), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Global model' }));
    expect(
      await screen.findByText('Invalid value for setting public_api_url'),
    ).toBeInTheDocument();
  });

  it('adopts a background value change ONLY when the draft is untouched (legacy sync guard)', async () => {
    const { rerender } = render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SettingField def={DEF} current="one" />
      </QueryClientProvider>,
    );
    // Untouched → a refetched value flows in.
    rerender(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SettingField def={DEF} current="two" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Global model')).toHaveValue('two'),
    );
    // Mid-edit → the operator's draft survives the next background change.
    fireEvent.change(screen.getByLabelText('Global model'), {
      target: { value: 'operator-draft' },
    });
    rerender(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SettingField def={DEF} current="three" />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText('Global model')).toHaveValue('operator-draft');
  });
});
