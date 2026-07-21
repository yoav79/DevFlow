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

type ColumnSpec = {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
};

const REQUIRED_TASK_REVIEW_COLUMNS: readonly ColumnSpec[] = [
  { name: "id", type: "TEXT", notnull: true, pk: true },
  { name: "taskId", type: "TEXT", notnull: true, pk: false },
  { name: "reviewNumber", type: "INTEGER", notnull: true, pk: false },
  { name: "runNumber", type: "INTEGER", notnull: true, pk: false },
  { name: "status", type: "TEXT", notnull: true, pk: false },
  { name: "reviewerClaimJson", type: "TEXT", notnull: false, pk: false },
  { name: "snapshotWorkspaceId", type: "TEXT", notnull: false, pk: false },
  { name: "snapshotBaseCommit", type: "TEXT", notnull: false, pk: false },
  { name: "snapshotHeadCommit", type: "TEXT", notnull: false, pk: false },
  { name: "snapshotFingerprint", type: "TEXT", notnull: false, pk: false },
  { name: "verdict", type: "TEXT", notnull: false, pk: false },
  { name: "summary", type: "TEXT", notnull: false, pk: false },
  { name: "findingsJson", type: "TEXT", notnull: false, pk: false },
  { name: "requiredChangesJson", type: "TEXT", notnull: false, pk: false },
  { name: "discardReason", type: "TEXT", notnull: false, pk: false },
  { name: "createdAt", type: "TEXT", notnull: true, pk: false },
  { name: "completedAt", type: "TEXT", notnull: false, pk: false },
  { name: "discardedAt", type: "TEXT", notnull: false, pk: false },
] as const;

type RequiredIndex = {
  name: string;
  unique: boolean;
  columns: readonly string[];
  where: string;
};

const REQUIRED_TASK_REVIEW_INDEXES: readonly RequiredIndex[] = [
  { name: "idx_single_running", unique: true, columns: ["taskId"], where: "status = 'RUNNING'" },
  { name: "idx_single_completed_per_review", unique: true, columns: ["taskId", "reviewNumber"], where: "status = 'COMPLETED'" },
] as const;

export function initializeSchema(database: DatabaseSync): void {
  const taskReviewsExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_reviews'")
    .get() as { name: string } | undefined;

  if (taskReviewsExists) {
    validateTaskReviewsSchema(database);
  }

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
        correctionCount INTEGER NOT NULL DEFAULT 0,
        contractJson TEXT NULL,
        currentRevisionJson TEXT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE RESTRICT,
        CHECK (attempt >= 0),
        CHECK (maxAttempts > 0),
        CHECK (attempt <= maxAttempts),
        CHECK (correctionCount >= 0),
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

      CREATE TABLE IF NOT EXISTS task_workspaces (
        id TEXT PRIMARY KEY NOT NULL,
        taskId TEXT NOT NULL,
        executionNumber INTEGER NOT NULL,
        workspacePath TEXT NOT NULL,
        branchName TEXT NOT NULL,
        baseCommit TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PREPARING',
        createdAt TEXT NOT NULL,
        removedAt TEXT NULL,
        FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE RESTRICT,
        UNIQUE (taskId, executionNumber),
        UNIQUE (workspacePath),
        CHECK (executionNumber >= 1),
        CHECK (
          status IN (
            'PREPARING',
            'READY',
            'FAILED',
            'REMOVED'
          )
        ),
        CHECK (
          (status = 'REMOVED' AND removedAt IS NOT NULL)
          OR
          (status != 'REMOVED' AND removedAt IS NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_task_workspaces_task_id
        ON task_workspaces(taskId);

      CREATE INDEX IF NOT EXISTS idx_task_workspaces_status
        ON task_workspaces(status);

      CREATE TABLE IF NOT EXISTS task_reviews (
        id TEXT PRIMARY KEY NOT NULL,
        taskId TEXT NOT NULL,
        reviewNumber INTEGER NOT NULL,
        runNumber INTEGER NOT NULL,
        status TEXT NOT NULL,
        reviewerClaimJson TEXT,
        snapshotWorkspaceId TEXT,
        snapshotBaseCommit TEXT,
        snapshotHeadCommit TEXT,
        snapshotFingerprint TEXT,
        verdict TEXT,
        summary TEXT,
        findingsJson TEXT,
        requiredChangesJson TEXT,
        discardReason TEXT,
        createdAt TEXT NOT NULL,
        completedAt TEXT,
        discardedAt TEXT,
        FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE (taskId, reviewNumber, runNumber),
        CHECK (reviewNumber >= 1),
        CHECK (runNumber >= 1),
        CHECK (status IN ('RUNNING', 'COMPLETED', 'DISCARDED')),
        CHECK (
          (status = 'RUNNING'
            AND reviewerClaimJson IS NOT NULL
            AND snapshotWorkspaceId IS NOT NULL
            AND snapshotBaseCommit IS NOT NULL
            AND snapshotHeadCommit IS NOT NULL
            AND snapshotFingerprint IS NOT NULL
            AND verdict IS NULL
            AND summary IS NULL
            AND findingsJson IS NULL
            AND requiredChangesJson IS NULL
            AND completedAt IS NULL
            AND discardedAt IS NULL
            AND discardReason IS NULL)
          OR (status = 'COMPLETED'
            AND reviewerClaimJson IS NULL
            AND snapshotWorkspaceId IS NOT NULL
            AND snapshotBaseCommit IS NOT NULL
            AND snapshotHeadCommit IS NOT NULL
            AND snapshotFingerprint IS NOT NULL
            AND verdict IS NOT NULL AND verdict IN ('APPROVED', 'REVISION_REQUIRED')
            AND summary IS NOT NULL
            AND findingsJson IS NOT NULL
            AND requiredChangesJson IS NOT NULL
            AND completedAt IS NOT NULL
            AND discardedAt IS NULL
            AND discardReason IS NULL)
          OR (status = 'DISCARDED'
            AND reviewerClaimJson IS NULL
            AND verdict IS NULL
            AND summary IS NULL
            AND findingsJson IS NULL
            AND requiredChangesJson IS NULL
            AND completedAt IS NULL
            AND discardedAt IS NOT NULL
            AND discardReason IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_single_running
        ON task_reviews(taskId) WHERE status = 'RUNNING';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_single_completed_per_review
        ON task_reviews(taskId, reviewNumber) WHERE status = 'COMPLETED';

      CREATE INDEX IF NOT EXISTS idx_task_reviews_completed
        ON task_reviews(taskId, reviewNumber DESC)
        WHERE status = 'COMPLETED';
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

  migrateExistingSchema(database);
}

function migrateExistingSchema(database: DatabaseSync): void {
  const taskColumns = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const hasCorrectionCount = taskColumns.some((c) => c.name === "correctionCount");

  if (!hasCorrectionCount) {
    database.exec("ALTER TABLE tasks ADD COLUMN correctionCount INTEGER NOT NULL DEFAULT 0");
  }
}

function validateTaskReviewsSchema(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(task_reviews)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;

  for (const required of REQUIRED_TASK_REVIEW_COLUMNS) {
    const actual = columns.find((c) => c.name === required.name);
    if (!actual) {
      throw new SchemaIncompatibleError(
        `task_reviews missing column: ${required.name}`,
        { code: "SCHEMA_INCOMPATIBLE", missing: [required.name] },
      );
    }
    if (actual.type.toUpperCase() !== required.type) {
      throw new SchemaIncompatibleError(
        `task_reviews column ${required.name} has type ${actual.type}, expected ${required.type}`,
        { code: "SCHEMA_INCOMPATIBLE", missing: [required.name] },
      );
    }
    if (required.notnull && actual.notnull !== 1) {
      throw new SchemaIncompatibleError(
        `task_reviews column ${required.name} is nullable, expected NOT NULL`,
        { code: "SCHEMA_INCOMPATIBLE", missing: [required.name] },
      );
    }
    if (required.pk && actual.pk !== 1) {
      throw new SchemaIncompatibleError(
        `task_reviews column ${required.name} is not PK, expected PRIMARY KEY`,
        { code: "SCHEMA_INCOMPATIBLE", missing: [required.name] },
      );
    }
  }

  const fkList = database.prepare("PRAGMA foreign_key_list(task_reviews)").all() as Array<{
    from: string;
    table: string;
    to: string;
    on_delete: string;
  }>;
  const taskFk = fkList.find((fk) => fk.from === "taskId");
  if (!taskFk) {
    throw new SchemaIncompatibleError(
      "task_reviews missing foreign key on taskId",
      { code: "SCHEMA_INCOMPATIBLE", missing: ["taskId"] },
    );
  }
  if (taskFk.table !== "tasks") {
    throw new SchemaIncompatibleError(
      `task_reviews foreign key references ${taskFk.table}, expected tasks`,
      { code: "SCHEMA_INCOMPATIBLE", missing: ["taskId"] },
    );
  }
  if (taskFk.to !== "id") {
    throw new SchemaIncompatibleError(
      `task_reviews foreign key references ${taskFk.to}, expected id`,
      { code: "SCHEMA_INCOMPATIBLE", missing: ["taskId"] },
    );
  }
  if (taskFk.on_delete !== "CASCADE") {
    throw new SchemaIncompatibleError(
      `task_reviews foreign key on_delete is ${taskFk.on_delete}, expected CASCADE`,
      { code: "SCHEMA_INCOMPATIBLE", missing: ["taskId"] },
    );
  }

  const indexList = database.prepare("PRAGMA index_list(task_reviews)").all() as Array<{
    name: string;
    unique: number;
  }>;

  for (const required of REQUIRED_TASK_REVIEW_INDEXES) {
    const actual = indexList.find((i) => i.name === required.name);
    if (!actual) {
      throw new SchemaIncompatibleError(
        `task_reviews missing index: ${required.name}`,
        { code: "SCHEMA_INCOMPATIBLE", missing: [required.name] },
      );
    }
    if (required.unique && actual.unique !== 1) {
      throw new SchemaIncompatibleError(
        `task_reviews index ${required.name} is not unique, expected UNIQUE`,
        { code: "SCHEMA_INCOMPATIBLE", missing: [required.name] },
      );
    }

    const indexInfo = database.prepare(`PRAGMA index_info("${required.name}")`).all() as Array<{
      name: string;
      seq: number;
    }>;
    const indexColumns = indexInfo.map((i) => i.name);
    if (indexColumns.length !== required.columns.length) {
      throw new SchemaIncompatibleError(
        `task_reviews index ${required.name} has columns [${indexColumns.join(", ")}], expected [${required.columns.join(", ")}]`,
        { code: "SCHEMA_INCOMPATIBLE", missing: [required.name] },
      );
    }
    for (let i = 0; i < required.columns.length; i++) {
      if (indexColumns[i] !== required.columns[i]) {
        throw new SchemaIncompatibleError(
          `task_reviews index ${required.name} column ${i} is ${indexColumns[i]}, expected ${required.columns[i]}`,
          { code: "SCHEMA_INCOMPATIBLE", missing: [required.name] },
        );
      }
    }

    const indexSql = database
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='${required.name}'`)
      .get() as { sql: string } | undefined;
    if (!indexSql?.sql) {
      throw new SchemaIncompatibleError(
        `task_reviews index ${required.name} SQL not found`,
        { code: "SCHEMA_INCOMPATIBLE", missing: [required.name] },
      );
    }
    const sqlLower = indexSql.sql.toLowerCase().replace(/\s+/g, " ");
    if (!sqlLower.includes(`where ${required.where.toLowerCase()}`)) {
      throw new SchemaIncompatibleError(
        `task_reviews index ${required.name} missing partial condition WHERE ${required.where}`,
        { code: "SCHEMA_INCOMPATIBLE", missing: [required.name] },
      );
    }
  }

  const tableSql = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_reviews'")
    .get() as { sql: string } | undefined;

  if (!tableSql) {
    throw new SchemaIncompatibleError(
      "task_reviews table SQL not found in sqlite_master",
      { code: "SCHEMA_INCOMPATIBLE" },
    );
  }

  const sqlNormalized = tableSql.sql.toLowerCase().replace(/\s+/g, " ");

  if (!sqlNormalized.includes("check (reviewnumber >= 1)")) {
    throw new SchemaIncompatibleError(
      "task_reviews missing CHECK (reviewNumber >= 1)",
      { code: "SCHEMA_INCOMPATIBLE" },
    );
  }

  if (!sqlNormalized.includes("check (runnumber >= 1)")) {
    throw new SchemaIncompatibleError(
      "task_reviews missing CHECK (runNumber >= 1)",
      { code: "SCHEMA_INCOMPATIBLE" },
    );
  }

  if (!sqlNormalized.includes("check (status in ('running', 'completed', 'discarded'))")) {
    throw new SchemaIncompatibleError(
      "task_reviews missing CHECK (status IN (...))",
      { code: "SCHEMA_INCOMPATIBLE" },
    );
  }

  if (!sqlNormalized.includes("verdict is not null and verdict in ('approved', 'revision_required')")) {
    throw new SchemaIncompatibleError(
      "task_reviews missing CHECK (verdict IS NOT NULL AND verdict IN ('APPROVED', 'REVISION_REQUIRED'))",
      { code: "SCHEMA_INCOMPATIBLE" },
    );
  }
}

export class SchemaIncompatibleError extends Error {
  readonly code: string;
  readonly missing: readonly string[] | undefined;

  constructor(message: string, options?: { code?: string; missing?: readonly string[] }) {
    super(message);
    this.name = "SchemaIncompatibleError";
    this.code = options?.code ?? "SCHEMA_INCOMPATIBLE";
    this.missing = options?.missing;
  }
}
