import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApprovalsView } from './ApprovalsView';
import * as api from '../api';

const approval = {
  id: 9,
  object_type: 'expense',
  object_id: 42,
  status: 'pending',
  requested_by: 'system',
  approved_by: null,
  rejected_reason: null,
  policy_reason: 'Unknown supplier requires approval',
  superseded_by: null,
  created_at: 0,
  resolved_at: null,
};

describe('ApprovalsView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getPendingApprovals').mockResolvedValue([approval]);
    vi.spyOn(api, 'approveApproval').mockResolvedValue({ approval });
    vi.spyOn(window, 'prompt').mockReturnValue('operator');
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists pending approvals and approves with the entered approver', async () => {
    render(<ApprovalsView />);
    expect(await screen.findByText(/expense #42/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    await waitFor(() =>
      expect(api.approveApproval).toHaveBeenCalledWith(9, 'operator'),
    );
  });
});
