export type IntentClass = 'advisory' | 'action' | 'report' | 'reconciliation';
export type ActionIntent =
  | 'create_sales_invoice'
  | 'approve'
  | 'reject'
  | 'correct'
  | 'create_allowance';

export type RoutedIntent =
  | { kind: 'advisory' }
  | {
      kind: 'action';
      actionIntent: ActionIntent;
      fields: Record<string, string>;
    }
  | { kind: 'report'; reportKind: string }
  | { kind: 'reconciliation' }
  | { kind: 'clarify'; question: string };

/** What the router did with one inbound envelope — returned for tests/e2e and audit. */
export interface RouterOutcome {
  conversation_id: number;
  gated_in: boolean;
  ingested: number; // count of documents ingested this turn
  intent: RoutedIntent | null; // null when no message / gated out
  dispatched: boolean;
}
