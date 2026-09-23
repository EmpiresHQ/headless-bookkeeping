import {
  render as rtlRender,
  type RenderOptions,
} from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import type { UnauthorizedError } from '../auth';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

/** The shell's session scope the preview's Open original reports 401s to
 *  (issue #272) — AppLayout provides it in the app. */
export let shellUnauthorized: (error: UnauthorizedError) => void = () =>
  undefined;

export function setShellUnauthorized(
  fn: (error: UnauthorizedError) => void,
): void {
  shellUnauthorized = fn;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <UnsavedChangesProvider onUnauthorized={(e) => shellUnauthorized(e)}>
      {children}
    </UnsavedChangesProvider>
  );
}

/** RTL's render inside the authenticated shell's provider. */
export function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: Shell, ...options });
}
