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

  it('wires hint and error to the control via aria-describedby', () => {
    const { rerender } = render(
      <Field label="Amount" hint="In euros">
        <TextInput aria-label="Amount" />
      </Field>,
    );
    const input = screen.getByLabelText('Amount');
    expect(screen.getByText('In euros').id).toBe(
      input.getAttribute('aria-describedby'),
    );
    rerender(
      <Field label="Amount" error="Required">
        <TextInput aria-label="Amount" />
      </Field>,
    );
    expect(screen.getByLabelText('Amount')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByText('Required').id).toBe(
      screen.getByLabelText('Amount').getAttribute('aria-describedby'),
    );
  });

  it('group variant renders role=group without a label element (chip clusters)', () => {
    render(
      <Field label="Category" group>
        <div>
          <button>Fuel</button>
          <button>Office</button>
        </div>
      </Field>,
    );
    const group = screen.getByRole('group', { name: 'Category' });
    expect(group).toBeInTheDocument();
    expect(group.querySelector('label')).toBeNull();
  });
});
