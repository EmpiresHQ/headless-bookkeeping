import { useEffect, useState } from 'react';
import { getOrganization, updateOrganization, type Organization } from '../api';

const ORG_TYPES = ['company', 'sole_proprietor'] as const;

export function OrgView() {
  const [org, setOrg] = useState<Organization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    getOrganization()
      .then(setOrg)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!org) return;
    setBusy(true);
    setError(null);
    setSavedNote(null);
    try {
      const saved = await updateOrganization({
        country: org.country,
        org_type:
          org.org_type === 'sole_proprietor' ? 'sole_proprietor' : 'company',
        vat_registered: org.vat_registered,
        // Empty string → null: inherit the country plugin's base currency.
        base_currency: org.base_currency?.trim()
          ? org.base_currency.trim()
          : null,
      });
      setOrg(saved);
      setSavedNote('Organization saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!org) {
    return (
      <div className="p-4 text-sm">
        {error ? (
          <p className="text-red-600">{error}</p>
        ) : (
          <p className="text-gray-500">Loading…</p>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 max-w-lg text-sm">
      {error && <p className="text-red-600">{error}</p>}

      <label className="flex flex-col gap-1 sm:flex-row sm:items-center">
        <span className="sm:w-48 text-gray-700">Country (ISO code)</span>
        <input
          aria-label="Country"
          value={org.country}
          onChange={(e) => setOrg({ ...org, country: e.target.value })}
          placeholder="EE"
          className="border rounded px-2 py-1 sm:w-48 uppercase"
        />
      </label>

      <label className="flex flex-col gap-1 sm:flex-row sm:items-center">
        <span className="sm:w-48 text-gray-700">Org type</span>
        <select
          aria-label="Org type"
          value={org.org_type}
          onChange={(e) => setOrg({ ...org, org_type: e.target.value })}
          className="border rounded px-2 py-1 sm:w-48"
        >
          {ORG_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={org.vat_registered}
          onChange={(e) => setOrg({ ...org, vat_registered: e.target.checked })}
        />
        <span className="text-gray-700">VAT registered</span>
      </label>

      <label className="flex flex-col gap-1 sm:flex-row sm:items-center">
        <span className="sm:w-48 text-gray-700">Base currency</span>
        <input
          aria-label="Base currency"
          value={org.base_currency ?? ''}
          onChange={(e) =>
            setOrg({ ...org, base_currency: e.target.value || null })
          }
          placeholder="(inherit from country)"
          className="border rounded px-2 py-1 sm:w-48 uppercase"
        />
      </label>
      <p className="text-xs text-gray-400">
        Leave base currency blank to inherit the country plugin default.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="bg-black text-white rounded px-3 py-1 disabled:opacity-50"
        >
          Save
        </button>
        {savedNote && <span className="text-green-700">{savedNote}</span>}
      </div>
    </div>
  );
}
