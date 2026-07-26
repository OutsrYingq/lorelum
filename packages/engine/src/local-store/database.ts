import { Database } from "bun:sqlite";
import { join } from "node:path";

import type { StorageRoot } from "./types";
import { migrateDatabase } from "./migrations";

const DATABASE_FILE = "store.sqlite";

export function databasePath(root: StorageRoot): string {
  return join(root.path, DATABASE_FILE);
}

export class StoreDatabase {
  readonly connection: Database;

  constructor(root: StorageRoot, path = databasePath(root)) {
    const connection = new Database(path, { strict: true });
    try {
      migrateDatabase(connection);
    } catch (error: unknown) {
      connection.close();
      throw error;
    }
    this.connection = connection;
  }

  transaction<T>(operation: () => T): T {
    return this.connection.transaction(operation).immediate();
  }

  close(): void {
    this.connection.close();
  }

  assertHealthy(): void {
    const integrity = this.connection
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("SQLite integrity check failed");
    }

    const foreignKeyViolations = this.connection
      .query<unknown, []>("PRAGMA foreign_key_check")
      .all();
    if (foreignKeyViolations.length > 0) {
      throw new Error("SQLite foreign key check failed");
    }
  }
}
