/** 5.1e follow-up (c): Settings → Logging lists the shared feature list, each named in en + de. */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';
import {ALL_LOG_FEATURES, DEFAULT_LOG_CONFIG} from '@/shared/logging';
import settingsEN from '@/i18n/locales/en/settings.json';
import settingsDE from '@/i18n/locales/de/settings.json';

describe('LoggingTab features', () => {
  it('uses ALL_LOG_FEATURES (no list of its own)', () => {
    const src = readFileSync(join(__dirname, '../LoggingTab.tsx'), 'utf8');
    expect(src).toContain('ALL_LOG_FEATURES.map');
    expect(src).not.toMatch(/const ALL_FEATURES/);
  });

  it('the shared list is the default config list, update included', () => {
    expect(ALL_LOG_FEATURES).toContain('update');
    expect([...ALL_LOG_FEATURES]).toEqual(DEFAULT_LOG_CONFIG.file.features);
  });

  it('every feature has a name in en and de', () => {
    for (const names of [settingsEN.logging.featureNames, settingsDE.logging.featureNames]) {
      expect(Object.keys(names).sort()).toEqual([...ALL_LOG_FEATURES].sort());
    }
  });
});
