/**
 * SqlConn adapter contract against the bun:sqlite replay driver — the same
 * cases vitest runs on node:sqlite (src/main/db/__tests__/sql-conn.test.ts).
 *
 *   bun scripts/check-bun-sql.ts
 */
import {CONTRACT_CASES} from '@/test/sql/contract';
import {openBunSqlite} from '@/replay/sql/bun-sqlite';

let failed = 0;
for (const c of CONTRACT_CASES) {
  const conn = openBunSqlite(':memory:');
  try {
    c.run(conn);
    console.log(`  ok    ${c.name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${c.name}\n        ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    conn.close();
  }
}
console.log(`${CONTRACT_CASES.length - failed}/${CONTRACT_CASES.length} bun:sqlite contract cases passed`);
if (failed > 0) process.exit(1);
