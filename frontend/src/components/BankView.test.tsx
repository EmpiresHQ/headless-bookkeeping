import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BankView } from './BankView';
import * as api from '../api';

vi.mock('../api', () => ({
  importBankStatement: vi.fn(),
  getBankImportStatus: vi.fn(),
}));

describe('BankView', () => {
  beforeEach(() => {
    vi.mocked(api.importBankStatement).mockResolvedValue({ jobId: 7 });
    // First (immediate) poll already returns `done`, so the component stops
    // polling right away — no fake timers or real 1.5s waits needed.
    vi.mocked(api.getBankImportStatus).mockResolvedValue({
      id: 7,
      status: 'done',
      account_code: 'BANK_EUR',
      statement_id: 5,
      error: null,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('imports a CSV and shows the created statement', async () => {
    render(<BankView />);

    const fileInput = screen.getByLabelText(
      'Bank statement CSV',
    ) as HTMLInputElement;
    const file = new File(['Date,Amount\n'], 's.csv', { type: 'text/csv' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    const accountInput = screen.getByLabelText('Account code') as HTMLInputElement;
    fireEvent.change(accountInput, { target: { value: 'BANK_EUR' } });

    fireEvent.click(screen.getByRole('button', { name: /import/i }));

    expect(
      await screen.findByText('Created statement #5'),
    ).toBeInTheDocument();
    expect(api.importBankStatement).toHaveBeenCalledWith(file, 'BANK_EUR');
  });
});
