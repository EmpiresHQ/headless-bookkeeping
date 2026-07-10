import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LinkButton } from './LinkButton';

describe('LinkButton', () => {
  it('renders a link styled as a primary button', () => {
    render(
      <MemoryRouter>
        <LinkButton to="/bank/import">Import statement</LinkButton>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Import statement' });
    expect(link).toHaveAttribute('href', '/bank/import');
    expect(link.className).toContain('bg-accent');
    expect(link.className).toContain('rounded-xl');
  });

  it('supports the secondary variant and extra classes', () => {
    render(
      <MemoryRouter>
        <LinkButton to="/x" variant="secondary" className="mt-3">
          Back
        </LinkButton>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Back' });
    expect(link.className).toContain('bg-fill');
    expect(link.className).toContain('mt-3');
  });
});
