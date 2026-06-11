import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EntitiesView } from './EntitiesView';
import * as api from '../api';

vi.mock('../api', () => ({
  getEntities: vi.fn(),
  onboardEntity: vi.fn(),
  updateEntity: vi.fn(),
  deleteEntity: vi.fn(),
}));

const acme = {
  id: 7,
  role: 'supplier',
  country: 'EE',
  name: 'Acme',
  goods_vs_services: 'goods',
};

describe('EntitiesView', () => {
  beforeEach(() => {
    vi.mocked(api.getEntities).mockResolvedValue([{ ...acme }]);
    vi.mocked(api.onboardEntity).mockResolvedValue({ ...acme, id: 8 });
    vi.mocked(api.updateEntity).mockImplementation((id, dto) =>
      Promise.resolve({ ...acme, id, ...dto } as api.Entity),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('onboards a new entity from the add form', async () => {
    render(<EntitiesView />);
    await screen.findByText('Acme'); // list loaded

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Globex' },
    });
    fireEvent.change(screen.getByLabelText('Country'), {
      target: { value: 'EE' },
    });
    fireEvent.change(screen.getByLabelText('Registration key'), {
      target: { value: 'EE123456' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(api.onboardEntity).toHaveBeenCalledWith({
      role: 'supplier',
      name: 'Globex',
      country: 'EE',
      registrationKey: 'EE123456',
      goodsVsServices: 'unknown',
    });
  });

  it('edits an existing entity name', async () => {
    render(<EntitiesView />);
    await screen.findByText('Acme');

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByLabelText('Edit name 7'), {
      target: { value: 'Acme Corp' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(api.updateEntity).toHaveBeenCalledWith(7, {
      name: 'Acme Corp',
      country: 'EE',
      goodsVsServices: 'goods',
    });
  });
});
