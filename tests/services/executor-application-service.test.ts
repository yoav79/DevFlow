import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { createProject } from "../../src/repositories/project-repository.js";
import { createTask, getTaskById } from "../../src/repositories/task-repository.js";
import {
  createTaskWorkspace,
  updateTaskWorkspaceStatus,
} from "../../src/repositories/task-workspace-repository.js";
import {
  executeExecutorForTask,
  type ExecutorApplicationDeps,
} from "../../src/services/executor-application-service.js";
import {
  runExecutorWithOpenCode,
  type ExecutorRuntimeOptions,
} from "../../src/services/executor-opencode-executor.js";
import type { ExecutorPromptInput } from "../../src/services/executor-prompt-builder.js";
import type { ExecutorOpenCodeInterpretation } from "../../src/services/executor-opencode-integration.js";
import type { AgentEnvelope, ExecutableTaskContract, Project, Task, TaskWorkspace } from "../../src/types.js";
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

const completedEnvelope: AgentEnvelope = {
  protocolVersion: 1,
  role: "executor",
  status: "COMPLETED",
  summary: "Implemented login button",
  questions: [],
  risks: [],
  payload: { filesClaimed: ["src/components/LoginButton.tsx"], commandsClaimed: ["npm run build"] },
};

const needsInputEnvelope: AgentEnvelope = {
  protocolVersion: 1,
  role: "executor",
  status: "NEEDS_INPUT",
  summary: "Need clarification on auth provider",
  questions: ["Which auth provider?"],
  risks: [],
  payload: { filesClaimed: [], commandsClaimed: [] },
};

function createRuntime(overrides: Partial<ExecutorRuntimeOptions> = {}): ExecutorRuntimeOptions {
  return {
    timeoutMs: 5000,
    ...overrides,
  };
}

function createInterpretation(
  envelope: AgentEnvelope = completedEnvelope,
  overrides: Partial<ExecutorOpenCodeInterpretation> = {},
): ExecutorOpenCodeInterpretation {
  return {
    sessionID: "sess-1",
    messageID: "msg-1",
    envelope,
    executorPayload: envelope.payload as { filesClaimed: readonly string[]; commandsClaimed: readonly string[] },
    ...overrides,
  };
}

function createTestProject(tempDb: TempDatabase, overrides: Partial<Project> = {}): Project {
  return createProject(tempDb.database, {
    id: overrides.id ?? "proj-1",
    name: overrides.name ?? "Alpha",
    repositoryPath: overrides.repositoryPath ?? "/repo/main",
    defaultBranch: overrides.defaultBranch ?? "main",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
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
    state: overrides.state ?? "CREATED",
    attempt: overrides.attempt ?? 0,
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

describe("executeExecutorForTask", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  it("builds ExecutorPromptInput with project, task, contract and workspace", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb, { name: "Alpha" });
    const task = createTestTask(tempDb, project.id, {
      title: "Implement feature",
      description: "Build the first slice",
      state: "EXECUTING",
      attempt: 1,
    });
    persistContract(tempDb, task.id);
    const workspace = createTestWorkspace(tempDb, task.id, {
      workspacePath: "/workspaces/proj-1/task-1/2",
      branchName: "devflow/proj-1/task-1/execution-2",
      baseCommit: "def456",
      executionNumber: 2,
      status: "READY",
    });

    let capturedInput: ExecutorPromptInput | null = null;
    const deps: ExecutorApplicationDeps = {
      runExecutor: async (input) => {
        capturedInput = input;
        return createInterpretation();
      },
    };

    await executeExecutorForTask(tempDb.database, task.id, createRuntime(), deps);

    expect(capturedInput).not.toBeNull();
    expect(capturedInput).toEqual({
      project: { name: "Alpha" },
      task: {
        id: task.id,
        title: "Implement feature",
        description: "Build the first slice",
      },
      contract: {
        objective: executableContract.objective,
        context: executableContract.context,
        acceptanceCriteria: executableContract.acceptanceCriteria,
        allowedPaths: executableContract.allowedPaths,
        forbiddenPaths: executableContract.forbiddenPaths,
        requiredCommands: executableContract.requiredCommands,
        assumptions: executableContract.assumptions,
        risks: executableContract.risks,
      },
      workspace: {
        workspacePath: "/workspaces/proj-1/task-1/2",
        branchName: "devflow/proj-1/task-1/execution-2",
        baseCommit: "def456",
        executionNumber: 2,
      },
    });
  });

  it("propagates runtime exactly", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    const controller = new AbortController();
    let capturedRuntime: ExecutorRuntimeOptions | null = null;

    await executeExecutorForTask(
      tempDb.database,
      task.id,
      createRuntime({
        timeoutMs: 9876,
        agent: "executor",
        model: "gpt-5.4-mini",
        binaryPath: "/bin/opencode",
        signal: controller.signal,
      }),
      {
        runExecutor: async (_input, runtime) => {
          capturedRuntime = runtime;
          return createInterpretation();
        },
      },
    );

    expect(capturedRuntime).toEqual({
      timeoutMs: 9876,
      agent: "executor",
      model: "gpt-5.4-mini",
      binaryPath: "/bin/opencode",
      signal: controller.signal,
    });
  });

  it("transitions task to VERIFYING and returns interpretation metadata", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    const interpretation = createInterpretation(completedEnvelope, {
      sessionID: "sess-exec",
      messageID: "msg-exec",
    });

    const result = await executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
      runExecutor: async () => interpretation,
    });

    expect(result.taskId).toBe(task.id);
    expect(result.projectId).toBe(project.id);
    expect(result.workspaceId).toBe("ws-1");
    expect(result.workspacePath).toBe("/home/user/.devflow/worktrees/proj-1/task-1/1");
    expect(result.branchName).toBe("devflow/proj-1/task-1/execution-1");
    expect(result.executionNumber).toBe(1);
    expect(result.interpretation).toBe(interpretation);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("VERIFYING");
  });

  it("transitions to VERIFYING even when executor status is NEEDS_INPUT", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    const interpretation = createInterpretation(needsInputEnvelope);

    const result = await executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
      runExecutor: async () => interpretation,
    });

    expect(result.interpretation.envelope.status).toBe("NEEDS_INPUT");
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("VERIFYING");
  });

  it("rejects empty taskId before running the executor", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    let called = false;

    await expect(
      executeExecutorForTask(tempDb.database, "   ", createRuntime(), {
        runExecutor: async () => {
          called = true;
          return createInterpretation();
        },
      }),
    ).rejects.toThrow("El id de la tarea no puede estar vacío.");

    expect(called).toBe(false);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("EXECUTING");
  });

  it("rejects nonexistent task before running the executor", async () => {
    tempDb = createTempDatabase();
    let called = false;

    await expect(
      executeExecutorForTask(tempDb.database, "missing", createRuntime(), {
        runExecutor: async () => {
          called = true;
          return createInterpretation();
        },
      }),
    ).rejects.toThrow("No existe la tarea: missing");

    expect(called).toBe(false);
  });

  it("rejects missing project before running the executor", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb, { id: "missing-project" });
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    tempDb.database.exec("PRAGMA foreign_keys = OFF;");
    tempDb.database.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    tempDb.database.exec("PRAGMA foreign_keys = ON;");
    let called = false;

    await expect(
      executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
        runExecutor: async () => {
          called = true;
          return createInterpretation();
        },
      }),
    ).rejects.toThrow(`No existe el proyecto: ${project.id}`);

    expect(called).toBe(false);
  });

  it("rejects task without persisted contract", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    let called = false;

    await expect(
      executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
        runExecutor: async () => {
          called = true;
          return createInterpretation();
        },
      }),
    ).rejects.toThrow(`La tarea ${task.id} no tiene un contrato persistido.`);

    expect(called).toBe(false);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("EXECUTING");
  });

  it("rejects states different from EXECUTING before running the executor", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "PREPARING_WORKSPACE" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    let called = false;

    await expect(
      executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
        runExecutor: async () => {
          called = true;
          return createInterpretation();
        },
      }),
    ).rejects.toThrow(`La tarea ${task.id} no puede ejecutar el executor desde el estado PREPARING_WORKSPACE.`);

    expect(called).toBe(false);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("PREPARING_WORKSPACE");
  });

  it("rejects task without any READY workspace", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "PREPARING" });
    let called = false;

    await expect(
      executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
        runExecutor: async () => {
          called = true;
          return createInterpretation();
        },
      }),
    ).rejects.toThrow(`La tarea ${task.id} no tiene un workspace listo para ejecutar.`);

    expect(called).toBe(false);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("EXECUTING");
  });

  it("propagates runExecutor errors without wrapping", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    const error = new RangeError("runner failed");

    await expect(
      executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
        runExecutor: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);

    expect(getTaskById(tempDb.database, task.id)?.state).toBe("EXECUTING");
  });

  it("calls runExecutor exactly once on success", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    let runCount = 0;

    const result = await executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
      runExecutor: async () => {
        runCount += 1;
        return createInterpretation();
      },
    });

    expect(runCount).toBe(1);
    expect(result.interpretation.envelope.status).toBe("COMPLETED");
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("VERIFYING");
  });

  it("passes the exact interpretation instance from runExecutor to result", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    const interpretation = createInterpretation(completedEnvelope, {
      sessionID: "sess-unique",
      messageID: "msg-unique",
    });

    const result = await executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
      runExecutor: async () => interpretation,
    });

    expect(result.interpretation).toBe(interpretation);
    expect(result.interpretation.sessionID).toBe("sess-unique");
    expect(result.interpretation.messageID).toBe("msg-unique");
  });

  it("returns workspace details from the READY workspace", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, {
      id: "ws-custom",
      workspacePath: "/custom/path",
      branchName: "custom/branch",
      baseCommit: "custom-commit",
      executionNumber: 3,
      status: "READY",
    });

    const result = await executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
      runExecutor: async () => createInterpretation(),
    });

    expect(result.workspaceId).toBe("ws-custom");
    expect(result.workspacePath).toBe("/custom/path");
    expect(result.branchName).toBe("custom/branch");
    expect(result.executionNumber).toBe(3);
  });

  it("uses workspace workspacePath as cwd for the executor", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, {
      workspacePath: "/my/special/workspace",
      status: "READY",
    });
    let capturedCwd: string | null = null;

    await executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
      runExecutor: async (input) => {
        capturedCwd = input.workspace.workspacePath;
        return createInterpretation();
      },
    });

    expect(capturedCwd).toBe("/my/special/workspace");
  });

  it("transitions EXECUTING to VERIFYING for BLOCKED status without creating human requests", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    const blockedEnvelope: AgentEnvelope = {
      protocolVersion: 1,
      role: "executor",
      status: "BLOCKED",
      summary: "Cannot proceed: missing dependency",
      questions: [],
      risks: ["Dependency X is unavailable"],
      payload: { filesClaimed: [], commandsClaimed: [] },
    };
    const interpretation = createInterpretation(blockedEnvelope);

    const result = await executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
      runExecutor: async () => interpretation,
    });

    expect(result.interpretation.envelope.status).toBe("BLOCKED");
    expect(result.interpretation.envelope.risks).toEqual(["Dependency X is unavailable"]);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("VERIFYING");
  });

  it("transitions EXECUTING to VERIFYING for FAILED status without treating it as application rejection", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    const failedEnvelope: AgentEnvelope = {
      protocolVersion: 1,
      role: "executor",
      status: "FAILED",
      summary: "Build failed due to type errors",
      questions: [],
      risks: [],
      payload: { filesClaimed: [], commandsClaimed: [] },
    };
    const interpretation = createInterpretation(failedEnvelope);

    const result = await executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
      runExecutor: async () => interpretation,
    });

    expect(result.interpretation.envelope.status).toBe("FAILED");
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("VERIFYING");
  });

  it("rejects multiple READY workspaces without running the executor", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { id: "ws-1", executionNumber: 1, status: "READY" });
    createTestWorkspace(tempDb, task.id, {
      id: "ws-2",
      executionNumber: 2,
      workspacePath: "/home/user/.devflow/worktrees/proj-1/task-1/2",
      status: "READY",
    });
    let called = false;

    await expect(
      executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
        runExecutor: async () => {
          called = true;
          return createInterpretation();
        },
      }),
    ).rejects.toThrow(`La tarea ${task.id} tiene múltiples workspaces listos: 2.`);

    expect(called).toBe(false);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("EXECUTING");
  });

  it("detects concurrent state change after executor finishes", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });

    await expect(
      executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
        runExecutor: async () => {
          tempDb.database.exec("PRAGMA foreign_keys = OFF;");
          tempDb.database
            .prepare("UPDATE tasks SET state = ?, updatedAt = ? WHERE id = ?")
            .run("BLOCKED", new Date().toISOString(), task.id);
          tempDb.database.exec("PRAGMA foreign_keys = ON;");
          return createInterpretation();
        },
      }),
    ).rejects.toThrow(
      `La tarea ${task.id} cambió de estado durante la ejecución del executor. Se esperaba EXECUTING y se encontró BLOCKED.`,
    );

    expect(getTaskById(tempDb.database, task.id)?.state).toBe("BLOCKED");
  });

  it("detects task deletion after executor finishes", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });

    await expect(
      executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
        runExecutor: async () => {
          tempDb.database.exec("PRAGMA foreign_keys = OFF;");
          tempDb.database.prepare("DELETE FROM task_workspaces WHERE taskId = ?").run(task.id);
          tempDb.database.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
          tempDb.database.exec("PRAGMA foreign_keys = ON;");
          return createInterpretation();
        },
      }),
    ).rejects.toThrow(
      `La tarea ${task.id} ya no existe después de la ejecución del executor.`,
    );
  });

  it("re-reads task after runner completes before updating state", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    const callOrder: string[] = [];

    await executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
      runExecutor: async () => {
        callOrder.push("runner");
        return createInterpretation();
      },
    });

    callOrder.push("post-read-verified");

    expect(callOrder).toEqual(["runner", "post-read-verified"]);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("VERIFYING");
  });

  it("preserves questions from NEEDS_INPUT interpretation", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    const envelope: AgentEnvelope = {
      protocolVersion: 1,
      role: "executor",
      status: "NEEDS_INPUT",
      summary: "Need clarification",
      questions: ["Which auth provider?", "Which session strategy?"],
      risks: [],
      payload: { filesClaimed: [], commandsClaimed: [] },
    };

    const result = await executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
      runExecutor: async () => createInterpretation(envelope),
    });

    expect(result.interpretation.envelope.questions).toEqual([
      "Which auth provider?",
      "Which session strategy?",
    ]);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("VERIFYING");
  });

  it("does not create human requests for any executor status", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "EXECUTING" });
    persistContract(tempDb, task.id);
    createTestWorkspace(tempDb, task.id, { status: "READY" });
    const envelope: AgentEnvelope = {
      protocolVersion: 1,
      role: "executor",
      status: "NEEDS_INPUT",
      summary: "Need input",
      questions: ["Question?"],
      risks: ["Risk?"],
      payload: { filesClaimed: [], commandsClaimed: [] },
    };

    await executeExecutorForTask(tempDb.database, task.id, createRuntime(), {
      runExecutor: async () => createInterpretation(envelope),
    });

    const requests = tempDb.database
      .prepare("SELECT * FROM human_requests WHERE taskId = ?")
      .all(task.id) as Record<string, unknown>[];

    expect(requests).toHaveLength(0);
  });
});
