import { useState } from 'react';
import { setToken } from '../auth';

/** Full-screen token entry shown when no token is stored (or after a 401). */
export function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <form
        className="bg-white p-6 rounded shadow w-96 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim().length === 0) return;
          setToken(value.trim());
          onSaved();
        }}
      >
        <h1 className="text-lg font-semibold">API token</h1>
        <p className="text-sm text-gray-500">
          Paste an API token. It is stored in this browser only and sent as a
          Bearer header.
        </p>
        <input
          className="w-full border rounded px-3 py-2 font-mono text-sm"
          type="password"
          placeholder="token"
          aria-label="API token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <button
          className="w-full bg-black text-white rounded px-3 py-2 text-sm"
          type="submit"
        >
          Save
        </button>
      </form>
    </div>
  );
}
