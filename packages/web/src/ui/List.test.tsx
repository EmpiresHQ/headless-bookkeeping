import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { KeyValue, ListGroup, ListRow } from './List';

describe('ListRow', () => {
  it('renders a link with chevron when `to` is set', () => {
    render(
      <MemoryRouter>
        <ListRow
          to="/books/expenses/1"
          title="Telia Eesti AS"
          subtitle="Software"
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/books/expenses/1');
    expect(screen.getByText('Telia Eesti AS')).toBeInTheDocument();
    expect(screen.getByText('›')).toBeInTheDocument();
  });

  it('renders a button when `onClick` is set and fires it', () => {
    const onClick = vi.fn();
    render(<ListRow onClick={onClick} title="Retry" />);
    screen.getByRole('button').click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders static div with no chevron when non-interactive', () => {
    render(<ListRow title="Static" />);
    expect(screen.queryByText('›')).toBeNull();
  });
});

describe('ListGroup / KeyValue', () => {
  it('renders group label and key/value pair', () => {
    render(
      <ListGroup label="Classification">
        <KeyValue k="Category" v="Software & IT" />
      </ListGroup>,
    );
    expect(screen.getByText('Classification')).toBeInTheDocument();
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByText('Software & IT')).toBeInTheDocument();
  });
});
