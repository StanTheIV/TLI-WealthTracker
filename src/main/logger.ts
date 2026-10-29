/**
 * Logger — main-process singleton.
 *
 * Each message carries a feature (domain) and a type (level).
 * Two output targets (console, file) are independently configurable.
 * Configuration is read from the SQLite settings table on init and on
 * explicit reloadConfig() calls (SettingsService, after a `logging.*` write).
 *
 * The logger is intentionally kept dependency-free (no imports from db.ts,
 * none from electron) so it loads anywhere main-process code does — the app,
 * vitest, the Bun replay CLI. Instead it receives the log file path and a
 * config-reader function during initialisation.
 */

import * as fs from 'fs';
import {DEFAULT_LOG_CONFIG, parseLogTargetConfig, type LogConfig, type LogFeature, type LogType} from '@/shared/logging';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoggerOptions {
  /** Absolute path of the log file. Null: the file target never writes (replay CLI). */
  logFile:  string | null;
  /** Reads the raw settings table — `settingsGetAll()` in the app. May throw
   *  (no settings table before the first migration): the defaults apply then. */
  settings: () => Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _configReader: (() => Record<string, string>) | null = null;
let _config: LogConfig = DEFAULT_LOG_CONFIG;
/** '' before init and when initialised without a file — the file target is then off. */
let _logFilePath = '';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** The stored config over the defaults. Never throws: a throwing reader (the
 *  settings table doesn't exist before the first migration; a corrupt DB)
 *  yields the defaults — at init and on reloadConfig() alike. */
function loadConfig(): LogConfig {
  if (!_configReader) return DEFAULT_LOG_CONFIG;
  let settings: Record<string, string>;
  try {
    settings = _configReader();
  } catch {
    return DEFAULT_LOG_CONFIG;
  }
  return {
    console: parseLogTargetConfig(settings['logging.console'], DEFAULT_LOG_CONFIG.console),
    file:    parseLogTargetConfig(settings['logging.file'],    DEFAULT_LOG_CONFIG.file),
  };
}

// ---------------------------------------------------------------------------
// File rotation
// ---------------------------------------------------------------------------

function rotateIfNeeded(): void {
  const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
  try {
    const stat = fs.statSync(_logFilePath);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(_logFilePath, `${_logFilePath}.1`);
    }
  } catch {
    // File doesn't exist yet — nothing to rotate
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTimestamp(): string {
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 23); // HH:MM:SS.mmm
  return `${date} ${time}`;
}

function formatLine(type: LogType, feature: LogFeature, message: string): string {
  return `[${formatTimestamp()}] [${type.toUpperCase().padEnd(5)}] [${feature}] ${message}`;
}

// ---------------------------------------------------------------------------
// Core write
// ---------------------------------------------------------------------------

function write(type: LogType, feature: LogFeature, message: string): void {
  const line = formatLine(type, feature, message);

  // Console target
  const con = _config.console;
  if (con.enabled && con.types.includes(type) && con.features.includes(feature)) {
    const fn = type === 'error' ? console.error
             : type === 'warn'  ? console.warn
             : console.log;
    fn(line);
  }

  // File target
  const fil = _config.file;
  if (_logFilePath && fil.enabled && fil.types.includes(type) && fil.features.includes(feature)) {
    try {
      fs.appendFileSync(_logFilePath, line + '\n', 'utf8');
    } catch {
      // Don't throw from a logger — silently ignore file write failures
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Called once in main.ts before the DB is opened (the reader throws → defaults),
 *  so a failed open reaches the file; log.reloadConfig() reads the stored config. */
export function initLogger(opts: LoggerOptions): void {
  _configReader = opts.settings;
  _logFilePath  = opts.logFile ?? '';
  if (_logFilePath) rotateIfNeeded();
  _config = loadConfig();
}

/** The file target's path; '' before init or when initialised without a file. */
export function getLogFilePath(): string {
  return _logFilePath;
}

export const log = {
  info:  (feature: LogFeature, message: string) => write('info',  feature, message),
  warn:  (feature: LogFeature, message: string) => write('warn',  feature, message),
  error: (feature: LogFeature, message: string) => write('error', feature, message),
  debug: (feature: LogFeature, message: string) => write('debug', feature, message),

  /** Re-reads configuration from the DB. Called by SettingsService after a `logging.*` write. */
  reloadConfig(): void {
    _config = loadConfig();
  },
};

/** The logger's shape — for code that receives it as an injected dependency. */
export type Logger = typeof log;
