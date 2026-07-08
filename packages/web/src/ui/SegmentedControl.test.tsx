import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

describe('SegmentedControl', () => {
  const options = [
    { value: 'all', label: 'All' },
    { value: 'triage', label: 'Triage' },
  ];

  it('marks active option and switches on click', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl options={options} value="all" onChange={onChange} />,
    );
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    screen.getByRole('tab', { name: 'Triage' }).click();
    expect(onChange).toHaveBeenCalledWith('triage');
  });
});
