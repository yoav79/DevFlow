import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDeterministicRevision,
  DeterministicRevisionError,
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
} from "../../src/services/required-command-runner.js";

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

afterEach(() => {
  vi.useRealTimers();
});

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
  it("serializes as exact JSON round-trip", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));

    const result = await buildDeterministicRevision(createInput(), createDeps());

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("is deterministic with fixed time and deterministic deps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));

    const deps = createDeps({
      gitResult: {
        baseCommit: "abc123",
        changedFiles: [file("src/index.ts", "MODIFIED")],
      },
    });

    const first = await buildDeterministicRevision(createInput(), deps);
    const second = await buildDeterministicRevision(createInput(), deps);

    expect(first).toEqual(second);
  });

  it("does not mutate input arrays", async () => {
    const allowedPaths = ["src"];
    const forbiddenPaths = ["src/api"];
    const requiredCommands = ["npm test"];

    await buildDeterministicRevision(
      createInput({ allowedPaths, forbiddenPaths, requiredCommands }),
      createDeps({
        commandsResult: {
          results: [],
          passed: true,
          stoppedAtIndex: null,
        },
      }),
    );

    expect(allowedPaths).toEqual(["src"]);
    expect(forbiddenPaths).toEqual(["src/api"]);
    expect(requiredCommands).toEqual(["npm test"]);
  });
});
