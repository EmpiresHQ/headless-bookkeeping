import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CategoriesView } from './CategoriesView';
import * as api from '../api';

describe('CategoriesView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getCategories').mockResolvedValue([
      { key: 'software', label: 'Software', accountCode: 'EXPENSE_SOFTWARE' },
      { key: 'rent', label: 'Rent', accountCode: 'EXPENSE_RENT' },
    ]);
  });

  it('renders each category with its account binding', async () => {
    render(<CategoriesView />);
    await waitFor(() => expect(screen.getByText('software')).toBeInTheDocument());
    expect(screen.getByText('EXPENSE_SOFTWARE')).toBeInTheDocument();
    expect(screen.getByText('rent')).toBeInTheDocument();
    expect(screen.getByText('EXPENSE_RENT')).toBeInTheDocument();
  });
});
