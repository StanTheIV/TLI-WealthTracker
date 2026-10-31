/** 5.1d: the logger's config reader is guarded (init and reloadConfig) and the default is the shared one. */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {DEFAULT_LOG_CONFIG} from '@/shared/logging';

async function fresh() {
  vi.resetModules();
  return import('@/main/logger');
}

const lines = (file: string) => readFileSync(file, 'utf8').trimEnd().split('\n');

describe('logger config reader guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tli-logger-guard-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, {recursive: true, force: true});
  });

  it('a throwing reader at init → defaults, no throw', async () => {
    const {initLogger, log} = await fresh();
    const file = join(dir, 'a.log');
    expect(() => initLogger({logFile: file, settings: () => { throw new Error('no such table: settings'); }})).not.toThrow();
    log.info('app', 'info line');
    log.warn('app', 'warn line');
    log.error('app', 'error line');
    expect(console.log).toHaveBeenCalledTimes(1); // console default still includes info
    expect(lines(file)).toHaveLength(2);
    expect(lines(file)[0]).toContain('warn line');
  });

  it('a throwing reader on reloadConfig → defaults (a stored config before it is dropped), no throw', async () => {
    const {initLogger, log} = await fresh();
    const file = join(dir, 'b.log');
    let fail = false;
    const allOn = JSON.stringify({enabled: true, features: ['app'], types: ['info', 'warn', 'error', 'debug']});
    initLogger({logFile: file, settings: () => {
      if (fail) throw new Error('database disk image is malformed');
      return {'logging.file': allOn};
    }});
    log.debug('app', 'debug while stored');
    fail = true;
    expect(() => log.reloadConfig()).not.toThrow();
    log.debug('app', 'debug on defaults');
    log.error('app', 'error on defaults');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('debug while stored');
    expect(text).not.toContain('debug on defaults');
    expect(text).toContain('error on defaults');
  });

  it('a non-Error throw from the reader is handled the same', async () => {
    const {initLogger} = await fresh();
    expect(() => initLogger({logFile: null, settings: () => { throw Symbol('x'); }})).not.toThrow();
  });

  it('a stored logging.file overrides the default — including turning it off', async () => {
    const {initLogger, log} = await fresh();
    const file = join(dir, 'c.log');
    initLogger({logFile: file, settings: () => ({'logging.file': JSON.stringify({enabled: false})})});
    log.error('app', 'x');
    expect(existsSync(file)).toBe(false);
  });

  it('a stored logging.file with only types keeps the default enabled flag and features', async () => {
    const {initLogger, log} = await fresh();
    const file = join(dir, 'd.log');
    initLogger({logFile: file, settings: () => ({'logging.file': JSON.stringify({types: ['info']})})});
    log.info('engine', 'info only');
    log.error('engine', 'not an error type now');
    expect(lines(file)).toHaveLength(1);
    expect(lines(file)[0]).toContain('info only');
  });
});

describe('DEFAULT_LOG_CONFIG', () => {
  it('file target on for warn + error; console on for info + warn + error; every feature', () => {
    expect(DEFAULT_LOG_CONFIG.file).toEqual({
      enabled: true,
      features: ['engine', 'worker', 'database', 'ipc', 'overlay', 'session', 'price', 'wealth', 'app', 'filter', 'update'],
      types: ['warn', 'error'],
    });
    expect(DEFAULT_LOG_CONFIG.console.enabled).toBe(true);
    expect(DEFAULT_LOG_CONFIG.console.types).toEqual(['info', 'warn', 'error']);
    expect(DEFAULT_LOG_CONFIG.console.features).toEqual(DEFAULT_LOG_CONFIG.file.features);
  });

  it('logger.ts and loggingStore.ts define no default of their own', () => {
    for (const rel of ['../logger.ts', '../../state/loggingStore.ts']) {
      const src = readFileSync(join(__dirname, rel), 'utf8');
      expect(src, rel).toContain('DEFAULT_LOG_CONFIG');
      expect(src, rel).not.toMatch(/DEFAULT_TYPES|ALL_FEATURES|DEFAULT_FILE|DEFAULT_CONSOLE/);
    }
  });
});
