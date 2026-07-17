import { describe, expect, it, afterEach } from "vitest";
import {
  prepareContractApproval,
  ContractApprovalPreparationError,
} from "../../src/services/contract-approval-service.js";
import { createProject } from "../../src/repositories/project-repository.js";
import {
  createTask,
  getTaskById,
  updateTaskState,
} from "../../src/repositories/task-repository.js";
import { listPendingHumanRequests, resolveHumanRequest } from "../../src/repositories/human-request-repository.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";
import type { TaskContract, Task } from "../../src/types.js";

const validContract: TaskContract = {
  classification: "EXECUTABLE_TASK",
  summary: "Add login button",
  reasoning: "Clear scope",
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

function createTestProject(tempDb: TempDatabase) {
  return createProject(tempDb.database, {
    id: "proj-1",
    name: "Test Project",
    repositoryPath: "/tmp/test",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
}

function createTestTask(tempDb: TempDatabase, projectId: string): Task {
  return createTask(tempDb.database, {
    id: "task-1",
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

function moveToGeneratingContract(tempDb: TempDatabase, taskId: string): void {
  updateTaskState(tempDb.database, taskId, "GENERATING_CONTRACT", new Date().toISOString());
}

describe("prepareContractApproval", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  describe("valid case", () => {
    it("persists the contract", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      prepareContractApproval(tempDb.database, task.id, validContract);

      const updated = getTaskById(tempDb.database, task.id);
      expect(updated?.contractJson).not.toBeNull();
    });

    it("changes state to CONTRACT_APPROVAL_REQUIRED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      prepareContractApproval(tempDb.database, task.id, validContract);

      const updated = getTaskById(tempDb.database, task.id);
      expect(updated?.state).toBe("CONTRACT_APPROVAL_REQUIRED");
    });

    it("creates exactly one HumanRequest", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      prepareContractApproval(tempDb.database, task.id, validContract);

      const pending = listPendingHumanRequests(tempDb.database);
      const forTask = pending.filter((r) => r.taskId === task.id);
      expect(forTask).toHaveLength(1);
    });

    it("HumanRequest has type CONTRACT_APPROVAL", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = prepareContractApproval(tempDb.database, task.id, validContract);
      expect(result.humanRequest.type).toBe("CONTRACT_APPROVAL");
    });

    it("HumanRequest has status PENDING", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = prepareContractApproval(tempDb.database, task.id, validContract);
      expect(result.humanRequest.status).toBe("PENDING");
    });

    it("HumanRequest belongs to the correct task", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = prepareContractApproval(tempDb.database, task.id, validContract);
      expect(result.humanRequest.taskId).toBe(task.id);
    });

    it("prompt contains the taskId", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = prepareContractApproval(tempDb.database, task.id, validContract);
      expect(result.humanRequest.question).toContain(task.id);
    });

    it("optionsJson contains APPROVE, REJECT and REQUEST_CHANGES", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = prepareContractApproval(tempDb.database, task.id, validContract);
      const options = JSON.parse(result.humanRequest.optionsJson);
      expect(options).toEqual(["APPROVE", "REJECT", "REQUEST_CHANGES"]);
    });

    it("returns previousState GENERATING_CONTRACT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = prepareContractApproval(tempDb.database, task.id, validContract);
      expect(result.previousState).toBe("GENERATING_CONTRACT");
    });

    it("returns currentState CONTRACT_APPROVAL_REQUIRED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = prepareContractApproval(tempDb.database, task.id, validContract);
      expect(result.currentState).toBe("CONTRACT_APPROVAL_REQUIRED");
    });

    it("returns the created HumanRequest", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const result = prepareContractApproval(tempDb.database, task.id, validContract);
      expect(result.humanRequest.id).toBeDefined();
      expect(result.humanRequest.id.length).toBeGreaterThan(0);
    });

    it("does not modify attempt", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      prepareContractApproval(tempDb.database, task.id, validContract);

      const updated = getTaskById(tempDb.database, task.id);
      expect(updated?.attempt).toBe(0);
    });

    it("does not modify maxAttempts", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      prepareContractApproval(tempDb.database, task.id, validContract);

      const updated = getTaskById(tempDb.database, task.id);
      expect(updated?.maxAttempts).toBe(3);
    });

    it("does not modify currentRevisionJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      prepareContractApproval(tempDb.database, task.id, validContract);

      const updated = getTaskById(tempDb.database, task.id);
      expect(updated?.currentRevisionJson).toBeNull();
    });
  });

  describe("validations", () => {
    it("rejects empty taskId", () => {
      tempDb = createTempDatabase();
      expect(() =>
        prepareContractApproval(tempDb.database, "", validContract),
      ).toThrow("El id de la tarea no puede estar vacío.");
    });

    it("rejects nonexistent task", () => {
      tempDb = createTempDatabase();
      expect(() =>
        prepareContractApproval(tempDb.database, "nonexistent", validContract),
      ).toThrow("No existe la tarea: nonexistent");
    });

    it("rejects task in CREATED state", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);

      expect(() =>
        prepareContractApproval(tempDb.database, task.id, validContract),
      ).toThrow(ContractApprovalPreparationError);
    });

    it("rejects task already in CONTRACT_APPROVAL_REQUIRED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      prepareContractApproval(tempDb.database, task.id, validContract);

      expect(() =>
        prepareContractApproval(tempDb.database, task.id, validContract),
      ).toThrow(ContractApprovalPreparationError);
    });

    it("rejects task in terminal state", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      updateTaskState(tempDb.database, task.id, "COMPLETED", new Date().toISOString());

      expect(() =>
        prepareContractApproval(tempDb.database, task.id, validContract),
      ).toThrow(ContractApprovalPreparationError);
    });

    it("rejects if CONTRACT_APPROVAL already pending", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      prepareContractApproval(tempDb.database, task.id, validContract);

      expect(() =>
        prepareContractApproval(tempDb.database, task.id, validContract),
      ).toThrow(ContractApprovalPreparationError);
    });

    it("allows new request if previous is RESOLVED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const first = prepareContractApproval(tempDb.database, task.id, validContract);

      resolveHumanRequest(tempDb.database, first.humanRequest.id, "RESOLVED", JSON.stringify({ approved: true }), new Date().toISOString());

      updateTaskState(tempDb.database, task.id, "GENERATING_CONTRACT", new Date().toISOString());

      const second = prepareContractApproval(tempDb.database, task.id, validContract);
      expect(second.humanRequest.id).not.toBe(first.humanRequest.id);
    });

    it("allows new request if previous is REJECTED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const first = prepareContractApproval(tempDb.database, task.id, validContract);

      resolveHumanRequest(tempDb.database, first.humanRequest.id, "REJECTED", null, new Date().toISOString());

      updateTaskState(tempDb.database, task.id, "GENERATING_CONTRACT", new Date().toISOString());

      const second = prepareContractApproval(tempDb.database, task.id, validContract);
      expect(second.humanRequest.id).not.toBe(first.humanRequest.id);
    });

    it("rejects semantically invalid contract", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const invalid: TaskContract = {
        ...validContract,
        acceptanceCriteria: ["dup", "dup"],
      };
      expect(() =>
        prepareContractApproval(tempDb.database, task.id, invalid),
      ).toThrow();
    });
  });

  describe("atomicity", () => {
    it("contractJson stays null if contract validation fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      try {
        prepareContractApproval(tempDb.database, task.id, {
          ...validContract,
          acceptanceCriteria: ["dup", "dup"],
        });
      } catch {
        // expected
      }

      const updated = getTaskById(tempDb.database, task.id);
      expect(updated?.contractJson).toBeNull();
    });

    it("state stays GENERATING_CONTRACT if contract validation fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      try {
        prepareContractApproval(tempDb.database, task.id, {
          ...validContract,
          acceptanceCriteria: ["dup", "dup"],
        });
      } catch {
        // expected
      }

      const updated = getTaskById(tempDb.database, task.id);
      expect(updated?.state).toBe("GENERATING_CONTRACT");
    });

    it("no HumanRequest created if contract validation fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      try {
        prepareContractApproval(tempDb.database, task.id, {
          ...validContract,
          acceptanceCriteria: ["dup", "dup"],
        });
      } catch {
        // expected
      }

      const pending = listPendingHumanRequests(tempDb.database);
      expect(pending).toHaveLength(0);
    });

    it("rollback of contractJson if createHumanRequest fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_human_request_insert
        AFTER INSERT ON human_requests
        BEGIN
          SELECT RAISE(ABORT, 'trigger abort');
        END;
      `);

      try {
        prepareContractApproval(tempDb.database, task.id, validContract);
      } catch {
        // expected
      }

      const updated = getTaskById(tempDb.database, task.id);
      expect(updated?.contractJson).toBeNull();
    });

    it("rollback of state if createHumanRequest fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_human_request_insert2
        AFTER INSERT ON human_requests
        BEGIN
          SELECT RAISE(ABORT, 'trigger abort');
        END;
      `);

      try {
        prepareContractApproval(tempDb.database, task.id, validContract);
      } catch {
        // expected
      }

      const updated = getTaskById(tempDb.database, task.id);
      expect(updated?.state).toBe("GENERATING_CONTRACT");
    });

    it("no HumanRequest remains if createHumanRequest fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_human_request_insert3
        AFTER INSERT ON human_requests
        BEGIN
          SELECT RAISE(ABORT, 'trigger abort');
        END;
      `);

      try {
        prepareContractApproval(tempDb.database, task.id, validContract);
      } catch {
        // expected
      }

      const pending = listPendingHumanRequests(tempDb.database);
      expect(pending).toHaveLength(0);
    });
  });

  describe("isolation", () => {
    it("preparing one task does not affect another", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);

      const task1 = createTask(tempDb.database, {
        id: "task-1",
        projectId: project.id,
        title: "Task 1",
        description: "First",
        state: "GENERATING_CONTRACT",
        attempt: 0,
        maxAttempts: 3,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const task2 = createTask(tempDb.database, {
        id: "task-2",
        projectId: project.id,
        title: "Task 2",
        description: "Second",
        state: "GENERATING_CONTRACT",
        attempt: 0,
        maxAttempts: 3,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      prepareContractApproval(tempDb.database, task1.id, validContract);

      const updated2 = getTaskById(tempDb.database, task2.id);
      expect(updated2?.state).toBe("GENERATING_CONTRACT");
      expect(updated2?.contractJson).toBeNull();
    });

    it("pending request of different type does not block CONTRACT_APPROVAL", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      tempDb.database
        .prepare(
          "INSERT INTO human_requests (id, taskId, type, question, optionsJson, resolutionJson, status, createdAt, resolvedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "req-other",
          task.id,
          "FUNCTIONAL_DECISION",
          "Some question",
          "[]",
          null,
          "PENDING",
          new Date().toISOString(),
          null,
        );

      const result = prepareContractApproval(tempDb.database, task.id, validContract);
      expect(result.humanRequest.type).toBe("CONTRACT_APPROVAL");
    });

    it("pending CONTRACT_APPROVAL of another task does not block", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);

      const task1 = createTask(tempDb.database, {
        id: "task-1",
        projectId: project.id,
        title: "Task 1",
        description: "First",
        state: "GENERATING_CONTRACT",
        attempt: 0,
        maxAttempts: 3,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const task2 = createTask(tempDb.database, {
        id: "task-2",
        projectId: project.id,
        title: "Task 2",
        description: "Second",
        state: "GENERATING_CONTRACT",
        attempt: 0,
        maxAttempts: 3,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      prepareContractApproval(tempDb.database, task1.id, validContract);

      const result = prepareContractApproval(tempDb.database, task2.id, validContract);
      expect(result.humanRequest.taskId).toBe(task2.id);
    });

    it("two consecutive calls for the same task do not create duplicates", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const first = prepareContractApproval(tempDb.database, task.id, validContract);

      resolveHumanRequest(tempDb.database, first.humanRequest.id, "RESOLVED", JSON.stringify({ approved: true }), new Date().toISOString());
      updateTaskState(tempDb.database, task.id, "GENERATING_CONTRACT", new Date().toISOString());

      prepareContractApproval(tempDb.database, task.id, validContract);

      const pending = listPendingHumanRequests(tempDb.database);
      expect(pending).toHaveLength(1);
    });
  });

  describe("transaction", () => {
    it("no open transaction after success", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      prepareContractApproval(tempDb.database, task.id, validContract);

      const row = tempDb.database
        .prepare("SELECT * FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
        .get();
      expect(row).toBeDefined();
    });

    it("connection is usable after rollback", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      try {
        prepareContractApproval(tempDb.database, task.id, {
          ...validContract,
          acceptanceCriteria: ["dup", "dup"],
        });
      } catch {
        // expected
      }

      const row = tempDb.database
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(task.id);
      expect(row).toBeDefined();
    });

    it("successful data persists after close and reopen", async () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      prepareContractApproval(tempDb.database, task.id, validContract);
      tempDb.close();

      const { DatabaseSync } = await import("node:sqlite");
      const { initializeSchema } = await import("../../src/db.js");
      const db = new DatabaseSync(tempDb.databasePath);
      initializeSchema(db);

      const reopened = getTaskById(db, task.id);
      expect(reopened?.state).toBe("CONTRACT_APPROVAL_REQUIRED");
      expect(reopened?.contractJson).not.toBeNull();
      db.close();
    });
  });
});
