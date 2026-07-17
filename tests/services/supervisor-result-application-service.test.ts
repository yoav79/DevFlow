import { afterEach, describe, expect, it } from "vitest";

import {
  applySupervisorResult,
  SupervisorResultApplicationError,
} from "../../src/services/supervisor-result-application-service.js";
import { createProject } from "../../src/repositories/project-repository.js";
import { createTask, getTaskById, updateTaskState } from "../../src/repositories/task-repository.js";
import {
  createHumanRequest,
  getHumanRequestById,
  listPendingHumanRequests,
} from "../../src/repositories/human-request-repository.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";
import type {
  Task,
  TaskContract,
  SupervisorResult,
  HumanRequest,
} from "../../src/types.js";

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

const decompositionResult = {
  classification: "NEEDS_DECOMPOSITION" as const,
  summary: "Build auth system",
  reasoning: "Too much surface area",
  decompositionReason: "Auth spans frontend and backend",
  suggestedTasks: [
    { title: "Add login form", objective: "Implement the login UI" },
    { title: "Add auth API", objective: "Implement the auth endpoint" },
  ],
  openQuestions: ["Which auth provider?", "Which session strategy?"],
};

const discoveryResult = {
  classification: "NEEDS_DISCOVERY" as const,
  summary: "Optimize database",
  reasoning: "Missing performance data",
  missingInformation: ["Current query latency", "Target SLA"],
  recommendedDiscoveryActions: ["Run benchmarks", "Inspect slow queries"],
  openQuestions: ["Which tables are slow?"],
};

function createTestProject(tempDb: TempDatabase) {
  return createProject(tempDb.database, {
    id: "proj-1",
    name: "Test Project",
    repositoryPath: "/tmp/test",
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

function createPendingFunctionalDecision(
  tempDb: TempDatabase,
  taskId: string,
  requestId: string,
  status: "PENDING" = "PENDING",
): HumanRequest {
  const request: HumanRequest = {
    id: requestId,
    taskId,
    type: "FUNCTIONAL_DECISION",
    question: "Pending functional decision",
    optionsJson: JSON.stringify(["YES", "NO"]),
    resolutionJson: null,
    status,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };

  return createHumanRequest(tempDb.database, request);
}

function parseOptions(optionsJson: string): string[] {
  return JSON.parse(optionsJson) as string[];
}

describe("applySupervisorResult", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  describe("EXECUTABLE_TASK", () => {
    it("persists the contract and creates CONTRACT_APPROVAL", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = applySupervisorResult(tempDb.database, task.id, executableResult);

      const updatedTask = getTaskById(tempDb.database, task.id);
      expect(updatedTask?.contractJson).not.toBeNull();
      expect(updatedTask?.state).toBe("CONTRACT_APPROVAL_REQUIRED");
      expect(result.classification).toBe("EXECUTABLE_TASK");
      expect(result.currentState).toBe("CONTRACT_APPROVAL_REQUIRED");
      expect(result.humanRequest.type).toBe("CONTRACT_APPROVAL");
    });

    it("does not create FUNCTIONAL_DECISION and keeps task counters", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        attempt: 2,
        maxAttempts: 5,
        currentRevisionJson: "revision-1",
      });
      moveToGeneratingContract(tempDb, task.id);

      const result = applySupervisorResult(tempDb.database, task.id, executableResult);

      const pending = listPendingHumanRequests(tempDb.database).filter((r) => r.taskId === task.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.type).toBe("CONTRACT_APPROVAL");
      expect(pending.some((request) => request.type === "FUNCTIONAL_DECISION")).toBe(false);
      expect(result.humanRequest.taskId).toBe(task.id);

      const updatedTask = getTaskById(tempDb.database, task.id);
      expect(updatedTask?.attempt).toBe(2);
      expect(updatedTask?.maxAttempts).toBe(5);
      expect(updatedTask?.currentRevisionJson).toBe("revision-1");
    });

    it("reuses prepareContractApproval flow without duplicates", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const first = applySupervisorResult(tempDb.database, task.id, executableResult);

      expect(() => applySupervisorResult(tempDb.database, task.id, executableResult)).toThrow(
        SupervisorResultApplicationError,
      );

      const pending = listPendingHumanRequests(tempDb.database).filter((request) => request.taskId === task.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe(first.humanRequest.id);
    });
  });

  describe("NEEDS_DECOMPOSITION", () => {
    it("creates FUNCTIONAL_DECISION and moves to HUMAN_REQUIRED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = applySupervisorResult(tempDb.database, task.id, decompositionResult);

      expect(result.classification).toBe("NEEDS_DECOMPOSITION");
      expect(result.currentState).toBe("HUMAN_REQUIRED");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("HUMAN_REQUIRED");

      const request = getHumanRequestById(tempDb.database, result.humanRequest.id);
      expect(request?.type).toBe("FUNCTIONAL_DECISION");
      expect(request?.status).toBe("PENDING");
      expect(request?.resolutionJson).toBeNull();
      expect(parseOptions(request?.optionsJson ?? "[]")).toEqual([
        "ACCEPT_DECOMPOSITION",
        "EDIT_DECOMPOSITION",
        "CANCEL_TASK",
      ]);
    });

    it("formats question with reason, suggested tasks and open questions", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = applySupervisorResult(tempDb.database, task.id, decompositionResult);
      const question = result.humanRequest.question;

      expect(question).toContain(`La tarea ${task.id} necesita descomposición antes de poder ejecutarse.`);
      expect(question).toContain(`Motivo: ${decompositionResult.decompositionReason}`);
      expect(question).toContain(
        `1. ${decompositionResult.suggestedTasks[0]!.title}: ${decompositionResult.suggestedTasks[0]!.objective}`,
      );
      expect(question).toContain(
        `2. ${decompositionResult.suggestedTasks[1]!.title}: ${decompositionResult.suggestedTasks[1]!.objective}`,
      );
      expect(question).toContain(`Preguntas abiertas:`);
      expect(question).toContain(`- ${decompositionResult.openQuestions[0]}`);
    });

    it("omits open questions section when empty and preserves existing contractJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        contractJson: JSON.stringify(executableResult),
      });
      moveToGeneratingContract(tempDb, task.id);

      const result = applySupervisorResult(tempDb.database, task.id, {
        ...decompositionResult,
        openQuestions: [],
      });

      expect(result.humanRequest.question).not.toContain("Preguntas abiertas:");
      expect(getTaskById(tempDb.database, task.id)?.contractJson).toBe(JSON.stringify(executableResult));
    });

    it("rejects duplicate pending FUNCTIONAL_DECISION for the same task", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      createPendingFunctionalDecision(tempDb, task.id, "req-1");

      expect(() => applySupervisorResult(tempDb.database, task.id, decompositionResult)).toThrow(
        "La tarea task-1 ya tiene una decisión funcional pendiente.",
      );
    });
  });

  describe("NEEDS_DISCOVERY", () => {
    it("creates FUNCTIONAL_DECISION and moves to HUMAN_REQUIRED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = applySupervisorResult(tempDb.database, task.id, discoveryResult);

      expect(result.classification).toBe("NEEDS_DISCOVERY");
      expect(result.currentState).toBe("HUMAN_REQUIRED");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("HUMAN_REQUIRED");

      const request = getHumanRequestById(tempDb.database, result.humanRequest.id);
      expect(request?.type).toBe("FUNCTIONAL_DECISION");
      expect(request?.status).toBe("PENDING");
      expect(request?.resolutionJson).toBeNull();
      expect(parseOptions(request?.optionsJson ?? "[]")).toEqual([
        "PROVIDE_INFORMATION",
        "RUN_DISCOVERY",
        "CANCEL_TASK",
      ]);
    });

    it("formats question with missing information, actions and open questions", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = applySupervisorResult(tempDb.database, task.id, discoveryResult);
      const question = result.humanRequest.question;

      expect(question).toContain(`La tarea ${task.id} necesita descubrimiento antes de poder ejecutarse.`);
      expect(question).toContain(`- ${discoveryResult.missingInformation[0]}`);
      expect(question).toContain(`- ${discoveryResult.recommendedDiscoveryActions[0]}`);
      expect(question).toContain(`Preguntas abiertas:`);
      expect(question).toContain(`- ${discoveryResult.openQuestions[0]}`);
    });

    it("omits open questions section when empty and preserves existing contractJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        contractJson: JSON.stringify(executableResult),
      });
      moveToGeneratingContract(tempDb, task.id);

      const result = applySupervisorResult(tempDb.database, task.id, {
        ...discoveryResult,
        openQuestions: [],
      });

      expect(result.humanRequest.question).not.toContain("Preguntas abiertas:");
      expect(getTaskById(tempDb.database, task.id)?.contractJson).toBe(JSON.stringify(executableResult));
    });

    it("rejects duplicate pending FUNCTIONAL_DECISION for the same task", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      createPendingFunctionalDecision(tempDb, task.id, "req-1");

      expect(() => applySupervisorResult(tempDb.database, task.id, discoveryResult)).toThrow(
        "La tarea task-1 ya tiene una decisión funcional pendiente.",
      );
    });
  });

  describe("validations", () => {
    it("rejects empty taskId", () => {
      tempDb = createTempDatabase();
      expect(() => applySupervisorResult(tempDb.database, "", executableResult)).toThrow(
        "El id de la tarea no puede estar vacío.",
      );
    });

    it("rejects nonexistent task", () => {
      tempDb = createTempDatabase();
      expect(() => applySupervisorResult(tempDb.database, "missing", executableResult)).toThrow(
        "No existe la tarea: missing",
      );
    });

    it("rejects CREATED state", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { state: "CREATED" });

      expect(() => applySupervisorResult(tempDb.database, task.id, executableResult)).toThrow(
        SupervisorResultApplicationError,
      );
    });

    it("rejects HUMAN_REQUIRED state", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { state: "HUMAN_REQUIRED" });

      expect(() => applySupervisorResult(tempDb.database, task.id, executableResult)).toThrow(
        SupervisorResultApplicationError,
      );
    });

    it("rejects terminal state", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { state: "COMPLETED" });

      expect(() => applySupervisorResult(tempDb.database, task.id, executableResult)).toThrow(
        SupervisorResultApplicationError,
      );
    });

    it("does not mutate the received result object", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = {
        ...discoveryResult,
        openQuestions: [...discoveryResult.openQuestions],
      };
      const copy = JSON.parse(JSON.stringify(result));

      applySupervisorResult(tempDb.database, task.id, result);

      expect(result).toEqual(copy);
    });
  });

  describe("atomicity", () => {
    it("rolls back if createHumanRequest fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_human_request_insert_apply
        AFTER INSERT ON human_requests
        BEGIN
          SELECT RAISE(ABORT, 'request abort');
        END;
      `);

      expect(() => applySupervisorResult(tempDb.database, task.id, discoveryResult)).toThrow();
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
      expect(listPendingHumanRequests(tempDb.database)).toHaveLength(0);
    });

    it("rolls back if updateTaskState fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_task_update_apply
        AFTER UPDATE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'task abort');
        END;
      `);

      expect(() => applySupervisorResult(tempDb.database, task.id, discoveryResult)).toThrow();
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
      expect(listPendingHumanRequests(tempDb.database)).toHaveLength(0);
    });

    it("connection remains usable after rollback", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_task_update_apply_2
        AFTER UPDATE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'task abort');
        END;
      `);

      expect(() => applySupervisorResult(tempDb.database, task.id, discoveryResult)).toThrow();
      expect(getTaskById(tempDb.database, task.id)).toBeDefined();
    });

    it("changes persist after reopening SQLite", async () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = applySupervisorResult(tempDb.database, task.id, executableResult);
      tempDb.close();

      const { DatabaseSync } = await import("node:sqlite");
      const { initializeSchema } = await import("../../src/db.js");
      const db = new DatabaseSync(tempDb.databasePath);
      initializeSchema(db);

      expect(getTaskById(db, task.id)?.state).toBe("CONTRACT_APPROVAL_REQUIRED");
      expect(getHumanRequestById(db, result.humanRequest.id)?.type).toBe("CONTRACT_APPROVAL");
      db.close();
    });
  });

  describe("isolation", () => {
    it("does not affect another task", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task1 = createTestTask(tempDb, project.id, { id: "task-1" });
      const task2 = createTestTask(tempDb, project.id, { id: "task-2" });
      moveToGeneratingContract(tempDb, task1.id);
      moveToGeneratingContract(tempDb, task2.id);

      applySupervisorResult(tempDb.database, task1.id, executableResult);

      expect(getTaskById(tempDb.database, task2.id)?.state).toBe("GENERATING_CONTRACT");
      expect(getHumanRequestById(tempDb.database, task2.id)).toBeNull();
    });

    it("does not interfere with another task's pending request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task1 = createTestTask(tempDb, project.id, { id: "task-1" });
      const task2 = createTestTask(tempDb, project.id, { id: "task-2" });
      moveToGeneratingContract(tempDb, task1.id);
      moveToGeneratingContract(tempDb, task2.id);

      createPendingFunctionalDecision(tempDb, task2.id, "req-2");

      const result = applySupervisorResult(tempDb.database, task1.id, discoveryResult);
      expect(result.humanRequest.taskId).toBe(task1.id);
      expect(getHumanRequestById(tempDb.database, "req-2")?.status).toBe("PENDING");
    });
  });
});
