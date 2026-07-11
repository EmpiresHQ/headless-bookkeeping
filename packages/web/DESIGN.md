# Headless Bookkeeping Design System

## 1. Atmosphere & Identity

The product is a quiet operational bookkeeping tool. Screens should feel
decisive, trustworthy, and dense enough for repeated daily work. The interface
explains the accounting decision in plain language and keeps diagnostics out of
the primary action path.

## 2. Color

Use semantic Tailwind tokens from `tailwind.config.js`; components must not
hardcode colors.

- `bg`, `surface`, `line`: page, working surfaces, and separators.
- `ink`, `ink-2`, `ink-3`: primary, supporting, and subdued text.
- `accent`, `accent-deep`: primary commands and navigation.
- `ok`, `ok-bg`: confirmed or strongly matched data.
- `warn`, `warn-bg`, `warn-deep`: decisions requiring operator attention.
- `err`, `err-bg`: destructive actions and failed states only.

Warning color identifies the unresolved question; green identifies a safe next
action. Never use color as the only carrier of meaning.

## 3. Typography

Use the native system stack declared in `src/index.css`. Body copy is 13-15px;
screen titles are 17px; compact labels are 11-12px. Use bold weight for actions
and values, not whole paragraphs. Letter spacing remains non-negative.

## 4. Spacing & Layout

The base spacing unit is 4px. Triage content is centered at `max-w-3xl`, with
14-20px horizontal page padding. Separate sections with whitespace or hairline
dividers, not nested cards. Interactive controls are at least 44px tall. Cards
and decision panels use an 8px radius; legacy shared primitives may retain their
existing radius until touched.

## 5. Components

### Decision Header

An amber-tinted full-width band containing a semantic title and one sentence
describing the operator's decision. Raw pipeline diagnostics are available only
inside a collapsed technical details disclosure.

### Decision Panel

An un-nested working surface with a short evidence summary and one dominant
domain action. Secondary actions change the proposed resolution. Retry and
archive actions are tertiary and visually separated from the primary workflow.

### Evidence Row

Label/value rows show extracted facts, match evidence, and draft outcome. Values
are tabular where numeric and wrap instead of truncating identifiers.

### Buttons

Primary green buttons complete or advance the accounting task. Neutral buttons
edit or choose an alternative. Destructive red buttons are reserved for deleting
source files. Use Lucide icons when an icon has a familiar meaning.

## 6. Motion & Interaction

Use the existing 90-180ms route transitions. Respect `prefers-reduced-motion`.
Loading must not resize fixed controls. Successful actions advance to the next
queue item; recoverable failures keep the current document and its context.

## 7. Depth & Surface

Use flat surfaces and borders. Avoid decorative shadows, gradients, floating
section cards, and cards inside cards. Sheets are reserved for forms that need
focused editing, not for hiding the initial decision context.

## 8. Accessibility Constraints & Accepted Debt

- All actions have explicit accessible names and visible focus behavior.
- Status text is present alongside semantic color.
- Long filenames, supplier names, and registration keys must wrap safely.
- Confirmation is required before archive-without-booking and delete actions.
- Existing shared primitives with radii above 8px are accepted debt; new triage
  components use the current 8px rule.
