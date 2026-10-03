import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchDocumentPreviewObjectUrl: vi.fn(),
  openSignedDocument: vi.fn(),
}));

import * as api from '../api';
import { render } from './previewTestShell';
import {
  createModalLayerRegistry,
  ModalLayerContext,
  type ModalLayerRegistry,
} from '../lib/modalLayers';
import { Sheet } from '../ui/Sheet';
import { DocPreviewRow } from './DocPreviewRow';
import { DocThumbLightbox } from './DocThumbLightbox';

/** Issue #269: the preview is a real modal — focus starts inside and is
 *  trapped, the background is hidden/inert/unscrollable, and every way out
 *  returns focus to the control that opened it. (jsdom: the accessibility
 *  tree is checked through aria-hidden/role queries only.) */

// Radix FocusScope dispatches close-autofocus in a task after unmount.
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });

// Nothing focused may ever sit inside a subtree the modal marks aria-hidden
// (the browser's "Blocked aria-hidden" warning).
let ariaViolations: string[] = [];
const realSetAttribute = Element.prototype.setAttribute;
beforeEach(() => {
  vi.mocked(api.fetchDocumentPreviewObjectUrl).mockImplementation(
    async (_id: number, opts: { size?: 'lg' } = {}) =>
      opts.size === 'lg' ? 'blob:lg' : 'blob:thumb',
  );
  ariaViolations = [];
  vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (
    this: Element,
    name: string,
    value: string,
  ) {
    const active = document.activeElement;
    if (
      name === 'aria-hidden' &&
      value === 'true' &&
      active !== null &&
      active !== document.body &&
      this.contains(active)
    ) {
      ariaViolations.push(active.textContent ?? active.tagName);
    }
    return realSetAttribute.call(this, name, value);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function renderWithLayers(ui: ReactNode, strict = false) {
  const registry = createModalLayerRegistry();
  const tree = (
    <ModalLayerContext.Provider value={registry}>
      <button type="button">Before</button>
      {ui}
      <button type="button">After</button>
    </ModalLayerContext.Provider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return registry;
}

async function openThumb() {
  const thumb = await screen.findByRole('button', {
    name: 'Open document preview',
  });
  thumb.focus();
  fireEvent.click(thumb);
  const dialog = await screen.findByRole('dialog', {
    name: 'Document preview',
  });
  await settle();
  return { thumb, dialog };
}

const closeButton = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: 'Close preview' });

function expectBackgroundReleased() {
  expect(document.querySelector('[aria-hidden="true"] button')).toBeNull();
  expect(document.body.style.pointerEvents).toBe('');
  expect(document.body).not.toHaveAttribute('data-scroll-locked');
}

describe('DocumentPreviewLightbox modal behaviour (issue #269)', () => {
  it('starts on Close and isolates the background while open', async () => {
    renderWithLayers(<DocThumbLightbox id={7} />);
    const { thumb, dialog } = await openThumb();

    expect(closeButton(dialog)).toHaveFocus();
    // Accessibility: only the dialog is exposed; the background is hidden.
    expect(screen.queryByRole('button', { name: 'Before' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Open document preview' }),
    ).toBeNull();
    expect(thumb.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(dialog.closest('[aria-hidden="true"]')).toBeNull();
    // aria-modal is declared AND backed by real isolation (above/below).
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Pointer: the background no longer takes pointer events.
    expect(document.body.style.pointerEvents).toBe('none');
    // Scroll: the body is locked (react-remove-scroll, via Dialog.Overlay).
    expect(document.body).toHaveAttribute('data-scroll-locked');
    expect(ariaViolations).toEqual([]);
  });

  it('keeps Tab and Shift+Tab inside the preview', async () => {
    const user = userEvent.setup();
    renderWithLayers(<DocThumbLightbox id={7} />);
    const { dialog } = await openThumb();
    const open = within(dialog).getByRole('button', { name: 'Open original' });
    const close = closeButton(dialog);

    expect(close).toHaveFocus();
    await user.tab();
    expect(open).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(open).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
  });

  it('pulls programmatic outside focus back into the preview', async () => {
    renderWithLayers(<DocThumbLightbox id={7} />);
    const { dialog } = await openThumb();
    act(() => {
      screen.getByRole('button', { name: 'After', hidden: true }).focus();
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it.each([
    ['Close', (d: HTMLElement) => fireEvent.click(closeButton(d))],
    ['Escape', (d: HTMLElement) => fireEvent.keyDown(d, { key: 'Escape' })],
    // The scrim around the image: the content container itself.
    ['the backdrop', (d: HTMLElement) => fireEvent.click(d)],
  ])(
    'closing via %s returns focus to the thumbnail and releases the page',
    async (_label, close) => {
      renderWithLayers(<DocThumbLightbox id={7} />);
      const { thumb, dialog } = await openThumb();
      close(dialog);
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
      );
      await settle();
      expect(thumb).toHaveFocus();
      expectBackgroundReleased();
      expect(ariaViolations).toEqual([]);
    },
  );

  it('Back (the modal-layer registry) closes the preview and returns focus', async () => {
    const registry = renderWithLayers(<DocThumbLightbox id={7} />);
    const { thumb } = await openThumb();
    expect(registry.count()).toBe(1);
    act(() => {
      expect(registry.top()?.dismiss()).toBe(true);
    });
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(registry.count()).toBe(0);
    expect(thumb).toHaveFocus();
  });

  it('clicking the image or Open original keeps it open', async () => {
    renderWithLayers(<DocThumbLightbox id={7} />);
    const { dialog } = await openThumb();
    fireEvent.click(within(dialog).getByAltText('Document preview'));
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Open original' }),
    );
    expect(api.openSignedDocument).toHaveBeenCalledWith(7, expect.anything());
    await settle(); // the (mocked) attempt settles
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('returns focus to the DocPreviewRow row that opened it, and reopens', async () => {
    renderWithLayers(<DocPreviewRow documentId={42} />);
    const row = await screen.findByRole('button', { name: /Source document/ });
    for (let i = 0; i < 2; i++) {
      row.focus();
      fireEvent.click(row);
      const dialog = await screen.findByRole('dialog', {
        name: 'Document preview',
      });
      await settle();
      expect(closeButton(dialog)).toHaveFocus();
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await settle();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(row).toHaveFocus();
    }
    expectBackgroundReleased();
  });

  it('survives StrictMode: focus in, trapped, and returned', async () => {
    renderWithLayers(<DocThumbLightbox id={7} />, true);
    const { thumb, dialog } = await openThumb();
    expect(closeButton(dialog)).toHaveFocus();
    fireEvent.click(closeButton(dialog));
    await settle();
    expect(thumb).toHaveFocus();
    expectBackgroundReleased();
  });

  it('a late close-autofocus never steals focus taken meanwhile', async () => {
    renderWithLayers(<DocThumbLightbox id={7} />);
    const { dialog } = await openThumb();
    fireEvent.click(closeButton(dialog));
    // Before Radix's close task runs, something else takes focus.
    const after = screen.getByRole('button', { name: 'After' });
    after.focus();
    await settle();
    expect(after).toHaveFocus();
  });

  it('unmounted while open (e.g. session ends) leaves the page clean', async () => {
    function Host() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShown(false)}>
            Sign out
          </button>
          {shown && <DocThumbLightbox id={7} />}
        </>
      );
    }
    renderWithLayers(<Host />);
    const { dialog } = await openThumb();
    expect(dialog).toBeInTheDocument();
    // The 401 path: the tree goes away underneath the open modal.
    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sign out', hidden: true }),
      );
    });
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expectBackgroundReleased();
    // The disconnected opener is never targeted; focus is simply free.
    expect(document.activeElement).toBe(document.body);
  });

  describe('over an open Sheet', () => {
    function SheetHost() {
      const [open, setOpen] = useState(true);
      return (
        <Sheet open={open} onOpenChange={setOpen} title="Verify">
          <p>Form</p>
          <DocThumbLightbox id={7} />
        </Sheet>
      );
    }

    async function openInSheet(registry: ModalLayerRegistry) {
      await screen.findByRole('dialog', { name: 'Verify' });
      await settle();
      const res = await openThumb();
      expect(registry.count()).toBe(2);
      return res;
    }

    it('Escape closes only the preview; focus goes back into the sheet', async () => {
      const registry = renderWithLayers(<SheetHost />);
      const { thumb, dialog } = await openInSheet(registry);
      // The sheet underneath is hidden from the accessibility tree too.
      expect(screen.queryByRole('dialog', { name: 'Verify' })).toBeNull();
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await settle();
      expect(
        screen.queryByRole('dialog', { name: 'Document preview' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('dialog', { name: 'Verify' }),
      ).toBeInTheDocument();
      expect(registry.count()).toBe(1);
      expect(thumb).toHaveFocus();
      expect(ariaViolations).toEqual([]);
    });

    it('Back closes only the top preview', async () => {
      const registry = renderWithLayers(<SheetHost />);
      const { thumb } = await openInSheet(registry);
      act(() => {
        registry.top()?.dismiss();
      });
      await settle();
      expect(
        screen.queryByRole('dialog', { name: 'Document preview' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('dialog', { name: 'Verify' }),
      ).toBeInTheDocument();
      expect(thumb).toHaveFocus();
    });
  });
});
