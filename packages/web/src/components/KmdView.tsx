import { useEffect, useState } from 'react';
import {
  getReportingPeriods,
  getKmd,
  createReportingPeriod,
  downloadStatutoryReport,
  fmtCents,
  type ReportingPeriod,
  type KmdDeclaration,
} from '../api';

const ROWS: { label: string; key: keyof KmdDeclaration }[] = [
  { label: 'Row 1 — 24% käive (base)', key: 'row1_base_24' },
  { label: 'Row 2 — 9/13% käive (base)', key: 'row2_base_reduced' },
  { label: 'Row 3 — 0% käive (base)', key: 'row3_base_zero' },
  { label: 'Row 4 — output VAT', key: 'row4_output_vat' },
  { label: 'Row 5 — input VAT', key: 'row5_input_vat' },
  {
    label: 'Row 6 — intra-EU acquisitions (base)',
    key: 'row6_intra_eu_acquisition',
  },
  { label: 'Row 7 — other acquisitions (base)', key: 'row7_other_acquisition' },
];

export function KmdView() {
  const [periods, setPeriods] = useState<ReportingPeriod[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [decl, setDecl] = useState<KmdDeclaration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd] = useState('');

  function handleDownload() {
    if (selected === null) return;
    setDownloading(true);
    downloadStatutoryReport(selected, 'all')
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDownloading(false));
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    createReportingPeriod({ name: newName, start_date: newStart, end_date: newEnd })
      .then((p) => {
        setPeriods((prev) => [...prev, p]);
        setSelected(p.id);
        setShowCreate(false);
        setNewName('');
        setNewStart('');
        setNewEnd('');
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setCreating(false));
  }

  // Load the period list once; default to the first period.
  useEffect(() => {
    getReportingPeriods()
      .then((ps) => {
        setPeriods(ps);
        if (ps.length > 0) setSelected(ps[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Fetch the declaration whenever the selected period changes.
  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    setDecl(null);
    setError(null);
    getKmd(selected)
      .then((d) => {
        if (!cancelled) setDecl(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm flex items-center gap-2">
          <span className="text-gray-600">Period</span>
          <select
            className="border rounded px-2 py-1 text-sm"
            value={selected ?? ''}
            onChange={(e) => setSelected(Number(e.target.value))}
          >
            {periods.length === 0 && <option value="">(no periods)</option>}
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.start_date} → {p.end_date})
              </option>
            ))}
          </select>
        </label>
        <button
          className="text-sm border rounded px-3 py-1 bg-white hover:bg-gray-50"
          onClick={() => setShowCreate((v) => !v)}
        >
          {showCreate ? 'Cancel' : 'New period'}
        </button>
        <button
          className="text-sm border rounded px-3 py-1 bg-white hover:bg-gray-50 disabled:opacity-50"
          disabled={selected === null || downloading}
          onClick={handleDownload}
        >
          {downloading ? 'Downloading…' : 'Download KMD'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="flex items-end gap-2 flex-wrap text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-gray-600">Name</span>
            <input
              className="border rounded px-2 py-1"
              placeholder="e.g. 2026-06"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-600">Start date</span>
            <input
              type="date"
              className="border rounded px-2 py-1"
              value={newStart}
              onChange={(e) => setNewStart(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-600">End date</span>
            <input
              type="date"
              className="border rounded px-2 py-1"
              value={newEnd}
              onChange={(e) => setNewEnd(e.target.value)}
              required
            />
          </label>
          <button
            type="submit"
            className="border rounded px-3 py-1 bg-white hover:bg-gray-50 disabled:opacity-50"
            disabled={creating}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}

      {error && <p className="text-red-600 text-sm">{error}</p>}

      {decl && (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="text-sm border-collapse">
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.key} className="border-b">
                    <td className="px-3 py-1 text-gray-700">{r.label}</td>
                    <td className="px-3 py-1 text-right tabular-nums">
                      {fmtCents(decl[r.key] as number)} €
                    </td>
                  </tr>
                ))}
                <tr className="border-b font-medium">
                  <td className="px-3 py-1">Net VAT due (row 4 − row 5)</td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {fmtCents(decl.net_vat_due)} €
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-1 text-gray-700">
                    VD koondaruanne — 3S (intra-EU services)
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {fmtCents(decl.vd_intra_eu_services)} €
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {decl.vd_intra_eu_services > 0 && (
            <p className="text-sm text-amber-700">
              File the VD koondaruanne (tähis 3S) manually in e-MTA — the system
              does not submit it.
            </p>
          )}

          {decl.review_flags.length > 0 && (
            <div className="text-sm">
              <p className="font-medium text-gray-700">Review before filing:</p>
              <ul className="list-disc ml-5 text-amber-700">
                {decl.review_flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
