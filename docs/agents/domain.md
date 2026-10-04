# Domain docs

## Layout and reading rules

This repo uses a single-context layout across its packages:

- `GLOSSARY.md` at the repository root holds shared domain vocabulary.
- `docs/adr/` holds architectural decisions.

Before exploring the codebase, read the root glossary and ADRs relevant
to the area being changed.

If a document is absent, proceed silently. Domain modeling creates
glossaries and ADRs lazily as terms and decisions are resolved.

## Vocabulary

Use glossary terms in issue titles, proposals, hypotheses, and tests.
When a needed concept is missing, reconsider whether it belongs or
note the vocabulary gap for domain modeling.

## Decision conflicts

Explicitly identify any proposal that contradicts an existing ADR,
including the ADR reference and the reason to reconsider it.
