import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IntakeView } from './IntakeView';
import * as api from '../api';

const doc = {
  id: 5,
  filename: 'invoice.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  status: 'pending',
  created_at: 0,
};

describe('IntakeView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([doc]);
    vi.spyOn(api, 'triageDocument').mockResolvedValue({
      kind: 'expense',
      document_id: 5,
      expense_id: 42,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists pending documents and runs triage, showing the outcome', async () => {
    render(<IntakeView />);
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /run triage/i }));

    await waitFor(() => expect(api.triageDocument).toHaveBeenCalledWith(5));
    expect(await screen.findByText(/expense #42/i)).toBeInTheDocument();
  });
});
