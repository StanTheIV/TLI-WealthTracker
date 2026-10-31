/** 7.3: SetupDialog's strings live in the `setup` namespace, en + de alike; the dialog stays non-dismissable. */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';
import setupEN from '@/i18n/locales/en/setup.json';
import setupDE from '@/i18n/locales/de/setup.json';

function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === 'object'
      ? keyPaths(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  ).sort();
}

describe('setup namespace', () => {
  it('en and de have identical, non-empty key sets', () => {
    expect(keyPaths(setupEN).length).toBeGreaterThan(0);
    expect(keyPaths(setupDE)).toEqual(keyPaths(setupEN));
    for (const v of [...Object.values(setupDE), ...Object.values(setupDE.error)]) {
      if (typeof v === 'string') expect(v.trim()).not.toBe('');
    }
  });

  it('is registered in i18n/index.ts for both languages', () => {
    const src = readFileSync(join(__dirname, '../../../i18n/index.ts'), 'utf8');
    expect(src).toContain("'setup'");
    expect(src).toMatch(/setup:\s+setupEN/);
    expect(src).toMatch(/setup:\s+setupDE/);
  });

  it('SetupDialog uses the namespace and passes no onClose (cannot be dismissed)', () => {
    const src = readFileSync(join(__dirname, '../SetupDialog.tsx'), 'utf8');
    expect(src).toContain("useTranslation('setup')");
    expect(src).not.toMatch(/onClose/);
    expect(src).not.toContain('Welcome to TLI Tracker');
  });
});
