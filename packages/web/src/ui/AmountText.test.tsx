import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AmountText } from './AmountText';

describe('AmountText', () => {
  it('formats cents as euros', () => {
    render(<AmountText cents={-8900} />);
    expect(screen.getByText('-89.00 €')).toBeInTheDocument();
  });

  it('shows plus sign and ok color for positive amounts when showSign', () => {
    render(<AmountText cents={120000} showSign />);
    const el = screen.getByText('+1200.00 €');
    expect(el.className).toContain('text-ok');
  });

  it('renders non-EUR currency code', () => {
    render(<AmountText cents={500} currency="USD" />);
    expect(screen.getByText('5.00 USD')).toBeInTheDocument();
  });
});
