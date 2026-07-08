import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';

function renderShell(path = '/inbox') {
  const router = createMemoryRouter(
    [
      {
        element: <AppLayout onSignOut={vi.fn()} />,
        children: [
          { path: '/inbox', element: <p>inbox body</p> },
          { path: '/books', element: <p>books body</p> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

describe('AppLayout', () => {
  it('renders all five sections in both navs and the outlet content', () => {
    renderShell();
    // TabBar + Sidebar both render the section links (2 x 5 links).
    expect(screen.getAllByRole('link', { name: /inbox/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /books/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /bank/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /reports/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /settings/i })).toHaveLength(2);
    expect(screen.getByText('inbox body')).toBeInTheDocument();
  });

  it('marks the active section', () => {
    renderShell('/books');
    const active = screen
      .getAllByRole('link', { name: /books/i })
      .map((a) => a.getAttribute('aria-current'));
    expect(active).toContain('page');
  });
});
