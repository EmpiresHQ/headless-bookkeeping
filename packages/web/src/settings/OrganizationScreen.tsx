import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  updateOrganization,
  type Organization,
  type UpdateOrganizationDto,
} from '../api';
import { sameValues, useUnsavedChanges } from '../lib/unsavedChanges';
import { sharedKeys } from '../queries/keys';
import { invalidateOrganization, useOrganization } from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { Field, INPUT_CLS, SelectInput, TextInput } from '../ui/Form';
import { LoadError } from '../ui/LoadError';
import { toastOk } from '../ui/toast';
import { usePendingOperation } from '../lib/pendingOperation';

const COUNTRY_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** /settings/organization — the GET+PUT /api/organization surface
 *  (Reality #1). Country/base-currency are constrained TEXT inputs, not the
 *  asset's ISO selects: the API exposes no supported-countries list and a
 *  200-entry ISO dropdown would be fake surface (Appendix A gap 6). */
export function OrganizationScreen() {
  const orgQ = useOrganization();
  if (orgQ.isPending) {
    return (
      <Frame>
        <SkeletonRows count={4} />
      </Frame>
    );
  }
  // Only a FIRST load failure replaces the screen. A failed background
  // refetch keeps the form (and any unsaved input) mounted and says so.
  if (orgQ.data === undefined) {
    return (
      <Frame>
        <LoadError
          message={orgQ.error instanceof Error ? orgQ.error.message : 'Failed'}
          onRetry={() => void orgQ.refetch()}
        />
      </Frame>
    );
  }
  return (
    <Frame>
      {orgQ.isError && (
        <LoadError
          message={orgQ.error instanceof Error ? orgQ.error.message : 'Failed'}
          onRetry={() => void orgQ.refetch()}
        />
      )}
      <OrgForm data={orgQ.data} />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Organization" backTo="/settings" />
      {children}
    </div>
  );
}

/** The form's view of a server snapshot — the unsaved-changes baseline. */
function fromServer(data: Organization) {
  return {
    country: data.country,
    orgType:
      data.org_type === 'sole_proprietor' ? 'sole_proprietor' : 'company',
    vatRegistered: data.vat_registered,
    vatKind: data.vat_registration_kind,
    entitlement: data.input_vat_entitlement,
    permille:
      data.input_vat_deduction_permille === null
        ? ''
        : String(data.input_vat_deduction_permille),
    name: data.name ?? '',
    vatNumber: data.vat_registration_number ?? '',
    registryCode: data.registry_code ?? '',
    iban: data.iban ?? '',
    currency: data.base_currency ?? '',
  };
}

function OrgForm({ data }: { data: Organization }) {
  const qc = useQueryClient();
  // Stays editable while saving (inline form): a save adopts the server's
  // values only if nothing was typed meanwhile — newer edits stay unsaved.
  const op = usePendingOperation('Organization');
  const busy = op.pending;
  const [initial] = useState(() => fromServer(data));
  const [country, setCountry] = useState(initial.country);
  const [orgType, setOrgType] = useState(initial.orgType);
  const [vatRegistered, setVatRegistered] = useState(initial.vatRegistered);
  const [vatKind, setVatKind] = useState(initial.vatKind);
  const [entitlement, setEntitlement] = useState(initial.entitlement);
  const [permille, setPermille] = useState(initial.permille);
  const [name, setName] = useState(initial.name);
  const [vatNumber, setVatNumber] = useState(initial.vatNumber);
  const [registryCode, setRegistryCode] = useState(initial.registryCode);
  const [iban, setIban] = useState(initial.iban);
  const [currency, setCurrency] = useState(initial.currency);
  const values = {
    country,
    orgType,
    vatRegistered,
    vatKind,
    entitlement,
    permille,
    name,
    vatNumber,
    registryCode,
    iban,
    currency,
  };
  const adopt = (f: ReturnType<typeof fromServer>) => {
    setCountry(f.country);
    setOrgType(f.orgType);
    setVatRegistered(f.vatRegistered);
    setVatKind(f.vatKind);
    setEntitlement(f.entitlement);
    setPermille(f.permille);
    setName(f.name);
    setVatNumber(f.vatNumber);
    setRegistryCode(f.registryCode);
    setIban(f.iban);
    setCurrency(f.currency);
  };

  // Unsaved = differs from the LATEST server snapshot (issue #250). The
  // baseline and the fields are derived from the same `data`.
  useUnsavedChanges({
    label: 'Organization',
    values,
    baseline: fromServer(data),
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
    if (sameValues(latest.current, fromServer(syncedData.current))) {
      adopt(fromServer(data));
    }
    syncedData.current = data;
  }, [data]);

  const countryErr = COUNTRY_RE.test(country.trim().toUpperCase())
    ? null
    : 'Two-letter ISO code, e.g. EE';
  const currencyErr =
    currency.trim() === '' || CURRENCY_RE.test(currency.trim().toUpperCase())
      ? null
      : 'Three-letter ISO code, e.g. EUR — or blank to inherit';
  // Deduction entitlement only exists for a registered person, and the
  // proportion only exists while the entitlement is partial. Checked here so
  // the form cannot send a combination the API will reject (issue #211).
  // A limited registration deducts nothing, so the entitlement is not a choice
  // there — the control is disabled and reads 'none' rather than offering a
  // Full/Partial the plugin would always answer zero to.
  const effectiveEntitlement =
    !vatRegistered || vatKind === 'limited' ? 'none' : entitlement;
  const permilleNum = Number(permille);
  const permilleErr =
    effectiveEntitlement !== 'partial'
      ? null
      : /^\d+$/.test(permille.trim()) && permilleNum >= 0 && permilleNum <= 1000
        ? null
        : 'A whole number of per mille, 0–1000 (500 = 50%)';
  const valid =
    countryErr === null && currencyErr === null && permilleErr === null;

  const save = () => {
    const sent = values;
    const req: UpdateOrganizationDto = {
      country: country.trim().toUpperCase(),
      org_type: orgType === 'sole_proprietor' ? 'sole_proprietor' : 'company',
      vat_registered: vatRegistered,
      vat_registration_kind: vatKind,
      // Deregistering carries the entitlement to 'none' with it — the API
      // refuses any other combination, and so does the form.
      input_vat_entitlement: effectiveEntitlement,
      input_vat_deduction_permille:
        effectiveEntitlement === 'partial' ? permilleNum : null,
      // Empty string → null: inherit the country plugin's base currency
      // (ADR-0004; legacy organization-tab semantics preserved).
      base_currency: currency.trim() ? currency.trim().toUpperCase() : null,
      name: name.trim() ? name.trim() : null,
      vat_registration_number: vatNumber.trim() ? vatNumber.trim() : null,
      registry_code: registryCode.trim() || null,
      iban: iban.trim() ? iban.trim() : null,
    };
    op.run(() => updateOrganization(req), {
      onSuccess: (saved) => {
        // The saved (server-normalized) snapshot is the new baseline; adopt
        // it into the fields unless the operator kept typing during the save
        // — their newer edits stay, and stay unsaved.
        if (sameValues(latest.current, sent)) adopt(fromServer(saved));
        syncedData.current = saved;
        qc.setQueryData(sharedKeys.organization, saved);
        void invalidateOrganization(qc);
        toastOk('Organization saved');
      },
    });
  };

  return (
    <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
      <Field label="Name">
        <TextInput
          aria-label="Name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          placeholder="e.g. Acme OÜ"
        />
      </Field>
      <Field
        label="Country"
        error={countryErr}
        hint="Determines the accounting rules, VAT rates and how often VAT is filed. Locked once the first entry is posted — posted amounts were measured under this country’s rules"
      >
        <TextInput
          aria-label="Country"
          value={country}
          onChange={(e) => {
            setCountry(e.target.value.toUpperCase());
          }}
          placeholder="EE"
          maxLength={2}
          className={`${INPUT_CLS} uppercase`}
        />
      </Field>
      <Field label="Type">
        <SelectInput
          aria-label="Type"
          value={orgType}
          onChange={(e) => {
            setOrgType(e.target.value);
          }}
        >
          <option value="company">Company</option>
          <option value="sole_proprietor">Sole proprietor</option>
        </SelectInput>
      </Field>
      <label className="flex items-center gap-2 text-[15px]">
        <input
          type="checkbox"
          aria-label="VAT registered"
          checked={vatRegistered}
          onChange={(e) => {
            setVatRegistered(e.target.checked);
          }}
        />
        <span>VAT registered</span>
      </label>
      {vatRegistered && (
        <>
          <Field
            label="Registration kind"
            hint="A limited taxable person (piiratud maksukohustuslane) self-assesses VAT on specified acquisitions and deducts no input VAT"
          >
            <SelectInput
              aria-label="Registration kind"
              value={vatKind}
              onChange={(e) => {
                setVatKind(
                  e.target.value === 'limited' ? 'limited' : 'ordinary',
                );
              }}
            >
              <option value="ordinary">Ordinary</option>
              <option value="limited">Limited</option>
            </SelectInput>
          </Field>
          <Field
            label="Input VAT deduction"
            hint={
              vatKind === 'limited'
                ? 'A limited taxable person deducts no input VAT: the tax it self-assesses is payable in full and increases the expense or asset cost'
                : 'Inputs used partly for non-business or exempt supply are deductible only in proportion (KMD row 5)'
            }
          >
            <SelectInput
              aria-label="Input VAT deduction"
              disabled={vatKind === 'limited'}
              value={effectiveEntitlement}
              onChange={(e) => {
                const v = e.target.value;
                setEntitlement(v === 'partial' || v === 'none' ? v : 'full');
              }}
            >
              <option value="full">Full</option>
              <option value="partial">Partial</option>
              <option value="none">None</option>
            </SelectInput>
          </Field>
          {effectiveEntitlement === 'partial' && (
            <Field
              label="Deductible proportion (per mille)"
              error={permilleErr}
              hint="500 = 50%"
            >
              <TextInput
                aria-label="Deductible proportion (per mille)"
                value={permille}
                onChange={(e) => {
                  setPermille(e.target.value);
                }}
                placeholder="e.g. 500"
                inputMode="numeric"
              />
            </Field>
          )}
        </>
      )}
      <Field
        label="VAT registration number"
        hint="VAT registration number (KMKR)"
      >
        <TextInput
          aria-label="VAT registration number"
          value={vatNumber}
          onChange={(e) => {
            setVatNumber(e.target.value);
          }}
          placeholder="e.g. EE123456789"
        />
      </Field>
      <Field
        label="Registry code"
        hint="Commercial registry code — required for the final KMD (8 digits for Estonia)"
      >
        <TextInput
          aria-label="Registry code"
          value={registryCode}
          onChange={(e) => {
            setRegistryCode(e.target.value);
          }}
          placeholder="e.g. 17499653"
        />
      </Field>
      <Field label="IBAN">
        <TextInput
          aria-label="IBAN"
          value={iban}
          onChange={(e) => {
            setIban(e.target.value);
          }}
          placeholder="e.g. EE382200221020145685"
        />
      </Field>
      <Field
        label="Base currency"
        error={currencyErr}
        hint="Leave blank to use the country’s default currency. Locked once the first entry is posted — every posted amount is measured in it"
      >
        <TextInput
          aria-label="Base currency"
          value={currency}
          onChange={(e) => {
            setCurrency(e.target.value.toUpperCase());
          }}
          placeholder="(inherit)"
          maxLength={3}
          className={`${INPUT_CLS} uppercase`}
        />
      </Field>
      <Button
        className="w-full"
        busy={busy}
        disabled={!valid || busy}
        onClick={save}
      >
        Save organization
      </Button>
    </div>
  );
}
