import type {MigrationResult} from './migrations';

/** The start-up warning for a DB written by a newer app, or null. English: main has no i18n. */
export function newerSchemaMessage(result: MigrationResult): string | null {
  if (!result.newerThanApp) return null;
  return `This database was created by a newer version of TLI Tracker (schema v${result.from}; `
    + `this version knows v${result.latest}). Continuing may misread or overwrite data. `
    + 'Update TLI Tracker to avoid problems.';
}
