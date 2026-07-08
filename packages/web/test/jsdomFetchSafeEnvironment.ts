import type { Environment } from 'vitest/environments';
import { builtinEnvironments } from 'vitest/environments';

const jsdom = builtinEnvironments.jsdom;

/**
 * Vitest's jsdom environment shadows the global `AbortController`/`AbortSignal`
 * with jsdom's own classes (see vitest's `populateGlobal`). Node's native
 * fetch/Request implementation validates a `signal` against the
 * AbortSignal class it captured at process start, so an AbortController
 * built via the jsdom-shadowed global fails Request's brand check with
 * "RequestInit: Expected signal to be an instance of AbortSignal".
 *
 * react-router v7 data routers always construct a Request to represent a
 * pending client-side navigation (redirects included), so this breaks any
 * test that exercises a <Navigate> element or router.navigate() under
 * jsdom. Restore Node's native AbortController/AbortSignal right after
 * jsdom sets up so fetch/Request keep working; jsdom still owns the DOM,
 * localStorage, etc.
 */
const jsdomFetchSafe: Environment = {
  name: 'jsdom-fetch-safe',
  transformMode: 'web',
  async setup(global, options) {
    const nativeAbortController = global.AbortController;
    const nativeAbortSignal = global.AbortSignal;
    const result = await jsdom.setup(global, options);
    global.AbortController = nativeAbortController;
    global.AbortSignal = nativeAbortSignal;
    return result;
  },
};

export default jsdomFetchSafe;
