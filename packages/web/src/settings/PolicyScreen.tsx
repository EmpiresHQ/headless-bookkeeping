import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  fmtCents,
  setSetting,
  updatePolicyConfig,
  type PolicyConfig,
} from '../api';
import { centsToEuroInput, eurosToCents } from '../lib/money';
import { sameValues, useUnsavedChanges } from '../lib/unsavedChanges';
import {
  invalidateAdminSettings,
  invalidatePolicy,
  settingsKeys,
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
  const err = policyQ.error ?? settingsQ.error;
  const loadError = (
    <LoadError
      message={err instanceof Error ? err.message : 'Failed to load policy'}
      onRetry={() => {
        void policyQ.refetch();
        void settingsQ.refetch();
      }}
    />
  );
  // Only a FIRST load failure replaces the screen; a failed background
  // refetch keeps the forms (and unsaved input) mounted and says so.
  if (policyQ.data === undefined || settingsQ.data === undefined) {
    return <Frame>{loadError}</Frame>;
  }
  return (
    <Frame>
      {(policyQ.isError || settingsQ.isError) && loadError}
      <IngestPolicyGroup current={settingsQ.data['ingest_policy'] ?? ''} />
      <RiskGateForm data={policyQ.data} />
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
  // Optimistic local echo (P06 T11 deferred): the select shows the picked
  // value during the in-flight write instead of snapping back to the cached
  // value until the refetch lands. Cleared in `finally`: on success the
  // AWAITED invalidate has already refreshed `current` to the echoed value;
  // on failure the select honestly reverts to server truth.
  const [echo, setEcho] = useState<string | null>(null);
  const onChange = async (value: string) => {
    setBusy(true);
    setEcho(value);
    try {
      await setSetting('ingest_policy', value);
      await invalidateAdminSettings(qc);
      toastOk(`Ingest policy — ${value}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setEcho(null);
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
            value={echo ?? current}
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

/** The form's view of a server snapshot — the unsaved-changes baseline. */
function policyForm(data: PolicyConfig) {
  return {
    ceiling: centsToEuroInput(data.auto_post_amount_ceiling),
    confidence: String(data.auto_post_min_confidence),
    unknownSupplier: data.unknown_supplier_requires_approval,
    alwaysApprove: data.always_approve_operations.join(', '),
  };
}

function RiskGateForm({ data }: { data: PolicyConfig }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [initial] = useState(() => policyForm(data));
  const [ceiling, setCeiling] = useState(initial.ceiling);
  const [confidence, setConfidence] = useState(initial.confidence);
  const [unknownSupplier, setUnknownSupplier] = useState(
    initial.unknownSupplier,
  );
  const [alwaysApprove, setAlwaysApprove] = useState(initial.alwaysApprove);
  const values = { ceiling, confidence, unknownSupplier, alwaysApprove };
  const adopt = (f: ReturnType<typeof policyForm>) => {
    setCeiling(f.ceiling);
    setConfidence(f.confidence);
    setUnknownSupplier(f.unknownSupplier);
    setAlwaysApprove(f.alwaysApprove);
  };
  // Unsaved = differs from the LATEST server snapshot (issue #250).
  useUnsavedChanges({
    label: 'Risk gate',
    values,
    baseline: policyForm(data),
  });
  const latest = useRef(values);
  latest.current = values;

  // Sync guard (SettingField.tsx's syncedCurrent pattern, ported to a
  // multi-field form): a background refetch (staleTime 15s +
  // refetchOnWindowFocus) adopts the new server snapshot into the fields
  // ONLY while they still equal the previous snapshot — otherwise tabbing
  // away mid-edit silently clobbers every typed field on return.
  const syncedData = useRef(data);
  useEffect(() => {
    if (data === syncedData.current) return;
    if (sameValues(latest.current, policyForm(syncedData.current))) {
      adopt(policyForm(data));
    }
    syncedData.current = data;
  }, [data]);

  const ceilingCents = eurosToCents(ceiling);
  const confidenceNum = Number(confidence);
  const confidenceOk =
    confidence.trim() !== '' &&
    Number.isFinite(confidenceNum) &&
    confidenceNum >= 0 &&
    confidenceNum <= 1;
  const valid = ceilingCents !== null && ceilingCents >= 0 && confidenceOk;
  const ceilingError =
    ceilingCents === null
      ? 'Enter an amount like 50.00'
      : ceilingCents < 0
        ? 'The ceiling cannot be negative — enter 0 or more'
        : null;

  const save = async () => {
    if (ceilingCents === null || ceilingCents < 0 || !confidenceOk) return;
    setBusy(true);
    const sent = values;
    try {
      const saved = await updatePolicyConfig({
        auto_post_amount_ceiling: ceilingCents,
        auto_post_min_confidence: confidenceNum,
        unknown_supplier_requires_approval: unknownSupplier,
        always_approve_operations: alwaysApprove
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      });
      // The saved (server-normalized) snapshot is the new baseline; adopt it
      // unless the operator kept typing during the save.
      if (sameValues(latest.current, sent)) adopt(policyForm(saved));
      syncedData.current = saved;
      qc.setQueryData(settingsKeys.policy, saved);
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
          error={ceilingError}
          hint={
            ceilingError === null && ceilingCents !== null
              ? `Expenses above ${fmtCents(ceilingCents)} € are held for approval`
              : undefined
          }
        >
          <TextInput
            aria-label="Auto-post ceiling (€)"
            inputMode="decimal"
            value={ceiling}
            onChange={(e) => {
              setCeiling(e.target.value);
            }}
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
            onChange={(e) => {
              setConfidence(e.target.value);
            }}
          />
        </Field>
        <label className="flex items-center gap-2 text-[15px]">
          <input
            type="checkbox"
            aria-label="Unknown supplier requires approval"
            checked={unknownSupplier}
            onChange={(e) => {
              setUnknownSupplier(e.target.checked);
            }}
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
            onChange={(e) => {
              setAlwaysApprove(e.target.value);
            }}
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
