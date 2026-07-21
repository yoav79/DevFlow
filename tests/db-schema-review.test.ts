import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { initializeSchema, openDatabase, SchemaIncompatibleError } from "../src/db.js";
import { createProject } from "../src/repositories/project-repository.js";
import { createTask } from "../src/repositories/task-repository.js";
import type { Project, Task } from "../src/types.js";
import { createTempDatabase, type TempDatabase } from "./helpers/temp-database.js";
import { createTempDirectory, type TempDirectory } from "./helpers/temp-directory.js";

function createTestProject(database: Parameters<typeof createProject>[0]): Project {
  const now = new Date().toISOString();
  const project: Project = {
    id: "alpha",
    name: "Alpha",
    repositoryPath: "/tmp/alpha",
    defaultBranch: "main",
    createdAt: now,
  };
  return createProject(database, project);
}

function createTestTask(database: Parameters<typeof createTask>[0], projectId: string = "alpha"): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: "TASK-001",
    projectId,
    title: "Test task",
    description: "For schema tests",
    state: "CREATED",
    attempt: 0,
    maxAttempts: 2,
    contractJson: null,
    currentRevisionJson: null,
    createdAt: now,
    updatedAt: now,
  };
  return createTask(database, task);
}

function insertRunningReview(
  database: Parameters<typeof createTask>[0],
  overrides: Partial<{
    id: string;
    taskId: string;
    reviewNumber: number;
    runNumber: number;
    reviewerClaimJson: string;
    snapshotWorkspaceId: string;
    snapshotBaseCommit: string;
    snapshotHeadCommit: string;
    snapshotFingerprint: string;
  }> = {},
): void {
  const defaults = {
    id: "rev-001",
    taskId: "TASK-001",
    reviewNumber: 1,
    runNumber: 1,
    reviewerClaimJson: '{"claim":"data"}',
    snapshotWorkspaceId: "ws-001",
    snapshotBaseCommit: "base123",
    snapshotHeadCommit: "head456",
    snapshotFingerprint: "fp789",
  };
  const input = { ...defaults, ...overrides };
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO task_reviews
        (id, taskId, reviewNumber, runNumber, status, reviewerClaimJson,
         snapshotWorkspaceId, snapshotBaseCommit, snapshotHeadCommit, snapshotFingerprint, createdAt)
       VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.taskId,
      input.reviewNumber,
      input.runNumber,
      input.reviewerClaimJson,
      input.snapshotWorkspaceId,
      input.snapshotBaseCommit,
      input.snapshotHeadCommit,
      input.snapshotFingerprint,
      now,
    );
}

function insertCompletedReview(
  database: Parameters<typeof createTask>[0],
  overrides: Partial<{
    id: string;
    taskId: string;
    reviewNumber: number;
    runNumber: number;
    snapshotWorkspaceId: string;
    snapshotBaseCommit: string;
    snapshotHeadCommit: string;
    snapshotFingerprint: string;
    verdict: string;
    summary: string;
    findingsJson: string;
    requiredChangesJson: string;
  }> = {},
): void {
  const defaults = {
    id: "rev-001",
    taskId: "TASK-001",
    reviewNumber: 1,
    runNumber: 1,
    snapshotWorkspaceId: "ws-001",
    snapshotBaseCommit: "base123",
    snapshotHeadCommit: "head456",
    snapshotFingerprint: "fp789",
    verdict: "APPROVED",
    summary: "Looks good",
    findingsJson: "[]",
    requiredChangesJson: "[]",
  };
  const input = { ...defaults, ...overrides };
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO task_reviews
        (id, taskId, reviewNumber, runNumber, status,
         snapshotWorkspaceId, snapshotBaseCommit, snapshotHeadCommit, snapshotFingerprint,
         verdict, summary, findingsJson, requiredChangesJson, completedAt, createdAt)
       VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.taskId,
      input.reviewNumber,
      input.runNumber,
      input.snapshotWorkspaceId,
      input.snapshotBaseCommit,
      input.snapshotHeadCommit,
      input.snapshotFingerprint,
      input.verdict,
      input.summary,
      input.findingsJson,
      input.requiredChangesJson,
      now,
      now,
    );
}

function insertDiscardedReview(
  database: Parameters<typeof createTask>[0],
  overrides: Partial<{
    id: string;
    taskId: string;
    reviewNumber: number;
    runNumber: number;
    discardReason: string;
  }> = {},
): void {
  const defaults = {
    id: "rev-001",
    taskId: "TASK-001",
    reviewNumber: 1,
    runNumber: 1,
    discardReason: "orphaned_claim",
  };
  const input = { ...defaults, ...overrides };
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO task_reviews
        (id, taskId, reviewNumber, runNumber, status, discardReason, discardedAt, createdAt)
       VALUES (?, ?, ?, ?, 'DISCARDED', ?, ?, ?)`,
    )
    .run(input.id, input.taskId, input.reviewNumber, input.runNumber, input.discardReason, now, now);
}

function getReview(
  database: Parameters<typeof createTask>[0],
  id: string,
): Record<string, unknown> | undefined {
  return database.prepare("SELECT * FROM task_reviews WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
}

function createHistoricalDbWithoutCorrectionCount(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      repositoryPath TEXT NOT NULL,
      defaultBranch TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE tasks (
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
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE RESTRICT
    );
  `);
  db.close();
}

function createHistoricalDbWithIncompatibleReviews(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      repositoryPath TEXT NOT NULL,
      defaultBranch TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE tasks (
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
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE RESTRICT
    );
    CREATE TABLE task_reviews (
      id TEXT PRIMARY KEY NOT NULL,
      taskId TEXT NOT NULL,
      reviewNumber INTEGER NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
  `);
  db.close();
}

function createHistoricalDbWithWrongIndex(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      repositoryPath TEXT NOT NULL,
      defaultBranch TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE tasks (
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
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE RESTRICT
    );
    CREATE TABLE task_reviews (
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
      CHECK (status IN ('RUNNING', 'COMPLETED', 'DISCARDED'))
    );
    CREATE INDEX idx_wrong_running ON task_reviews(taskId);
  `);
  db.close();
}

function createHistoricalDbWithWrongPartial(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      repositoryPath TEXT NOT NULL,
      defaultBranch TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE tasks (
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
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE RESTRICT
    );
    CREATE TABLE task_reviews (
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
      CHECK (status IN ('RUNNING', 'COMPLETED', 'DISCARDED'))
    );
    CREATE UNIQUE INDEX idx_single_running ON task_reviews(taskId) WHERE status = 'PENDING';
  `);
  db.close();
}

function createHistoricalDbWithMissingVerdictCheck(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      repositoryPath TEXT NOT NULL,
      defaultBranch TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE tasks (
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
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE RESTRICT
    );
    CREATE TABLE task_reviews (
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
      CHECK (status IN ('RUNNING', 'COMPLETED', 'DISCARDED'))
    );
    CREATE UNIQUE INDEX idx_single_running ON task_reviews(taskId) WHERE status = 'RUNNING';
    CREATE UNIQUE INDEX idx_single_completed_per_review ON task_reviews(taskId, reviewNumber) WHERE status = 'COMPLETED';
    CREATE INDEX idx_task_reviews_completed ON task_reviews(taskId, reviewNumber DESC) WHERE status = 'COMPLETED';
  `);
  db.close();
}

function createHistoricalDbWithWrongFk(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      repositoryPath TEXT NOT NULL,
      defaultBranch TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE tasks (
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
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE RESTRICT
    );
    CREATE TABLE task_reviews (
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
      FOREIGN KEY (taskId) REFERENCES projects(id) ON DELETE RESTRICT,
      UNIQUE (taskId, reviewNumber, runNumber),
      CHECK (reviewNumber >= 1),
      CHECK (runNumber >= 1),
      CHECK (status IN ('RUNNING', 'COMPLETED', 'DISCARDED')),
      CHECK (verdict IN ('APPROVED', 'REVISION_REQUIRED'))
    );
    CREATE UNIQUE INDEX idx_single_running ON task_reviews(taskId) WHERE status = 'RUNNING';
    CREATE UNIQUE INDEX idx_single_completed_per_review ON task_reviews(taskId, reviewNumber) WHERE status = 'COMPLETED';
    CREATE INDEX idx_task_reviews_completed ON task_reviews(taskId, reviewNumber DESC) WHERE status = 'COMPLETED';
  `);
  db.close();
}

function createHistoricalDbWithNonUniqueIndex(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      repositoryPath TEXT NOT NULL,
      defaultBranch TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE tasks (
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
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE RESTRICT
    );
    CREATE TABLE task_reviews (
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
      CHECK (verdict IN ('APPROVED', 'REVISION_REQUIRED'))
    );
    CREATE INDEX idx_single_running ON task_reviews(taskId) WHERE status = 'RUNNING';
    CREATE UNIQUE INDEX idx_single_completed_per_review ON task_reviews(taskId, reviewNumber) WHERE status = 'COMPLETED';
    CREATE INDEX idx_task_reviews_completed ON task_reviews(taskId, reviewNumber DESC) WHERE status = 'COMPLETED';
  `);
  db.close();
}

function createHistoricalDbWithPartialMigration(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      repositoryPath TEXT NOT NULL,
      defaultBranch TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE tasks (
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
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE RESTRICT
    );
    CREATE TABLE task_reviews (
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
      CHECK (verdict IS NOT NULL AND verdict IN ('APPROVED', 'REVISION_REQUIRED'))
    );
    CREATE UNIQUE INDEX idx_single_running ON task_reviews(taskId) WHERE status = 'RUNNING';
    CREATE UNIQUE INDEX idx_single_completed_per_review ON task_reviews(taskId, reviewNumber) WHERE status = 'COMPLETED';
    CREATE INDEX idx_task_reviews_completed ON task_reviews(taskId, reviewNumber DESC) WHERE status = 'COMPLETED';
  `);
  db.close();
}

describe("task_reviews schema", () => {
  let tempDb: TempDatabase | null = null;

  afterEach(() => {
    tempDb?.cleanup();
    tempDb = null;
  });

  describe("creation", () => {
    it("creates task_reviews table", () => {
      tempDb = createTempDatabase();
      const row = getReview(tempDb.database, "nonexistent");
      expect(row).toBeUndefined();
    });

    it("creates the three expected indexes", () => {
      tempDb = createTempDatabase();
      const indexes = tempDb.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_reviews'")
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_single_running");
      expect(names).toContain("idx_single_completed_per_review");
      expect(names).toContain("idx_task_reviews_completed");
    });
  });

  describe("new DB correctionCount", () => {
    it("creates correctionCount with default 0", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const task = tempDb.database
        .prepare("SELECT correctionCount FROM tasks WHERE id = ?")
        .get("TASK-001") as { correctionCount: number };
      expect(task.correctionCount).toBe(0);
    });
  });

  describe("RUNNING inserts", () => {
    it("inserts a valid RUNNING review", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertRunningReview(tempDb.database);
      const review = getReview(tempDb.database, "rev-001");
      expect(review).toBeDefined();
      expect(review!["status"]).toBe("RUNNING");
      expect(review!["reviewNumber"]).toBe(1);
      expect(review!["runNumber"]).toBe(1);
    });

    it("rejects RUNNING without reviewerClaimJson", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      expect(() => {
        tempDb!.database
          .prepare(
            `INSERT INTO task_reviews
              (id, taskId, reviewNumber, runNumber, status,
               snapshotWorkspaceId, snapshotBaseCommit, snapshotHeadCommit, snapshotFingerprint, createdAt)
             VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?)`,
          )
          .run("rev-bad", "TASK-001", 1, 1, "ws-001", "base", "head", "fp", now);
      }).toThrow();
    });

    it("rejects RUNNING with semantic result fields set", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      expect(() => {
        tempDb!.database
          .prepare(
            `INSERT INTO task_reviews
              (id, taskId, reviewNumber, runNumber, status, reviewerClaimJson,
               snapshotWorkspaceId, snapshotBaseCommit, snapshotHeadCommit, snapshotFingerprint,
               verdict, createdAt)
             VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("rev-bad", "TASK-001", 1, 1, '{"c":"1"}', "ws", "base", "head", "fp", "APPROVED", now);
      }).toThrow();
    });
  });

  describe("COMPLETED inserts", () => {
    it("inserts a valid COMPLETED review with APPROVED", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertCompletedReview(tempDb.database, { verdict: "APPROVED" });
      const review = getReview(tempDb.database, "rev-001");
      expect(review).toBeDefined();
      expect(review!["status"]).toBe("COMPLETED");
      expect(review!["verdict"]).toBe("APPROVED");
    });

    it("inserts a valid COMPLETED review with REVISION_REQUIRED", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertCompletedReview(tempDb.database, { verdict: "REVISION_REQUIRED" });
      const review = getReview(tempDb.database, "rev-001");
      expect(review).toBeDefined();
      expect(review!["verdict"]).toBe("REVISION_REQUIRED");
    });

    it("rejects COMPLETED without verdict", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      expect(() => {
        tempDb!.database
          .prepare(
            `INSERT INTO task_reviews
              (id, taskId, reviewNumber, runNumber, status,
               snapshotWorkspaceId, snapshotBaseCommit, snapshotHeadCommit, snapshotFingerprint,
               summary, findingsJson, requiredChangesJson, completedAt, createdAt)
             VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("rev-bad", "TASK-001", 1, 1, "ws", "base", "head", "fp", "ok", "[]", "[]", now, now);
      }).toThrow();
    });

    it("rejects COMPLETED with reviewerClaimJson set", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      expect(() => {
        tempDb!.database
          .prepare(
            `INSERT INTO task_reviews
              (id, taskId, reviewNumber, runNumber, status, reviewerClaimJson,
               snapshotWorkspaceId, snapshotBaseCommit, snapshotHeadCommit, snapshotFingerprint,
               verdict, summary, findingsJson, requiredChangesJson, completedAt, createdAt)
             VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("rev-bad", "TASK-001", 1, 1, '{"c":"1"}', "ws", "base", "head", "fp", "APPROVED", "ok", "[]", "[]", now, now);
      }).toThrow();
    });

    it("rejects COMPLETED with verdict FAILED", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      expect(() => insertCompletedReview(tempDb!.database, { verdict: "FAILED" })).toThrow();
    });

    it("rejects COMPLETED with verdict BLOCKED", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      expect(() => insertCompletedReview(tempDb!.database, { verdict: "BLOCKED" })).toThrow();
    });

    it("rejects COMPLETED with arbitrary verdict string", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      expect(() => insertCompletedReview(tempDb!.database, { verdict: "INVALID" })).toThrow();
    });
  });

  describe("DISCARDED inserts", () => {
    it("inserts a valid DISCARDED review", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertDiscardedReview(tempDb.database);
      const review = getReview(tempDb.database, "rev-001");
      expect(review).toBeDefined();
      expect(review!["status"]).toBe("DISCARDED");
      expect(review!["discardReason"]).toBe("orphaned_claim");
    });

    it("rejects DISCARDED without discardReason", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      expect(() => {
        tempDb!.database
          .prepare(
            `INSERT INTO task_reviews
              (id, taskId, reviewNumber, runNumber, status, discardedAt, createdAt)
             VALUES (?, ?, ?, ?, 'DISCARDED', ?, ?)`,
          )
          .run("rev-bad", "TASK-001", 1, 1, now, now);
      }).toThrow();
    });
  });

  describe("uniqueness", () => {
    it("rejects two RUNNING for the same taskId", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertRunningReview(tempDb.database, { id: "rev-1" });
      expect(() => insertRunningReview(tempDb!.database, { id: "rev-2" })).toThrow();
    });

    it("rejects two COMPLETED for the same taskId + reviewNumber", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertCompletedReview(tempDb.database, { id: "rev-1", runNumber: 1 });
      expect(() =>
        insertCompletedReview(tempDb!.database, { id: "rev-2", runNumber: 2 }),
      ).toThrow();
    });

    it("allows multiple DISCARDED for the same reviewNumber with different runNumber", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertDiscardedReview(tempDb.database, { id: "rev-1", runNumber: 1 });
      insertDiscardedReview(tempDb.database, { id: "rev-2", runNumber: 2 });
      insertDiscardedReview(tempDb.database, { id: "rev-3", runNumber: 3 });
      expect(getReview(tempDb.database, "rev-1")).toBeDefined();
      expect(getReview(tempDb.database, "rev-2")).toBeDefined();
      expect(getReview(tempDb.database, "rev-3")).toBeDefined();
    });
  });

  describe("migration", () => {
    it("migrates historical DB without correctionCount", () => {
      const directory = createTempDirectory("devflow-db-migration-test");
      const databasePath = join(directory.path, "devflow.db");
      createHistoricalDbWithoutCorrectionCount(databasePath);

      const reopened = openDatabase(databasePath);
      initializeSchema(reopened);
      const columns = reopened.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain("correctionCount");

      reopened.close();
      directory.cleanup();
    });

    it("is idempotent for already-migrated DB", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertRunningReview(tempDb.database);
      initializeSchema(tempDb.database);
      const review = getReview(tempDb.database, "rev-001");
      expect(review).toBeDefined();
      expect(review!["status"]).toBe("RUNNING");
    });

    it("propagates errors from incomplete migration dependencies", () => {
      const directory = createTempDirectory("devflow-db-migration-propagation-test");
      const databasePath = join(directory.path, "devflow.db");
      const db = new DatabaseSync(databasePath);
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          repositoryPath TEXT NOT NULL,
          defaultBranch TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
        CREATE TABLE tasks (
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
          FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE RESTRICT
        );
      `);
      db.close();

      const reopened = openDatabase(databasePath);
      initializeSchema(reopened);
      const columns = reopened.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain("correctionCount");
      reopened.close();
      directory.cleanup();
    });

    it("task_reviews correct + tasks without correctionCount migrates successfully", () => {
      const directory = createTempDirectory("devflow-db-partial-migration-test");
      const databasePath = join(directory.path, "devflow.db");
      createHistoricalDbWithPartialMigration(databasePath);

      const reopened = openDatabase(databasePath);
      expect(() => initializeSchema(reopened)).not.toThrow();
      const columns = reopened.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain("correctionCount");

      expect(() => initializeSchema(reopened)).not.toThrow();
      reopened.close();
      directory.cleanup();
    });
  });

  describe("compatibility", () => {
    it("rejects task_reviews with missing column", () => {
      const directory = createTempDirectory("devflow-db-compat-test");
      const databasePath = join(directory.path, "devflow.db");
      createHistoricalDbWithIncompatibleReviews(databasePath);

      const reopened = openDatabase(databasePath);
      expect(() => initializeSchema(reopened)).toThrow(SchemaIncompatibleError);
      reopened.close();
      directory.cleanup();
    });

    it("rejects task_reviews with incorrect index", () => {
      const directory = createTempDirectory("devflow-db-compat-idx-test");
      const databasePath = join(directory.path, "devflow.db");
      createHistoricalDbWithWrongIndex(databasePath);

      const reopened = openDatabase(databasePath);
      expect(() => initializeSchema(reopened)).toThrow(SchemaIncompatibleError);
      reopened.close();
      directory.cleanup();
    });

    it("rejects task_reviews with incorrect partial condition", () => {
      const directory = createTempDirectory("devflow-db-compat-partial-test");
      const databasePath = join(directory.path, "devflow.db");
      createHistoricalDbWithWrongPartial(databasePath);

      const reopened = openDatabase(databasePath);
      expect(() => initializeSchema(reopened)).toThrow(SchemaIncompatibleError);
      reopened.close();
      directory.cleanup();
    });

    it("rejects task_reviews with wrong foreign key target", () => {
      const directory = createTempDirectory("devflow-db-compat-fk-test");
      const databasePath = join(directory.path, "devflow.db");
      createHistoricalDbWithWrongFk(databasePath);

      const reopened = openDatabase(databasePath);
      expect(() => initializeSchema(reopened)).toThrow(SchemaIncompatibleError);
      reopened.close();
      directory.cleanup();
    });

    it("rejects task_reviews with non-unique index where unique expected", () => {
      const directory = createTempDirectory("devflow-db-compat-nonunique-test");
      const databasePath = join(directory.path, "devflow.db");
      createHistoricalDbWithNonUniqueIndex(databasePath);

      const reopened = openDatabase(databasePath);
      expect(() => initializeSchema(reopened)).toThrow(SchemaIncompatibleError);
      reopened.close();
      directory.cleanup();
    });

    it("rejects task_reviews with missing verdict CHECK constraint", () => {
      const directory = createTempDirectory("devflow-db-compat-verdict-test");
      const databasePath = join(directory.path, "devflow.db");
      createHistoricalDbWithMissingVerdictCheck(databasePath);

      const reopened = openDatabase(databasePath);
      expect(() => initializeSchema(reopened)).toThrow(SchemaIncompatibleError);
      reopened.close();
      directory.cleanup();
    });
  });

  describe("foreign key", () => {
    it("rejects review with nonexistent taskId", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      expect(() => insertRunningReview(tempDb!.database, { taskId: "NONEXISTENT" })).toThrow();
    });

    it("ON DELETE CASCADE removes reviews when task is deleted", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertRunningReview(tempDb.database);
      expect(getReview(tempDb.database, "rev-001")).toBeDefined();

      tempDb.database.prepare("DELETE FROM tasks WHERE id = ?").run("TASK-001");
      expect(getReview(tempDb.database, "rev-001")).toBeUndefined();
    });
  });
});
