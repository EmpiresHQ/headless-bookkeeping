/**
 * Test matchers for Books rows (issue #283). A row's metadata now lives in
 * one cell per desktop column, and a supplier-less card is titled by its
 * category while the Category column keeps the value too — so an exact
 * text can occur in both the title and its cell. These scope a query to
 * the part of the row an assertion is about.
 */
type Matcher = (content: string, el: Element | null) => boolean;

const matches = (text: string | RegExp, content: string) =>
  typeof text === 'string' ? content === text : text.test(content);

/** The row's title (what the stacked card is titled by). */
export const rowTitle =
  (text: string | RegExp): Matcher =>
  (content, el) =>
    el?.closest('[data-books-title]') != null && matches(text, content);

/** The row's whole " · "-joined meta line, by its full text. */
export const metaLine =
  (re: RegExp): Matcher =>
  (_, el) =>
    el?.hasAttribute('data-books-meta') === true &&
    re.test(el.textContent ?? '');
