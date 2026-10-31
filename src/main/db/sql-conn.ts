/**
 * Driver-neutral SQLite connection. db.ts and the migration runner talk only
 * to this; the app (better-sqlite3), tests (node:sqlite) and replay
 * (bun:sqlite) each supply a tiny adapter.
 *
 * Adapter contract — identical on every driver:
 *   - one object argument binds named params (`@name` ↔ key `name`); extra keys are ignored
 *   - otherwise arguments bind positionally (`.run(a, b)`)
 *   - `undefined` binds as NULL, booleans as 1/0
 *   - `get()` returns `undefined` when there is no row; rows are plain objects
 *   - `changes` / `lastInsertRowid` are numbers
 *   - `transaction(fn)` runs `fn` immediately and returns its result; a throw
 *     rolls back. Nested calls use savepoints (only the inner part rolls back).
 */

export type SqlValue = string | number | bigint | null | Uint8Array;
/** Variadic positional values, or a single object of named values. */
export type SqlArgs  = [] | [Record<string, unknown>] | unknown[];

export interface SqlRunResult { changes: number; lastInsertRowid: number }

export interface SqlStatement {
  run(...args: SqlArgs): SqlRunResult;
  get<T = Record<string, unknown>>(...args: SqlArgs): T | undefined;
  all<T = Record<string, unknown>>(...args: SqlArgs): T[];
}

export interface SqlConn {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Runs `fn` now inside a transaction (savepoint when nested). */
  transaction<T>(fn: () => T): T;
  getPragma(name: string): unknown;
  setPragma(name: string, value: string | number): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Shared adapter helpers (pure — no driver imports)
// ---------------------------------------------------------------------------

function bindValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function isNamedArg(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

/** Normalise call arguments per the contract (undefined → null, boolean → 1/0). */
export function normalizeArgs(args: unknown[]): unknown[] {
  if (args.length === 1 && isNamedArg(args[0])) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args[0])) out[k] = bindValue(v);
    return [out];
  }
  return args.map(bindValue);
}

const PRAGMA_NAME  = /^[a-z_]+$/i;
const PRAGMA_VALUE = /^[a-z0-9_]+$/i;

/** `name` / `name = value` (no PRAGMA keyword), refusing anything but bare identifiers. */
export function pragmaBody(name: string, value?: string | number): string {
  if (!PRAGMA_NAME.test(name)) throw new Error(`Invalid pragma name: ${name}`);
  if (value === undefined) return name;
  if (!PRAGMA_VALUE.test(String(value))) throw new Error(`Invalid pragma value: ${value}`);
  return `${name} = ${value}`;
}

/** First column of a single-row result (what `PRAGMA name` returns). */
export function firstColumn(row: Record<string, unknown> | null | undefined): unknown {
  if (!row) return undefined;
  const keys = Object.keys(row);
  return keys.length > 0 ? row[keys[0]] : undefined;
}
