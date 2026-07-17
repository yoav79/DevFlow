import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { createTempDirectory, type TempDirectory } from "./temp-directory.js";
import { initializeSchema, openDatabase } from "../../src/db.js";

export interface TempDatabase {
  database: DatabaseSync;
  databasePath: string;
  directory: TempDirectory;
  close(): void;
  cleanup(): void;
}

export function createTempDatabase(): TempDatabase {
  const directory = createTempDirectory("devflow-db-test");
  const databasePath = join(directory.path, "devflow.db");
  let database: DatabaseSync | null = null;
  let closed = false;

  try {
    database = openDatabase(databasePath);
    initializeSchema(database);
  } catch (error) {
    if (database !== null) {
      try {
        database.close();
      } catch {
        // Ignore close errors while preserving the original failure.
      }
    }

    directory.cleanup();
    throw error;
  }

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    database?.close();
  };

  const cleanup = (): void => {
    close();

    if (existsSync(directory.path)) {
      directory.cleanup();
      return;
    }

    directory.cleanup();
  };

  return {
    database,
    databasePath,
    directory,
    close,
    cleanup,
  };
}
