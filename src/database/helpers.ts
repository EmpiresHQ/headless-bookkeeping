/**
 * Coerce a SQLite integer (0/1) to a TypeScript boolean.
 * SQLite lacks a native boolean type; columns store 0 or 1.
 */
export function toBool(value: number): boolean {
  return value === 1;
}
