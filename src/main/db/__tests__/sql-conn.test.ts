/**
 * SqlConn adapter contract on the node:sqlite test driver. The same cases run
 * against the bun:sqlite driver via `bun scripts/check-bun-sql.ts`.
 */
import {describe, it, expect} from 'vitest';
import {CONTRACT_CASES} from '@/test/sql/contract';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import {normalizeArgs, pragmaBody} from '@/main/db/sql-conn';

describe('SqlConn contract (node:sqlite)', () => {
  for (const c of CONTRACT_CASES) {
    it(c.name, () => {
      const conn = openNodeSqlite();
      try {
        c.run(conn);
      } finally {
        conn.close();
      }
    });
  }
});

describe('adapter helpers', () => {
  it('normalizeArgs maps undefined/booleans and leaves blobs and arrays positional', () => {
    const blob = new Uint8Array([1, 2]);
    expect(normalizeArgs([undefined, true, false, 'x', 1, null])).toEqual([null, 1, 0, 'x', 1, null]);
    expect(normalizeArgs([{a: undefined, b: true, c: 2}])).toEqual([{a: null, b: 1, c: 2}]);
    expect(normalizeArgs([blob])).toEqual([blob]);
  });

  it('pragmaBody accepts identifiers only', () => {
    expect(pragmaBody('journal_mode', 'WAL')).toBe('journal_mode = WAL');
    expect(pragmaBody('user_version')).toBe('user_version');
    expect(() => pragmaBody('table_info(t)')).toThrow();
    expect(() => pragmaBody('user_version', "1'")).toThrow();
  });
});
