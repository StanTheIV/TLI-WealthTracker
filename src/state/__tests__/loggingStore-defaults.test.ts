/** 5.1d: the Settings → Logging store starts from, and falls back to, the shared DEFAULT_LOG_CONFIG. */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import {DEFAULT_LOG_CONFIG} from '@/shared/logging';

async function load(settings: Record<string, string>) {
  vi.resetModules();
  vi.stubGlobal('window', {electronAPI: {
    settings: {getAll: vi.fn(() => Promise.resolve(settings)), set: vi.fn(() => Promise.resolve())},
    logging:  {getLogPath: vi.fn(() => Promise.resolve('C:/logs/tli.log'))},
  }});
  const {useLoggingStore} = await import('@/state/loggingStore');
  return useLoggingStore;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('loggingStore defaults', () => {
  it('before load: the shared default (file target on, warn + error)', async () => {
    const store = await load({});
    expect(store.getState().console).toEqual(DEFAULT_LOG_CONFIG.console);
    expect(store.getState().file).toEqual(DEFAULT_LOG_CONFIG.file);
    expect(store.getState().file.enabled).toBe(true);
  });

  it('load with nothing stored: the shared default — the same the main logger applies', async () => {
    const store = await load({});
    await store.getState().load();
    expect(store.getState().file).toEqual(DEFAULT_LOG_CONFIG.file);
    expect(store.getState().console).toEqual(DEFAULT_LOG_CONFIG.console);
    expect(store.getState().logFilePath).toBe('C:/logs/tli.log');
  });

  it('load respects a stored logging.file; a corrupt value falls back to the default', async () => {
    const stored = {enabled: false, features: ['app'], types: ['error']};
    const store = await load({'logging.file': JSON.stringify(stored), 'logging.console': '{nope'});
    await store.getState().load();
    expect(store.getState().file).toEqual(stored);
    expect(store.getState().console).toEqual(DEFAULT_LOG_CONFIG.console);
  });

  it('toggling a type does not mutate the shared default', async () => {
    const store = await load({});
    const before = structuredClone(DEFAULT_LOG_CONFIG);
    store.getState().toggleFileType('info');
    store.getState().toggleFileFeature('app');
    store.getState().setFileEnabled(false);
    expect(store.getState().file.types).toEqual(['warn', 'error', 'info']);
    expect(DEFAULT_LOG_CONFIG).toEqual(before);
  });
});
