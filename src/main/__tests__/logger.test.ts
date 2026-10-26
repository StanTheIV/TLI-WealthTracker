import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

// The logger keeps module-level state: every test gets a fresh copy.
async function fresh() {
  vi.resetModules();
  return import('@/main/logger');
}

const FILE_ON = JSON.stringify({enabled: true, features: ['engine', 'app'], types: ['info', 'warn', 'error', 'debug']});

describe('logger without Electron', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tli-logger-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, {recursive: true, force: true});
  });

  it('getLogFilePath is empty before init, and logging before init writes to the console only', async () => {
    const {getLogFilePath, log} = await fresh();
    expect(getLogFilePath()).toBe('');
    log.info('engine', 'early');
    log.warn('engine', 'early warn');
    log.error('engine', 'early error');
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('logFile null: path stays empty and nothing is written even with the file target enabled', async () => {
    const {initLogger, getLogFilePath, log} = await fresh();
    const before = readdirSync(dir);
    initLogger({logFile: null, settings: () => ({'logging.file': FILE_ON})});
    expect(getLogFilePath()).toBe('');
    log.info('engine', 'x');
    expect(readdirSync(dir)).toEqual(before);
  });

  it('with a file and the file target enabled it appends formatted lines and reports the path', async () => {
    const {initLogger, getLogFilePath, log} = await fresh();
    const file = join(dir, 'a.log');
    initLogger({logFile: file, settings: () => ({'logging.file': FILE_ON})});
    expect(getLogFilePath()).toBe(file);
    log.info('engine', 'one');
    log.warn('app', 'two');
    log.info('ipc', 'filtered out by feature');
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}\] \[INFO \] \[engine\] one$/);
    expect(lines[1]).toContain('[WARN ] [app] two');
  });

  it('with a file but the file target disabled (the default) it never creates the file', async () => {
    const {initLogger, log} = await fresh();
    const file = join(dir, 'b.log');
    initLogger({logFile: file, settings: () => ({})});
    log.error('engine', 'x');
    expect(existsSync(file)).toBe(false);
  });

  it('reloadConfig picks up a settings change', async () => {
    const {initLogger, log} = await fresh();
    const file = join(dir, 'c.log');
    let settings: Record<string, string> = {};
    initLogger({logFile: file, settings: () => settings});
    log.info('engine', 'off');
    settings = {'logging.file': FILE_ON};
    log.reloadConfig();
    log.info('engine', 'on');
    expect(readFileSync(file, 'utf8')).toContain('on');
    expect(readFileSync(file, 'utf8')).not.toContain('off');
  });

  it('rotates an oversized file at init, only when a file is given', async () => {
    const {initLogger} = await fresh();
    const file = join(dir, 'big.log');
    writeFileSync(file, Buffer.alloc(10 * 1024 * 1024 + 1));
    initLogger({logFile: null, settings: () => ({})});
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(existsSync(file)).toBe(true);

    initLogger({logFile: file, settings: () => ({})});
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('does not rotate a file at exactly the limit', async () => {
    const {initLogger} = await fresh();
    const file = join(dir, 'edge.log');
    writeFileSync(file, Buffer.alloc(10 * 1024 * 1024));
    initLogger({logFile: file, settings: () => ({})});
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  it('an unwritable log path never throws', async () => {
    const {initLogger, log} = await fresh();
    initLogger({logFile: join(dir, 'missing-dir', 'x.log'), settings: () => ({'logging.file': FILE_ON})});
    expect(() => log.info('engine', 'x')).not.toThrow();
  });

  it('a corrupt settings value falls back to the defaults instead of throwing', async () => {
    const {initLogger, log} = await fresh();
    initLogger({logFile: null, settings: () => ({'logging.console': '{not json', 'logging.file': '[]'})});
    log.info('engine', 'still logs');
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it('re-initialising with null after a file clears the path', async () => {
    const {initLogger, getLogFilePath} = await fresh();
    initLogger({logFile: join(dir, 'd.log'), settings: () => ({})});
    initLogger({logFile: null, settings: () => ({})});
    expect(getLogFilePath()).toBe('');
  });

  it('the module imports no electron (loads with the module graph free of it)', () => {
    const src = readFileSync(join(__dirname, '../logger.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]electron['"]/);
  });
});
