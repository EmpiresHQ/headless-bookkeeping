import { act, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionBar } from './ActionBar';

/**
 * QA-012 (#305) D1 — Tab moved focus onto candidate / form rows that sat
 * fully behind the sticky ActionBar (and the TabBar). The bar now reports
 * its height as --actionbar-h, and index.css reserves it (plus --tabbar-h)
 * as the page's scroll-padding-bottom, so the browser scrolls a newly
 * focused row clear of both bars. jsdom has no layout: offsetHeight is
 * read from data-h, and ResizeObserver is a controllable fake.
 */

const observers = new Set<ResizeObserverCallback>();
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    observers.add(this.cb);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.cb);
  }
}
const relayout = () =>
  act(() => observers.forEach((cb) => cb([], {} as ResizeObserver)));

const published = () =>
  document.documentElement.style.getPropertyValue('--actionbar-h');

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return Number(this.dataset.h ?? 0);
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  observers.clear();
});

// The bar's own div is the measured element; data-h lives on it.
function Bar({ h, label = 'Match' }: { h: number; label?: string }) {
  return (
    <ActionBar>
      <button ref={(b) => b?.parentElement?.setAttribute('data-h', String(h))}>
        {label}
      </button>
    </ActionBar>
  );
}

describe('ActionBar reserves its height for keyboard focus (#305 D1)', () => {
  it('publishes its height while mounted and clears it on unmount', () => {
    const { unmount } = render(<Bar h={72} />);
    expect(published()).toBe('72px');
    unmount();
    expect(published()).toBe('');
  });

  it('follows the bar when its content grows (error summary, blocked reason)', () => {
    const { getByRole } = render(<Bar h={72} />);
    getByRole('button').parentElement!.setAttribute('data-h', '130');
    relayout();
    expect(published()).toBe('130px');
  });

  it('keeps the tallest bar while two are mounted, and the survivor after one leaves', () => {
    const a = render(<Bar h={72} label="A" />);
    const b = render(<Bar h={118} label="B" />);
    expect(published()).toBe('118px');
    b.unmount();
    expect(published()).toBe('72px');
    a.unmount();
    expect(published()).toBe('');
  });

  it('still measures once where ResizeObserver is missing', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { unmount } = render(<Bar h={72} />);
    expect(published()).toBe('72px');
    unmount();
    expect(published()).toBe('');
  });

  it('index.css turns the TabBar + ActionBar heights into scroll-padding-bottom', () => {
    const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
    expect(css).toMatch(
      /html\s*\{[^}]*scroll-padding-bottom:\s*calc\(var\(--tabbar-h\)\s*\+\s*var\(--actionbar-h,\s*0px\)\)/,
    );
  });
});
