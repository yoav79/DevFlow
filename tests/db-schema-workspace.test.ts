import { afterEach, describe, expect, it } from "vitest";

import { initializeSchema, openDatabase } from "../src/db.js";
import { createProject, getProjectById } from "../src/repositories/project-repository.js";
import { createTask, getTaskById } from "../src/repositories/task-repository.js";
import type { Project, Task } from "../src/types.js";
import {
  TASK_WORKSPACE_STATUSES,
  type TaskWorkspaceStatus,
  type TaskWorkspace,
  type CreateTaskWorkspaceInput,
} from "../src/types.js";
import { createTempDatabase, type TempDatabase } from "./helpers/temp-database.js";
import { createTempGitRepository, type TempGitRepository } from "./helpers/temp-git-repository.js";

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

function insertWorkspace(
  database: Parameters<typeof createTask>[0],
  overrides: Partial<CreateTaskWorkspaceInput> = {},
): void {
  const input: CreateTaskWorkspaceInput = {
    id: "ws-001",
    taskId: "TASK-001",
    executionNumber: 1,
    workspacePath: "/tmp/devflow/worktrees/alpha/TASK-001/1",
    branchName: "devflow/alpha/TASK-001/attempt-1",
    baseCommit: "abc123def456",
    ...overrides,
  };

  database
    .prepare(
      "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(input.id, input.taskId, input.executionNumber, input.workspacePath, input.branchName, input.baseCommit, new Date().toISOString());
}

function getWorkspace(
  database: Parameters<typeof createTask>[0],
  id: string,
): Record<string, unknown> | undefined {
  return database.prepare("SELECT * FROM task_workspaces WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
}

describe("task_workspaces schema", () => {
  let tempDb: TempDatabase | null = null;

  afterEach(() => {
    tempDb?.cleanup();
    tempDb = null;
  });

  describe("creation and idempotency", () => {
    it("creates task_workspaces", () => {
      tempDb = createTempDatabase();
      const row = getWorkspace(tempDb.database, "nonexistent");
      expect(row).toBeUndefined();
    });

    it("can run initializeSchema twice", () => {
      tempDb = createTempDatabase();
      initializeSchema(tempDb.database);
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database);
      const workspace = getWorkspace(tempDb.database, "ws-001");
      expect(workspace).toBeDefined();
    });

    it("keeps existing tables available", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      expect(getProjectById(tempDb.database, "alpha")).not.toBeNull();
      expect(getTaskById(tempDb.database, "TASK-001")).not.toBeNull();
    });

    it("keeps PRAGMA foreign_keys active", () => {
      tempDb = createTempDatabase();
      const result = tempDb.database.prepare("PRAGMA foreign_keys;").get() as
        | { foreign_keys?: number }
        | undefined;
      expect(result?.foreign_keys).toBe(1);
    });
  });

  describe("valid insertion", () => {
    it("inserts a valid workspace", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database);
      const workspace = getWorkspace(tempDb.database, "ws-001");
      expect(workspace).toBeDefined();
    });

    it("recovers all fields", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database);
      const ws = getWorkspace(tempDb.database, "ws-001")!;
      expect(ws["id"]).toBe("ws-001");
      expect(ws["taskId"]).toBe("TASK-001");
      expect(ws["executionNumber"]).toBe(1);
      expect(ws["workspacePath"]).toBe("/tmp/devflow/worktrees/alpha/TASK-001/1");
      expect(ws["branchName"]).toBe("devflow/alpha/TASK-001/attempt-1");
      expect(ws["baseCommit"]).toBe("abc123def456");
      expect(ws["status"]).toBe("PREPARING");
      expect(typeof ws["createdAt"]).toBe("string");
      expect(ws["removedAt"]).toBeNull();
    });

    it("defaults status to PREPARING", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database);
      const ws = getWorkspace(tempDb.database, "ws-001")!;
      expect(ws["status"]).toBe("PREPARING");
    });

    it("defaults removedAt to NULL", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database);
      const ws = getWorkspace(tempDb.database, "ws-001")!;
      expect(ws["removedAt"]).toBeNull();
    });

    it("accepts READY with removedAt NULL", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      tempDb.database
        .prepare(
          "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws-002", "TASK-001", 1, "/path/a", "branch-a", "commit-a", "READY", now);
      const ws = getWorkspace(tempDb.database, "ws-002")!;
      expect(ws["status"]).toBe("READY");
      expect(ws["removedAt"]).toBeNull();
    });

    it("accepts FAILED with removedAt NULL", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      tempDb.database
        .prepare(
          "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws-003", "TASK-001", 1, "/path/b", "branch-b", "commit-b", "FAILED", now);
      const ws = getWorkspace(tempDb.database, "ws-003")!;
      expect(ws["status"]).toBe("FAILED");
      expect(ws["removedAt"]).toBeNull();
    });

    it("accepts REMOVED with removedAt not null", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      const removedAt = new Date().toISOString();
      tempDb.database
        .prepare(
          "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt, removedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws-004", "TASK-001", 1, "/path/c", "branch-c", "commit-c", "REMOVED", now, removedAt);
      const ws = getWorkspace(tempDb.database, "ws-004")!;
      expect(ws["status"]).toBe("REMOVED");
      expect(ws["removedAt"]).toBe(removedAt);
    });
  });

  describe("executionNumber", () => {
    it("accepts executionNumber 1", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database, { executionNumber: 1 });
      const ws = getWorkspace(tempDb.database, "ws-001")!;
      expect(ws["executionNumber"]).toBe(1);
    });

    it("accepts a larger executionNumber", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database, { executionNumber: 5 });
      const ws = getWorkspace(tempDb.database, "ws-001")!;
      expect(ws["executionNumber"]).toBe(5);
    });

    it("rejects executionNumber 0", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      expect(() => insertWorkspace(tempDb!.database, { executionNumber: 0 })).toThrow();
    });

    it("rejects negative executionNumber", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      expect(() => insertWorkspace(tempDb!.database, { executionNumber: -1 })).toThrow();
    });
  });

  describe("uniqueness", () => {
    it("rejects duplicate id", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database, { id: "ws-dup" });
      expect(() => insertWorkspace(tempDb!.database, { id: "ws-dup" })).toThrow();
    });

    it("rejects duplicate taskId + executionNumber", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database, { taskId: "TASK-001", executionNumber: 1 });
      expect(() =>
        insertWorkspace(tempDb!.database, { id: "ws-other", taskId: "TASK-001", executionNumber: 1 }),
      ).toThrow();
    });

    it("allows two different executionNumbers for the same task", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database, { id: "ws-1", taskId: "TASK-001", executionNumber: 1, workspacePath: "/path/1", branchName: "branch-1" });
      insertWorkspace(tempDb.database, { id: "ws-2", taskId: "TASK-001", executionNumber: 2, workspacePath: "/path/2", branchName: "branch-2" });
      expect(getWorkspace(tempDb.database, "ws-1")).toBeDefined();
      expect(getWorkspace(tempDb.database, "ws-2")).toBeDefined();
    });

    it("allows the same executionNumber for different tasks", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      const task2: Task = {
        id: "TASK-002",
        projectId: "alpha",
        title: "Second task",
        description: "Another",
        state: "CREATED",
        attempt: 0,
        maxAttempts: 2,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: now,
        updatedAt: now,
      };
      createTask(tempDb.database, task2);
      insertWorkspace(tempDb.database, { id: "ws-t1", taskId: "TASK-001", executionNumber: 1, workspacePath: "/path/t1", branchName: "branch-t1" });
      insertWorkspace(tempDb.database, { id: "ws-t2", taskId: "TASK-002", executionNumber: 1, workspacePath: "/path/t2", branchName: "branch-t2" });
      expect(getWorkspace(tempDb.database, "ws-t1")).toBeDefined();
      expect(getWorkspace(tempDb.database, "ws-t2")).toBeDefined();
    });

    it("rejects duplicate workspacePath", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database, { workspacePath: "/same/path" });
      expect(() =>
        insertWorkspace(tempDb!.database, { id: "ws-other", workspacePath: "/same/path" }),
      ).toThrow();
    });

    it("allows repeated branchName in different tasks", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      const task2: Task = {
        id: "TASK-002",
        projectId: "alpha",
        title: "Second task",
        description: "Another",
        state: "CREATED",
        attempt: 0,
        maxAttempts: 2,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: now,
        updatedAt: now,
      };
      createTask(tempDb.database, task2);
      insertWorkspace(tempDb.database, { id: "ws-a", taskId: "TASK-001", executionNumber: 1, workspacePath: "/path/a", branchName: "same-branch" });
      insertWorkspace(tempDb.database, { id: "ws-b", taskId: "TASK-002", executionNumber: 1, workspacePath: "/path/b", branchName: "same-branch" });
      expect(getWorkspace(tempDb.database, "ws-a")).toBeDefined();
      expect(getWorkspace(tempDb.database, "ws-b")).toBeDefined();
    });
  });

  describe("foreign key", () => {
    it("rejects nonexistent taskId", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      expect(() => insertWorkspace(tempDb!.database, { taskId: "NONEXISTENT" })).toThrow();
    });

    it("accepts a valid task", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database);
      expect(getWorkspace(tempDb.database, "ws-001")).toBeDefined();
    });

    it("ON DELETE RESTRICT prevents deleting a task with associated workspace", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database);
      expect(() => {
        tempDb!.database.prepare("DELETE FROM tasks WHERE id = ?").run("TASK-001");
      }).toThrow();
    });
  });

  describe("status", () => {
    it("rejects unknown status", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      expect(() => {
        tempDb!.database
          .prepare(
            "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("ws-bad", "TASK-001", 1, "/bad", "bad-branch", "bad-commit", "INVALID", now);
      }).toThrow();
    });

    it("accepts PREPARING", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database, { id: "ws-prep" });
      expect(getWorkspace(tempDb.database, "ws-prep")!["status"]).toBe("PREPARING");
    });

    it("accepts READY", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      tempDb.database
        .prepare(
          "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws-ready", "TASK-001", 1, "/ready", "ready-branch", "ready-commit", "READY", now);
      expect(getWorkspace(tempDb.database, "ws-ready")!["status"]).toBe("READY");
    });

    it("accepts FAILED", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      tempDb.database
        .prepare(
          "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws-fail", "TASK-001", 1, "/fail", "fail-branch", "fail-commit", "FAILED", now);
      expect(getWorkspace(tempDb.database, "ws-fail")!["status"]).toBe("FAILED");
    });

    it("accepts REMOVED", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      tempDb.database
        .prepare(
          "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt, removedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws-rm", "TASK-001", 1, "/rm", "rm-branch", "rm-commit", "REMOVED", now, now);
      expect(getWorkspace(tempDb.database, "ws-rm")!["status"]).toBe("REMOVED");
    });
  });

  describe("status and removedAt consistency", () => {
    it("rejects REMOVED with removedAt NULL", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      expect(() => {
        tempDb!.database
          .prepare(
            "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("ws-rm-null", "TASK-001", 1, "/rm-null", "rm-null-branch", "rm-null-commit", "REMOVED", now);
      }).toThrow();
    });

    it("rejects PREPARING with removedAt not null", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      expect(() => {
        tempDb!.database
          .prepare(
            "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt, removedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("ws-prep-rm", "TASK-001", 1, "/prep-rm", "prep-rm-branch", "prep-rm-commit", "PREPARING", now, now);
      }).toThrow();
    });

    it("rejects READY with removedAt not null", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      expect(() => {
        tempDb!.database
          .prepare(
            "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt, removedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("ws-ready-rm", "TASK-001", 1, "/ready-rm", "ready-rm-branch", "ready-rm-commit", "READY", now, now);
      }).toThrow();
    });

    it("rejects FAILED with removedAt not null", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      expect(() => {
        tempDb!.database
          .prepare(
            "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt, removedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("ws-fail-rm", "TASK-001", 1, "/fail-rm", "fail-rm-branch", "fail-rm-commit", "FAILED", now, now);
      }).toThrow();
    });

    it("accepts REMOVED with a timestamp", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      const now = new Date().toISOString();
      const removedAt = new Date().toISOString();
      tempDb.database
        .prepare(
          "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt, removedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws-rm-ok", "TASK-001", 1, "/rm-ok", "rm-ok-branch", "rm-ok-commit", "REMOVED", now, removedAt);
      const ws = getWorkspace(tempDb.database, "ws-rm-ok")!;
      expect(ws["status"]).toBe("REMOVED");
      expect(ws["removedAt"]).toBe(removedAt);
    });
  });

  describe("persistence", () => {
    it("workspace persists across close and reopen", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb.database);
      createTestTask(tempDb.database);
      insertWorkspace(tempDb.database);
      const dbPath = tempDb.databasePath;
      tempDb.close();
      const reopened = openDatabase(dbPath);
      initializeSchema(reopened);
      const ws = reopened.prepare("SELECT * FROM task_workspaces WHERE id = ?").get("ws-001") as
        | Record<string, unknown>
        | undefined;
      expect(ws).toBeDefined();
      expect(ws!["taskId"]).toBe("TASK-001");
      expect(ws!["executionNumber"]).toBe(1);
      reopened.close();
      tempDb = null;
    });

    it("has expected indexes", () => {
      tempDb = createTempDatabase();
      const indexes = tempDb.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_workspaces'")
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_task_workspaces_task_id");
      expect(names).toContain("idx_task_workspaces_status");
    });

    it("has no projectId column", () => {
      tempDb = createTempDatabase();
      const columns = tempDb.database.prepare("PRAGMA table_info(task_workspaces)").all() as Array<{
        name: string;
      }>;
      const names = columns.map((c) => c.name);
      expect(names).not.toContain("projectId");
    });

    it("has no attempt column", () => {
      tempDb = createTempDatabase();
      const columns = tempDb.database.prepare("PRAGMA table_info(task_workspaces)").all() as Array<{
        name: string;
      }>;
      const names = columns.map((c) => c.name);
      expect(names).not.toContain("attempt");
    });

    it("has executionNumber column", () => {
      tempDb = createTempDatabase();
      const columns = tempDb.database.prepare("PRAGMA table_info(task_workspaces)").all() as Array<{
        name: string;
      }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain("executionNumber");
    });
  });

  describe("types", () => {
    it("TASK_WORKSPACE_STATUSES contains exactly four values", () => {
      expect(TASK_WORKSPACE_STATUSES).toHaveLength(4);
      expect(TASK_WORKSPACE_STATUSES).toEqual(["PREPARING", "READY", "FAILED", "REMOVED"]);
    });

    it("TaskWorkspaceStatus derives from the tuple", () => {
      const status: TaskWorkspaceStatus = "PREPARING";
      expect(TASK_WORKSPACE_STATUSES).toContain(status);
    });

    it("TaskWorkspace uses executionNumber", () => {
      const workspace: TaskWorkspace = {
        id: "ws-type",
        taskId: "TASK-001",
        executionNumber: 1,
        workspacePath: "/path",
        branchName: "branch",
        baseCommit: "commit",
        status: "PREPARING",
        createdAt: "2025-01-01T00:00:00.000Z",
        removedAt: null,
      };
      expect(workspace.executionNumber).toBe(1);
    });

    it("CreateTaskWorkspaceInput requires id", () => {
      const input: CreateTaskWorkspaceInput = {
        id: "ws-input",
        taskId: "TASK-001",
        executionNumber: 1,
        workspacePath: "/path",
        branchName: "branch",
        baseCommit: "commit",
      };
      expect(input.id).toBe("ws-input");
    });

    it("types do not contain projectId", () => {
      const workspace: TaskWorkspace = {
        id: "ws-check",
        taskId: "TASK-001",
        executionNumber: 1,
        workspacePath: "/path",
        branchName: "branch",
        baseCommit: "commit",
        status: "READY",
        createdAt: "2025-01-01T00:00:00.000Z",
        removedAt: null,
      };
      expect(workspace).not.toHaveProperty("projectId");

      const input: CreateTaskWorkspaceInput = {
        id: "ws-check-input",
        taskId: "TASK-001",
        executionNumber: 1,
        workspacePath: "/path",
        branchName: "branch",
        baseCommit: "commit",
      };
      expect(input).not.toHaveProperty("projectId");
    });
  });
});
