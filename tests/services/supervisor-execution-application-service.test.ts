import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { createProject } from "../../src/repositories/project-repository.js";
import {
  createTask,
  getTaskById,
  getTaskContract,
  updateTaskState,
  type PersistedTaskContractError,
} from "../../src/repositories/task-repository.js";
import {
  createHumanRequest,
  getHumanRequestById,
  listPendingHumanRequests,
} from "../../src/repositories/human-request-repository.js";
import {
  executeSupervisorForTask,
  type SupervisorExecutionApplicationDeps,
} from "../../src/services/supervisor-execution-application-service.js";
import {
  applySupervisorResult,
  SupervisorResultApplicationError,
  type AppliedSupervisorOutcome,
} from "../../src/services/supervisor-result-application-service.js";
import {
  runSupervisorWithOpenCode,
  type SupervisorRuntimeOptions,
} from "../../src/services/supervisor-opencode-executor.js";
import type { SupervisorPromptInput } from "../../src/services/supervisor-prompt-builder.js";
import type { SupervisorOpenCodeInterpretation } from "../../src/services/supervisor-opencode-integration.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";
import type { HumanRequest, Project, SupervisorResult, Task } from "../../src/types.js";

const executableResult: Extract<SupervisorResult, { classification: "EXECUTABLE_TASK" }> = {
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

const decompositionResult: Extract<SupervisorResult, { classification: "NEEDS_DECOMPOSITION" }> = {
  classification: "NEEDS_DECOMPOSITION",
  summary: "Build auth system",
  reasoning: "Too much surface area",
  decompositionReason: "Auth spans frontend and backend",
  suggestedTasks: [
    { title: "Add login form", objective: "Implement the login UI" },
    { title: "Add auth API", objective: "Implement the auth endpoint" },
  ],
  openQuestions: ["Which auth provider?", "Which session strategy?"],
};

const discoveryResult: Extract<SupervisorResult, { classification: "NEEDS_DISCOVERY" }> = {
  classification: "NEEDS_DISCOVERY",
  summary: "Optimize database",
  reasoning: "Missing performance data",
  missingInformation: ["Current query latency", "Target SLA"],
  recommendedDiscoveryActions: ["Run benchmarks", "Inspect slow queries"],
  openQuestions: ["Which tables are slow?"],
};

function createRuntime(overrides: Partial<SupervisorRuntimeOptions> = {}): SupervisorRuntimeOptions {
  return {
    timeoutMs: 1234,
    ...overrides,
  };
}

function createInterpretation(
  supervisorResult: SupervisorResult,
  overrides: Partial<SupervisorOpenCodeInterpretation> = {},
): SupervisorOpenCodeInterpretation {
  return {
    supervisorResult,
    sessionID: "sess-1",
    messageID: "msg-1",
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

function moveToGeneratingContract(tempDb: TempDatabase, taskId: string): void {
  updateTaskState(tempDb.database, taskId, "GENERATING_CONTRACT", new Date().toISOString());
}

function createPendingRequest(
  tempDb: TempDatabase,
  request: Partial<HumanRequest> & Pick<HumanRequest, "id" | "taskId" | "type" | "question" | "optionsJson">,
): HumanRequest {
  return createHumanRequest(tempDb.database, {
    resolutionJson: null,
    status: "PENDING",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...request,
  });
}

describe("executeSupervisorForTask", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  it("builds SupervisorPromptInput with project, task and only pending requests of the task", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb, { name: "Alpha", repositoryPath: "/repo/main" });
    const task = createTestTask(tempDb, project.id, {
      title: "Implement feature",
      description: "Build the first slice",
      attempt: 2,
      maxAttempts: 5,
      contractJson: '{"saved":true}',
      currentRevisionJson: '{"revision":1}',
    });
    const otherTask = createTestTask(tempDb, project.id, { id: "task-2" });
    moveToGeneratingContract(tempDb, task.id);
    createPendingRequest(tempDb, {
      id: "req-1",
      taskId: task.id,
      type: "FUNCTIONAL_DECISION",
      question: "Need input",
      optionsJson: '["A","B"]',
    });
    createPendingRequest(tempDb, {
      id: "req-2",
      taskId: otherTask.id,
      type: "CONTRACT_APPROVAL",
      question: "Other task",
      optionsJson: '["APPROVE"]',
    });

    let capturedInput: SupervisorPromptInput | null = null;
    const application: AppliedSupervisorOutcome = {
      classification: "NEEDS_DISCOVERY",
      taskId: task.id,
      currentState: "HUMAN_REQUIRED",
      humanRequest: {
        id: "req-applied",
        taskId: task.id,
        type: "FUNCTIONAL_DECISION",
        question: "Applied",
        optionsJson: '["PROVIDE_INFORMATION"]',
        resolutionJson: null,
        status: "PENDING",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      },
    };
    const deps: SupervisorExecutionApplicationDeps = {
      runSupervisor: async (input, runtime) => {
        capturedInput = input;
        expect(runtime.timeoutMs).toBe(1234);
        return createInterpretation(discoveryResult);
      },
      applyResult: (_database: DatabaseSync, _taskId: string, _result: SupervisorResult): AppliedSupervisorOutcome => application,
    };

    await executeSupervisorForTask(tempDb.database, task.id, createRuntime(), deps);

    expect(capturedInput).not.toBeNull();
    expect(capturedInput).toEqual({
      project: {
        name: "Alpha",
        repositoryPath: "/repo/main",
      },
      task: {
        id: task.id,
        title: "Implement feature",
        description: "Build the first slice",
        state: "GENERATING_CONTRACT",
        attempt: 2,
        maxAttempts: 5,
        contractJson: '{"saved":true}',
        currentRevisionJson: '{"revision":1}',
      },
      pendingHumanRequests: [
        {
          id: "req-1",
          type: "FUNCTIONAL_DECISION",
          question: "Need input",
          optionsJson: '["A","B"]',
        },
      ],
    });
  });

  it("propagates runtime exactly", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);
    moveToGeneratingContract(tempDb, task.id);
    const controller = new AbortController();
    let capturedRuntime: SupervisorRuntimeOptions | null = null;

    await executeSupervisorForTask(
      tempDb.database,
      task.id,
      createRuntime({
        timeoutMs: 9876,
        agent: "reviewer",
        model: "gpt-5.4-mini",
        binaryPath: "/bin/opencode",
        signal: controller.signal,
      }),
      {
        runSupervisor: async (_input, runtime) => {
          capturedRuntime = runtime;
          return createInterpretation(discoveryResult);
        },
      },
    );

    expect(capturedRuntime).toEqual({
      timeoutMs: 9876,
      agent: "reviewer",
      model: "gpt-5.4-mini",
      binaryPath: "/bin/opencode",
      signal: controller.signal,
    });
  });

  it("applies EXECUTABLE_TASK and returns interpretation metadata plus application outcome", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);
    moveToGeneratingContract(tempDb, task.id);
    const interpretation = createInterpretation(executableResult, {
      sessionID: "sess-exec",
      messageID: "msg-exec",
    });

    const result = await executeSupervisorForTask(tempDb.database, task.id, createRuntime(), {
      runSupervisor: async () => interpretation,
    });

    expect(result.taskId).toBe(task.id);
    expect(result.projectId).toBe(project.id);
    expect(result.sessionID).toBe("sess-exec");
    expect(result.messageID).toBe("msg-exec");
    expect(result.supervisorResult).toBe(interpretation.supervisorResult);
    expect(result.application.classification).toBe("EXECUTABLE_TASK");
    expect(result.application.currentState).toBe("CONTRACT_APPROVAL_REQUIRED");
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("CONTRACT_APPROVAL_REQUIRED");
    expect(getTaskContract(tempDb.database, task.id)).toEqual(executableResult);
    expect(getHumanRequestById(tempDb.database, result.application.humanRequest.id)?.type).toBe("CONTRACT_APPROVAL");
  });

  it("applies NEEDS_DECOMPOSITION and creates FUNCTIONAL_DECISION without persisting contractJson", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);
    moveToGeneratingContract(tempDb, task.id);

    const result = await executeSupervisorForTask(tempDb.database, task.id, createRuntime(), {
      runSupervisor: async () => createInterpretation(decompositionResult),
    });

    expect(getTaskById(tempDb.database, task.id)?.state).toBe("HUMAN_REQUIRED");
    expect(getTaskContract(tempDb.database, task.id)).toBeNull();
    expect(result.application.classification).toBe("NEEDS_DECOMPOSITION");
    expect(result.application.humanRequest.type).toBe("FUNCTIONAL_DECISION");
    expect(JSON.parse(result.application.humanRequest.optionsJson)).toEqual([
      "ACCEPT_DECOMPOSITION",
      "EDIT_DECOMPOSITION",
      "CANCEL_TASK",
    ]);
  });

  it("applies NEEDS_DISCOVERY and creates FUNCTIONAL_DECISION without persisting contractJson", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);
    moveToGeneratingContract(tempDb, task.id);

    const result = await executeSupervisorForTask(tempDb.database, task.id, createRuntime(), {
      runSupervisor: async () => createInterpretation(discoveryResult),
    });

    expect(getTaskById(tempDb.database, task.id)?.state).toBe("HUMAN_REQUIRED");
    expect(getTaskContract(tempDb.database, task.id)).toBeNull();
    expect(result.application.classification).toBe("NEEDS_DISCOVERY");
    expect(result.application.humanRequest.type).toBe("FUNCTIONAL_DECISION");
    expect(JSON.parse(result.application.humanRequest.optionsJson)).toEqual([
      "PROVIDE_INFORMATION",
      "RUN_DISCOVERY",
      "CANCEL_TASK",
    ]);
  });

  it("rejects empty taskId before running the supervisor", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);
    moveToGeneratingContract(tempDb, task.id);
    let called = false;

    await expect(
      executeSupervisorForTask(tempDb.database, "   ", createRuntime(), {
        runSupervisor: async () => {
          called = true;
          return createInterpretation(executableResult);
        },
      }),
    ).rejects.toThrow("El id de la tarea no puede estar vacío.");

    expect(called).toBe(false);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
  });

  it("rejects nonexistent task before running the supervisor", async () => {
    tempDb = createTempDatabase();
    let called = false;

    await expect(
      executeSupervisorForTask(tempDb.database, "missing", createRuntime(), {
        runSupervisor: async () => {
          called = true;
          return createInterpretation(executableResult);
        },
      }),
    ).rejects.toThrow("No existe la tarea: missing");

    expect(called).toBe(false);
  });

  it("rejects missing project before running the supervisor", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb, { id: "missing-project" });
    const task = createTestTask(tempDb, project.id, { state: "GENERATING_CONTRACT" });
    tempDb.database.exec("PRAGMA foreign_keys = OFF;");
    tempDb.database.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    tempDb.database.exec("PRAGMA foreign_keys = ON;");
    let called = false;

    await expect(
      executeSupervisorForTask(tempDb.database, task.id, createRuntime(), {
        runSupervisor: async () => {
          called = true;
          return createInterpretation(executableResult);
        },
      }),
    ).rejects.toThrow(`La tarea ${task.id} referencia un proyecto inexistente: missing-project`);

    expect(called).toBe(false);
  });

  it("rejects states different from GENERATING_CONTRACT before running the supervisor", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id, { state: "CREATED" });
    let called = false;

    await expect(
      executeSupervisorForTask(tempDb.database, task.id, createRuntime(), {
        runSupervisor: async () => {
          called = true;
          return createInterpretation(executableResult);
        },
      }),
    ).rejects.toBeInstanceOf(SupervisorResultApplicationError);

    expect(called).toBe(false);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("CREATED");
    expect(listPendingHumanRequests(tempDb.database)).toHaveLength(0);
  });

  it("propagates runSupervisorWithOpenCode errors by identity and does not apply changes", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);
    moveToGeneratingContract(tempDb, task.id);
    const error = new RangeError("runner failed");
    let applyCalled = false;

    await expect(
      executeSupervisorForTask(tempDb.database, task.id, createRuntime(), {
        runSupervisor: async () => {
          throw error;
        },
        applyResult: (database: DatabaseSync, appliedTaskId: string, result: SupervisorResult): AppliedSupervisorOutcome => {
          applyCalled = true;
          return applySupervisorResult(database, appliedTaskId, result);
        },
      }),
    ).rejects.toBe(error);

    expect(applyCalled).toBe(false);
    expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
    expect(listPendingHumanRequests(tempDb.database)).toHaveLength(0);
  });

  it("propagates applySupervisorResult errors by identity after executing the supervisor", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);
    moveToGeneratingContract(tempDb, task.id);
    const error = new SupervisorResultApplicationError(task.id, "boom");
    let runCalled = false;

    await expect(
      executeSupervisorForTask(tempDb.database, task.id, createRuntime(), {
        runSupervisor: async () => {
          runCalled = true;
          return createInterpretation(executableResult);
        },
        applyResult: (_database: DatabaseSync, _taskId: string, _result: SupervisorResult): AppliedSupervisorOutcome => {
          throw error;
        },
      }),
    ).rejects.toBe(error);

    expect(runCalled).toBe(true);
  });

  it("simulates concurrency by letting applySupervisorResult reject after state changes during execution", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);
    moveToGeneratingContract(tempDb, task.id);

    await expect(
      executeSupervisorForTask(tempDb.database, task.id, createRuntime(), {
        runSupervisor: async () => {
          updateTaskState(tempDb.database, task.id, "HUMAN_REQUIRED", new Date().toISOString());
          return createInterpretation(executableResult);
        },
      }),
    ).rejects.toBeInstanceOf(SupervisorResultApplicationError);

    expect(getTaskById(tempDb.database, task.id)?.state).toBe("HUMAN_REQUIRED");
  });

  it("calls runner and applyResult exactly once on success", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);
    moveToGeneratingContract(tempDb, task.id);
    let runCount = 0;
    let applyCount = 0;
    const application: AppliedSupervisorOutcome = {
      classification: "NEEDS_DISCOVERY",
      taskId: task.id,
      currentState: "HUMAN_REQUIRED",
      humanRequest: {
        id: "req-1",
        taskId: task.id,
        type: "FUNCTIONAL_DECISION",
        question: "Need discovery",
        optionsJson: '["PROVIDE_INFORMATION"]',
        resolutionJson: null,
        status: "PENDING",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      },
    };

    const result = await executeSupervisorForTask(tempDb.database, task.id, createRuntime(), {
      runSupervisor: async () => {
        runCount += 1;
        return createInterpretation(discoveryResult);
      },
      applyResult: (database: DatabaseSync, appliedTaskId: string, supervisorResult: SupervisorResult): AppliedSupervisorOutcome => {
        applyCount += 1;
        expect(appliedTaskId).toBe(task.id);
        expect(supervisorResult).toBe(discoveryResult);
        expect(database).toBe(tempDb.database);
        return application;
      },
    });

    expect(runCount).toBe(1);
    expect(applyCount).toBe(1);
    expect(result.supervisorResult).toBe(discoveryResult);
    expect(result.application).toBe(application);
  });

  it("passes the exact supervisorResult instance from interpretation to applyResult", async () => {
    tempDb = createTempDatabase();
    const project = createTestProject(tempDb);
    const task = createTestTask(tempDb, project.id);
    moveToGeneratingContract(tempDb, task.id);
    const supervisorResult = discoveryResult;
    let received: SupervisorResult | null = null;

    await executeSupervisorForTask(tempDb.database, task.id, createRuntime(), {
      runSupervisor: async () => createInterpretation(supervisorResult),
      applyResult: (_database: DatabaseSync, appliedTaskId: string, result: SupervisorResult): AppliedSupervisorOutcome => {
        received = result;
        return {
          classification: "NEEDS_DISCOVERY",
          taskId: appliedTaskId,
          currentState: "HUMAN_REQUIRED",
          humanRequest: createPendingRequest(tempDb, {
            id: "req-1",
            taskId: task.id,
            type: "FUNCTIONAL_DECISION",
            question: "Need info",
            optionsJson: '["PROVIDE_INFORMATION"]',
          }),
        };
      },
    });

    expect(received).toBe(supervisorResult);
  });
});
