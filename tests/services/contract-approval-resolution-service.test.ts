import { afterEach, describe, expect, it } from "vitest";

import {
  ContractApprovalResolutionError,
  resolveContractApproval,
} from "../../src/services/contract-approval-resolution-service.js";
import { prepareContractApproval } from "../../src/services/contract-approval-service.js";
import { createProject } from "../../src/repositories/project-repository.js";
import { createTask, getTaskById, updateTaskState } from "../../src/repositories/task-repository.js";
import { getHumanRequestById, listPendingHumanRequests, resolveHumanRequest } from "../../src/repositories/human-request-repository.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";
import type { ContractApprovalDecision } from "../../src/services/contract-approval-resolution-service.js";
import type { TaskContract, Task, HumanRequest } from "../../src/types.js";

const baseContract: TaskContract = {
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

function createTestTask(tempDb: TempDatabase, projectId: string, overrides: Partial<Task> = {}): Task {
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
    ...overrides,
  });
}

function preparePendingApproval(tempDb: TempDatabase, taskId: string): HumanRequest {
  updateTaskState(tempDb.database, taskId, "GENERATING_CONTRACT", new Date().toISOString());
  const result = prepareContractApproval(tempDb.database, taskId, baseContract);
  return result.humanRequest;
}

function parseResolutionJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe("resolveContractApproval", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  describe("APPROVE", () => {
    it("resolves the request as RESOLVED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" });

      expect(result.humanRequest.status).toBe("RESOLVED");
    });

    it("moves the task to PREPARING_WORKSPACE", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" });

      expect(result.currentTaskState).toBe("PREPARING_WORKSPACE");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("PREPARING_WORKSPACE");
    });

    it("stores decision APPROVE without comment", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution).toEqual({ decision: "APPROVE" });
    });

    it("omits blank comment for APPROVE", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, {
        decision: "APPROVE",
        comment: "   ",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution).toEqual({ decision: "APPROVE" });
    });

    it("stores normalized comment for APPROVE", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, {
        decision: "APPROVE",
        comment: "  good to go  ",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution).toEqual({ decision: "APPROVE", comment: "good to go" });
    });

    it("keeps contractJson on APPROVE", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" });

      expect(getTaskById(tempDb.database, task.id)?.contractJson).not.toBeNull();
    });

    it("does not modify attempt, maxAttempts or currentRevisionJson on APPROVE", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { attempt: 2, maxAttempts: 4, currentRevisionJson: "rev" });
      const request = preparePendingApproval(tempDb, task.id);

      resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" });

      const updated = getTaskById(tempDb.database, task.id);
      expect(updated?.attempt).toBe(2);
      expect(updated?.maxAttempts).toBe(4);
      expect(updated?.currentRevisionJson).toBe("rev");
    });
  });

  describe("REQUEST_CHANGES", () => {
    it("resolves the request as RESOLVED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, {
        decision: "REQUEST_CHANGES",
        comment: "Please clarify scope",
      });

      expect(result.humanRequest.status).toBe("RESOLVED");
    });

    it("moves the task back to GENERATING_CONTRACT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, {
        decision: "REQUEST_CHANGES",
        comment: "Please clarify scope",
      });

      expect(result.currentTaskState).toBe("GENERATING_CONTRACT");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
    });

    it("stores decision and comment for REQUEST_CHANGES", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, {
        decision: "REQUEST_CHANGES",
        comment: "  please clarify scope  ",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution).toEqual({ decision: "REQUEST_CHANGES", comment: "please clarify scope" });
    });

    it("rejects empty comment for REQUEST_CHANGES", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, {
          decision: "REQUEST_CHANGES",
          comment: "",
        }),
      ).toThrow(ContractApprovalResolutionError);
    });

    it("rejects whitespace-only comment for REQUEST_CHANGES", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, {
          decision: "REQUEST_CHANGES",
          comment: "   ",
        }),
      ).toThrow("La decisión REQUEST_CHANGES requiere un comentario.");
    });

    it("keeps contractJson on REQUEST_CHANGES", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      resolveContractApproval(tempDb.database, request.id, {
        decision: "REQUEST_CHANGES",
        comment: "Please clarify scope",
      });

      expect(getTaskById(tempDb.database, task.id)?.contractJson).not.toBeNull();
    });

    it("returns currentTaskState GENERATING_CONTRACT for REQUEST_CHANGES", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, {
        decision: "REQUEST_CHANGES",
        comment: "Please clarify scope",
      });

      expect(result.currentTaskState).toBe("GENERATING_CONTRACT");
    });
  });

  describe("REJECT", () => {
    it("resolves the request as REJECTED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, {
        decision: "REJECT",
        comment: "Not acceptable",
      });

      expect(result.humanRequest.status).toBe("REJECTED");
    });

    it("moves the task to BLOCKED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, {
        decision: "REJECT",
        comment: "Not acceptable",
      });

      expect(result.currentTaskState).toBe("BLOCKED");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("BLOCKED");
    });

    it("stores decision and comment for REJECT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, {
        decision: "REJECT",
        comment: "  not acceptable  ",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution).toEqual({ decision: "REJECT", comment: "not acceptable" });
    });

    it("rejects empty comment for REJECT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, {
          decision: "REJECT",
          comment: "",
        }),
      ).toThrow("La decisión REJECT requiere un comentario.");
    });

    it("rejects whitespace-only comment for REJECT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, {
          decision: "REJECT",
          comment: "   ",
        }),
      ).toThrow(ContractApprovalResolutionError);
    });

    it("keeps contractJson on REJECT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      resolveContractApproval(tempDb.database, request.id, {
        decision: "REJECT",
        comment: "Not acceptable",
      });

      expect(getTaskById(tempDb.database, task.id)?.contractJson).not.toBeNull();
    });

    it("returns currentTaskState BLOCKED for REJECT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const result = resolveContractApproval(tempDb.database, request.id, {
        decision: "REJECT",
        comment: "Not acceptable",
      });

      expect(result.currentTaskState).toBe("BLOCKED");
    });
  });

  describe("validations", () => {
    it("rejects empty requestId", () => {
      tempDb = createTempDatabase();
      expect(() => resolveContractApproval(tempDb.database, "", { decision: "APPROVE" })).toThrow(
        "El id de la solicitud no puede estar vacío.",
      );
    });

    it("rejects nonexistent request", () => {
      tempDb = createTempDatabase();
      expect(() =>
        resolveContractApproval(tempDb.database, "missing", { decision: "APPROVE" }),
      ).toThrow("No existe la solicitud humana: missing");
    });

    it("rejects request of another type", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      updateTaskState(tempDb.database, task.id, "GENERATING_CONTRACT", new Date().toISOString());
      const request = prepareContractApproval(tempDb.database, task.id, baseContract);

      tempDb.database
        .prepare("UPDATE human_requests SET type = 'FUNCTIONAL_DECISION' WHERE id = ?")
        .run(request.humanRequest.id);

      expect(() =>
        resolveContractApproval(tempDb.database, request.humanRequest.id, { decision: "APPROVE" }),
      ).toThrow(ContractApprovalResolutionError);
    });

    it("rejects already RESOLVED request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      resolveHumanRequest(tempDb.database, request.id, "RESOLVED", JSON.stringify({ decision: "APPROVE" }), new Date().toISOString());

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" }),
      ).toThrow(ContractApprovalResolutionError);
    });

    it("rejects already REJECTED request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      resolveHumanRequest(tempDb.database, request.id, "REJECTED", JSON.stringify({ decision: "REJECT" }), new Date().toISOString());

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" }),
      ).toThrow(ContractApprovalResolutionError);
    });

    it("rejects task not in CONTRACT_APPROVAL_REQUIRED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      updateTaskState(tempDb.database, task.id, "PREPARING_WORKSPACE", new Date().toISOString());

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" }),
      ).toThrow(ContractApprovalResolutionError);
    });

    it("does not modify the decision object received", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      const decision: ContractApprovalDecision = {
        decision: "APPROVE",
        comment: "  okay  ",
      };
      const copy = JSON.parse(JSON.stringify(decision));

      resolveContractApproval(tempDb.database, request.id, decision);

      expect(decision).toEqual(copy);
    });

    it("error has the correct name", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      try {
        resolveContractApproval(tempDb.database, request.id, {
          decision: "REQUEST_CHANGES",
          comment: "   ",
        });
        expect.fail("should throw");
      } catch (error) {
        expect((error as ContractApprovalResolutionError).name).toBe("ContractApprovalResolutionError");
      }
    });

    it("error extends Error", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, {
          decision: "REQUEST_CHANGES",
          comment: "   ",
        }),
      ).toThrow(Error);
    });

    it("error preserves requestId", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      try {
        resolveContractApproval(tempDb.database, request.id, {
          decision: "REQUEST_CHANGES",
          comment: "   ",
        });
        expect.fail("should throw");
      } catch (error) {
        expect((error as ContractApprovalResolutionError).requestId).toBe(request.id);
      }
    });
  });

  describe("atomicity", () => {
    it("keeps request PENDING if updateTaskState fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_task_update
        AFTER UPDATE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'task abort');
        END;
      `);

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" }),
      ).toThrow();

      expect(getHumanRequestById(tempDb.database, request.id)?.status).toBe("PENDING");
    });

    it("keeps resolutionJson null if updateTaskState fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_task_update_json
        AFTER UPDATE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'task abort');
        END;
      `);

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" }),
      ).toThrow();

      expect(getHumanRequestById(tempDb.database, request.id)?.resolutionJson).toBeNull();
    });

    it("keeps resolvedAt null if updateTaskState fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_task_update_resolved_at
        AFTER UPDATE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'task abort');
        END;
      `);

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" }),
      ).toThrow();

      expect(getHumanRequestById(tempDb.database, request.id)?.resolvedAt).toBeNull();
    });

    it("keeps task in CONTRACT_APPROVAL_REQUIRED if resolveHumanRequest fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_request_update
        AFTER UPDATE ON human_requests
        BEGIN
          SELECT RAISE(ABORT, 'request abort');
        END;
      `);

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" }),
      ).toThrow();

      expect(getTaskById(tempDb.database, task.id)?.state).toBe("CONTRACT_APPROVAL_REQUIRED");
    });

    it("connection remains usable after rollback", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_request_update_2
        AFTER UPDATE ON human_requests
        BEGIN
          SELECT RAISE(ABORT, 'request abort');
        END;
      `);

      expect(() =>
        resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" }),
      ).toThrow();

      expect(getTaskById(tempDb.database, task.id)).toBeDefined();
    });

    it("no open transaction remains after success", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" });

      expect(getTaskById(tempDb.database, task.id)?.state).toBe("PREPARING_WORKSPACE");
    });
  });

  describe("isolation", () => {
    it("resolving one request does not affect another task", () => {
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

      const request1 = preparePendingApproval(tempDb, task1.id);
      const request2 = preparePendingApproval(tempDb, task2.id);

      resolveContractApproval(tempDb.database, request1.id, { decision: "APPROVE" });

      expect(getHumanRequestById(tempDb.database, request1.id)?.status).toBe("RESOLVED");
      expect(getHumanRequestById(tempDb.database, request2.id)?.status).toBe("PENDING");
      expect(getTaskById(tempDb.database, task2.id)?.state).toBe("CONTRACT_APPROVAL_REQUIRED");
    });

    it("a pending request of another task does not interfere", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task1 = createTestTask(tempDb, project.id);
      const task2 = createTask(tempDb.database, {
        id: "task-2",
        projectId: project.id,
        title: "Task 2",
        description: "Second",
        state: "CREATED",
        attempt: 0,
        maxAttempts: 3,
        contractJson: null,
        currentRevisionJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const request1 = preparePendingApproval(tempDb, task1.id);
      const request2 = preparePendingApproval(tempDb, task2.id);

      const result = resolveContractApproval(tempDb.database, request1.id, { decision: "APPROVE" });
      expect(result.humanRequest.id).toBe(request1.id);
      expect(getHumanRequestById(tempDb.database, request2.id)?.status).toBe("PENDING");
    });

    it("changes remain after reopening SQLite", async () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      const request = preparePendingApproval(tempDb, task.id);

      resolveContractApproval(tempDb.database, request.id, { decision: "APPROVE" });
      tempDb.close();

      const { DatabaseSync } = await import("node:sqlite");
      const { initializeSchema } = await import("../../src/db.js");
      const db = new DatabaseSync(tempDb.databasePath);
      initializeSchema(db);

      expect(getTaskById(db, task.id)?.state).toBe("PREPARING_WORKSPACE");
      db.close();
    });
  });
});
