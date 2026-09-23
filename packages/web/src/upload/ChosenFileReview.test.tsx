import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../inbox/pdfjs', () => ({
  loadPdfJs: vi.fn(),
  pdfDocumentOptions: () => ({ isEvalSupported: false }),
}));

import * as pdfjs from '../inbox/pdfjs';
import { ChosenFileReview, SLOW_PREVIEW_MS } from './ChosenFileReview';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake pdf.js: each getDocument() is a task the test settles; pages
 *  render at once. */
function fakePdf() {
  const tasks: {
    done: ReturnType<typeof deferred<unknown>>;
    destroy: ReturnType<typeof vi.fn>;
  }[] = [];
  const doc = (numPages: number) => ({
    numPages,
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    })),
  });
  const getDocument = vi.fn(() => {
    const t = { done: deferred<unknown>(), destroy: vi.fn(async () => {}) };
    tasks.push(t);
    return { promise: t.done.promise, destroy: t.destroy };
  });
  vi.mocked(pdfjs.loadPdfJs).mockResolvedValue({
    getDocument,
    version: 'x',
  } as never);
  return { tasks, doc, getDocument };
}

function Harness() {
  const [file, setFile] = useState<File | null>(null);
  return (
    <ChosenFileReview
      label="File"
      file={file}
      onChoose={setFile}
      onRemove={() => setFile(null)}
      submitLabel="Upload & process"
    />
  );
}

const input = () => screen.getByLabelText('File');
const choose = (f: File) =>
  fireEvent.change(input(), { target: { files: [f] } });
/** A picker closed without a choice: browsers report an empty selection. */
const cancelPicker = () => fireEvent.change(input(), { target: { files: [] } });
const img = () => document.querySelector('img');

const png = (name = 'receipt.png') =>
  new File(['png-bytes'], name, { type: 'image/png' });
const pdf = (name = 'invoice.pdf') =>
  new File(['%PDF-1.7'], name, { type: 'application/pdf' });

const clientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'clientWidth',
);
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 400,
  });
  if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Blob.prototype.arrayBuffer = function () {
      return Promise.resolve(new ArrayBuffer(8));
    };
  }
});
afterAll(() => {
  if (clientWidth)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
});

let urls: Map<string, Blob>;
let revoked: string[];
beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  urls = new Map();
  revoked = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
    const u = `blob:local-${++n}`;
    urls.set(u, b as Blob);
    return u;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => {
    revoked.push(u);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ChosenFileReview (issue #293)', () => {
  it('offers one photo-or-file entry without forcing the camera or narrowing types', () => {
    render(<Harness />);
    expect(
      screen.getByRole('button', { name: 'Choose photo or file' }),
    ).toBeInTheDocument();
    expect(input()).not.toHaveAttribute('capture');
    expect(input()).not.toHaveAttribute('accept');
    expect(
      screen.getByText(/depends on your device and browser/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing is uploaded until you press Upload & process/),
    ).toBeInTheDocument();
  });

  it('a raster photo is previewed locally from the chosen File and confirmed once drawn', () => {
    render(<Harness />);
    const f = png();
    choose(f);
    expect(screen.getByText('receipt.png')).toBeInTheDocument();
    expect(
      screen.getByText(/PNG image, 9 B · selected on this device/),
    ).toBeInTheDocument();
    expect(img()).toHaveAttribute('alt', 'Selected file receipt.png');
    expect(urls.get(img()!.getAttribute('src')!)).toBe(f);
    fireEvent.load(img()!);
    expect(
      screen.getByText(/whole page is in the photo and the text is sharp/),
    ).toBeInTheDocument();
  });

  it('an image the browser cannot draw says so, with a local alternative — never "download the original"', () => {
    render(<Harness />);
    choose(png('broken.png'));
    fireEvent.error(img()!);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/can’t be displayed here/);
    expect(alert).toHaveTextContent(/choose another photo or a PDF/);
    expect(alert).not.toHaveTextContent(/download/i);
    expect(screen.queryByText(/text is sharp/)).toBeNull();
  });

  it('HEIC: tried, and when this browser cannot show it, says so honestly without claiming it was checked', () => {
    render(<Harness />);
    // Some pickers report no type: the extension still identifies it.
    choose(new File(['heic'], 'IMG_0001.HEIC', { type: '' }));
    expect(screen.getByText(/HEIC photo/)).toBeInTheDocument();
    fireEvent.error(img()!);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/This HEIC photo can’t be displayed here/);
    expect(alert).toHaveTextContent(/JPEG or PNG photo, or a PDF/);
    expect(screen.queryByText(/Check it is the right document/)).toBeNull();
  });

  it('a PDF is reviewable page by page through the shared viewer', async () => {
    const lib = fakePdf();
    render(<Harness />);
    const f = pdf();
    choose(f);
    await waitFor(() => expect(lib.getDocument).toHaveBeenCalledTimes(1));
    lib.tasks[0].done.resolve(lib.doc(3));
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    expect(await screen.findByText(/Check each page/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('canvas')).toHaveAttribute(
        'data-drawn-page',
        '2',
      ),
    );
  });

  it('a password-protected PDF: local guidance, no pointless retry, no "download the original"', async () => {
    const lib = fakePdf();
    render(<Harness />);
    choose(pdf('locked.pdf'));
    await waitFor(() => expect(lib.getDocument).toHaveBeenCalled());
    const e = new Error('No password given');
    e.name = 'PasswordException';
    lib.tasks[0].done.reject(e);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      /password-protected, so its pages can’t be checked here/,
    );
    expect(alert).toHaveTextContent(/unprotected copy or a photo/);
    expect(alert).not.toHaveTextContent(/download/i);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // Still the operator's choice: it can be changed or removed.
    expect(screen.getByRole('button', { name: 'Change file' })).toBeEnabled();
  });

  it('a file that is not a valid PDF: says so and points to another file', async () => {
    const lib = fakePdf();
    render(<Harness />);
    choose(pdf('fake.pdf'));
    await waitFor(() => expect(lib.getDocument).toHaveBeenCalled());
    const e = new Error('Invalid PDF structure.');
    e.name = 'InvalidPDFException';
    lib.tasks[0].done.reject(e);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be opened as a PDF/);
    expect(alert).not.toHaveTextContent(/download/i);
  });

  it.each([
    ['logo.svg', 'image/svg+xml', /SVG files are not opened here/],
    ['page.html', 'text/html', /no preview for this file type \(text\/html\)/],
    ['data.bin', '', /no preview for this file type \(unknown type\)/],
  ])(
    '%s is never opened: no image, frame or object URL — and it stays uploadable',
    (name, type, copy) => {
      render(<Harness />);
      choose(new File(['<svg onload="x()"/>'], name, { type }));
      expect(screen.getByText(copy)).toBeInTheDocument();
      expect(screen.getByText(/You can still upload it/)).toBeInTheDocument();
      expect(img()).toBeNull();
      expect(
        document.querySelector('iframe, object, embed, canvas'),
      ).toBeNull();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(pdfjs.loadPdfJs).not.toHaveBeenCalled();
    },
  );

  it('an empty file is flagged, not previewed', () => {
    render(<Harness />);
    choose(new File([], 'empty.jpg', { type: 'image/jpeg' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/This file is empty/);
    expect(img()).toBeNull();
  });

  it('a cancelled picker keeps the choice; only Remove clears it', () => {
    render(<Harness />);
    choose(png());
    const shown = img()!.getAttribute('src');
    cancelPicker();
    expect(screen.getByText('receipt.png')).toBeInTheDocument();
    expect(img()).toHaveAttribute('src', shown);
    expect(revoked).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('receipt.png')).toBeNull();
    expect(img()).toBeNull();
    expect(revoked).toEqual([shown]);
    expect(
      screen.getByRole('button', { name: 'Choose photo or file' }),
    ).toBeInTheDocument();
  });

  it('Change file opens the same picker; replacing revokes the old URL, unmount revokes the current one', () => {
    const { unmount } = render(<Harness />);
    choose(png('a.png'));
    const a = img()!.getAttribute('src')!;
    const click = vi.spyOn(input() as HTMLInputElement, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Change file' }));
    expect(click).toHaveBeenCalledTimes(1);
    choose(png('b.png'));
    const b = img()!.getAttribute('src')!;
    expect(b).not.toBe(a);
    expect(revoked).toEqual([a]);
    expect(screen.getByText('b.png')).toBeInTheDocument();
    unmount();
    expect(revoked).toEqual([a, b]);
  });

  it('rapid A(pdf) → B(photo) → A: a late result of an earlier pick never shows under the current one', async () => {
    const lib = fakePdf();
    render(<Harness />);
    const a = pdf('a.pdf');
    choose(a);
    await waitFor(() => expect(lib.getDocument).toHaveBeenCalledTimes(1));
    choose(png('b.png'));
    const b = img()!.getAttribute('src')!;
    // B's image fails late — after A is back: nothing of it may appear.
    const staleImg = img()!;
    choose(a);
    expect(revoked).toContain(b);
    expect(img()).toBeNull();
    await waitFor(() => expect(lib.getDocument).toHaveBeenCalledTimes(2));
    expect(lib.tasks[0].destroy).toHaveBeenCalled();
    fireEvent.error(staleImg);
    // The first A load finishes late with a different document.
    lib.tasks[0].done.resolve(lib.doc(5));
    lib.tasks[1].done.resolve(lib.doc(2));
    expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/of 5/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('photo A failed → photo B: B starts clean — no error or "checked" note of A carried over', () => {
    render(<Harness />);
    choose(png('a.png'));
    fireEvent.error(img()!);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    choose(png('b.png'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(img()).toHaveAttribute('alt', 'Selected file b.png');
    fireEvent.load(img()!);
    expect(screen.getByText(/text is sharp/)).toBeInTheDocument();
    // …and a ready A never vouches for a new pick not yet drawn.
    choose(png('c.png'));
    expect(screen.queryByText(/text is sharp/)).toBeNull();
  });

  it('A → clear while A is still opening: nothing of A appears afterwards', async () => {
    const lib = fakePdf();
    render(<Harness />);
    choose(pdf('a.pdf'));
    await waitFor(() => expect(lib.getDocument).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const e = new Error('Invalid PDF structure.');
    e.name = 'InvalidPDFException';
    lib.tasks[0].done.reject(e);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
    expect(lib.tasks[0].destroy).toHaveBeenCalled();
  });

  it('a preview that does not settle says so instead of loading forever', async () => {
    vi.useFakeTimers();
    vi.mocked(pdfjs.loadPdfJs).mockReturnValue(new Promise(() => undefined));
    render(<Harness />);
    choose(pdf());
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(SLOW_PREVIEW_MS);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /taking longer than usual.*choose another file, or upload this one without checking it here/,
    );
  });

  it('a File already accepted by the server names its stored document', () => {
    const f = png();
    render(
      <ChosenFileReview
        label="File"
        file={f}
        onChoose={() => undefined}
        onRemove={() => undefined}
        submitLabel="Upload & process"
        uploadedAs={32}
      />,
    );
    expect(
      screen.getByText(/already uploaded as document #32/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/selected on this device/)).toBeNull();
  });
});
