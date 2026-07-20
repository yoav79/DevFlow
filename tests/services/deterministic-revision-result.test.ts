import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

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
  buildDeterministicRevision,
  executeDeterministicRevision,
  DeterministicRevisionError,
  type DeterministicRevisionResult,
  type BuildDeterministicRevisionInput,
  type DeterministicRevisionDeps,
} from "../../src/services/deterministic-revision-result.js";
import type {
  ChangedFile,
  GitChangeDetectionResult,
} from "../../src/services/git-change-detector.js";
import type { PathValidationResult } from "../../src/services/path-validation.js";
import type {
  RequiredCommandsExecutionResult,
  RequiredCommandRuntimeOptions,
} from "../../src/services/required-command-runner.js";
import type { Project, Task, TaskWorkspace } from "../../src/types.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";

function file(
  path: string,
  status: ChangedFile["status"],
): ChangedFile {
  return { path, status };
}

function fileRenamed(
  previousPath: string,
  path: string,
): ChangedFile {
  return { path, status: "RENAMED", previousPath };
}

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
  return createTaskWorkspace(tempDb.database, {
    id: overrides.id ?? "ws-1",
    taskId,
    executionNumber: overrides.executionNumber ?? 1,
    workspacePath: overrides.workspacePath ?? "/home/user/.devflow/worktrees/proj-1/task-1/1",
    branchName: overrides.branchName ?? "devflow/proj-1/task-1/execution-1",
    baseCommit: overrides.baseCommit ?? "abc123",
    ...(overrides.status !== undefined
      ? { status: overrides.status }
      : {}),
  });
}

function createInput(
  overrides: Partial<BuildDeterministicRevisionInput> = {},
): BuildDeterministicRevisionInput {
  return {
    taskId: overrides.taskId ?? "task-1",
    projectId: overrides.projectId ?? "proj-1",
    workspaceId: overrides.workspaceId ?? "ws-1",
    workspacePath: overrides.workspacePath ?? "/workspace/task-1",
    baseCommit: overrides.baseCommit ?? "abc123",
    allowedPaths: overrides.allowedPaths ?? ["src"],
    forbiddenPaths: overrides.forbiddenPaths ?? ["src/api"],
    requiredCommands: overrides.requiredCommands ?? [],
    runtime: overrides.runtime ?? { timeoutMs: 5000 },
  };
}

function createDeps(overrides: {
  gitResult?: GitChangeDetectionResult;
  pathResult?: PathValidationResult;
  commandsResult?: RequiredCommandsExecutionResult;
} = {}): DeterministicRevisionDeps {
  const gitResult: GitChangeDetectionResult = overrides.gitResult ?? {
    baseCommit: "abc123",
    changedFiles: [],
  };

  const pathResult: PathValidationResult = overrides.pathResult ?? {
    passed: true,
    violations: [],
  };

  const commandsResult: RequiredCommandsExecutionResult | undefined =
    overrides.commandsResult;

  return {
    detectChanges: () => gitResult,
    validatePaths: () => pathResult,
    runCommands: commandsResult !== undefined
      ? () => Promise.resolve(commandsResult)
      : undefined,
  };
}

describe("buildDeterministicRevision", () => {
  it("produces REVIEWING with no files and no commands", async () => {
    const deps = createDeps();
    const result = await buildDeterministicRevision(createInput(), deps);

    expect(result.status).toBe("REVIEWING");
    expect(result.changedFiles).toEqual([]);
    expect(result.commandsResult).toBeNull();
  });

  it("produces REVIEWING with files that pass path validation", async () => {
    const gitResult: GitChangeDetectionResult = {
      baseCommit: "abc123",
      changedFiles: [
        file("src/index.ts", "MODIFIED"),
        file("src/utils.ts", "ADDED"),
      ],
    };

    const deps = createDeps({ gitResult });
    const result = await buildDeterministicRevision(
      createInput({ allowedPaths: ["src"], forbiddenPaths: [] }),
      deps,
    );

    expect(result.status).toBe("REVIEWING");
    expect(result.changedFiles).toHaveLength(2);
    expect(result.pathValidation.passed).toBe(true);
  });

  it("produces REVISION_REQUIRED with path violations", async () => {
    const gitResult: GitChangeDetectionResult = {
      baseCommit: "abc123",
      changedFiles: [
        file("src/index.ts", "MODIFIED"),
        file("src/api/secret.ts", "ADDED"),
      ],
    };

    const pathResult: PathValidationResult = {
      passed: false,
      violations: [
        {
          path: "src/api/secret.ts",
          status: "ADDED",
          code: "FORBIDDEN",
          message: 'Path prohibido: src/api/secret.ts coincide con la regla forbidden "src/api".',
        },
      ],
    };

    const deps = createDeps({ gitResult, pathResult });
    const result = await buildDeterministicRevision(
      createInput({ allowedPaths: ["src"], forbiddenPaths: ["src/api"] }),
      deps,
    );

    expect(result.status).toBe("REVISION_REQUIRED");
    expect(result.pathValidation.passed).toBe(false);
    expect(result.pathValidation.violations).toHaveLength(1);
  });

  it("produces REVISION_REQUIRED when commands fail", async () => {
    const commandsResult: RequiredCommandsExecutionResult = {
      results: [
        {
          command: "npm run build",
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "Build failed",
          durationMs: 100,
          timedOut: false,
          aborted: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          passed: false,
        },
      ],
      passed: false,
      stoppedAtIndex: 0,
    };

    const deps = createDeps({ commandsResult });
    const result = await buildDeterministicRevision(
      createInput({ requiredCommands: ["npm run build"] }),
      deps,
    );

    expect(result.status).toBe("REVISION_REQUIRED");
    expect(result.commandsResult!.passed).toBe(false);
    expect(result.commandsResult!.stoppedAtIndex).toBe(0);
  });

  it("produces REVIEWING when commands pass", async () => {
    const commandsResult: RequiredCommandsExecutionResult = {
      results: [
        {
          command: "npm run build",
          exitCode: 0,
          signal: null,
          stdout: "Build succeeded",
          stderr: "",
          durationMs: 100,
          timedOut: false,
          aborted: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          passed: true,
        },
      ],
      passed: true,
      stoppedAtIndex: null,
    };

    const deps = createDeps({ commandsResult });
    const result = await buildDeterministicRevision(
      createInput({ requiredCommands: ["npm run build"] }),
      deps,
    );

    expect(result.status).toBe("REVIEWING");
    expect(result.commandsResult!.passed).toBe(true);
  });

  it("includes baseCommit in result", async () => {
    const gitResult: GitChangeDetectionResult = {
      baseCommit: "def456",
      changedFiles: [],
    };
    const deps = createDeps({ gitResult });
    const result = await buildDeterministicRevision(
      createInput({ baseCommit: "def456" }),
      deps,
    );

    expect(result.baseCommit).toBe("def456");
  });

  it("includes metadata fields", async () => {
    const deps = createDeps();
    const result = await buildDeterministicRevision(
      createInput({
        taskId: "task-abc",
        projectId: "proj-xyz",
        workspaceId: "ws-123",
      }),
      deps,
    );

    expect(result.taskId).toBe("task-abc");
    expect(result.projectId).toBe("proj-xyz");
    expect(result.workspaceId).toBe("ws-123");
    expect(result.generatedAt).toBeDefined();
    expect(new Date(result.generatedAt).getTime()).not.toBeNaN();
  });

  it("throws for empty taskId", async () => {
    await expect(
      buildDeterministicRevision(
        createInput({ taskId: "" }),
        createDeps(),
      ),
    ).rejects.toThrow(DeterministicRevisionError);
  });

  it("throws for empty projectId", async () => {
    await expect(
      buildDeterministicRevision(
        createInput({ projectId: "" }),
        createDeps(),
      ),
    ).rejects.toThrow(DeterministicRevisionError);
  });

  it("throws for empty workspaceId", async () => {
    await expect(
      buildDeterministicRevision(
        createInput({ workspaceId: "" }),
        createDeps(),
      ),
    ).rejects.toThrow(DeterministicRevisionError);
  });

  it("throws for empty workspacePath", async () => {
    await expect(
      buildDeterministicRevision(
        createInput({ workspacePath: "" }),
        createDeps(),
      ),
    ).rejects.toThrow(DeterministicRevisionError);
  });

  it("throws for empty baseCommit", async () => {
    await expect(
      buildDeterministicRevision(
        createInput({ baseCommit: "" }),
        createDeps(),
      ),
    ).rejects.toThrow(DeterministicRevisionError);
  });

  it("commandsResult is null when requiredCommands is empty", async () => {
    const deps = createDeps();
    const result = await buildDeterministicRevision(
      createInput({ requiredCommands: [] }),
      deps,
    );

    expect(result.commandsResult).toBeNull();
  });

  it("renamed file produces violations", async () => {
    const gitResult: GitChangeDetectionResult = {
      baseCommit: "abc123",
      changedFiles: [fileRenamed("src/old.ts", "src/api/new.ts")],
    };

    const pathResult: PathValidationResult = {
      passed: false,
      violations: [
        {
          path: "src/api/new.ts",
          status: "RENAMED",
          code: "FORBIDDEN",
          message: 'Path prohibido: src/api/new.ts coincide con la regla forbidden "src/api".',
          previousPath: "src/old.ts",
        },
      ],
    };

    const deps = createDeps({ gitResult, pathResult });
    const result = await buildDeterministicRevision(
      createInput({ allowedPaths: ["src"], forbiddenPaths: ["src/api"] }),
      deps,
    );

    expect(result.status).toBe("REVISION_REQUIRED");
    expect(result.pathValidation.violations.length).toBeGreaterThanOrEqual(1);
  });

  it("passes requiredCommands to runCommands", async () => {
    let receivedCommands: readonly string[] = [];

    const deps: DeterministicRevisionDeps = {
      detectChanges: () => ({ baseCommit: "abc123", changedFiles: [] }),
      validatePaths: () => ({ passed: true, violations: [] }),
      runCommands: (workspacePath, commands) => {
        receivedCommands = commands;
        return Promise.resolve({
          results: [],
          passed: true,
          stoppedAtIndex: null,
        });
      },
    };

    await buildDeterministicRevision(
      createInput({ requiredCommands: ["npm test", "npm run lint"] }),
      deps,
    );

    expect(receivedCommands).toEqual(["npm test", "npm run lint"]);
  });
});

describe("executeDeterministicRevision", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  it("persists revision and updates task state to REVIEWING", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id);

    const deps = createDeps();
    const result = await executeDeterministicRevision(
      tempDb.database,
      createInput(),
      deps,
    );

    expect(result.status).toBe("REVIEWING");

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("REVIEWING");
    expect(updatedTask!.currentRevisionJson).not.toBeNull();

    const parsed = JSON.parse(updatedTask!.currentRevisionJson!);
    expect(parsed.taskId).toBe(task.id);
    expect(parsed.status).toBe("REVIEWING");
  });

  it("updates task state to REVISION_REQUIRED on path violations", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id);

    const gitResult: GitChangeDetectionResult = {
      baseCommit: "abc123",
      changedFiles: [file("src/api/secret.ts", "ADDED")],
    };

    const pathResult: PathValidationResult = {
      passed: false,
      violations: [
        {
          path: "src/api/secret.ts",
          status: "ADDED",
          code: "FORBIDDEN",
          message: 'Path prohibido: src/api/secret.ts coincide con la regla forbidden "src/api".',
        },
      ],
    };

    const deps = createDeps({ gitResult, pathResult });
    const result = await executeDeterministicRevision(
      tempDb.database,
      createInput({ allowedPaths: ["src"], forbiddenPaths: ["src/api"] }),
      deps,
    );

    expect(result.status).toBe("REVISION_REQUIRED");

    const updatedTask = getTaskById(tempDb.database, task.id);
    expect(updatedTask!.state).toBe("REVISION_REQUIRED");
  });

  it("throws for nonexistent task", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);

    await expect(
      executeDeterministicRevision(
        tempDb.database,
        createInput({ taskId: "nonexistent" }),
        createDeps(),
      ),
    ).rejects.toThrow(DeterministicRevisionError);
  });

  it("throws for task not in VERIFYING state", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    createTestWorkspace(tempDb, task.id);

    await expect(
      executeDeterministicRevision(
        tempDb.database,
        createInput(),
        createDeps(),
      ),
    ).rejects.toThrow(DeterministicRevisionError);
  });

  it("serializes result as JSON to currentRevisionJson", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "VERIFYING" });
    createTestWorkspace(tempDb, task.id);

    await executeDeterministicRevision(
      tempDb.database,
      createInput({ taskId: task.id }),
      createDeps(),
    );

    const updatedTask = getTaskById(tempDb.database, task.id);
    const parsed = JSON.parse(updatedTask!.currentRevisionJson!);

    expect(parsed.taskId).toBe(task.id);
    expect(parsed.projectId).toBe(project.id);
    expect(parsed.baseCommit).toBe("abc123");
    expect(parsed.changedFiles).toEqual([]);
    expect(parsed.pathValidation).toEqual({ passed: true, violations: [] });
    expect(parsed.commandsResult).toBeNull();
    expect(parsed.generatedAt).toBeDefined();
  });

  it("clears previous revisionJson on new execution", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, {
      state: "VERIFYING",
      currentRevisionJson: JSON.stringify({ old: "data" }),
    });
    createTestWorkspace(tempDb, task.id);

    await executeDeterministicRevision(
      tempDb.database,
      createInput({ taskId: task.id }),
      createDeps(),
    );

    const updatedTask = getTaskById(tempDb.database, task.id);
    const parsed = JSON.parse(updatedTask!.currentRevisionJson!);
    expect(parsed.taskId).toBe(task.id);
    expect(parsed).not.toHaveProperty("old");
  });
});
