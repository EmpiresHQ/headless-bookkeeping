/** A full page load of the current address (path, query and hash kept).
 *  Its own module so tests can observe it — jsdom has no navigation. */
export function reloadPage(): void {
  window.location.reload();
}
