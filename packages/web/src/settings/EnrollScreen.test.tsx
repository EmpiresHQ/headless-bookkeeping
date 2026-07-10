import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') },
}));
vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  createDeviceEnrollment: vi.fn(),
  getSettings: vi.fn(),
}));
import QRCode from 'qrcode';
import { createDeviceEnrollment, getSettings } from '../api';
import { EnrollScreen } from './EnrollScreen';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/enroll']}>
        <EnrollScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue([]);
});

describe('EnrollScreen', () => {
  it('renders the QR from the EXACT legacy payload shape', async () => {
    vi.mocked(createDeviceEnrollment).mockResolvedValue({
      apiBaseUrl: 'https://api.example.com',
      enrollmentToken: 'tok-123',
      expiresAt: '2026-07-11T10:00:00.000Z',
    });
    mount();
    expect(await screen.findByAltText('Enrollment QR code')).toHaveAttribute(
      'src',
      'data:image/png;base64,QR',
    );
    expect(vi.mocked(QRCode.toDataURL)).toHaveBeenCalledWith(
      JSON.stringify({
        v: 1,
        api: 'https://api.example.com',
        enroll: 'tok-123',
      }),
    );
    expect(screen.getByText(/Expires/)).toBeInTheDocument();
  });

  it('unset public_api_url 500 → honest guidance with the fix field inline', async () => {
    vi.mocked(createDeviceEnrollment).mockRejectedValue(
      new Error(
        'Public API URL is not configured — set "public_api_url" in Settings (or the PUBLIC_API_URL env var)',
      ),
    );
    mount();
    expect(
      await screen.findByText(/The QR cannot be generated yet/),
    ).toBeInTheDocument();
    // The fix is right here — the public_api_url editor, not a dead end.
    expect(screen.getByLabelText('Public API URL')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
  });

  it('Regenerate mints a fresh enrollment', async () => {
    vi.mocked(createDeviceEnrollment).mockResolvedValue({
      apiBaseUrl: 'https://api.example.com',
      enrollmentToken: 'tok-123',
      expiresAt: '2026-07-11T10:00:00.000Z',
    });
    mount();
    await screen.findByAltText('Enrollment QR code');
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() =>
      expect(createDeviceEnrollment).toHaveBeenCalledTimes(2),
    );
  });
});
