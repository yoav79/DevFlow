import { afterEach, describe, expect, it } from "vitest";

import { initializeSchema, openDatabase } from "../../src/db.js";
import { createProject } from "../../src/repositories/project-repository.js";
import {
  createTask,
  getTaskById,
} from "../../src/repositories/task-repository.js";
import {
  createTaskWorkspace,
  updateTaskWorkspaceStatus,
} from "../../src/repositories/task-workspace-repository.js";
import {
  executeRevisionForTask,
  RevisionApplicationError,
  type RevisionApplicationDeps,
} from "../../src/services/revision-application-service.js";
import type {
  BuildDeterministicRevisionInput,
  DeterministicRevisionResult,
} from "../../src/services/deterministic-revision-result.js";
import type { ExecutableTaskContract, Project, Task, TaskWorkspace } from "../../src/types.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";

const executableContract: ExecutableTaskContract = {
  classification: "EXECUTABLE_TASK",
  summary: "Add login button",
  reasoning: "Clear scope and bounded changes",
  objective: "Add a login button",
  context: "User management page",
  acceptanceCriteria: ["Button renders", "Click opens modal"],
  allowedPaths: ["src/components"],
  forbiddenPaths: ["src/api"],
  requiredCommands: ["npm run build"],
  assumptions: [],
  risks: [],
  openQuestions: [],
};

function createTestProject(tempDb: TempDatabase): Project {
  return createProject(tempDb.database, {
    id: "proj-1",
    name: "Alpha",
    repositoryPath: "/repo/main",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
}

function createTestTask(
  tempDb: TempDatabase,
  projectId: string,
  overrides: Partial<Task> = {},
): Task {
  return createTask(tempDb.database, {
    id: overrides.id ?? "task-1",
    projectId,
    title: overrides.title ?? "Test Task",
    description: overrides.description ?? "A test task",
    state: overrides.state ?? "VERIFYING",
    attempt: overrides.attempt ?? 1,
    maxAttempts: overrides.maxAttempts ?? 3,
    contractJson: overrides.contractJson ?? null,
    currentRevisionJson: overrides.currentRevisionJson ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  });
}

function createTestWorkspace(
  tempDb: TempDatabase,
  taskId: string,
  overrides: Partial<TaskWorkspace> = {},
): TaskWorkspace {
  const workspace = createTaskWorkspace(tempDb.database, {
    id: overrides.id ?? "ws-1",
    taskId,
    executionNumber: overrides.executionNumber ?? 1,
    workspacePath: overrides.workspacePath ?? "/home/user/.devflow/worktrees/proj-1/task-1/1",
    branchName: overrides.branchName ?? "devflow/proj-1/task-1/execution-1",
    baseCommit: overrides.baseCommit ?? "abc123",
  });

  if (overrides.status !== undefined && overrides.status !== "PREPARING") {
    return updateTaskWorkspaceStatus(tempDb.database, workspace.id, overrides.status);
  }

  return workspace;
}

function persistContract(tempDb: TempDatabase, taskId: string): void {
  tempDb.database
    .prepare("UPDATE tasks SET contractJson = ? WHERE id = ?")
    .run(JSON.stringify(executableContract), taskId);
}

function createSuccessfulResult(taskId: string): DeterministicRevisionResult {
  return {
    taskId,
    projectId: "proj-1",
    workspaceId: "ws-1",
    baseCommit: "abc123",
    changedFiles: [],
    pathValidation: { passed: true, violations: [] },
    commandsResult: null,
    status: "REVIEWING",
    generatedAt: new Date().toISOString(),
  };
}

function createFailingResult(taskId: string): DeterministicRevisionResult {
  return {
    taskId,
    projectId: "proj-1",
    workspaceId: "ws-1",
    baseCommit: "abc123",
    changedFiles: [],
    pathValidation: {
      passed: false,
      violations: [
        {
          path: "src/api/secret.ts",
          status: "ADDED",
          code: "FORBIDDEN",
          message: "Path forbidden",
        },
      ],
    },
    commandsResult: null,
    status: "REVISION_REQUIRED",
    generatedAt: new Date().toISOString(),
  };
}

function createDeps(
  result: DeterministicRevisionResult,
): RevisionApplicationDeps {
  return {
    buildRevision: (_input) => Promise.resolve(result),
    createClaimId: () => "test-claim-id",
    now: () => "2026-07-20T12:00:00.000Z",
  };
}

function readTaskRow(tempDb: TempDatabase, taskId: string): Record<string, unknown> {
  return tempDb.database
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as Record<string, unknown>;
}

describe("executeRevisionForTask", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  it("loads workspace and contract from database", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    const workspace = createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    let receivedInput: unknown = null;

    const deps: RevisionApplicationDeps = {
      createClaimId: () => "test-claim-id",
      now: () => "2026-07-20T12:00:00.000Z",
      buildRevision: (input) => {
        receivedInput = input;
        return Promise.resolve(createSuccessfulResult(task.id));
      },
    };

    await executeRevisionForTask(
      tempDb.database,
      task.id,
      { timeoutMs: 5000 },
      deps,
    );

    expect(receivedInput).toBeDefined();
    const input = receivedInput as {
      taskId: string;
      projectId: string;
      workspaceId: string;
      workspacePath: string;
      baseCommit: string;
      allowedPaths: readonly string[];
      forbiddenPaths: readonly string[];
      requiredCommands: readonly string[];
    };

    expect(input.taskId).toBe(task.id);
    expect(input.projectId).toBe(project.id);
    expect(input.workspaceId).toBe(workspace.id);
    expect(input.workspacePath).toBe(workspace.workspacePath);
    expect(input.baseCommit).toBe(workspace.baseCommit);
    expect(input.allowedPaths).toEqual(["src/components"]);
    expect(input.forbiddenPaths).toEqual(["src/api"]);
    expect(input.requiredCommands).toEqual(["npm run build"]);
  });

  it("returns the revision result", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const expectedResult = createSuccessfulResult(task.id);
    const deps = createDeps(expectedResult);

    const result = await executeRevisionForTask(
      tempDb.database,
      task.id,
      { timeoutMs: 5000 },
      deps,
    );

    expect(result.taskId).toBe(task.id);
    expect(result.projectId).toBe(project.id);
    expect(result.workspaceId).toBe("ws-1");
    expect(result.result).toBe(expectedResult);
  });

  it("persists revision and updates task state on success", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const mockResult = createSuccessfulResult(task.id);

    await executeRevisionForTask(
      tempDb.database,
      task.id,
      { timeoutMs: 5000 },
      createDeps(mockResult),
    );

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("REVIEWING");
    expect(updatedTask!.currentRevisionJson).not.toBeNull();
    const persisted = JSON.parse(updatedTask!.currentRevisionJson!);
    expect(persisted.taskId).toBe(task.id);
    expect(persisted.status).toBe("REVIEWING");
  });

  it("persists revision and updates task state on failure", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const mockResult = createFailingResult(task.id);

    await executeRevisionForTask(
      tempDb.database,
      task.id,
      { timeoutMs: 5000 },
      createDeps(mockResult),
    );

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("REVISION_REQUIRED");
    expect(updatedTask!.currentRevisionJson).not.toBeNull();
    const persisted = JSON.parse(updatedTask!.currentRevisionJson!);
    expect(persisted.status).toBe("REVISION_REQUIRED");
  });

  it("persists the exact DeterministicRevisionResult to currentRevisionJson", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const result = createFailingResult(task.id);

    await executeRevisionForTask(
      tempDb.database,
      task.id,
      { timeoutMs: 5000 },
      createDeps(result),
    );

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(JSON.parse(updatedTask!.currentRevisionJson!)).toEqual(result);
  });

  it("throws for nonexistent task", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);

    await expect(
      executeRevisionForTask(
        tempDb.database,
        "nonexistent",
        { timeoutMs: 5000 },
        createDeps(createSuccessfulResult("nonexistent")),
      ),
    ).rejects.toThrow(RevisionApplicationError);
  });

  it("throws for task not in VERIFYING state", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    createTestWorkspace(tempDb, task.id);
    persistContract(tempDb, task.id);

    await expect(
      executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        createDeps(createSuccessfulResult(task.id)),
      ),
    ).rejects.toThrow(RevisionApplicationError);
  });

  it("throws for task without contract", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id);

    await expect(
      executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        createDeps(createSuccessfulResult(task.id)),
      ),
    ).rejects.toThrow(RevisionApplicationError);
  });

  it("throws for task without workspace", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    persistContract(tempDb, task.id);

    await expect(
      executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        createDeps(createSuccessfulResult(task.id)),
      ),
    ).rejects.toThrow(RevisionApplicationError);
  });

  it("throws for task with multiple READY workspaces", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { id: "ws-1", status: "READY" });
    createTestWorkspace(tempDb, task.id, {
      id: "ws-2",
      executionNumber: 2,
      workspacePath: "/home/user/.devflow/worktrees/proj-1/task-1/2",
      branchName: "devflow/proj-1/task-1/execution-2",
      status: "READY",
    });
    persistContract(tempDb, task.id);

    await expect(
      executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        createDeps(createSuccessfulResult(task.id)),
      ),
    ).rejects.toThrow(RevisionApplicationError);
  });

  it("claim remains persisted when buildRevision fails", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const error = new Error("build failed");

    await expect(
      executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        {
          createClaimId: () => "orphan-claim",
          now: () => "2026-07-20T12:00:00.000Z",
          buildRevision: () => Promise.reject(error),
        },
      ),
    ).rejects.toBe(error);

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("VERIFYING");
    expect(updatedTask!.currentRevisionJson).not.toBeNull();
    const claim = JSON.parse(updatedTask!.currentRevisionJson!);
    expect(claim.kind).toBe("DETERMINISTIC_REVISION_CLAIM");
    expect(claim.claimId).toBe("orphan-claim");
  });

  it("throws REVISION_PERSIST_FAILED when JSON.stringify(result) fails and claim persists", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const serializationError = new Error("toJSON exploded");
    let builderCalled = false;

    const result = createSuccessfulResult(task.id);
    Object.defineProperty(result, "toJSON", {
      value() {
        throw serializationError;
      },
    });

    try {
      await executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        {
          createClaimId: () => "serial-fail-claim",
          now: () => "2026-07-20T12:00:00.000Z",
          buildRevision: () => {
            builderCalled = true;
            return Promise.resolve(result);
          },
        },
      );
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RevisionApplicationError);
      expect((error as RevisionApplicationError).code).toBe("REVISION_PERSIST_FAILED");
      expect((error as RevisionApplicationError).cause).toBe(serializationError);
    }

    expect(builderCalled).toBe(true);

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("VERIFYING");
    expect(updatedTask!.currentRevisionJson).not.toBeNull();
    const claim = JSON.parse(updatedTask!.currentRevisionJson!);
    expect(claim.kind).toBe("DETERMINISTIC_REVISION_CLAIM");
    expect(claim.taskId).toBe(task.id);
    expect(claim.claimId).toBe("serial-fail-claim");
    expect(claim.claimedAt).toBe("2026-07-20T12:00:00.000Z");
  });

  it("revalidates VERIFYING after loading context and aborts concurrent state changes before build", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    let buildCalled = false;

    await expect(
      executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        {
          createClaimId: () => "test-claim",
          now: () => "2026-07-20T12:00:00.000Z",
          beforeRevalidate: () => {
            tempDb.database
              .prepare("UPDATE tasks SET state = ?, updatedAt = ? WHERE id = ?")
              .run("EXECUTING", "2026-07-20T12:00:00.000Z", task.id);
          },
          buildRevision: () => {
            buildCalled = true;
            return Promise.resolve(createSuccessfulResult(task.id));
          },
        },
      ),
    ).rejects.toThrow(RevisionApplicationError);

    expect(buildCalled).toBe(false);
    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("EXECUTING");
    expect(updatedTask!.currentRevisionJson).toBeNull();
  });

  it("returns error when state changes during build and finalize fails", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const result = createSuccessfulResult(task.id);

    await expect(
      executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        {
          createClaimId: () => "test-claim",
          now: () => "2026-07-20T12:00:00.000Z",
          buildRevision: (_input: BuildDeterministicRevisionInput) => {
            tempDb.database
              .prepare("UPDATE tasks SET state = ?, updatedAt = ? WHERE id = ?")
              .run("EXECUTING", "2026-07-20T12:00:00.000Z", task.id);
            return Promise.resolve(result);
          },
        },
      ),
    ).rejects.toThrow(RevisionApplicationError);

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("EXECUTING");
  });

  it("throws for empty taskId", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);

    await expect(
      executeRevisionForTask(
        tempDb.database,
        "",
        { timeoutMs: 5000 },
        createDeps(createSuccessfulResult("")),
      ),
    ).rejects.toThrow(RevisionApplicationError);
  });

  it("throws REVISION_ALREADY_RUNNING when claim fails", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const secondDb = openDatabase(tempDb.databasePath);
    initializeSchema(secondDb);

    try {
      let hookRan = false;

      await expect(
        executeRevisionForTask(
          tempDb.database,
          task.id,
          { timeoutMs: 5000 },
          {
            createClaimId: () => "new-claim",
            now: () => "2026-07-20T12:00:00.000Z",
            buildRevision: () => Promise.resolve(createSuccessfulResult(task.id)),
            beforeRevalidate: () => {
              hookRan = true;
              secondDb
                .prepare("UPDATE tasks SET currentRevisionJson = ?, updatedAt = ? WHERE id = ?")
                .run(JSON.stringify({ stolen: true }), "2026-07-20T12:00:01.000Z", task.id);
            },
          },
        ),
      ).rejects.toThrow(RevisionApplicationError);

      expect(hookRan).toBe(true);
      const row = readTaskRow(tempDb, task.id);
      expect(String(row["currentRevisionJson"])).toBe(JSON.stringify({ stolen: true }));
    } finally {
      secondDb.close();
    }
  });

  it("uses exact same claimJson in claim and finalize", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const result = createSuccessfulResult(task.id);
    let capturedClaimJson: string | null = null;

    await executeRevisionForTask(
      tempDb.database,
      task.id,
      { timeoutMs: 5000 },
      {
        createClaimId: () => "exact-claim",
        now: () => "2026-07-20T12:00:00.000Z",
        buildRevision: () => {
          const row = readTaskRow(tempDb, task.id);
          capturedClaimJson = String(row["currentRevisionJson"]);
          return Promise.resolve(result);
        },
      },
    );

    const updatedTask = getTaskById(tempDb.database, task.id);
    const finalJson = JSON.parse(updatedTask!.currentRevisionJson!);
    expect(finalJson.taskId).toBe(task.id);
    expect(finalJson.status).toBe("REVIEWING");
    expect(capturedClaimJson).not.toBeNull();
    const claim = JSON.parse(capturedClaimJson!);
    expect(claim.kind).toBe("DETERMINISTIC_REVISION_CLAIM");
    expect(claim.claimId).toBe("exact-claim");
  });

  it("calls claim before builder and builder before finalize", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const order: string[] = [];

    await executeRevisionForTask(
      tempDb.database,
      task.id,
      { timeoutMs: 5000 },
      {
        createClaimId: () => "order-claim",
        now: () => "2026-07-20T12:00:00.000Z",
        buildRevision: () => {
          const row = readTaskRow(tempDb, task.id);
          const val = row["currentRevisionJson"];
          if (val !== null && typeof val === "string" && val.includes("DETERMINISTIC_REVISION_CLAIM")) {
            order.push("claim");
          }
          order.push("builder");
          return Promise.resolve(createSuccessfulResult(task.id));
        },
      },
    );

    order.push("finalize");
    expect(order).toEqual(["claim", "builder", "finalize"]);
  });

  it("only one of two concurrent callers acquires claim", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const secondDb = openDatabase(tempDb.databasePath);

    try {
      let builderACalled = false;
      let builderBCalled = false;
      let p2Started = false;

      let resolveBuilderA: (() => void) | null = null;
      const builderAPromise = new Promise<DeterministicRevisionResult>((resolve) => {
        resolveBuilderA = () => resolve(createSuccessfulResult(task.id));
      });

      const p1 = executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        {
          createClaimId: () => "claim-a",
          now: () => "2026-07-20T12:00:00.000Z",
          buildRevision: () => {
            builderACalled = true;
            return builderAPromise;
          },
        },
      );

      await new Promise((r) => setTimeout(r, 20));

      const p2 = executeRevisionForTask(
        secondDb,
        task.id,
        { timeoutMs: 5000 },
        {
          createClaimId: () => "claim-b",
          now: () => "2026-07-20T12:00:01.000Z",
          beforeRevalidate: () => {
            p2Started = true;
          },
          buildRevision: () => {
            builderBCalled = true;
            return Promise.resolve(createSuccessfulResult(task.id));
          },
        },
      );

      resolveBuilderA!();

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedError).toBeInstanceOf(RevisionApplicationError);

      expect(builderACalled).toBe(true);

      const finalTask = getTaskById(tempDb.database, task.id);
      expect(finalTask!.state).toBe("REVIEWING");
    } finally {
      secondDb.close();
    }
  });

  it("throws REVISION_CONCURRENTLY_CHANGED when ownership is lost during build", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const secondDb = openDatabase(tempDb.databasePath);
    initializeSchema(secondDb);

    try {
      let resolveBuilder: (() => void) | null = null;
      const builderPromise = new Promise<DeterministicRevisionResult>((resolve) => {
        resolveBuilder = () => resolve(createSuccessfulResult(task.id));
      });

      const p1 = executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        {
          createClaimId: () => "claim-build",
          now: () => "2026-07-20T12:00:00.000Z",
          buildRevision: () => builderPromise,
        },
      );

      await new Promise((r) => setTimeout(r, 20));

      secondDb
        .prepare("UPDATE tasks SET currentRevisionJson = ?, updatedAt = ? WHERE id = ?")
        .run(JSON.stringify({ stolen: true }), "2026-07-20T12:00:01.000Z", task.id);

      resolveBuilder!();

      await expect(p1).rejects.toThrow(RevisionApplicationError);

      try {
        await p1;
      } catch (error) {
        expect((error as RevisionApplicationError).code).toBe("REVISION_CONCURRENTLY_CHANGED");
      }

      const finalTask = getTaskById(tempDb.database, task.id);
      expect(finalTask!.currentRevisionJson).toBe(JSON.stringify({ stolen: true }));
    } finally {
      secondDb.close();
    }
  });

  it("throws REVISION_CONCURRENTLY_CHANGED when task is deleted during build", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const secondDb = openDatabase(tempDb.databasePath);
    initializeSchema(secondDb);
    secondDb.exec("PRAGMA foreign_keys = OFF;");

    try {
      let resolveBuilder: (() => void) | null = null;
      const builderPromise = new Promise<DeterministicRevisionResult>((resolve) => {
        resolveBuilder = () => resolve(createSuccessfulResult(task.id));
      });

      const p1 = executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        {
          createClaimId: () => "claim-delete",
          now: () => "2026-07-20T12:00:00.000Z",
          buildRevision: () => builderPromise,
        },
      );

      await new Promise((r) => setTimeout(r, 20));

      secondDb.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);

      resolveBuilder!();

      await expect(p1).rejects.toThrow(RevisionApplicationError);

      try {
        await p1;
      } catch (error) {
        expect((error as RevisionApplicationError).code).toBe("REVISION_CONCURRENTLY_CHANGED");
      }
    } finally {
      secondDb.close();
    }
  });

  it("finalizes with REVIEWING on success", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const result = createSuccessfulResult(task.id);

    await executeRevisionForTask(
      tempDb.database,
      task.id,
      { timeoutMs: 5000 },
      createDeps(result),
    );

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("REVIEWING");
    const persisted = JSON.parse(updatedTask!.currentRevisionJson!);
    expect(persisted.status).toBe("REVIEWING");
    expect(persisted.taskId).toBe(task.id);
  });

  it("finalizes with REVISION_REQUIRED on failure", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const result = createFailingResult(task.id);

    await executeRevisionForTask(
      tempDb.database,
      task.id,
      { timeoutMs: 5000 },
      createDeps(result),
    );

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("REVISION_REQUIRED");
    const persisted = JSON.parse(updatedTask!.currentRevisionJson!);
    expect(persisted.status).toBe("REVISION_REQUIRED");
    expect(persisted.taskId).toBe(task.id);
  });
});
