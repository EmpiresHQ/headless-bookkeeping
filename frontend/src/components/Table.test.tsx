import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Table } from './Table';

describe('Table actions column', () => {
  const rows = [{ id: 1, name: 'a' }];
  const columns = [{ header: 'Name', cell: (r: { name: string }) => r.name }];

  it('renders an Actions column header + cell when actions provided', () => {
    render(
      <Table
        columns={columns}
        rows={rows}
        actions={(r) => <button>del {r.id}</button>}
      />,
    );
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'del 1' })).toBeInTheDocument();
  });

  it('omits the Actions column when actions not provided', () => {
    render(<Table columns={columns} rows={rows} />);
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
  });
});
