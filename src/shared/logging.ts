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
