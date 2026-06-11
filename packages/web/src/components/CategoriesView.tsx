import { useEffect, useState } from 'react';
import { getCategories, type CategoryDef } from '../api';

export function CategoriesView() {
  const [cats, setCats] = useState<CategoryDef[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCategories()
      .then(setCats)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="p-4 space-y-4 text-sm">
      {error && <p className="text-red-600">{error}</p>}
      <p className="text-xs text-gray-500">
        Categories are defined by the active country plugin (read-only). Each
        maps to a chart-of-accounts expense account.
      </p>
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2 font-medium text-gray-700">Key</th>
              <th className="px-3 py-2 font-medium text-gray-700">Label</th>
              <th className="px-3 py-2 font-medium text-gray-700">Account</th>
            </tr>
          </thead>
          <tbody>
            {cats.map((c) => (
              <tr key={c.key} className="border-b align-top">
                <td className="px-3 py-2">{c.key}</td>
                <td className="px-3 py-2">{c.label}</td>
                <td className="px-3 py-2 font-mono">{c.accountCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
