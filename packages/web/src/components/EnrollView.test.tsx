import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnrollView } from './EnrollView';
import * as api from '../api';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,FAKE') },
}));

describe('EnrollView', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a QR image after fetching an enrollment token', async () => {
    vi.spyOn(api, 'createDeviceEnrollment').mockResolvedValue({
      apiBaseUrl: 'https://api.example.test',
      enrollmentToken: 'enr0lltok',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    render(<EnrollView />);

    const img = await screen.findByAltText('Enrollment QR code');
    await waitFor(() =>
      expect(img).toHaveAttribute('src', 'data:image/png;base64,FAKE'),
    );
  });

  it('shows an error message when the request fails', async () => {
    vi.spyOn(api, 'createDeviceEnrollment').mockRejectedValue(
      new Error('boom'),
    );
    render(<EnrollView />);
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });
});
