import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field, TextInput } from './Form';

describe('Field', () => {
  it('associates label with input and shows error', () => {
    render(
      <Field label="Gross (EUR)" error="Enter a valid amount">
        <TextInput />
      </Field>,
    );
    expect(screen.getByLabelText('Gross (EUR)')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid amount')).toBeInTheDocument();
  });

  it('shows hint when no error', () => {
    render(
      <Field label="Currency" hint="ISO code, e.g. EUR">
        <TextInput />
      </Field>,
    );
    expect(screen.getByText('ISO code, e.g. EUR')).toBeInTheDocument();
  });
});
