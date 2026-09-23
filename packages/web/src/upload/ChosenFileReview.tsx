import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText, FileUp } from 'lucide-react';
import {
  ImageViewer,
  PdfViewer,
  useObjectUrl,
  type ViewerStatus,
} from '../inbox/DocumentSourcePane';
import { Button } from '../ui/Button';
import { READABLE } from '../ui/List';

/**
 * Choosing a file to upload, and checking it BEFORE anything is sent
 * (issue #293) — shared by "Upload a document" and the OCR "Fix file"
 * replacement. Everything here is local: the preview reads the chosen File
 * in this browser, never the server (no /api/documents/{id}), and nothing is
 * uploaded until the owning sheet's explicit submit.
 *
 * - The picker is the browser's own: on a phone it may offer the camera,
 *   the photo library or files — that is device-dependent, so nothing here
 *   promises a camera, and no `capture` forces one on everyone. There is no
 *   `accept` filter either: every type the server takes stays choosable.
 * - A cancelled picker never clears the choice (browsers report it as an
 *   empty selection); only "Remove" does.
 * - Each selection is a new preview generation (keyed), so a late
 *   render/error of an earlier pick never shows under a newer one; object
 *   URLs are revoked on replace and unmount (the sheet's content unmounts
 *   when it closes or the session ends).
 * - Only inert media are rendered: PDFs through the shared pdf.js viewer
 *   (no scripting, no XFA), rasters through <img>. SVG/HTML/other
 *   documents are never opened.
 */
export function ChosenFileReview({
  label,
  file,
  onChoose,
  onRemove,
  submitLabel,
  uploadedAs = null,
}: {
  /** Accessible name of the file input. */
  label: string;
  file: File | null;
  onChoose: (file: File) => void;
  onRemove: () => void;
  /** The owning sheet's submit — the only thing that uploads. */
  submitLabel: string;
  /** The stored document THIS File already became (a staged partial
   *  success), shown once known; the sheet states what remains
   *  (processing / result / archive / payer). Without it the header claims
   *  nothing about the server — an unanswered upload may or may not have
   *  stored the file (#259 receipt). */
  uploadedAs?: number | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Preview generation: bumped by every accepted pick, even the same File
  // chosen again, so each pick starts from a clean preview.
  const [pick, setPick] = useState(0);
  const openPicker = () => inputRef.current?.click();
  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        aria-label={label}
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          const chosen = e.target.files?.[0] ?? null;
          // Reset, so the same file can be picked again after Remove.
          e.target.value = '';
          // Cancelled picker (empty selection): keep the current choice.
          if (chosen === null) return;
          setPick((p) => p + 1);
          onChoose(chosen);
        }}
      />
      {file === null ? (
        <div className="rounded-2xl border border-dashed border-line px-4 py-4 text-center">
          <Button variant="secondary" onClick={openPicker}>
            <span className="inline-flex items-center gap-1.5">
              <FileUp className="size-4" aria-hidden /> Choose photo or file
            </span>
          </Button>
          <p className="mt-2 text-[12px] text-ink-2">
            A photo, a PDF or another document file. On a phone, what the picker
            offers (camera, photos, files) depends on your device and browser.
            Nothing is uploaded until you press {submitLabel}.
          </p>
        </div>
      ) : (
        <section
          aria-label="Selected file"
          className="overflow-hidden rounded-2xl border border-line bg-surface"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2">
            <div className="min-w-0 flex-[1_1_10rem]">
              <p className={`text-[13px] font-semibold ${READABLE}`}>
                {file.name}
              </p>
              <p className="text-[12px] text-ink-2">
                {describeFile(file)} ·{' '}
                {uploadedAs === null
                  ? 'selected on this device'
                  : `already uploaded as document #${uploadedAs}`}
              </p>
            </div>
            <div className="flex flex-none gap-1">
              <Button variant="ghost" className="!px-2" onClick={openPicker}>
                Change file
              </Button>
              <Button variant="ghost" className="!px-2" onClick={onRemove}>
                Remove
              </Button>
            </div>
          </div>
          <LocalPreview key={pick} file={file} />
        </section>
      )}
    </div>
  );
}

/** How long a preview may stay unsettled before saying so (never an
 *  endless spinner with nothing else to do). */
export const SLOW_PREVIEW_MS = 12_000;

const HEIC_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);
const IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

/** The file's media type — from the picker, else (some Android pickers and
 *  desktop files report none) from its extension. */
function fileType(file: File): string {
  const reported = file.type.split(';')[0].trim().toLowerCase();
  if (reported !== '') return reported;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'application/pdf';
  return IMAGE_EXTENSIONS[ext] ?? '';
}

export type PreviewKind = 'pdf' | 'image' | 'none';

/** What may be rendered locally: a PDF, a raster image (the browser decides
 *  if it can draw it — HEIC works in some), or nothing. SVG is excluded: it
 *  is a document, not a photo. */
export function previewKind(file: File): PreviewKind {
  const type = fileType(file);
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/') && !type.startsWith('image/svg'))
    return 'image';
  return 'none';
}

function describeFile(file: File): string {
  const type = fileType(file);
  const kind =
    type === 'application/pdf'
      ? 'PDF'
      : HEIC_TYPES.has(type)
        ? 'HEIC photo'
        : type.startsWith('image/')
          ? `${type.slice(6).toUpperCase()} image`
          : type !== ''
            ? type
            : 'unknown type';
  return `${kind}, ${formatSize(file.size)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Note({ children, alert }: { children: ReactNode; alert?: boolean }) {
  return (
    <p
      role={alert ? 'alert' : undefined}
      className={`px-3 py-2 text-[12.5px] ${alert ? 'bg-warn-bg text-warn' : 'text-ink-2'}`}
    >
      {children}
    </p>
  );
}

/** One pick's preview. Mounted per pick (keyed) and only while the sheet's
 *  content is: its object URL / pdf.js document go with it. */
function LocalPreview({ file }: { file: File }) {
  const kind = file.size === 0 ? 'empty' : previewKind(file);
  const [status, setStatus] = useState<ViewerStatus | null>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (kind !== 'pdf' && kind !== 'image') return;
    const t = setTimeout(() => setSlow(true), SLOW_PREVIEW_MS);
    return () => clearTimeout(t);
  }, [kind]);

  if (kind === 'empty') {
    return (
      <Note alert>
        This file is empty (0 bytes) — there is nothing in it to read. Choose
        another file.
      </Note>
    );
  }
  if (kind === 'none') {
    const type = fileType(file);
    return (
      <Note>
        <FileText className="mr-1 inline size-4 align-[-3px]" aria-hidden />
        {type.startsWith('image/svg')
          ? 'SVG files are not opened here, so this one can’t be checked before upload.'
          : `There is no preview for this file type (${type || 'unknown type'}), so it can’t be checked here.`}{' '}
        You can still upload it; whether it can be read is only known after
        processing. To check a document first, choose a photo or a PDF of it.
      </Note>
    );
  }
  return (
    <>
      <div className="flex h-[55vh] max-h-[34rem] min-h-[16rem] flex-col border-b border-line">
        {kind === 'pdf' ? (
          <PdfViewer blob={file} subject="local" onStatus={setStatus} />
        ) : (
          <LocalImage file={file} onStatus={setStatus} />
        )}
      </div>
      {status === 'ready' ? (
        <Note>
          {kind === 'pdf'
            ? 'Check each page (use the arrows) — right document, whole page, text sharp enough to read.'
            : 'Check it is the right document, the whole page is in the photo and the text is sharp enough to read.'}
        </Note>
      ) : status === null && slow ? (
        <Note alert>
          The preview is taking longer than usual. You can keep waiting, choose
          another file, or upload this one without checking it here.
        </Note>
      ) : null}
    </>
  );
}

function LocalImage({
  file,
  onStatus,
}: {
  file: File;
  onStatus: (s: ViewerStatus) => void;
}) {
  const url = useObjectUrl(file);
  if (url === null) return null;
  const heic = HEIC_TYPES.has(fileType(file));
  return (
    <ImageViewer
      url={url}
      alt={`Selected file ${file.name}`}
      onStatus={onStatus}
      failedText={
        heic
          ? 'This HEIC photo can’t be displayed here (not every browser shows HEIC, and the file may be damaged), so it can’t be checked before upload. You can upload it as it is, or choose a JPEG or PNG photo, or a PDF, to check it first.'
          : 'This image can’t be displayed here — it may be damaged or in a format this browser doesn’t show. You can upload it as it is, or choose another photo or a PDF to check it first.'
      }
    />
  );
}
