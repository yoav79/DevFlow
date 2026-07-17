/// <reference types="node" />

import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { TASK_STATES } from "./types.js";

const HUMAN_REQUEST_TYPES = [
  "CONTRACT_APPROVAL",
  "FUNCTIONAL_DECISION",
  "SCOPE_EXPANSION",
  "DEPENDENCY_APPROVAL",
  "FINAL_APPROVAL",
  "NEXT_TASK_APPROVAL",
] as const;

const HUMAN_REQUEST_STATUSES = ["PENDING", "RESOLVED", "REJECTED"] as const;

const taskStateSql = TASK_STATES.map((state) => `'${state}'`).join(", ");
const humanRequestTypeSql = HUMAN_REQUEST_TYPES.map((type) => `'${type}'`).join(", ");
const humanRequestStatusSql = HUMAN_REQUEST_STATUSES.map((status) => `'${status}'`).join(", ");

export function getDefaultDatabasePath(): string {
  return join(homedir(), ".devflow", "devflow.db");
}

export function openDatabase(databasePath: string = getDefaultDatabasePath()): DatabaseSync {
  const databaseDirectory = dirname(databasePath);
  mkdirSync(databaseDirectory, { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");

  const foreignKeysEnabled = database.prepare("PRAGMA foreign_keys;").get() as
    | { foreign_keys?: number }
    | undefined;

  if (foreignKeysEnabled?.foreign_keys !== 1) {
    database.close();
    throw new Error("SQLite foreign key enforcement could not be enabled.");
  }

  return database;
}

export function initializeSchema(database: DatabaseSync): void {
  try {
    database.exec("BEGIN;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        repositoryPath TEXT NOT NULL,
        defaultBranch TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY NOT NULL,
        projectId TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        maxAttempts INTEGER NOT NULL,
        contractJson TEXT NULL,
        currentRevisionJson TEXT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE RESTRICT,
        CHECK (attempt >= 0),
        CHECK (maxAttempts > 0),
        CHECK (attempt <= maxAttempts),
        CHECK (state IN (${taskStateSql}))
      );

      CREATE TABLE IF NOT EXISTS human_requests (
        id TEXT PRIMARY KEY NOT NULL,
        taskId TEXT NOT NULL,
        type TEXT NOT NULL,
        question TEXT NOT NULL,
        optionsJson TEXT NOT NULL,
        resolutionJson TEXT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        resolvedAt TEXT NULL,
        FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE,
        CHECK (type IN (${humanRequestTypeSql})),
        CHECK (status IN (${humanRequestStatusSql})),
        CHECK (
          (
            status = 'PENDING'
            AND resolutionJson IS NULL
            AND resolvedAt IS NULL
          ) OR (
            status = 'RESOLVED'
            AND resolutionJson IS NOT NULL
            AND resolvedAt IS NOT NULL
          ) OR (
            status = 'REJECTED'
            AND resolvedAt IS NOT NULL
          )
        )
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_project_id
        ON tasks(projectId);

      CREATE INDEX IF NOT EXISTS idx_human_requests_task_id
        ON human_requests(taskId);

      CREATE INDEX IF NOT EXISTS idx_human_requests_pending
        ON human_requests(status)
        WHERE status = 'PENDING';
    `);
    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Ignore rollback errors and propagate the original failure.
    }

    throw error;
  }
}
