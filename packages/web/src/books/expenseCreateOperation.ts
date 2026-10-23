import type { CreateExpenseInput } from '../api';

/** One Expense create attempt. Its facts/key survive an unconfirmed response;
 * a new form/chain is a separate operation. Nothing here retries posting.
 */
export interface ExpenseCreateOperation {
  key: string;
  input: CreateExpenseInput;
}

export function newExpenseCreateOperation(
  input: CreateExpenseInput,
): ExpenseCreateOperation {
  const key =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('');
  return { key, input: { ...input } };
}
