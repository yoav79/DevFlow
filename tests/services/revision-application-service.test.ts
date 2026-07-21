import { afterEach, describe, expect, it } from "vitest";

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
  };
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
  });

  it("persists the exact DeterministicRevisionResult to currentRevisionJson", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, {
      state: "VERIFYING",
      currentRevisionJson: JSON.stringify({ old: "data" }),
    });
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

  it("does not persist or transition when buildRevision fails", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, {
      state: "VERIFYING",
      currentRevisionJson: JSON.stringify({ old: "data" }),
    });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    persistContract(tempDb, task.id);

    const error = new Error("build failed");

    await expect(
      executeRevisionForTask(
        tempDb.database,
        task.id,
        { timeoutMs: 5000 },
        {
          buildRevision: () => Promise.reject(error),
        },
      ),
    ).rejects.toBe(error);

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("VERIFYING");
    expect(updatedTask!.currentRevisionJson).toBe(JSON.stringify({ old: "data" }));
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
          beforeRevalidate: () => {
            tempDb.database
              .prepare("UPDATE tasks SET state = ?, updatedAt = ? WHERE id = ?")
              .run("EXECUTING", new Date().toISOString(), task.id);
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

  it("retains the residual risk window after the last revalidation and before updateTaskState", async () => {
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
      {
        buildRevision: (_input: BuildDeterministicRevisionInput) => {
          tempDb.database
            .prepare("UPDATE tasks SET state = ?, updatedAt = ? WHERE id = ?")
            .run("EXECUTING", new Date().toISOString(), task.id);
          return Promise.resolve(result);
        },
      },
    );

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("REVIEWING");
    expect(JSON.parse(updatedTask!.currentRevisionJson!)).toEqual(result);
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
});
