import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState, SkeletonRows } from './Feedback';

describe('EmptyState', () => {
  it('renders title and hint', () => {
    render(
      <EmptyState title="Inbox zero" hint="Nothing needs your decision." />,
    );
    expect(screen.getByText('Inbox zero')).toBeInTheDocument();
    expect(
      screen.getByText('Nothing needs your decision.'),
    ).toBeInTheDocument();
  });
});

describe('SkeletonRows', () => {
  it('renders the requested number of pulse rows', () => {
    render(<SkeletonRows count={4} />);
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(4);
  });
});
