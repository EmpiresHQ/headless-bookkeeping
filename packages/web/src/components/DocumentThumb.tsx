import { useState } from 'react';

interface Props {
  id: number;
  /** null = known-absent → skip the request, show fallback immediately.
   *  undefined = unknown → request preview, fall back on error. */
  preview_path?: string | null;
}

export function DocumentThumb({ id, preview_path }: Props) {
  const [errored, setErrored] = useState(preview_path === null);
  const fileUrl = `/api/documents/${id}/file`;

  return (
    <a href={fileUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {errored ? (
        <span
          aria-label="no preview"
          className="inline-flex items-center justify-center w-10 h-10 bg-gray-100 rounded text-gray-400 text-xs"
        >
          📄
        </span>
      ) : (
        <img
          src={`/api/documents/${id}/preview`}
          alt="preview"
          aria-label="preview"
          width={48}
          height={48}
          className="w-10 h-10 object-cover rounded border border-gray-200"
          onError={() => setErrored(true)}
        />
      )}
    </a>
  );
}
