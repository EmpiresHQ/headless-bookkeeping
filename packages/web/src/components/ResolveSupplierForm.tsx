import { useEffect, useState } from 'react';
import {
  getPendingDraft,
  resolveSupplier,
  onboardEntity,
  getEntities,
  type PendingDraft,
  type Entity,
} from '../api';

const cents = (n: number) => (n / 100).toFixed(2);

export function ResolveSupplierForm({
  documentId,
  onDone,
  onCancel,
}: {
  documentId: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pd, setPd] = useState<PendingDraft | null>(null);
  const [mode, setMode] = useState<'create' | 'pick'>('create');
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [registrationKey, setRegistrationKey] = useState('');
  const [suppliers, setSuppliers] = useState<Entity[]>([]);
  const [pickId, setPickId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPendingDraft(documentId)
      .then((d) => {
        setPd(d);
        setName(d.supplier_proposal.create_name);
        setCountry(d.supplier_proposal.create_country);
        setRegistrationKey(d.supplier_proposal.create_registration_key);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    getEntities()
      .then((all) => setSuppliers(all.filter((e) => e.role === 'supplier')))
      .catch(() => undefined);
  }, [documentId]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let entityId: number;
      if (mode === 'create') {
        const created = await onboardEntity({
          role: 'supplier',
          name,
          country,
          registrationKey,
        });
        entityId = created.id;
      } else {
        if (pickId == null) {
          setError('Pick a supplier.');
          setBusy(false);
          return;
        }
        entityId = pickId;
      }
      await resolveSupplier(documentId, entityId);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (error && !pd) {
    return (
      <div className="border rounded p-3 text-sm">
        <p className="text-red-600">{error}</p>
        <button
          type="button"
          className="text-gray-600 hover:underline"
          onClick={onCancel}
        >
          Close
        </button>
      </div>
    );
  }
  if (!pd)
    return (
      <div className="border rounded p-3 text-sm text-gray-500">Loading…</div>
    );

  return (
    <div className="border rounded p-3 space-y-3 text-sm bg-gray-50">
      <div className="text-gray-700">
        AI proposes supplier <strong>{pd.supplier_proposal.create_name}</strong>{' '}
        ({pd.supplier_proposal.create_country}) — draft {pd.draft.category}{' '}
        {cents(pd.draft.gross_amount)} {pd.draft.currency} (VAT{' '}
        {cents(pd.draft.vat_amount)}), {pd.draft.tax_point_date}
      </div>

      <div className="flex gap-3">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={mode === 'create'}
            onChange={() => setMode('create')}
          />
          Create new
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={mode === 'pick'}
            onChange={() => setMode('pick')}
          />
          Pick existing
        </label>
      </div>

      {mode === 'create' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col">
            Name
            <input
              className="border rounded px-2 py-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="flex flex-col">
            Country
            <input
              className="border rounded px-2 py-1"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            />
          </label>
          <label className="flex flex-col">
            Registration key
            <input
              aria-label="Registration key"
              className="border rounded px-2 py-1"
              value={registrationKey}
              onChange={(e) => setRegistrationKey(e.target.value)}
            />
          </label>
        </div>
      ) : (
        <select
          className="border rounded px-2 py-1"
          value={pickId ?? ''}
          onChange={(e) =>
            setPickId(e.target.value ? Number(e.target.value) : null)
          }
        >
          <option value="">Select a supplier…</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.country})
            </option>
          ))}
        </select>
      )}

      {error && <p className="text-red-600">{error}</p>}

      <div className="space-x-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="bg-black text-white rounded px-3 py-1 disabled:opacity-50"
        >
          {mode === 'create' ? 'Create supplier & book' : 'Use supplier & book'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="text-gray-600 hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
