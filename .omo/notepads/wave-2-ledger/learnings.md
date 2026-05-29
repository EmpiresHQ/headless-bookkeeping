# Wave 2 Ledger — Learnings

## Task 10: Immutability enforcement

- NestJS `MethodNotAllowedException` maps to HTTP 405 automatically — no custom exception filter needed.
- Lint caught `@typescript-eslint/no-unsafe-member-access` on `created.body.id` in e2e tests — must cast `created.body as { id: number }` (same pattern as existing GET-by-id test).
- Unit tests for immutability handlers are pure synchronous `expect(() => ...).toThrow()` — no async needed since the handlers throw immediately.
- Return type `never` on immutability handlers is correct TypeScript — they always throw, never return.
