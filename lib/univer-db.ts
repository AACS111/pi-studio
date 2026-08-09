import { DatabaseSync } from "node:sqlite";

/**
 * How long a pi-studio SQLite connection waits for the univer daemon / agent CLI
 * to release its write lock before failing with SQLITE_BUSY.
 *
 * .univer files use rollback-journal mode (journal_mode=delete) with a
 * database-level busy_timeout of 0. The daemon and the sheet-edit skill's CLI
 * hold write locks for seconds at a time (a single `univer export` on a big
 * workbook takes 11-23s), so WITHOUT an explicit busy timeout every concurrent
 * read from pi-studio fails instantly → the route's catch-all turns it into
 * HTTP 500 → "Failed to load resource: 500" in the browser console when the
 * viewer opens while the agent is mid-edit. With busy_timeout set, readers
 * simply wait for the writer instead of erroring.
 */
export const UNIVER_DB_BUSY_TIMEOUT_MS = 8000;

/** Open a .univer SQLite database with a busy timeout (read or write). */
export function openUniverDb(file: string, options: { readOnly?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: options.readOnly ?? false });
  db.exec(`PRAGMA busy_timeout = ${UNIVER_DB_BUSY_TIMEOUT_MS}`);
  return db;
}
