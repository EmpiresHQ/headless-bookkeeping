import { useEffect, useState } from 'react';
import {
  getEntities,
  onboardEntity,
  updateEntity,
  deleteEntity,
  type Entity,
  type OnboardEntityInput,
} from '../api';

const ROLES = ['supplier', 'customer'] as const;
const GOODS = ['goods', 'services', 'unknown'] as const;

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
        registrationKey: form.registrationKey.trim(),
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

  const addValid =
    form.name.trim() !== '' &&
    form.country.trim() !== '' &&
    form.registrationKey.trim() !== '';

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
            onClick={onAdd}
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
        <table className="min-w-full border-collapse">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2 font-medium text-gray-700">ID</th>
              <th className="px-3 py-2 font-medium text-gray-700">Name</th>
              <th className="px-3 py-2 font-medium text-gray-700">Role</th>
              <th className="px-3 py-2 font-medium text-gray-700">Country</th>
              <th className="px-3 py-2 font-medium text-gray-700">
                Goods/Services
              </th>
              <th className="px-3 py-2 font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {entities.map((e) =>
              editId === e.id && draft ? (
                <tr key={e.id} className="border-b align-top">
                  <td className="px-3 py-2">{e.id}</td>
                  <td className="px-3 py-2">
                    <input
                      aria-label={`Edit name ${e.id}`}
                      value={draft.name}
                      onChange={(ev) =>
                        setDraft({ ...draft, name: ev.target.value })
                      }
                      className="border rounded px-2 py-1"
                    />
                  </td>
                  <td className="px-3 py-2 text-gray-400">{e.role}</td>
                  <td className="px-3 py-2">
                    <input
                      aria-label={`Edit country ${e.id}`}
                      value={draft.country}
                      onChange={(ev) =>
                        setDraft({ ...draft, country: ev.target.value })
                      }
                      className="border rounded px-2 py-1 w-20 uppercase"
                    />
                  </td>
                  <td className="px-3 py-2">
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
                      className="border rounded px-2 py-1"
                    >
                      {GOODS.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 space-x-3 whitespace-nowrap">
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
                  </td>
                </tr>
              ) : (
                <tr key={e.id} className="border-b align-top">
                  <td className="px-3 py-2">{e.id}</td>
                  <td className="px-3 py-2">{e.name}</td>
                  <td className="px-3 py-2">{e.role}</td>
                  <td className="px-3 py-2">{e.country}</td>
                  <td className="px-3 py-2">{e.goods_vs_services ?? '—'}</td>
                  <td className="px-3 py-2 space-x-3 whitespace-nowrap">
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
                      onClick={() => void onDelete(e)}
                      className="text-red-600 hover:underline disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
