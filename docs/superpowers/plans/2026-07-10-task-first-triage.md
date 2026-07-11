# Task-First Triage Implementation Plan

**Goal:** Replace pipeline-first triage with actionable scenario panels and make
invalid supplier proposals recoverable from strong document identifiers.

**Architecture:** Keep existing write endpoints and focused editing sheets. Add a
discriminated pending-supplier read model, resolve strong identifier suggestions
server-side, and render the initial decision inline through small scenario
components extracted from `TriageDocScreen`.

**Stack:** NestJS, TypeORM, React 18, TanStack Query, Tailwind, Vitest/Jest.

## 1. Lock The Supplier Read Model

- Add server tests for create proposals, invalid matches with a registration-key
  suggestion, and invalid matches without a suggestion.
- Add frontend API types for the discriminated proposal.
- Verify the stale AI entity ID is absent from the response contract.

## 2. Build Server Context

- Extract a focused builder for operator-facing supplier resolution context.
- Use the existing entity identifier lookup and supplier-role guard.
- Preserve the current expense draft and audit-finding reason.

## 3. Lock Task-First UI Behavior

- Add component tests for semantic supplier copy, strong-match evidence, direct
  resolution, alternative search, technical-details disclosure, and tertiary
  retry/archive actions.
- Add scenario copy/action tests for classification, outgoing invoices, OCR
  failure, and non-accounting documents.

## 4. Implement Scenario Components

- Extract decision header, persisted-facts summary, shared tertiary actions, and
  supplier decision panel from the oversized screen.
- Keep edit-heavy forms in their existing sheets while presenting their context
  and primary command inline.
- Adapt `ResolveSupplierSheet` to both proposal kinds without exposing stale IDs.

## 5. Verify Behavior And Presentation

- Run targeted server and web tests, type checks, lint, and production build.
- Measure touched TypeScript files against the 250 pure-LOC ceiling.
- Run React Doctor and verify development-only tooling does not enter production.
- Exercise all scenarios at 375px, 768px, and 1280px, including keyboard focus,
  overflow, confirmations, and primary actions.
- Complete independent code, UX, and runtime reviews before handoff.
