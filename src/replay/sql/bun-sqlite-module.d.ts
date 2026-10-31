/**
 * Minimal types for the `bun:sqlite` surface the replay driver uses. Declared
 * locally instead of installing @types/bun, which would put Bun globals into
 * the whole src typecheck (main/renderer code would see `Bun.*` as available).
 */
declare module 'bun:sqlite' {
  interface BunStatement {
    run(...params: unknown[]): {changes: number; lastInsertRowid: number | bigint};
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class Database {
    constructor(filename?: string, options?: {readonly?: boolean; create?: boolean; readwrite?: boolean; strict?: boolean});
    exec(sql: string): unknown;
    prepare(sql: string): BunStatement;
    transaction<R>(fn: () => R): () => R;
    close(): void;
  }
}
