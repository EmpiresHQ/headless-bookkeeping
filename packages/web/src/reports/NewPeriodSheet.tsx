import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createNextPeriod } from '../api';
import {
  invalidateReports,
  periodTitle,
  usePeriodConfig,
} from '../queries/reports';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

/**
 * Create-next-period flow (POST /api/reporting-periods/next) — the legacy
 * "Create next period" + "Override" pair as one sheet. The server
 * computes the next window from the plugin filing frequency; the optional
 * overrides survive from legacy (all three independent, all optional).
 * Overlap → server 409 surfaced verbatim (Reality #1).
 */
export function NewPeriodSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const configQ = usePeriodConfig();
  const [showOverride, setShowOverride] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const input: { start_date?: string; end_date?: string; name?: string } =
        {};
      if (startDate) input.start_date = startDate;
      if (endDate) input.end_date = endDate;
      if (name) input.name = name;
      return createNextPeriod(input);
    },
    onSuccess: async (p) => {
      await invalidateReports(qc);
      toastOk(`Period ${periodTitle(p.name)} opened`);
      onOpenChange(false);
    },
    onError: (e) =>
      toastErr(e instanceof Error ? e.message : 'Could not open the period'),
  });

  const frequency = configQ.data?.default_frequency;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="New period">
      <div className="space-y-3 px-6">
        <p className="text-[13.5px] text-ink-2">
          The next period is computed from your
          {frequency ? ` ${frequency} ` : ' '}filing frequency — normally you
          just confirm.
        </p>
        {!showOverride && (
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => setShowOverride(true)}
          >
            Override dates…
          </Button>
        )}
        {showOverride && (
          <div className="space-y-3">
            <Field label="Start date">
              <TextInput
                type="date"
                aria-label="Start date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </Field>
            <Field
              label="End date"
              hint="Leave empty to compute from the start date"
            >
              <TextInput
                type="date"
                aria-label="End date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </Field>
            <Field
              label="Name"
              hint="Leave empty for the standard name (e.g. 2026-08)"
            >
              <TextInput
                aria-label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          </div>
        )}
        <Button
          className="w-full"
          busy={create.isPending}
          onClick={() => create.mutate()}
        >
          Open next period
        </Button>
      </div>
    </Sheet>
  );
}
