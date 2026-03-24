/**
 * Logger — main-process singleton.
 *
 * Each message carries a feature (domain) and a type (level).
 * Two output targets (console, file) are independently configurable.
 * Configuration is read from the SQLite settings table on init and on
 * explicit reloadConfig() calls (triggered via IPC when the user saves settings).
 *
 * The logger is intentionally kept dependency-free (no imports from db.ts)
 * to avoid circular dependencies. Instead it receives a config-reader
 * function during initialisation.
 */

import * as fs from 'fs';
import * as path from 'path';
import {app} from 'electron';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogFeature =
  | 'engine'
  | 'worker'
  | 'database'
  | 'ipc'
  | 'overlay'
  | 'session'
  | 'price'
  | 'wealth'
  | 'app'
  | 'filter'
  | 'update';

export type LogType = 'info' | 'warn' | 'error' | 'debug';

export interface LogTargetConfig {
  enabled:  boolean;
  features: LogFeature[];
  types:    LogType[];
}

export interface LogConfig {
  console: LogTargetConfig;
  file:    LogTargetConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const ALL_FEATURES: LogFeature[] = [
  'engine', 'worker', 'database', 'ipc', 'overlay',
  'session', 'price', 'wealth', 'app', 'filter', 'update',
];

const DEFAULT_TYPES: LogType[] = ['info', 'warn', 'error'];

const DEFAULT_CONFIG: LogConfig = {
  console: {enabled: true,  features: ALL_FEATURES, types: DEFAULT_TYPES},
  file:    {enabled: false, features: ALL_FEATURES, types: DEFAULT_TYPES},
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _configReader: (() => Record<string, string>) | null = null;
let _config: LogConfig = DEFAULT_CONFIG;
let _logFilePath = '';

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

function parseTargetConfig(raw: string | undefined, fallback: LogTargetConfig): LogTargetConfig {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<LogTargetConfig>;
    return {
      enabled:  typeof parsed.enabled === 'boolean' ? parsed.enabled : fallback.enabled,
      features: Array.isArray(parsed.features)       ? parsed.features as LogFeature[] : fallback.features,
      types:    Array.isArray(parsed.types)           ? parsed.types as LogType[]       : fallback.types,
    };
  } catch {
    return fallback;
  }
}

function loadConfig(): LogConfig {
  if (!_configReader) return DEFAULT_CONFIG;
  const settings = _configReader();
  return {
    console: parseTargetConfig(settings['logging.console'], DEFAULT_CONFIG.console),
    file:    parseTargetConfig(settings['logging.file'],    DEFAULT_CONFIG.file),
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
  if (fil.enabled && fil.types.includes(type) && fil.features.includes(feature)) {
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

/**
 * Must be called once in main.ts, immediately after initDb().
 * @param configReader  A reference to settingsGetAll() from db.ts
 */
export function initLogger(configReader: () => Record<string, string>): void {
  _configReader = configReader;
  _logFilePath  = path.join(app.getPath('userData'), 'tli-tracker.log');
  rotateIfNeeded();
  _config = loadConfig();
}

export const log = {
  info:  (feature: LogFeature, message: string) => write('info',  feature, message),
  warn:  (feature: LogFeature, message: string) => write('warn',  feature, message),
  error: (feature: LogFeature, message: string) => write('error', feature, message),
  debug: (feature: LogFeature, message: string) => write('debug', feature, message),

  /** Re-reads configuration from the DB. Called via IPC when the user saves logging settings. */
  reloadConfig(): void {
    _config = loadConfig();
  },
};
