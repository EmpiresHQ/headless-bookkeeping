import {
  amountMatches,
  isoDateMatches,
  textMatches,
  type SearchNeedle,
} from '../lib/searchText';
import type { LineView } from './statementModel';

/** What the statement search looks at (issue #278). */
export const STATEMENT_SEARCH = {
  placeholder: 'Description, counterparty, reference, amount, date…',
  scope:
    'description, counterparty, reference, IBAN, matched document, amount or date',
} as const;

/** One bank line against the search: its own facts plus what its rows show
 *  after "→" (proposal, staged and active match targets). */
export function lineMatches(line: LineView, needle: SearchNeedle): boolean {
  const { tx } = line;
  const targets = [...line.proposals, ...line.staged, ...line.active];
  return (
    textMatches(needle, [
      tx.description,
      tx.counterparty_descriptor,
      tx.reference,
      ...targets.flatMap((t) => [t.objectLabel, t.counterpartyName]),
    ]) ||
    // An IBAN is typed with or without its print grouping.
    (tx.counterparty_iban != null &&
      tx.counterparty_iban
        .replace(/\s/g, '')
        .toLowerCase()
        .includes(needle.text.replace(/ /g, ''))) ||
    amountMatches(needle, tx.amount) ||
    isoDateMatches(needle, tx.transaction_date)
  );
}
