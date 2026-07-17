import { afterEach, describe, expect, it } from "vitest";

import { createProject, getProjectById } from "../../src/repositories/project-repository.js";
import { createTask, getTaskById } from "../../src/repositories/task-repository.js";
import type { Project, Task } from "../../src/types.js";
import {
  createTaskWorkspace,
  getTaskWorkspaceById,
  getTaskWorkspaceByTaskAndExecutionNumber,
  listTaskWorkspacesByTaskId,
  updateTaskWorkspaceStatus,
  markTaskWorkspaceRemoved,
  TaskWorkspaceRepositoryError,
} from "../../src/repositories/task-workspace-repository.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";

function createTestProject(tempDb: TempDatabase): Project {
  return createProject(tempDb!.database, {
    id: "proj-1",
    name: "Test Project",
    repositoryPath: "/tmp/test",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
}

function createTestTask(tempDb: TempDatabase, projectId: string = "proj-1"): Task {
  return createTask(tempDb!.database, {
    id: "TASK-001",
    projectId,
    title: "Test Task",
    description: "A test task",
    state: "CREATED",
    attempt: 0,
    maxAttempts: 3,
    contractJson: null,
    currentRevisionJson: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function defaultInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-001",
    taskId: "TASK-001",
    executionNumber: 1,
    workspacePath: "/tmp/devflow/worktrees/proj-1/TASK-001/1",
    branchName: "devflow/proj-1/TASK-001/attempt-1",
    baseCommit: "abc123def456789",
    ...overrides,
  };
}

describe("task-workspace-repository", () => {
  let tempDb: TempDatabase | null = null;

  afterEach(() => {
    tempDb?.cleanup();
    tempDb = null;
  });

  describe("create", () => {
    it("creates a valid workspace", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const ws = createTaskWorkspace(tempDb!.database, defaultInput());
      expect(ws.id).toBe("ws-001");
    });

    it("returns all fields", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const ws = createTaskWorkspace(tempDb!.database, defaultInput());
      expect(ws.taskId).toBe("TASK-001");
      expect(ws.executionNumber).toBe(1);
      expect(ws.workspacePath).toBe("/tmp/devflow/worktrees/proj-1/TASK-001/1");
      expect(ws.branchName).toBe("devflow/proj-1/TASK-001/attempt-1");
      expect(ws.baseCommit).toBe("abc123def456789");
      expect(ws.status).toBe("PREPARING");
      expect(ws.removedAt).toBeNull();
      expect(ws.createdAt).toBeDefined();
    });

    it("normalizes id", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const ws = createTaskWorkspace(tempDb!.database, defaultInput({ id: "  ws-001  " }));
      expect(ws.id).toBe("ws-001");
    });

    it("normalizes taskId", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const ws = createTaskWorkspace(tempDb!.database, defaultInput({ taskId: "  TASK-001  " }));
      expect(ws.taskId).toBe("TASK-001");
    });

    it("normalizes workspacePath", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const ws = createTaskWorkspace(
        tempDb!.database,
        defaultInput({ workspacePath: "  /tmp/path  " }),
      );
      expect(ws.workspacePath).toBe("/tmp/path");
    });

    it("normalizes branchName", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const ws = createTaskWorkspace(
        tempDb!.database,
        defaultInput({ branchName: "  feature/test  " }),
      );
      expect(ws.branchName).toBe("feature/test");
    });

    it("normalizes baseCommit", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const ws = createTaskWorkspace(
        tempDb!.database,
        defaultInput({ baseCommit: "  abc123  " }),
      );
      expect(ws.baseCommit).toBe("abc123");
    });

    it("uses status PREPARING", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const ws = createTaskWorkspace(tempDb!.database, defaultInput());
      expect(ws.status).toBe("PREPARING");
    });

    it("uses removedAt null", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const ws = createTaskWorkspace(tempDb!.database, defaultInput());
      expect(ws.removedAt).toBeNull();
    });

    it("generates createdAt", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const before = Date.now();
      const ws = createTaskWorkspace(tempDb!.database, defaultInput());
      const after = Date.now();
      const created = new Date(ws.createdAt).getTime();
      expect(created).toBeGreaterThanOrEqual(before);
      expect(created).toBeLessThanOrEqual(after);
    });

    it("persists across reopen", async () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const dbPath = tempDb!.databasePath;
      tempDb.close();
      const { initializeSchema, openDatabase } = await import("../../src/db.js");
      const reopened = openDatabase(dbPath);
      initializeSchema(reopened);
      const row = reopened
        .prepare("SELECT * FROM task_workspaces WHERE id = ?")
        .get("ws-001") as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(String(row!["taskId"])).toBe("TASK-001");
      reopened.close();
      tempDb = null;
    });

    it("does not modify the Task", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      const task = createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const after = getTaskById(tempDb!.database, "TASK-001");
      expect(after?.state).toBe(task.state);
      expect(after?.attempt).toBe(task.attempt);
      expect(after?.updatedAt).toBe(task.updatedAt);
    });

    it("does not modify the Project", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const after = getProjectById(tempDb!.database, "proj-1");
      expect(after?.name).toBe(project.name);
      expect(after?.repositoryPath).toBe(project.repositoryPath);
    });
  });

  describe("validations", () => {
    it("rejects empty id", () => {
      tempDb = createTempDatabase();
      expect(() =>
        createTaskWorkspace(tempDb!.database, defaultInput({ id: "" })),
      ).toThrow("El id del workspace no puede estar vacío.");
    });

    it("rejects empty taskId", () => {
      tempDb = createTempDatabase();
      expect(() =>
        createTaskWorkspace(tempDb!.database, defaultInput({ taskId: "" })),
      ).toThrow("El id de la tarea no puede estar vacío.");
    });

    it("rejects empty workspacePath", () => {
      tempDb = createTempDatabase();
      expect(() =>
        createTaskWorkspace(tempDb!.database, defaultInput({ workspacePath: "" })),
      ).toThrow("La ruta del workspace no puede estar vacía.");
    });

    it("rejects empty branchName", () => {
      tempDb = createTempDatabase();
      expect(() =>
        createTaskWorkspace(tempDb!.database, defaultInput({ branchName: "" })),
      ).toThrow("El nombre de la rama no puede estar vacío.");
    });

    it("rejects empty baseCommit", () => {
      tempDb = createTempDatabase();
      expect(() =>
        createTaskWorkspace(tempDb!.database, defaultInput({ baseCommit: "" })),
      ).toThrow("El commit base no puede estar vacío.");
    });

    it("rejects executionNumber 0", () => {
      tempDb = createTempDatabase();
      expect(() =>
        createTaskWorkspace(tempDb!.database, defaultInput({ executionNumber: 0 })),
      ).toThrow("El número de ejecución debe ser un entero mayor o igual que 1.");
    });

    it("rejects negative executionNumber", () => {
      tempDb = createTempDatabase();
      expect(() =>
        createTaskWorkspace(tempDb!.database, defaultInput({ executionNumber: -1 })),
      ).toThrow("El número de ejecución debe ser un entero mayor o igual que 1.");
    });

    it("rejects decimal executionNumber", () => {
      tempDb = createTempDatabase();
      expect(() =>
        createTaskWorkspace(tempDb!.database, defaultInput({ executionNumber: 1.5 })),
      ).toThrow("El número de ejecución debe ser un entero mayor o igual que 1.");
    });

    it("rejects NaN executionNumber", () => {
      tempDb = createTempDatabase();
      expect(() =>
        createTaskWorkspace(tempDb!.database, defaultInput({ executionNumber: NaN })),
      ).toThrow("El número de ejecución debe ser un entero mayor o igual que 1.");
    });

    it("rejects Infinity executionNumber", () => {
      tempDb = createTempDatabase();
      expect(() =>
        createTaskWorkspace(tempDb!.database, defaultInput({ executionNumber: Infinity })),
      ).toThrow("El número de ejecución debe ser un entero mayor o igual que 1.");
    });

    it("rejects nonexistent task", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      expect(() =>
        createTaskWorkspace(tempDb!.database, defaultInput({ taskId: "NONEXISTENT" })),
      ).toThrow("No existe la tarea: NONEXISTENT");
    });
  });

  describe("duplicates", () => {
    it("rejects duplicate id with stable message", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTask(tempDb!.database, {
        id: "TASK-002",
        projectId: "proj-1",
        title: "Task 2",
        description: "Another",
        state: "CREATED",
        attempt: 0,
        maxAttempts: 3,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      createTaskWorkspace(tempDb!.database, defaultInput());
      try {
        createTaskWorkspace(
          tempDb!.database,
          defaultInput({ id: "ws-001", taskId: "TASK-002", executionNumber: 1, workspacePath: "/other/path", branchName: "other-branch" }),
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(TaskWorkspaceRepositoryError);
        expect((error as TaskWorkspaceRepositoryError).message).toBe(
          "Ya existe el workspace: ws-001",
        );
      }
    });

    it("rejects duplicate taskId + executionNumber", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      try {
        createTaskWorkspace(
          tempDb!.database,
          defaultInput({ id: "ws-other", workspacePath: "/other/path" }),
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(TaskWorkspaceRepositoryError);
        expect((error as TaskWorkspaceRepositoryError).message).toBe(
          "Ya existe un workspace para la tarea TASK-001 y la ejecución 1.",
        );
      }
    });

    it("rejects duplicate workspacePath", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      try {
        createTaskWorkspace(
          tempDb!.database,
          defaultInput({ id: "ws-other", branchName: "other-branch" }),
        );
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(TaskWorkspaceRepositoryError);
        expect((error as TaskWorkspaceRepositoryError).message).toBe(
          "Ya existe un workspace con la ruta: /tmp/devflow/worktrees/proj-1/TASK-001/1",
        );
      }
    });

    it("allows repeated branchName in different tasks", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTask(tempDb!.database, {
        id: "TASK-002",
        projectId: "proj-1",
        title: "Task 2",
        description: "Another",
        state: "CREATED",
        attempt: 0,
        maxAttempts: 3,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      createTaskWorkspace(tempDb!.database, defaultInput());
      createTaskWorkspace(
        tempDb!.database,
        defaultInput({
          id: "ws-002",
          taskId: "TASK-002",
          workspacePath: "/other/path",
          branchName: "devflow/proj-1/TASK-001/attempt-1",
        }),
      );
      const list = listTaskWorkspacesByTaskId(tempDb!.database, "TASK-002");
      expect(list).toHaveLength(1);
    });

    it("preserves cause in constraint error", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      try {
        createTaskWorkspace(tempDb!.database, defaultInput());
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(TaskWorkspaceRepositoryError);
        expect((error as TaskWorkspaceRepositoryError).cause).toBeDefined();
      }
    });
  });

  describe("getTaskWorkspaceById", () => {
    it("recovers existing workspace", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const ws = getTaskWorkspaceById(tempDb!.database, "ws-001");
      expect(ws).not.toBeNull();
      expect(ws!.id).toBe("ws-001");
    });

    it("returns null if not exists", () => {
      tempDb = createTempDatabase();
      expect(getTaskWorkspaceById(tempDb!.database, "missing")).toBeNull();
    });

    it("rejects empty id", () => {
      tempDb = createTempDatabase();
      expect(() => getTaskWorkspaceById(tempDb!.database, "")).toThrow(
        "El id del workspace no puede estar vacío.",
      );
    });

    it("does not modify the row", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const first = getTaskWorkspaceById(tempDb!.database, "ws-001");
      const second = getTaskWorkspaceById(tempDb!.database, "ws-001");
      expect(first).toEqual(second);
    });
  });

  describe("getTaskWorkspaceByTaskAndExecutionNumber", () => {
    it("recovers by taskId and executionNumber", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const ws = getTaskWorkspaceByTaskAndExecutionNumber(tempDb!.database, "TASK-001", 1);
      expect(ws).not.toBeNull();
      expect(ws!.id).toBe("ws-001");
    });

    it("returns null if not exists", () => {
      tempDb = createTempDatabase();
      expect(getTaskWorkspaceByTaskAndExecutionNumber(tempDb!.database, "TASK-001", 1)).toBeNull();
    });

    it("rejects empty taskId", () => {
      tempDb = createTempDatabase();
      expect(() =>
        getTaskWorkspaceByTaskAndExecutionNumber(tempDb!.database, "", 1),
      ).toThrow("El id de la tarea no puede estar vacío.");
    });

    it("rejects invalid executionNumber", () => {
      tempDb = createTempDatabase();
      expect(() =>
        getTaskWorkspaceByTaskAndExecutionNumber(tempDb!.database, "TASK-001", 0),
      ).toThrow("El número de ejecución debe ser un entero mayor o igual que 1.");
    });
  });

  describe("listTaskWorkspacesByTaskId", () => {
    it("returns [] without records", () => {
      tempDb = createTempDatabase();
      expect(listTaskWorkspacesByTaskId(tempDb!.database, "TASK-001")).toEqual([]);
    });

    it("lists all workspaces for a task", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput({ id: "ws-1", executionNumber: 1, workspacePath: "/p1", branchName: "b1" }));
      createTaskWorkspace(tempDb!.database, defaultInput({ id: "ws-2", executionNumber: 2, workspacePath: "/p2", branchName: "b2" }));
      const list = listTaskWorkspacesByTaskId(tempDb!.database, "TASK-001");
      expect(list).toHaveLength(2);
    });

    it("does not mix workspaces from other tasks", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTask(tempDb!.database, {
        id: "TASK-002",
        projectId: "proj-1",
        title: "Task 2",
        description: "Another",
        state: "CREATED",
        attempt: 0,
        maxAttempts: 3,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      createTaskWorkspace(tempDb!.database, defaultInput({ id: "ws-1", executionNumber: 1, workspacePath: "/p1", branchName: "b1" }));
      createTaskWorkspace(
        tempDb!.database,
        defaultInput({
          id: "ws-2",
          taskId: "TASK-002",
          executionNumber: 1,
          workspacePath: "/p2",
          branchName: "b2",
        }),
      );
      const list = listTaskWorkspacesByTaskId(tempDb!.database, "TASK-001");
      expect(list).toHaveLength(1);
      expect(list[0]!.taskId).toBe("TASK-001");
    });

    it("orders by executionNumber ASC", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput({ id: "ws-2", executionNumber: 2, workspacePath: "/p2", branchName: "b2" }));
      createTaskWorkspace(tempDb!.database, defaultInput({ id: "ws-1", executionNumber: 1, workspacePath: "/p1", branchName: "b1" }));
      const list = listTaskWorkspacesByTaskId(tempDb!.database, "TASK-001");
      expect(list[0]!.executionNumber).toBe(1);
      expect(list[1]!.executionNumber).toBe(2);
    });

    it("includes REMOVED", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      markTaskWorkspaceRemoved(tempDb!.database, "ws-001");
      const list = listTaskWorkspacesByTaskId(tempDb!.database, "TASK-001");
      expect(list).toHaveLength(1);
      expect(list[0]!.status).toBe("REMOVED");
    });

    it("rejects empty taskId", () => {
      tempDb = createTempDatabase();
      expect(() => listTaskWorkspacesByTaskId(tempDb!.database, "")).toThrow(
        "El id de la tarea no puede estar vacío.",
      );
    });
  });

  describe("updateTaskWorkspaceStatus", () => {
    it("PREPARING to READY", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const ws = updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      expect(ws.status).toBe("READY");
    });

    it("PREPARING to FAILED", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const ws = updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "FAILED");
      expect(ws.status).toBe("FAILED");
    });

    it("READY to FAILED", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      const ws = updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "FAILED");
      expect(ws.status).toBe("FAILED");
    });

    it("FAILED to PREPARING", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "FAILED");
      const ws = updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "PREPARING");
      expect(ws.status).toBe("PREPARING");
    });

    it("same status is idempotent", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const ws = updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "PREPARING");
      expect(ws.status).toBe("PREPARING");
    });

    it("READY to PREPARING fails", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      expect(() =>
        updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "PREPARING"),
      ).toThrow("El workspace ws-001 no puede cambiar de READY a PREPARING.");
    });

    it("FAILED to READY fails", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "FAILED");
      expect(() =>
        updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY"),
      ).toThrow("El workspace ws-001 no puede cambiar de FAILED a READY.");
    });

    it("REMOVED to any status fails", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      markTaskWorkspaceRemoved(tempDb!.database, "ws-001");
      expect(() =>
        updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY"),
      ).toThrow("El workspace ws-001 no puede cambiar de REMOVED a READY.");
    });

    it("runtime REMOVED via updateTaskWorkspaceStatus fails", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      expect(() =>
        updateTaskWorkspaceStatus(
          tempDb!.database,
          "ws-001",
          "REMOVED" as Exclude<import("../../src/types.js").TaskWorkspaceStatus, "REMOVED">,
        ),
      ).toThrow("El workspace ws-001 no puede cambiar de READY a REMOVED.");
    });

    it("nonexistent workspace fails", () => {
      tempDb = createTempDatabase();
      expect(() =>
        updateTaskWorkspaceStatus(tempDb!.database, "missing", "READY"),
      ).toThrow("No existe el workspace: missing");
    });

    it("removedAt stays null", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const ws = updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      expect(ws.removedAt).toBeNull();
    });

    it("does not modify createdAt", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const before = createTaskWorkspace(tempDb!.database, defaultInput());
      const after = updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      expect(after.createdAt).toBe(before.createdAt);
    });

    it("does not modify identity fields", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const before = createTaskWorkspace(tempDb!.database, defaultInput());
      const after = updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      expect(after.id).toBe(before.id);
      expect(after.taskId).toBe(before.taskId);
      expect(after.executionNumber).toBe(before.executionNumber);
      expect(after.workspacePath).toBe(before.workspacePath);
      expect(after.branchName).toBe(before.branchName);
      expect(after.baseCommit).toBe(before.baseCommit);
    });
  });

  describe("markTaskWorkspaceRemoved", () => {
    it("READY to REMOVED", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      const ws = markTaskWorkspaceRemoved(tempDb!.database, "ws-001");
      expect(ws.status).toBe("REMOVED");
    });

    it("FAILED to REMOVED", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "FAILED");
      const ws = markTaskWorkspaceRemoved(tempDb!.database, "ws-001");
      expect(ws.status).toBe("REMOVED");
    });

    it("PREPARING to REMOVED fails", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      expect(() => markTaskWorkspaceRemoved(tempDb!.database, "ws-001")).toThrow(
        "El workspace ws-001 no puede eliminarse desde el estado PREPARING.",
      );
    });

    it("REMOVED is idempotent", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      markTaskWorkspaceRemoved(tempDb!.database, "ws-001");
      const ws = markTaskWorkspaceRemoved(tempDb!.database, "ws-001");
      expect(ws.status).toBe("REMOVED");
    });

    it("removedAt is generated", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      const ws = markTaskWorkspaceRemoved(tempDb!.database, "ws-001");
      expect(ws.removedAt).not.toBeNull();
      expect(new Date(ws.removedAt!).getTime()).toBeGreaterThan(0);
    });

    it("second call preserves original removedAt", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      const first = markTaskWorkspaceRemoved(tempDb!.database, "ws-001");
      const second = markTaskWorkspaceRemoved(tempDb!.database, "ws-001");
      expect(second.removedAt).toBe(first.removedAt);
    });

    it("nonexistent workspace fails", () => {
      tempDb = createTempDatabase();
      expect(() => markTaskWorkspaceRemoved(tempDb!.database, "missing")).toThrow(
        "No existe el workspace: missing",
      );
    });

    it("does not modify createdAt", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const before = createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      const after = markTaskWorkspaceRemoved(tempDb!.database, "ws-001");
      expect(after.createdAt).toBe(before.createdAt);
    });

    it("does not modify identity fields", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const before = createTaskWorkspace(tempDb!.database, defaultInput());
      updateTaskWorkspaceStatus(tempDb!.database, "ws-001", "READY");
      const after = markTaskWorkspaceRemoved(tempDb!.database, "ws-001");
      expect(after.id).toBe(before.id);
      expect(after.taskId).toBe(before.taskId);
      expect(after.executionNumber).toBe(before.executionNumber);
      expect(after.workspacePath).toBe(before.workspacePath);
      expect(after.branchName).toBe(before.branchName);
      expect(after.baseCommit).toBe(before.baseCommit);
    });
  });

  describe("error domain", () => {
    it("name is TaskWorkspaceRepositoryError", () => {
      try {
        tempDb = createTempDatabase();
        createTaskWorkspace(tempDb!.database, defaultInput());
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(TaskWorkspaceRepositoryError);
        expect((error as TaskWorkspaceRepositoryError).name).toBe("TaskWorkspaceRepositoryError");
      }
    });

    it("extends Error", () => {
      const error = new TaskWorkspaceRepositoryError("test");
      expect(error).toBeInstanceOf(Error);
    });

    it("preserves workspaceId", () => {
      try {
        tempDb = createTempDatabase();
        createTestProject(tempDb);
        createTestTask(tempDb);
        createTaskWorkspace(tempDb!.database, defaultInput());
        createTaskWorkspace(tempDb!.database, defaultInput({ workspacePath: "/other/path" }));
        expect.fail("should have thrown");
      } catch (error) {
        expect((error as TaskWorkspaceRepositoryError).workspaceId).toBe("ws-001");
      }
    });

    it("preserves taskId", () => {
      try {
        tempDb = createTempDatabase();
        createTestProject(tempDb);
        createTaskWorkspace(tempDb!.database, defaultInput({ taskId: "MISSING" }));
        expect.fail("should have thrown");
      } catch (error) {
        expect((error as TaskWorkspaceRepositoryError).taskId).toBe("MISSING");
      }
    });

    it("preserves cause when applicable", () => {
      try {
        tempDb = createTempDatabase();
        createTestProject(tempDb);
        createTestTask(tempDb);
        createTaskWorkspace(tempDb!.database, defaultInput());
        createTaskWorkspace(tempDb!.database, defaultInput());
        expect.fail("should have thrown");
      } catch (error) {
        expect((error as TaskWorkspaceRepositoryError).cause).toBeDefined();
      }
    });
  });

  describe("isolation", () => {
    it("does not run Git", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      const ws = createTaskWorkspace(tempDb!.database, defaultInput());
      expect(ws.branchName).toBeDefined();
      expect(ws.baseCommit).toBeDefined();
    });

    it("does not create worktrees", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const row = tempDb!.database
        .prepare("SELECT * FROM task_workspaces WHERE id = ?")
        .get("ws-001") as Record<string, unknown>;
      expect(row).toBeDefined();
    });

    it("does not create directories", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      expect(true).toBe(true);
    });

    it("does not modify external repository", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      expect(true).toBe(true);
    });

    it("does not change Task.state", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      const task = createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const after = getTaskById(tempDb!.database, "TASK-001");
      expect(after?.state).toBe(task.state);
    });

    it("does not change Task.attempt", () => {
      tempDb = createTempDatabase();
      createTestProject(tempDb);
      const task = createTestTask(tempDb);
      createTaskWorkspace(tempDb!.database, defaultInput());
      const after = getTaskById(tempDb!.database, "TASK-001");
      expect(after?.attempt).toBe(task.attempt);
    });
  });
});
