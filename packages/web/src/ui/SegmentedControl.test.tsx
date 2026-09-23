import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

const options = [
  { value: 'all', label: 'All' },
  { value: 'triage', label: 'Triage' },
  { value: 'approvals', label: 'Approvals' },
];

function Controlled({
  label = 'Inbox filter',
  initial = 'all',
  disabled,
  onChange,
}: {
  label?: string;
  initial?: string;
  disabled?: boolean;
  onChange?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      label={label}
      options={options}
      value={value}
      disabled={disabled}
      onChange={(v) => {
        onChange?.(v);
        setValue(v);
      }}
    />
  );
}

describe('SegmentedControl (issue #288: a radio group, not tabs)', () => {
  it('is a named radio group with the value checked, and switches on click', async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Inbox filter' });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(within(group).getByRole('radio', { name: 'All' })).toBeChecked();
    await userEvent.click(screen.getByText('Triage'));
    expect(onChange).toHaveBeenCalledWith('triage');
    expect(screen.getByRole('radio', { name: 'Triage' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'All' })).not.toBeChecked();
  });

  it('arrow keys move focus and the choice, wrapping at both ends', async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const all = screen.getByRole('radio', { name: 'All' });
    const triage = screen.getByRole('radio', { name: 'Triage' });
    const approvals = screen.getByRole('radio', { name: 'Approvals' });
    all.focus();

    await userEvent.keyboard('{ArrowRight}');
    expect(triage).toHaveFocus();
    expect(triage).toBeChecked();
    await userEvent.keyboard('{ArrowDown}');
    expect(approvals).toHaveFocus();
    expect(approvals).toBeChecked();
    await userEvent.keyboard('{ArrowRight}');
    expect(all).toHaveFocus();
    expect(all).toBeChecked();
    await userEvent.keyboard('{ArrowLeft}');
    expect(approvals).toHaveFocus();
    expect(approvals).toBeChecked();
    await userEvent.keyboard('{ArrowUp}');
    expect(triage).toHaveFocus();
    expect(triage).toBeChecked();
    expect(onChange.mock.calls.map(([v]) => v)).toEqual([
      'triage',
      'approvals',
      'all',
      'approvals',
      'triage',
    ]);
  });

  it('Tab enters on the checked option and the next Tab leaves the group', async () => {
    render(
      <>
        <button type="button">before</button>
        <Controlled initial="triage" />
        <button type="button">after</button>
      </>,
    );
    screen.getByRole('button', { name: 'before' }).focus();
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: 'Triage' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('radio', { name: 'Triage' })).toHaveFocus();
  });

  it('two instances keep separate groups: arrows never cross, both stay checked', async () => {
    render(
      <>
        <Controlled label="First filter" />
        <Controlled label="Second filter" initial="approvals" />
      </>,
    );
    const first = screen.getByRole('radiogroup', { name: 'First filter' });
    const second = screen.getByRole('radiogroup', { name: 'Second filter' });
    const firstAll = within(first).getByRole('radio', { name: 'All' });
    expect(firstAll.getAttribute('name')).not.toBe(
      within(second).getByRole('radio', { name: 'All' }).getAttribute('name'),
    );

    firstAll.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(
      within(first).getByRole('radio', { name: 'Approvals' }),
    ).toHaveFocus();
    expect(
      within(first).getByRole('radio', { name: 'Approvals' }),
    ).toBeChecked();
    expect(
      within(second).getByRole('radio', { name: 'Approvals' }),
    ).toBeChecked();
    await userEvent.click(within(second).getByText('Triage'));
    expect(within(second).getByRole('radio', { name: 'Triage' })).toBeChecked();
    expect(
      within(first).getByRole('radio', { name: 'Approvals' }),
    ).toBeChecked();
  });

  it('disabled (a pending operation) refuses clicks and keys and keeps the value', async () => {
    const onChange = vi.fn();
    render(<Controlled disabled onChange={onChange} />);
    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
    await userEvent.click(screen.getByText('Triage'));
    await userEvent.keyboard('{ArrowRight}');
    // A dispatched click on the input itself changes nothing either.
    fireEvent.click(screen.getByRole('radio', { name: 'Approvals' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();
  });

  it('follows a disabled ancestor fieldset', async () => {
    const onChange = vi.fn();
    render(
      <fieldset disabled>
        <Controlled onChange={onChange} />
      </fieldset>,
    );
    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
    await userEvent.click(screen.getByText('Approvals'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();
  });

  it('a caller that refuses the change keeps its value checked', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Document source"
        options={options}
        value="all"
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByText('Triage'));
    expect(onChange).toHaveBeenCalledWith('triage');
    expect(screen.getByRole('radio', { name: 'All' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Triage' })).not.toBeChecked();
  });

  it('Enter on an option does not submit an enclosing form', async () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) =>
      e.preventDefault(),
    );
    render(
      <form onSubmit={onSubmit}>
        <Controlled />
        <button type="submit">Save</button>
      </form>,
    );
    screen.getByRole('radio', { name: 'All' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
