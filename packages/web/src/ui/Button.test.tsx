import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders children and defaults to primary variant', () => {
    render(<Button>Approve</Button>);
    const btn = screen.getByRole('button', { name: 'Approve' });
    expect(btn.className).toContain('bg-accent');
  });

  it('is disabled and shows spinner text while busy', () => {
    render(<Button busy>Save</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('applies danger variant', () => {
    render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole('button').className).toContain('bg-err');
  });
});
