# Specialized client modules own posting and bank-line Expense lifecycles

Accepted on 2026-10-04 after the architecture interview. The Expense and SalesInvoice screens repeat the posting-result protocol; ordinary bank-line Expense creation and the bank-fee action repeat lifecycle bookkeeping around an existing request chain. Concentrate this behavior in two specialized modules, retaining the existing `pendingOperation` and `resultLog` mechanisms. This is a behavior-preserving frontend refactor.

Implementation scope and acceptance criteria: [PRD #400](https://github.com/EmpiresHQ/headless-bookkeeping/issues/400).

## Decision

The posting module owns the request, accepted-response handling, session guard, receipt persistence, books refresh and notification order. Screens supply the selected object and object-specific presentation, initiate the action and render its state. They do not orchestrate individual lifecycle steps. Persist the confirmed Operation result before refresh; a refresh failure must not turn it into an unknown posting outcome.

The bank-line Expense module deepens the existing `createExpenseFromLine` chain and its `lineResults` integration. It owns confirmed progress, retry-step selection, finished state, receipt handling and refresh. Both ordinary Expense creation and the bank-fee action use it. Screens retain input validation, presentation and navigation; callers request a retry without choosing its step.

The bank module's interface exposes the original failure and whether Expense creation was confirmed. The form retains existing create-error field mapping; after confirmed creation, later failures are operation errors and never field errors, and the saved facts remain locked.

An Operation result records the outcome of an attempt, not Current object state; see the [glossary](../../GLOSSARY.md). An earlier result awaiting Approval remains historically valid after approval.

## Trade-offs and constraints

- Prefer two specialized modules over a general workflow engine. A general engine would add configuration and abstractions beyond these two existing protocols. Thin helpers would leave ordering and error-handling knowledge duplicated in callers.
- Preserve state lifetime independently of code ownership. `TxScreen` remains the owner of the pending bank operation. The ordinary form's progress/finished state retains its form lifetime; bank-fee state retains its `TxScreen` lifetime. Refresh may unmount the form while the pending operation continues. Do not lift all retry state into `TxScreen` as an incidental refactor.
- Receipts retain current sessionStorage persistence. Progress and finished state do not gain reload persistence. Preserve current reset behavior when switching bank lines and current session guards.
- Preserve the two bank refresh paths: after chain success, await statement refresh while pending remains blocked. In error handling, refresh stays in the background; the ordinary form launches it only when an Expense ID is known or the error is `BookingPartialError`, while the bank-fee action launches it for every handled error. A failed awaited refresh follows the existing error path without replacing the confirmed result.
- A staged match whose approval was not confirmed is recovered through the existing confirmation action on the bank line, if it is still staged. Retrying the Expense-creation chain neither stages it again nor automatically retries its approval.
- No GET reconciliation or new server idempotency. An unconfirmed posting request is retried under current rules; ADR-0021 prevents a second Voucher via 409 but does not return the previous success. A lost create response without a known Expense ID can still lead to another Expense on retry.
- Test shared behavior through each module's interface; retain unique screen integration coverage, including refresh-driven unmounting and navigation. Remove duplicate tests only after equivalent coverage exists.

This does not change the kernel's posting rules ([ADR-0021](0021-voucher-numbering-and-idempotent-posting.md)), its caller-supplied refetch callback ([ADR-0029](0029-posting-pipeline-refetch-stays-a-callback.md)), or the SPA's role as a client ([ADR-0030](0030-operator-spa-on-headless-kernel.md)). Concrete TypeScript signatures and filenames remain implementation choices within this contract.
