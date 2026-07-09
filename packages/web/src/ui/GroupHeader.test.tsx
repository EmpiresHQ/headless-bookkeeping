import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GroupHeader } from './GroupHeader';

describe('GroupHeader', () => {
  it('renders label left and a tabular, non-wrapping trailing figure', () => {
    render(<GroupHeader label="July 2026" trailing="−650.00 € · 3" />);
    expect(screen.getByText('July 2026')).toBeInTheDocument();
    const trailing = screen.getByText('−650.00 € · 3');
    expect(trailing.className).toContain('tabular-nums');
    expect(trailing.className).toContain('whitespace-nowrap');
  });

  it('omits the trailing span when not provided', () => {
    const { container } = render(<GroupHeader label="2026" />);
    expect(screen.getByText('2026')).toBeInTheDocument();
    expect(container.querySelectorAll('span.tabular-nums')).toHaveLength(0);
  });
});
