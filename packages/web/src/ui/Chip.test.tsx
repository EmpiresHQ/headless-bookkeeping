import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Chip } from './Chip';

describe('Chip', () => {
  it('renders tone classes', () => {
    render(<Chip tone="warn">needs triage</Chip>);
    const el = screen.getByText('needs triage');
    expect(el.className).toContain('bg-warn-bg');
    expect(el.className).toContain('text-warn');
  });

  it('defaults to muted', () => {
    render(<Chip>draft</Chip>);
    expect(screen.getByText('draft').className).toContain('text-ink-2');
  });
});
