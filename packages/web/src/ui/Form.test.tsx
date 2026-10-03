import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createPortal } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  blockComposingEnter,
  Field,
  noImplicitSubmit,
  SubmitForm,
  TextInput,
} from './Form';

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

describe('SubmitForm / noImplicitSubmit (issue #266)', () => {
  // Fixture only: the manual Books forms have no textarea, but a form built
  // on SubmitForm must keep a textarea's Enter a newline.
  function Fixture({
    onSubmit,
    onInner = () => undefined,
  }: {
    onSubmit: () => void;
    onInner?: () => void;
  }) {
    return (
      <SubmitForm onSubmit={onSubmit} aria-label="fixture">
        <TextInput aria-label="Amount" />
        <textarea aria-label="Note" />
        {createPortal(
          <form
            aria-label="inner"
            onSubmit={(e) => {
              e.preventDefault();
              onInner();
            }}
          />,
          document.body,
        )}
        <button type="submit">Save</button>
      </SubmitForm>
    );
  }

  it('Enter in a field and the button both submit through onSubmit, no reload, noValidate', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Fixture onSubmit={onSubmit} />);
    const form = screen.getByRole('form', {
      name: 'fixture',
    }) as HTMLFormElement;
    expect(form.noValidate).toBe(true);
    await user.type(screen.getByLabelText('Amount'), '12{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    // Cancelled: no navigation (jsdom would log "not implemented").
    expect(fireEvent.submit(form)).toBe(false);
  });

  it('Enter in a textarea is a newline, never a submit', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Fixture onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Note'), 'line 1{Enter}line 2');
    expect(screen.getByLabelText('Note')).toHaveValue('line 1\nline 2');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("another form's submit bubbling through the React tree is not this form's", () => {
    const onSubmit = vi.fn();
    const onInner = vi.fn();
    render(<Fixture onSubmit={onSubmit} onInner={onInner} />);
    const inner = screen.getByRole('form', {
      name: 'inner',
    }) as HTMLFormElement;
    fireEvent.submit(inner);
    expect(onInner).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a composing Enter is cancelled in an input or a textarea; a plain Enter and other composing keys are not', () => {
    const onSubmit = vi.fn();
    render(<Fixture onSubmit={onSubmit} />);
    for (const label of ['Amount', 'Note']) {
      const el = screen.getByLabelText(label);
      // Chromium: isComposing (keyCode 13); Safari: after compositionend, 229.
      expect(fireEvent.keyDown(el, { key: 'Enter', isComposing: true })).toBe(
        false,
      );
      expect(fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 })).toBe(false);
      expect(fireEvent.keyDown(el, { key: 'Enter', keyCode: 13 })).toBe(true);
      expect(fireEvent.keyDown(el, { key: 'a', isComposing: true })).toBe(true);
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a composing Enter is cancelled for controls outside their form DOM, via their ancestor', () => {
    render(
      <div onKeyDown={blockComposingEnter}>
        <input aria-label="Owned elsewhere" form="elsewhere" />
      </div>,
    );
    const el = screen.getByLabelText('Owned elsewhere');
    expect(fireEvent.keyDown(el, { key: 'Enter', isComposing: true })).toBe(
      false,
    );
    expect(fireEvent.keyDown(el, { key: 'Enter' })).toBe(true);
  });

  it('noImplicitSubmit cancels Enter, not other keys', () => {
    render(<input aria-label="Search" onKeyDown={noImplicitSubmit} />);
    const el = screen.getByLabelText('Search');
    expect(fireEvent.keyDown(el, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(el, { key: 'a' })).toBe(true);
  });
});
