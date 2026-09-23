import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button, DEFAULT_PENDING_LABEL } from './Button';
import { PendingFieldset } from './Form';

describe('Button', () => {
  it('renders children and defaults to primary variant', () => {
    render(<Button>Approve</Button>);
    const btn = screen.getByRole('button', { name: 'Approve' });
    expect(btn.className).toContain('bg-accent');
  });

  it('applies danger variant', () => {
    render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole('button').className).toContain('bg-err');
  });

  it('plain buttons (no busy prop) add no status region', () => {
    render(<Button>Approve</Button>);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Button busy (issue #281)', () => {
  it('keeps the operation name while pending and is disabled + aria-busy', () => {
    render(
      <Button busy>
        Approve · <span>−1234.56 €</span>
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Approve · −1234.56 €' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).not.toHaveTextContent('Working');
  });

  it('announces pending in a status outside the button, empty when idle', () => {
    const { rerender } = render(<Button busy={false}>Save</Button>);
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy');

    rerender(<Button busy>Save</Button>);
    // Same node: the live region existed before it had text.
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent(DEFAULT_PENDING_LABEL);
    expect(screen.getByRole('button').contains(status)).toBe(false);

    rerender(<Button busy={false}>Save</Button>);
    expect(status).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('announces a caller pendingLabel', () => {
    render(
      <Button busy pendingLabel="Approving the expense…">
        Approve
      </Button>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Approving the expense…',
    );
  });

  it('an explicit aria-label stays the name while pending', () => {
    render(
      <Button busy aria-label="Save global model">
        Save
      </Button>,
    );
    expect(
      screen.getByRole('button', { name: 'Save global model' }),
    ).toBeDisabled();
  });

  it('adds no second status inside a PendingFieldset (it announces)', () => {
    render(
      <PendingFieldset pending>
        <Button busy type="submit">
          Create expense
        </Button>
      </PendingFieldset>,
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(/locked/);
    expect(
      screen.getByRole('button', { name: 'Create expense' }),
    ).toBeDisabled();
  });

  it('keeps ref, type, form, explicit disabled and aria wiring', () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <>
        <span id="d">Posts to the ledger</span>
        <Button
          ref={ref}
          busy={false}
          type="submit"
          form="f1"
          disabled
          aria-describedby="d"
          className="w-full"
        >
          Post
        </Button>
      </>,
    );
    const btn = screen.getByRole('button', { name: 'Post' });
    expect(ref.current).toBe(btn);
    expect(btn).toHaveAttribute('type', 'submit');
    expect(btn).toHaveAttribute('form', 'f1');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription('Posts to the ledger');
    expect(btn.className).toContain('w-full');
  });

  it('defaults to type="button"', () => {
    render(<Button busy={false}>Cancel</Button>);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute(
      'type',
      'button',
    );
  });
});
