import { useEffect, useState } from 'react';
import {
  getEntities,
  onboardEntity,
  updateEntity,
  deleteEntity,
  getEntity,
  addEntityAlias,
  type Entity,
  type EntityIdentifier,
  type OnboardEntityInput,
  type AddAliasInput,
} from '../api';
import { Table, type Column } from './Table';

const ROLES = ['supplier', 'customer'] as const;
const GOODS = ['goods', 'services', 'unknown'] as const;
const ALIAS_KINDS = ['iban', 'merchant_descriptor', 'name_alias'] as const;

const blankForm: OnboardEntityInput = {
  role: 'supplier',
  country: '',
  name: '',
  registrationKey: '',
  goodsVsServices: 'unknown',
};

interface EditDraft {
  name: string;
  country: string;
  goodsVsServices: 'goods' | 'services' | 'unknown';
}

export function EntitiesView() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<OnboardEntityInput>(blankForm);
  const [editId, setEditId] = useState<number | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  // Identifier (alias) management — which row's panel is open + its data.
  const [aliasFor, setAliasFor] = useState<number | null>(null);
  const [aliasList, setAliasList] = useState<EntityIdentifier[]>([]);
  const [aliasDraft, setAliasDraft] = useState<AddAliasInput>({
    kind: 'merchant_descriptor',
    value: '',
  });

  const load = () =>
    getEntities()
      .then(setEntities)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onAdd = () =>
    run(async () => {
      await onboardEntity({
        ...form,
        name: form.name.trim(),
        country: form.country.trim(),
        registrationKey: (form.registrationKey ?? '').trim(),
      });
      setForm(blankForm);
    });

  const startEdit = (e: Entity) => {
    setEditId(e.id);
    setDraft({
      name: e.name,
      country: e.country,
      goodsVsServices:
        e.goods_vs_services === 'goods' || e.goods_vs_services === 'services'
          ? e.goods_vs_services
          : 'unknown',
    });
  };

  const saveEdit = (id: number) =>
    run(async () => {
      if (!draft) return;
      await updateEntity(id, {
        name: draft.name.trim(),
        country: draft.country.trim(),
        goodsVsServices: draft.goodsVsServices,
      });
      setEditId(null);
      setDraft(null);
    });

  const onDelete = (e: Entity) =>
    run(async () => {
      if (!window.confirm(`Delete entity #${e.id} "${e.name}"?`)) return;
      await deleteEntity(e.id);
    });

  const openAliases = (id: number) => {
    if (aliasFor === id) {
      setAliasFor(null);
      return;
    }
    setAliasDraft({ kind: 'merchant_descriptor', value: '' });
    void getEntity(id)
      .then((ent) => {
        setAliasList(ent.identifiers ?? []);
        setAliasFor(id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const onAddAlias = (id: number) =>
    run(async () => {
      const value = aliasDraft.value.trim();
      if (!value) return;
      await addEntityAlias(id, { ...aliasDraft, value });
      const ent = await getEntity(id);
      setAliasList(ent.identifiers ?? []);
      setAliasDraft({ kind: 'merchant_descriptor', value: '' });
    });

  const addValid =
    form.name.trim() !== '' &&
    form.country.trim() !== '' &&
    (form.registrationKey ?? '').trim() !== '';

  const columns: Column<Entity>[] = [
    { header: 'ID', cell: (e) => e.id },
    {
      header: 'Name',
      cell: (e) =>
        editId === e.id && draft ? (
          <input
            aria-label={`Edit name ${e.id}`}
            value={draft.name}
            onChange={(ev) => setDraft({ ...draft, name: ev.target.value })}
            className="border rounded px-2 py-1 w-full sm:w-auto"
          />
        ) : (
          e.name
        ),
    },
    {
      header: 'Role',
      cell: (e) =>
        editId === e.id && draft ? (
          <span className="text-gray-400">{e.role}</span>
        ) : (
          e.role
        ),
    },
    {
      header: 'Country',
      cell: (e) =>
        editId === e.id && draft ? (
          <input
            aria-label={`Edit country ${e.id}`}
            value={draft.country}
            onChange={(ev) => setDraft({ ...draft, country: ev.target.value })}
            className="border rounded px-2 py-1 w-20 uppercase"
          />
        ) : (
          e.country
        ),
    },
    {
      header: 'Goods/Services',
      cell: (e) =>
        editId === e.id && draft ? (
          <select
            aria-label={`Edit goods ${e.id}`}
            value={draft.goodsVsServices}
            onChange={(ev) =>
              setDraft({
                ...draft,
                goodsVsServices: ev.target
                  .value as EditDraft['goodsVsServices'],
              })
            }
            className="border rounded px-2 py-1 w-full sm:w-auto"
          >
            {GOODS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        ) : (
          (e.goods_vs_services ?? '—')
        ),
    },
  ];

  return (
    <div className="p-4 space-y-6 text-sm">
      {error && <p className="text-red-600">{error}</p>}

      <section className="space-y-2">
        <h2 className="font-medium text-gray-700">Add entity</h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Role</span>
            <select
              aria-label="Role"
              value={form.role}
              onChange={(e) =>
                setForm({ ...form, role: e.target.value as typeof form.role })
              }
              className="border rounded px-2 py-1"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Name</span>
            <input
              aria-label="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="border rounded px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Country</span>
            <input
              aria-label="Country"
              value={form.country}
              onChange={(e) => setForm({ ...form, country: e.target.value })}
              placeholder="EE"
              className="border rounded px-2 py-1 w-20 uppercase"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Registry / VAT no.</span>
            <input
              aria-label="Registration key"
              value={form.registrationKey}
              onChange={(e) =>
                setForm({ ...form, registrationKey: e.target.value })
              }
              className="border rounded px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Goods/Services</span>
            <select
              aria-label="Goods or services"
              value={form.goodsVsServices}
              onChange={(e) =>
                setForm({
                  ...form,
                  goodsVsServices: e.target
                    .value as OnboardEntityInput['goodsVsServices'],
                })
              }
              className="border rounded px-2 py-1"
            >
              {GOODS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || !addValid}
            onClick={() => void onAdd()}
            className="bg-black text-white rounded px-3 py-1 disabled:opacity-50"
          >
            Add
          </button>
        </div>
        <p className="text-xs text-gray-400">
          The registry / VAT number is the strong identity used to match this
          entity to invoices and bank lines — it cannot be changed later.
        </p>
      </section>

      <section>
        <Table
          columns={columns}
          rows={entities}
          actions={(e) => (
            <div className="space-x-3 whitespace-nowrap">
              {editId === e.id && draft ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void saveEdit(e.id)}
                    className="text-blue-600 hover:underline disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditId(null);
                      setDraft(null);
                    }}
                    className="text-gray-600 hover:underline"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => startEdit(e)}
                    className="text-blue-600 hover:underline disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => openAliases(e.id)}
                    className="text-gray-700 hover:underline disabled:opacity-50"
                  >
                    Aliases
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onDelete(e)}
                    className="text-red-600 hover:underline disabled:opacity-50"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          )}
        />
      </section>

      {aliasFor !== null && (
        <section className="space-y-2">
          <h2 className="font-medium text-gray-700">
            Aliases —{' '}
            {entities.find((e) => e.id === aliasFor)?.name ??
              `entity #${aliasFor}`}
          </h2>
          <p className="text-xs text-gray-500">
            An IBAN or card merchant descriptor lets reconciliation recognise
            this counterparty on bank lines.
          </p>
          {aliasList.length === 0 ? (
            <p className="text-xs text-gray-400">No aliases yet.</p>
          ) : (
            <ul className="text-xs space-y-1">
              {aliasList.map((a) => (
                <li key={a.id}>
                  <span className="text-gray-500">{a.kind}:</span>{' '}
                  <span className="font-mono">{a.value}</span>
                  {!a.confirmed && (
                    <span className="text-amber-600"> (unconfirmed)</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">Kind</span>
              <select
                aria-label="Alias kind"
                value={aliasDraft.kind}
                onChange={(ev) =>
                  setAliasDraft({
                    ...aliasDraft,
                    kind: ev.target.value as AddAliasInput['kind'],
                  })
                }
                className="border rounded px-2 py-1"
              >
                {ALIAS_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">Value</span>
              <input
                aria-label="Alias value"
                value={aliasDraft.value}
                onChange={(ev) =>
                  setAliasDraft({ ...aliasDraft, value: ev.target.value })
                }
                placeholder="e.g. ANOMALY"
                className="border rounded px-2 py-1"
              />
            </label>
            <button
              type="button"
              disabled={busy || aliasDraft.value.trim() === ''}
              onClick={() => void onAddAlias(aliasFor)}
              className="bg-black text-white rounded px-3 py-1 disabled:opacity-50"
            >
              Add alias
            </button>
            <button
              type="button"
              onClick={() => setAliasFor(null)}
              className="text-gray-600 hover:underline"
            >
              Close
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
