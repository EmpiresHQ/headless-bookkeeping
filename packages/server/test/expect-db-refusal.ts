/**
 * Assert that the DATABASE refused a statement.
 *
 * Why this exists rather than `await expect(promise).rejects.toThrow(/…/)`:
 *
 * `better-sqlite3` is a native addon. Node caches native addons process-wide
 * (`process.dlopen` keys on the resolved filename), so every Jest test file in
 * a worker shares ONE copy — and its `SqliteError` class is bound to whichever
 * test file's VM context loaded it first. A later file in the same process
 * receives rejections whose prototype chain belongs to that first context, so
 * `err instanceof Error` is **false** there even though the object is a real
 * SqliteError with the right message.
 *
 * `.rejects.toThrow()` keys off exactly that check, so it reports "Received
 * function did not throw" for a statement the database genuinely aborted. The
 * result is a test that passes alone and fails when scheduled after another
 * file that touches SQLite — and Jest's sequencer orders files by cached
 * timings, so which of two identical assertions breaks varies run to run.
 * Diagnosed on issue #203: the trigger fired, the row was unchanged, and the
 * caught object reported `instanceof Error === false` with the prototype chain
 * `["SqliteError","Error","Object"]`.
 *
 * So the refusal is asserted on realm-independent evidence — the message text —
 * and the caller is handed the error to assert anything further. This is
 * strictly STRONGER than the matcher it replaces: it fails loudly if the
 * statement succeeds, and it never silently accepts a rejection for the wrong
 * reason.
 */
export async function expectDbRefusal(
  /** Run the statement. A thunk, so no rejected promise is left floating. */
  run: () => Promise<unknown>,
  /** The refusal the database is expected to give, matched on its message. */
  expected: RegExp,
): Promise<{ message: string }> {
  let refusal: unknown;
  let succeeded = false;

  try {
    await run();
    succeeded = true;
  } catch (err) {
    refusal = err;
  }

  if (succeeded) {
    throw new Error(
      `Expected the database to refuse this statement (${String(expected)}), ` +
        `but it succeeded.`,
    );
  }

  const message =
    typeof (refusal as { message?: unknown })?.message === 'string'
      ? (refusal as { message: string }).message
      : String(refusal);

  expect(message).toMatch(expected);
  return { message };
}
