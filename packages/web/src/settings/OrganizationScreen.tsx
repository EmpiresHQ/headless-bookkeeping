import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { updateOrganization, type Organization } from '../api';
import { sharedKeys } from '../queries/keys';
import { invalidateOrganization, useOrganization } from '../queries/settings';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { Field, INPUT_CLS, SelectInput, TextInput } from '../ui/Form';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';

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
  if (orgQ.isError) {
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

function OrgForm({ data }: { data: Organization }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [country, setCountry] = useState(data.country);
  const [orgType, setOrgType] = useState(
    data.org_type === 'sole_proprietor' ? 'sole_proprietor' : 'company',
  );
  const [vatRegistered, setVatRegistered] = useState(data.vat_registered);
  const [name, setName] = useState(data.name ?? '');
  const [vatNumber, setVatNumber] = useState(
    data.vat_registration_number ?? '',
  );
  const [iban, setIban] = useState(data.iban ?? '');
  const [currency, setCurrency] = useState(data.base_currency ?? '');

  // Sync guard (SettingField.tsx's syncedCurrent pattern, ported to a
  // multi-field form): a background refetch (staleTime 15s +
  // refetchOnWindowFocus) adopts the new server snapshot into the fields
  // ONLY while the operator has no unsaved edit — otherwise tabbing away
  // mid-edit silently clobbers every typed field on return.
  const syncedData = useRef(data);
  const dirty = useRef(false);
  useEffect(() => {
    if (data === syncedData.current) return;
    if (!dirty.current) {
      setCountry(data.country);
      setOrgType(
        data.org_type === 'sole_proprietor' ? 'sole_proprietor' : 'company',
      );
      setVatRegistered(data.vat_registered);
      setName(data.name ?? '');
      setVatNumber(data.vat_registration_number ?? '');
      setIban(data.iban ?? '');
      setCurrency(data.base_currency ?? '');
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
  const valid = countryErr === null && currencyErr === null;

  const save = async () => {
    setBusy(true);
    try {
      const saved = await updateOrganization({
        country: country.trim().toUpperCase(),
        org_type: orgType === 'sole_proprietor' ? 'sole_proprietor' : 'company',
        vat_registered: vatRegistered,
        // Empty string → null: inherit the country plugin's base currency
        // (ADR-0004; legacy organization-tab semantics preserved).
        base_currency: currency.trim() ? currency.trim().toUpperCase() : null,
        name: name.trim() ? name.trim() : null,
        vat_registration_number: vatNumber.trim() ? vatNumber.trim() : null,
        iban: iban.trim() ? iban.trim() : null,
      });
      // The saved snapshot is the new clean baseline — a subsequent
      // refetch (below) must be free to sync it in.
      dirty.current = false;
      qc.setQueryData(sharedKeys.organization, saved);
      await invalidateOrganization(qc);
      toastOk('Organization saved');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-3.5 mb-3.5 space-y-4 rounded-2xl bg-surface p-4">
      <Field label="Name">
        <TextInput
          aria-label="Name"
          value={name}
          onChange={(e) => {
            dirty.current = true;
            setName(e.target.value);
          }}
          placeholder="e.g. Acme OÜ"
        />
      </Field>
      <Field
        label="Country"
        error={countryErr}
        hint="Determines the accounting plugin, VAT rates and period frequency"
      >
        <TextInput
          aria-label="Country"
          value={country}
          onChange={(e) => {
            dirty.current = true;
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
            dirty.current = true;
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
            dirty.current = true;
            setVatRegistered(e.target.checked);
          }}
        />
        <span>VAT registered</span>
      </label>
      <Field
        label="VAT registration number"
        hint="Declarant identity — a locked period's FINAL KMD download fails without it"
      >
        <TextInput
          aria-label="VAT registration number"
          value={vatNumber}
          onChange={(e) => {
            dirty.current = true;
            setVatNumber(e.target.value);
          }}
          placeholder="e.g. EE123456789"
        />
      </Field>
      <Field label="IBAN">
        <TextInput
          aria-label="IBAN"
          value={iban}
          onChange={(e) => {
            dirty.current = true;
            setIban(e.target.value);
          }}
          placeholder="e.g. EE382200221020145685"
        />
      </Field>
      <Field
        label="Base currency"
        error={currencyErr}
        hint="Blank = inherit the country plugin default"
      >
        <TextInput
          aria-label="Base currency"
          value={currency}
          onChange={(e) => {
            dirty.current = true;
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
        onClick={() => void save()}
      >
        Save organization
      </Button>
    </div>
  );
}
