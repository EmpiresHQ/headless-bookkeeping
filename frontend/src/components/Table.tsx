import type { ReactNode } from 'react';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
}

export function Table<T>({
  columns,
  rows,
  actions,
}: {
  columns: Column<T>[];
  rows: T[];
  /** Optional trailing per-row controls (e.g. a delete button). */
  actions?: (row: T) => ReactNode;
}) {
  if (rows.length === 0) {
    return <p className="text-gray-500 p-4">Nothing here yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm border-collapse">
        <thead>
          <tr className="border-b bg-gray-50 text-left">
            {columns.map((c) => (
              <th key={c.header} className="px-3 py-2 font-medium text-gray-700">
                {c.header}
              </th>
            ))}
            {actions && (
              <th className="px-3 py-2 font-medium text-gray-700">Actions</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b hover:bg-gray-50">
              {columns.map((c) => (
                <td key={c.header} className="px-3 py-2 align-top">
                  {c.cell(row)}
                </td>
              ))}
              {actions && (
                <td className="px-3 py-2 align-top">{actions(row)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
