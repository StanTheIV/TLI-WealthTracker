import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {describe, it, expect} from 'vitest';

/**
 * Tripwire: ZoneHandler is the single writer of ctx.location / prevLocation /
 * transition (context.ts only declares and resets them). A second writer would
 * reintroduce the drift this field exists to remove. Like tax-coverage, it is a
 * tripwire, not a proof: a destructured or aliased write would slip past it.
 */

const SRC_MAIN = join(__dirname, '..', '..');   // src/main
const SRC      = join(SRC_MAIN, '..');          // src

const WRITERS = ['main/engine/context.ts', 'main/engine/handlers/zone.ts'];

const ASSIGN = /\.(?:location|prevLocation|transition)\s*(?:=(?!=)|\|\|=|&&=|\?\?=)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const rel = (f: string) => relative(SRC, f).split(sep).join('/');

const writers = () => sourceFiles(SRC_MAIN)
  .filter(f => ASSIGN.test(stripComments(readFileSync(f, 'utf8'))))
  .map(rel)
  .sort();

describe('ctx.location writers', () => {
  it('no non-test file under src/main writes location outside zone.ts and context.ts', () => {
    expect(
      writers().filter(f => !WRITERS.includes(f)),
      'Only ZoneHandler may assign ctx.location / prevLocation / transition.',
    ).toEqual([]);
  });

  it('exactly zone.ts and context.ts assign them', () => {
    expect(writers()).toEqual(WRITERS);
  });
});
