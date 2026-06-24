import { Fragment, type ReactNode } from 'react';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
}

export function Table<T>({
  columns,
  rows,
  actions,
  expandedRow,
}: {
  columns: Column<T>[];
  rows: T[];
  /** Optional trailing per-row controls (e.g. a delete button). */
  actions?: (row: T) => ReactNode;
  /**
   * Optional full-width detail rendered directly BENEATH a row (a master-detail
   * inline expansion, e.g. a document's Details/triage panel). Return null/false
   * for a collapsed row; a truthy node renders in a spanning row under it.
   */
  expandedRow?: (row: T, index: number) => ReactNode;
}) {
  if (rows.length === 0) {
    return <p className="text-gray-500 p-4">Nothing here yet.</p>;
  }
  return (
    <div className="sm:overflow-x-auto">
      <table className="block sm:table min-w-full text-sm sm:border-collapse">
        <thead className="hidden sm:table-header-group">
          <tr className="border-b bg-gray-50 text-left">
            {columns.map((c) => (
              <th
                key={c.header}
                className="px-3 py-2 font-medium text-gray-700"
              >
                {c.header}
              </th>
            ))}
            {actions && (
              <th className="px-3 py-2 font-medium text-gray-700">Actions</th>
            )}
          </tr>
        </thead>
        <tbody className="block sm:table-row-group space-y-4 sm:space-y-0">
          {rows.map((row, i) => {
            const expanded = expandedRow?.(row, i);
            const span = columns.length + (actions ? 1 : 0);
            return (
              <Fragment key={i}>
                <tr className="block sm:table-row bg-white sm:bg-transparent border border-gray-200 sm:border-0 sm:border-b rounded-lg sm:rounded-none shadow-sm sm:shadow-none p-4 sm:p-0 hover:bg-gray-50">
                  {columns.map((c) => (
                    <td
                      key={c.header}
                      className="flex sm:table-cell justify-between items-center sm:items-start py-2 sm:px-3 sm:py-2 border-b border-gray-100 sm:border-0 last:border-0 sm:align-top"
                    >
                      <span className="sm:hidden font-medium text-gray-500 mr-4">
                        {c.header}
                      </span>
                      <div className="text-right sm:text-left">
                        {c.cell(row)}
                      </div>
                    </td>
                  ))}
                  {actions && (
                    <td className="block sm:table-cell pt-3 mt-3 border-t border-gray-100 sm:border-0 sm:pt-2 sm:mt-0 sm:px-3 sm:py-2 sm:align-top">
                      {actions(row)}
                    </td>
                  )}
                </tr>
                {expanded && (
                  <tr className="block sm:table-row bg-gray-50 sm:border-b">
                    <td
                      colSpan={span}
                      className="block sm:table-cell px-3 py-3 align-top"
                    >
                      {expanded}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
