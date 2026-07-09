import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  fmtCents,
  setSetting,
  updatePolicyConfig,
  type PolicyConfig,
} from '../api';
import { centsToEuroInput, eurosToCents } from '../lib/money';
import {
  invalidateAdminSettings,
  invalidatePolicy,
  useAdminSettings,
  usePolicyConfig,
} from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { GroupLabel } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';

const INGEST_OPTIONS = ['known-only', 'quarantine', 'open'] as const;

/** /settings/policy — the risk gate in EUROS (Reality #11: the wire is
 *  integer cents; the legacy raw-cents input dies) + the ingest-policy
 *  setting. Every threshold explains its effect (asset §9+). */
export function PolicyScreen() {
  const policyQ = usePolicyConfig();
  const settingsQ = useAdminSettings();
  if (policyQ.isPending || settingsQ.isPending) {
    return (
      <Frame>
        <SkeletonRows count={3} />
      </Frame>
    );
  }
  if (policyQ.isError || settingsQ.isError) {
    const err = policyQ.error ?? settingsQ.error;
    return (
      <Frame>
        <LoadError
          message={err instanceof Error ? err.message : 'Failed to load policy'}
          onRetry={() => {
            void policyQ.refetch();
            void settingsQ.refetch();
          }}
        />
      </Frame>
    );
  }
  return (
    <Frame>
      <IngestPolicyGroup current={settingsQ.data['ingest_policy'] ?? ''} />
      <RiskGateForm key={policyQ.dataUpdatedAt} initial={policyQ.data} />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Posting policy" backTo="/settings" />
      {children}
    </div>
  );
}

function IngestPolicyGroup({ current }: { current: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const onChange = async (value: string) => {
    setBusy(true);
    try {
      await setSetting('ingest_policy', value);
      await invalidateAdminSettings(qc);
      toastOk(`Ingest policy — ${value}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <GroupLabel>Intake</GroupLabel>
      <div className="mx-3.5 mb-3.5 rounded-2xl bg-surface p-4">
        <Field
          label="Ingest policy"
          hint="How intake treats documents from unknown senders"
        >
          <SelectInput
            aria-label="Ingest policy"
            value={current}
            disabled={busy}
            onChange={(e) => void onChange(e.target.value)}
          >
            <option value="" disabled>
              (choose)
            </option>
            {INGEST_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>
    </>
  );
}

function RiskGateForm({ initial }: { initial: PolicyConfig }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [ceiling, setCeiling] = useState(
    centsToEuroInput(initial.auto_post_amount_ceiling),
  );
  const [confidence, setConfidence] = useState(
    String(initial.auto_post_min_confidence),
  );
  const [unknownSupplier, setUnknownSupplier] = useState(
    initial.unknown_supplier_requires_approval,
  );
  const [alwaysApprove, setAlwaysApprove] = useState(
    initial.always_approve_operations.join(', '),
  );

  const ceilingCents = eurosToCents(ceiling);
  const confidenceNum = Number(confidence);
  const confidenceOk =
    confidence.trim() !== '' &&
    Number.isFinite(confidenceNum) &&
    confidenceNum >= 0 &&
    confidenceNum <= 1;
  const valid = ceilingCents !== null && ceilingCents >= 0 && confidenceOk;

  const save = async () => {
    if (ceilingCents === null || !confidenceOk) return;
    setBusy(true);
    try {
      await updatePolicyConfig({
        auto_post_amount_ceiling: ceilingCents,
        auto_post_min_confidence: confidenceNum,
        unknown_supplier_requires_approval: unknownSupplier,
        always_approve_operations: alwaysApprove
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      });
      await invalidatePolicy(qc);
      toastOk('Policy saved');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <GroupLabel>Risk gate</GroupLabel>
      <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
        <Field
          label="Auto-post ceiling (€)"
          error={ceilingCents === null ? 'Enter an amount like 50.00' : null}
          hint={
            ceilingCents !== null
              ? `Expenses above ${fmtCents(ceilingCents)} € are held for approval`
              : undefined
          }
        >
          <TextInput
            aria-label="Auto-post ceiling (€)"
            inputMode="decimal"
            value={ceiling}
            onChange={(e) => setCeiling(e.target.value)}
          />
        </Field>
        <Field
          label="Minimum AI confidence (0–1)"
          error={confidenceOk ? null : 'A number between 0 and 1'}
          hint="Auto-posts below this confidence are held instead"
        >
          <TextInput
            aria-label="Minimum AI confidence (0–1)"
            inputMode="decimal"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-[15px]">
          <input
            type="checkbox"
            aria-label="Unknown supplier requires approval"
            checked={unknownSupplier}
            onChange={(e) => setUnknownSupplier(e.target.checked)}
          />
          <span>Unknown supplier requires approval</span>
        </label>
        <Field
          label="Always-approve operations"
          hint="Comma-separated operation names — these are held for approval regardless of amount"
        >
          <TextInput
            aria-label="Always-approve operations"
            value={alwaysApprove}
            onChange={(e) => setAlwaysApprove(e.target.value)}
            placeholder="comma-separated"
          />
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={!valid || busy}
          onClick={() => void save()}
        >
          Save policy
        </Button>
      </div>
    </>
  );
}
