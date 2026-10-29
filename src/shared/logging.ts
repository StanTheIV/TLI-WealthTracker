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

const ALL_LOG_FEATURES: readonly LogFeature[] = [
  'engine', 'worker', 'database', 'ipc', 'overlay',
  'session', 'price', 'wealth', 'app', 'filter', 'update',
];

/**
 * The code default for both targets — used by the main-process logger and the
 * Settings → Logging store alike. The file target is ON for warn + error so a
 * failure reaches the log file without the user opting in first; a stored
 * `logging.console` / `logging.file` value overrides its target.
 */
export const DEFAULT_LOG_CONFIG: LogConfig = {
  console: {enabled: true, features: [...ALL_LOG_FEATURES], types: ['info', 'warn', 'error']},
  file:    {enabled: true, features: [...ALL_LOG_FEATURES], types: ['warn', 'error']},
};

/** One stored target config (JSON); a missing, unparsable or mistyped field falls back to `fallback`'s. */
export function parseLogTargetConfig(raw: string | undefined, fallback: LogTargetConfig): LogTargetConfig {
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
