# Issue tracker: GitHub

Issues and specs live in GitHub Issues for EmpiresHQ/headless-bookkeeping.
Use the `gh` CLI from this clone, where it infers the repository.

## Operations

- Create: `gh issue create --title "..." --body-file <path>`.
- Read: `gh issue view <number> --comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`.
- Comment: `gh issue comment <number> --body-file <path>`.
- Label: `gh issue edit <number> --add-label "..."`.
- Remove label: `gh issue edit <number> --remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

Write multiline bodies to a temporary file and pass `--body-file`.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue and its comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub issues and PRs share a number space. When the object type is
unclear, resolve it with `gh pr view <number>`, falling back to
`gh issue view <number>`.

## Wayfinding

Keep the map in one issue labelled `wayfinder:map`, with Notes,
Decisions-so-far, and Fog sections.

Link child tickets as GitHub sub-issues. If unavailable, use a task
list in the map and a `Part of #<map>` line in each child.
Use `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`,
or `wayfinder:task` labels.

Record blockers using native GitHub issue dependencies when available;
otherwise use a `Blocked by: #<number>` line in the child.
A ticket is unblocked when all blockers are closed.

Select the first open, unassigned, unblocked child in map order.
Claim it with `gh issue edit <number> --add-assignee @me`.
On resolution, comment with the result, close the child, and append
a summary and link to the map's Decisions-so-far.
