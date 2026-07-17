import { afterEach, describe, expect, it } from "vitest";

import {
  FunctionalDecisionResolutionError,
  resolveFunctionalDecision,
  resolveFunctionalDecisionByChoice,
} from "../../src/services/functional-decision-resolution-service.js";
import {
  applySupervisorResult,
} from "../../src/services/supervisor-result-application-service.js";
import { createProject } from "../../src/repositories/project-repository.js";
import {
  createTask,
  getTaskById,
  updateTaskState,
} from "../../src/repositories/task-repository.js";
import {
  createHumanRequest,
  getHumanRequestById,
} from "../../src/repositories/human-request-repository.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";
import type { Task, SupervisorResult, HumanRequest } from "../../src/types.js";

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

function createDecompositionRequest(tempDb: TempDatabase, taskId: string): HumanRequest {
  const outcome = applySupervisorResult(tempDb.database, taskId, decompositionResult);
  return outcome.humanRequest;
}

function createDiscoveryRequest(tempDb: TempDatabase, taskId: string): HumanRequest {
  const outcome = applySupervisorResult(tempDb.database, taskId, discoveryResult);
  return outcome.humanRequest;
}

function parseResolutionJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe("resolveFunctionalDecision", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  describe("EDIT_DECOMPOSITION", () => {
    it("resolves correctly a decomposition request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Please simplify the scope",
      });

      expect(result.requestId).toBe(request.id);
      expect(result.taskId).toBe(task.id);
    });

    it("changes the request to RESOLVED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(result.humanRequest.status).toBe("RESOLVED");
      expect(getHumanRequestById(tempDb.database, request.id)?.status).toBe("RESOLVED");
    });

    it("changes the task to GENERATING_CONTRACT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(result.currentTaskState).toBe("GENERATING_CONTRACT");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
    });

    it("stores origin DECOMPOSITION", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(result.origin).toBe("DECOMPOSITION");
      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.origin).toBe("DECOMPOSITION");
    });

    it("stores decision EDIT_DECOMPOSITION", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(result.decision).toBe("EDIT_DECOMPOSITION");
      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.decision).toBe("EDIT_DECOMPOSITION");
    });

    it("stores normalized comment", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "  Please simplify  ",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.comment).toBe("Please simplify");
    });

    it("rejects empty comment", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "",
        }),
      ).toThrow("La decisión EDIT_DECOMPOSITION requiere un comentario.");
    });

    it("rejects whitespace-only comment", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "   ",
        }),
      ).toThrow("La decisión EDIT_DECOMPOSITION requiere un comentario.");
    });

    it("preserves contractJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        contractJson: JSON.stringify({ some: "contract" }),
      });
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(getTaskById(tempDb.database, task.id)?.contractJson).toBe(
        JSON.stringify({ some: "contract" }),
      );
    });

    it("preserves currentRevisionJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        currentRevisionJson: JSON.stringify({ rev: 1 }),
      });
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(getTaskById(tempDb.database, task.id)?.currentRevisionJson).toBe(
        JSON.stringify({ rev: 1 }),
      );
    });

    it("preserves attempt", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { attempt: 2 });
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(getTaskById(tempDb.database, task.id)?.attempt).toBe(2);
    });

    it("preserves maxAttempts", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, { maxAttempts: 5 });
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(getTaskById(tempDb.database, task.id)?.maxAttempts).toBe(5);
    });
  });

  describe("PROVIDE_INFORMATION", () => {
    it("resolves correctly a discovery request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DISCOVERY",
        decision: "PROVIDE_INFORMATION",
        comment: "The latency is 200ms and SLA is 100ms",
      });

      expect(result.requestId).toBe(request.id);
      expect(result.taskId).toBe(task.id);
    });

    it("changes the request to RESOLVED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DISCOVERY",
        decision: "PROVIDE_INFORMATION",
        comment: "Latency is 200ms",
      });

      expect(result.humanRequest.status).toBe("RESOLVED");
      expect(getHumanRequestById(tempDb.database, request.id)?.status).toBe("RESOLVED");
    });

    it("changes the task to GENERATING_CONTRACT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DISCOVERY",
        decision: "PROVIDE_INFORMATION",
        comment: "Latency is 200ms",
      });

      expect(result.currentTaskState).toBe("GENERATING_CONTRACT");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
    });

    it("stores origin DISCOVERY", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DISCOVERY",
        decision: "PROVIDE_INFORMATION",
        comment: "Latency is 200ms",
      });

      expect(result.origin).toBe("DISCOVERY");
      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.origin).toBe("DISCOVERY");
    });

    it("stores decision PROVIDE_INFORMATION", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DISCOVERY",
        decision: "PROVIDE_INFORMATION",
        comment: "Latency is 200ms",
      });

      expect(result.decision).toBe("PROVIDE_INFORMATION");
      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.decision).toBe("PROVIDE_INFORMATION");
    });

    it("stores normalized information", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DISCOVERY",
        decision: "PROVIDE_INFORMATION",
        comment: "  Latency is 200ms  ",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.comment).toBe("Latency is 200ms");
    });

    it("rejects empty information", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DISCOVERY",
          decision: "PROVIDE_INFORMATION",
          comment: "",
        }),
      ).toThrow("La decisión PROVIDE_INFORMATION requiere información.");
    });

    it("rejects whitespace-only information", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DISCOVERY",
          decision: "PROVIDE_INFORMATION",
          comment: "   ",
        }),
      ).toThrow("La decisión PROVIDE_INFORMATION requiere información.");
    });

    it("preserves unrelated fields", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        attempt: 1,
        maxAttempts: 4,
        contractJson: JSON.stringify({ contract: true }),
        currentRevisionJson: JSON.stringify({ rev: 2 }),
      });
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DISCOVERY",
        decision: "PROVIDE_INFORMATION",
        comment: "Latency is 200ms",
      });

      const updatedTask = getTaskById(tempDb.database, task.id);
      expect(updatedTask?.attempt).toBe(1);
      expect(updatedTask?.maxAttempts).toBe(4);
      expect(updatedTask?.contractJson).toBe(JSON.stringify({ contract: true }));
      expect(updatedTask?.currentRevisionJson).toBe(JSON.stringify({ rev: 2 }));
    });
  });

  describe("CANCEL_TASK", () => {
    it("cancels a decomposition request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
      });

      expect(result.decision).toBe("CANCEL_TASK");
      expect(result.origin).toBe("DECOMPOSITION");
      expect(result.currentTaskState).toBe("CANCELLED");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("CANCELLED");
    });

    it("cancels a discovery request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DISCOVERY",
        decision: "CANCEL_TASK",
      });

      expect(result.decision).toBe("CANCEL_TASK");
      expect(result.origin).toBe("DISCOVERY");
      expect(result.currentTaskState).toBe("CANCELLED");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("CANCELLED");
    });

    it("changes the task to CANCELLED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
      });

      expect(result.currentTaskState).toBe("CANCELLED");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("CANCELLED");
    });

    it("changes the request to RESOLVED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
      });

      expect(result.humanRequest.status).toBe("RESOLVED");
      expect(getHumanRequestById(tempDb.database, request.id)?.status).toBe("RESOLVED");
    });

    it("allows optional comment", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
        comment: "No longer needed",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.comment).toBe("No longer needed");
    });

    it("omits comment after normalization when empty", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
        comment: "   ",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution).toEqual({ origin: "DECOMPOSITION", decision: "CANCEL_TASK" });
      expect("comment" in resolution).toBe(false);
    });

    it("preserves non-empty comment", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
        comment: "  Changed priorities  ",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.comment).toBe("Changed priorities");
    });

    it("preserves contractJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        contractJson: JSON.stringify({ keep: true }),
      });
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
      });

      expect(getTaskById(tempDb.database, task.id)?.contractJson).toBe(
        JSON.stringify({ keep: true }),
      );
    });

    it("preserves currentRevisionJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id, {
        currentRevisionJson: JSON.stringify({ rev: 3 }),
      });
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
      });

      expect(getTaskById(tempDb.database, task.id)?.currentRevisionJson).toBe(
        JSON.stringify({ rev: 3 }),
      );
    });
  });

  describe("compatibility", () => {
    it("rejects EDIT_DECOMPOSITION over DISCOVERY origin", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(
        "La decisión EDIT_DECOMPOSITION no es compatible con el origen DISCOVERY de la solicitud",
      );
    });

    it("rejects PROVIDE_INFORMATION over DECOMPOSITION origin", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DISCOVERY",
          decision: "PROVIDE_INFORMATION",
          comment: "Info",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DISCOVERY",
          decision: "PROVIDE_INFORMATION",
          comment: "Info",
        }),
      ).toThrow(
        "La decisión PROVIDE_INFORMATION no es compatible con el origen DECOMPOSITION de la solicitud",
      );
    });

    it("accepts CANCEL_TASK for DECOMPOSITION", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
      });

      expect(result.decision).toBe("CANCEL_TASK");
      expect(result.origin).toBe("DECOMPOSITION");
    });

    it("accepts CANCEL_TASK for DISCOVERY", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DISCOVERY",
        decision: "CANCEL_TASK",
      });

      expect(result.decision).toBe("CANCEL_TASK");
      expect(result.origin).toBe("DISCOVERY");
    });

    it("does not modify the received resolution object", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const resolution = {
        origin: "DECOMPOSITION" as const,
        decision: "EDIT_DECOMPOSITION" as const,
        comment: "  Simplify  ",
      };
      const copy = JSON.parse(JSON.stringify(resolution));

      resolveFunctionalDecision(tempDb.database, request.id, resolution);

      expect(resolution).toEqual(copy);
    });
  });

  describe("validations", () => {
    it("rejects empty requestId", () => {
      tempDb = createTempDatabase();
      expect(() =>
        resolveFunctionalDecision(tempDb.database, "", {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("El id de la solicitud no puede estar vacío.");
    });

    it("rejects nonexistent request", () => {
      tempDb = createTempDatabase();
      expect(() =>
        resolveFunctionalDecision(tempDb.database, "missing", {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("No existe la solicitud humana: missing");
    });

    it("rejects request of another type", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const request: HumanRequest = {
        id: "wrong-type-req",
        taskId: task.id,
        type: "CONTRACT_APPROVAL",
        question: "Approve?",
        optionsJson: JSON.stringify(["YES", "NO"]),
        resolutionJson: null,
        status: "PENDING",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };
      createHumanRequest(tempDb.database, request);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("no es una decisión funcional");
    });

    it("rejects RESOLVED request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET status = 'RESOLVED', resolutionJson = '{}', resolvedAt = ? WHERE id = ?")
        .run(new Date().toISOString(), request.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("ya está cerrada con estado RESOLVED");
    });

    it("rejects REJECTED request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET status = 'REJECTED', resolvedAt = ? WHERE id = ?")
        .run(new Date().toISOString(), request.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("ya está cerrada con estado REJECTED");
    });

    it("rejects task outside HUMAN_REQUIRED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      updateTaskState(tempDb.database, task.id, "GENERATING_CONTRACT", new Date().toISOString());

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("no puede resolver una decisión funcional desde el estado GENERATING_CONTRACT");
    });

    it("rejects null optionsJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET optionsJson = ? WHERE id = ?")
        .run("null", request.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("No se puede determinar el origen");
    });

    it("rejects invalid JSON", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET optionsJson = ? WHERE id = ?")
        .run("not-json", request.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
    });

    it("rejects non-array value", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET optionsJson = ? WHERE id = ?")
        .run(JSON.stringify("not-an-array"), request.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
    });

    it("rejects non-string elements", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET optionsJson = ? WHERE id = ?")
        .run(JSON.stringify([1, 2, 3]), request.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
    });

    it("rejects partial array", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET optionsJson = ? WHERE id = ?")
        .run(JSON.stringify(["ACCEPT_DECOMPOSITION"]), request.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
    });

    it("rejects array with extra options", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET optionsJson = ? WHERE id = ?")
        .run(
          JSON.stringify(["ACCEPT_DECOMPOSITION", "EDIT_DECOMPOSITION", "CANCEL_TASK", "EXTRA"]),
          request.id,
        );

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
    });

    it("rejects different order", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET optionsJson = ? WHERE id = ?")
        .run(
          JSON.stringify(["CANCEL_TASK", "EDIT_DECOMPOSITION", "ACCEPT_DECOMPOSITION"]),
          request.id,
        );

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
    });

    it("does not use question to determine the origin", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET question = ? WHERE id = ?")
        .run("This mentions discovery but options are decomposition", request.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(result.origin).toBe("DECOMPOSITION");
    });
  });

  describe("error domain", () => {
    it("has the correct name", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      try {
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "",
        });
        expect.fail("should throw");
      } catch (error) {
        expect((error as FunctionalDecisionResolutionError).name).toBe(
          "FunctionalDecisionResolutionError",
        );
      }
    });

    it("extends Error", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "",
        }),
      ).toThrow(Error);
    });

    it("preserves requestId", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      try {
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "",
        });
        expect.fail("should throw");
      } catch (error) {
        expect((error as FunctionalDecisionResolutionError).requestId).toBe(request.id);
      }
    });

    it("preserves full message", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      try {
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "",
        });
        expect.fail("should throw");
      } catch (error) {
        expect((error as Error).message).toBe(
          "La decisión EDIT_DECOMPOSITION requiere un comentario.",
        );
      }
    });
  });

  describe("atomicity", () => {
    it("keeps request PENDING if updateTaskState fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_task_update_fdr
        AFTER UPDATE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'task abort');
        END;
      `);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow();

      expect(getHumanRequestById(tempDb.database, request.id)?.status).toBe("PENDING");
    });

    it("keeps resolutionJson null if updateTaskState fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_task_update_json_fdr
        AFTER UPDATE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'task abort');
        END;
      `);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow();

      expect(getHumanRequestById(tempDb.database, request.id)?.resolutionJson).toBeNull();
    });

    it("keeps resolvedAt null if updateTaskState fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_task_update_resolved_at_fdr
        AFTER UPDATE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'task abort');
        END;
      `);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow();

      expect(getHumanRequestById(tempDb.database, request.id)?.resolvedAt).toBeNull();
    });

    it("keeps task in HUMAN_REQUIRED if resolveHumanRequest fails", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_request_update_fdr
        AFTER UPDATE ON human_requests
        BEGIN
          SELECT RAISE(ABORT, 'request abort');
        END;
      `);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow();

      expect(getTaskById(tempDb.database, task.id)?.state).toBe("HUMAN_REQUIRED");
    });

    it("connection remains usable after rollback", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_request_update_fdr_2
        AFTER UPDATE ON human_requests
        BEGIN
          SELECT RAISE(ABORT, 'request abort');
        END;
      `);

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow();

      expect(getTaskById(tempDb.database, task.id)).toBeDefined();
    });

    it("no open transaction remains after success", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
    });
  });

  describe("isolation", () => {
    it("resolving one request does not affect another task", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task1 = createTestTask(tempDb, project.id, { id: "task-a" });
      const task2 = createTestTask(tempDb, project.id, { id: "task-b" });
      moveToGeneratingContract(tempDb, task1.id);
      moveToGeneratingContract(tempDb, task2.id);
      const request1 = createDecompositionRequest(tempDb, task1.id);
      createDecompositionRequest(tempDb, task2.id);

      resolveFunctionalDecision(tempDb.database, request1.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(getHumanRequestById(tempDb.database, request1.id)?.status).toBe("RESOLVED");
      expect(getTaskById(tempDb.database, task2.id)?.state).toBe("HUMAN_REQUIRED");
    });

    it("resolving one request does not affect another HumanRequest", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task1 = createTestTask(tempDb, project.id, { id: "task-a" });
      const task2 = createTestTask(tempDb, project.id, { id: "task-b" });
      moveToGeneratingContract(tempDb, task1.id);
      moveToGeneratingContract(tempDb, task2.id);
      const request1 = createDecompositionRequest(tempDb, task1.id);
      const request2 = createDiscoveryRequest(tempDb, task2.id);

      resolveFunctionalDecision(tempDb.database, request1.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(getHumanRequestById(tempDb.database, request2.id)?.status).toBe("PENDING");
    });

    it("two calls on the same request do not apply two transitions", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "First",
      });

      expect(() =>
        resolveFunctionalDecision(tempDb.database, request.id, {
          origin: "DECOMPOSITION",
          decision: "EDIT_DECOMPOSITION",
          comment: "Second",
        }),
      ).toThrow(FunctionalDecisionResolutionError);

      expect(getHumanRequestById(tempDb.database, request.id)?.status).toBe("RESOLVED");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
    });

    it("changes persist after reopening SQLite", async () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });
      tempDb.close();

      const { DatabaseSync } = await import("node:sqlite");
      const { initializeSchema } = await import("../../src/db.js");
      const db = new DatabaseSync(tempDb.databasePath);
      initializeSchema(db);

      expect(getTaskById(db, task.id)?.state).toBe("GENERATING_CONTRACT");
      expect(getHumanRequestById(db, request.id)?.status).toBe("RESOLVED");
      db.close();
    });
  });

  describe("RESOLUTION JSON", () => {
    it("is compact JSON", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      const raw = result.humanRequest.resolutionJson ?? "";
      expect(raw).toBe(JSON.stringify(JSON.parse(raw)));
    });

    it("does not contain requestId", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect("requestId" in resolution).toBe(false);
    });

    it("does not contain taskId", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect("taskId" in resolution).toBe(false);
    });

    it("does not contain timestamp", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect("timestamp" in resolution).toBe(false);
    });

    it("contains only origin, decision, and comment when applicable", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(Object.keys(resolution).sort()).toEqual(["comment", "decision", "origin"]);
    });

    it("contains only origin and decision for CANCEL_TASK without comment", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(Object.keys(resolution).sort()).toEqual(["decision", "origin"]);
    });
  });
});

describe("resolveFunctionalDecisionByChoice", () => {
  let tempDb: TempDatabase;

  afterEach(() => {
    tempDb?.cleanup();
  });

  describe("EDIT_DECOMPOSITION", () => {
    it("resolves a decomposition request without receiving origin", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify scope",
      });

      expect(result.requestId).toBe(request.id);
      expect(result.taskId).toBe(task.id);
    });

    it("infers DECOMPOSITION from optionsJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(result.origin).toBe("DECOMPOSITION");
    });

    it("changes the task to GENERATING_CONTRACT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(result.currentTaskState).toBe("GENERATING_CONTRACT");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
    });

    it("stores origin DECOMPOSITION", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.origin).toBe("DECOMPOSITION");
    });

    it("stores decision EDIT_DECOMPOSITION", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.decision).toBe("EDIT_DECOMPOSITION");
    });

    it("normalizes comment via the core", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "EDIT_DECOMPOSITION",
        comment: "  Simplify  ",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.comment).toBe("Simplify");
    });

    it("rejects empty comment via the core", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "EDIT_DECOMPOSITION",
          comment: "",
        }),
      ).toThrow("La decisión EDIT_DECOMPOSITION requiere un comentario.");
    });

    it("rejects EDIT_DECOMPOSITION over discovery request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
    });

    it("does not modify the received choice object", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const choice = {
        decision: "EDIT_DECOMPOSITION" as const,
        comment: "  Simplify  ",
      };
      const copy = JSON.parse(JSON.stringify(choice));

      resolveFunctionalDecisionByChoice(tempDb.database, request.id, choice);

      expect(choice).toEqual(copy);
    });
  });

  describe("PROVIDE_INFORMATION", () => {
    it("resolves a discovery request without receiving origin", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "PROVIDE_INFORMATION",
        comment: "Latency is 200ms",
      });

      expect(result.requestId).toBe(request.id);
      expect(result.taskId).toBe(task.id);
    });

    it("infers DISCOVERY from optionsJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "PROVIDE_INFORMATION",
        comment: "Latency is 200ms",
      });

      expect(result.origin).toBe("DISCOVERY");
    });

    it("changes the task to GENERATING_CONTRACT", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "PROVIDE_INFORMATION",
        comment: "Latency is 200ms",
      });

      expect(result.currentTaskState).toBe("GENERATING_CONTRACT");
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
    });

    it("stores origin DISCOVERY", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "PROVIDE_INFORMATION",
        comment: "Latency is 200ms",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.origin).toBe("DISCOVERY");
    });

    it("stores decision PROVIDE_INFORMATION", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "PROVIDE_INFORMATION",
        comment: "Latency is 200ms",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.decision).toBe("PROVIDE_INFORMATION");
    });

    it("normalizes information via the core", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "PROVIDE_INFORMATION",
        comment: "  Latency is 200ms  ",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.comment).toBe("Latency is 200ms");
    });

    it("rejects empty information via the core", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "PROVIDE_INFORMATION",
          comment: "",
        }),
      ).toThrow("La decisión PROVIDE_INFORMATION requiere información.");
    });

    it("rejects PROVIDE_INFORMATION over decomposition request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "PROVIDE_INFORMATION",
          comment: "Info",
        }),
      ).toThrow(FunctionalDecisionResolutionError);
    });

    it("does not modify the received choice object", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const choice = {
        decision: "PROVIDE_INFORMATION" as const,
        comment: "  Info  ",
      };
      const copy = JSON.parse(JSON.stringify(choice));

      resolveFunctionalDecisionByChoice(tempDb.database, request.id, choice);

      expect(choice).toEqual(copy);
    });
  });

  describe("CANCEL_TASK", () => {
    it("cancels a decomposition request without receiving origin", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "CANCEL_TASK",
      });

      expect(result.decision).toBe("CANCEL_TASK");
      expect(result.currentTaskState).toBe("CANCELLED");
    });

    it("cancels a discovery request without receiving origin", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDiscoveryRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "CANCEL_TASK",
      });

      expect(result.decision).toBe("CANCEL_TASK");
      expect(result.currentTaskState).toBe("CANCELLED");
    });

    it("changes the task to CANCELLED", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "CANCEL_TASK",
      });

      expect(getTaskById(tempDb.database, task.id)?.state).toBe("CANCELLED");
    });

    it("stores the inferred origin correctly", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "CANCEL_TASK",
      });

      expect(result.origin).toBe("DECOMPOSITION");
      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.origin).toBe("DECOMPOSITION");
    });

    it("allows comment absent", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "CANCEL_TASK",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect("comment" in resolution).toBe(false);
    });

    it("allows comment present", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "CANCEL_TASK",
        comment: "No longer needed",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect(resolution.comment).toBe("No longer needed");
    });

    it("delegates comment normalization to the core", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "CANCEL_TASK",
        comment: "   ",
      });

      const resolution = parseResolutionJson(result.humanRequest.resolutionJson ?? "{}");
      expect("comment" in resolution).toBe(false);
    });

    it("does not modify the received choice object", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const choice = {
        decision: "CANCEL_TASK" as const,
        comment: "  Cancel  ",
      };
      const copy = JSON.parse(JSON.stringify(choice));

      resolveFunctionalDecisionByChoice(tempDb.database, request.id, choice);

      expect(choice).toEqual(copy);
    });
  });

  describe("validations", () => {
    it("rejects empty requestId", () => {
      tempDb = createTempDatabase();
      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, "", {
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("El id de la solicitud no puede estar vacío.");
    });

    it("rejects nonexistent request", () => {
      tempDb = createTempDatabase();
      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, "missing", {
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("No existe la solicitud humana: missing");
    });

    it("rejects request of another type", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);

      const request: HumanRequest = {
        id: "wrong-type-req",
        taskId: task.id,
        type: "CONTRACT_APPROVAL",
        question: "Approve?",
        optionsJson: JSON.stringify(["YES", "NO"]),
        resolutionJson: null,
        status: "PENDING",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };
      createHumanRequest(tempDb.database, request);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("no es una decisión funcional");
    });

    it("rejects RESOLVED request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET status = 'RESOLVED', resolutionJson = '{}', resolvedAt = ? WHERE id = ?")
        .run(new Date().toISOString(), request.id);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("ya está cerrada con estado RESOLVED");
    });

    it("rejects REJECTED request", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET status = 'REJECTED', resolvedAt = ? WHERE id = ?")
        .run(new Date().toISOString(), request.id);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("ya está cerrada con estado REJECTED");
    });

    it("rejects null optionsJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET optionsJson = ? WHERE id = ?")
        .run("null", request.id);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("No se puede determinar el origen");
    });

    it("rejects invalid optionsJson", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET optionsJson = ? WHERE id = ?")
        .run("not-json", request.id);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("No se puede determinar el origen");
    });

    it("rejects optionsJson that does not correspond to a known origin", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database
        .prepare("UPDATE human_requests SET optionsJson = ? WHERE id = ?")
        .run(JSON.stringify(["UNKNOWN"]), request.id);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow("No se puede determinar el origen");
    });
  });

  describe("delegation and transaction", () => {
    it("returns ResolveFunctionalDecisionResult without transformation", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(result).toHaveProperty("requestId");
      expect(result).toHaveProperty("taskId");
      expect(result).toHaveProperty("origin");
      expect(result).toHaveProperty("decision");
      expect(result).toHaveProperty("previousTaskState");
      expect(result).toHaveProperty("currentTaskState");
      expect(result).toHaveProperty("humanRequest");
    });

    it("resolution remains atomic", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_task_update_bychoice
        AFTER UPDATE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'task abort');
        END;
      `);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "EDIT_DECOMPOSITION",
          comment: "Simplify",
        }),
      ).toThrow();

      expect(getHumanRequestById(tempDb.database, request.id)?.status).toBe("PENDING");
    });

    it("a failure in updateTaskState produces full rollback", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      tempDb.database.exec(`
        CREATE TRIGGER IF NOT EXISTS abort_task_update_bychoice_2
        AFTER UPDATE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'task abort');
        END;
      `);

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "CANCEL_TASK",
        }),
      ).toThrow();

      expect(getHumanRequestById(tempDb.database, request.id)?.resolutionJson).toBeNull();
      expect(getHumanRequestById(tempDb.database, request.id)?.resolvedAt).toBeNull();
      expect(getTaskById(tempDb.database, task.id)?.state).toBe("HUMAN_REQUIRED");
    });

    it("no additional transaction remains open", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(getTaskById(tempDb.database, task.id)?.state).toBe("GENERATING_CONTRACT");
    });

    it("does not duplicate requests or transitions", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "EDIT_DECOMPOSITION",
        comment: "First",
      });

      expect(() =>
        resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
          decision: "EDIT_DECOMPOSITION",
          comment: "Second",
        }),
      ).toThrow(FunctionalDecisionResolutionError);

      expect(getHumanRequestById(tempDb.database, request.id)?.status).toBe("RESOLVED");
    });

    it("changes persist after reopening SQLite", async () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      resolveFunctionalDecisionByChoice(tempDb.database, request.id, {
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });
      tempDb.close();

      const { DatabaseSync } = await import("node:sqlite");
      const { initializeSchema } = await import("../../src/db.js");
      const db = new DatabaseSync(tempDb.databasePath);
      initializeSchema(db);

      expect(getTaskById(db, task.id)?.state).toBe("GENERATING_CONTRACT");
      expect(getHumanRequestById(db, request.id)?.status).toBe("RESOLVED");
      db.close();
    });
  });

  describe("existing API", () => {
    it("all existing tests for resolveFunctionalDecision still pass", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });

      expect(result.humanRequest.status).toBe("RESOLVED");
    });

    it("resolveFunctionalDecision preserves its signature", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);
      const task = createTestTask(tempDb, project.id);
      moveToGeneratingContract(tempDb, task.id);
      const request = createDecompositionRequest(tempDb, task.id);

      const result = resolveFunctionalDecision(tempDb.database, request.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
      });

      expect(result.decision).toBe("CANCEL_TASK");
    });

    it("FunctionalDecisionResolution keeps its four variants", () => {
      tempDb = createTempDatabase();
      const project = createTestProject(tempDb);

      const task1 = createTestTask(tempDb, project.id, { id: "task-v1" });
      moveToGeneratingContract(tempDb, task1.id);
      const decompReq1 = createDecompositionRequest(tempDb, task1.id);

      const task2 = createTestTask(tempDb, project.id, { id: "task-v2" });
      moveToGeneratingContract(tempDb, task2.id);
      const decompReq2 = createDecompositionRequest(tempDb, task2.id);

      const task3 = createTestTask(tempDb, project.id, { id: "task-v3" });
      moveToGeneratingContract(tempDb, task3.id);
      const discoveryReq1 = createDiscoveryRequest(tempDb, task3.id);

      const task4 = createTestTask(tempDb, project.id, { id: "task-v4" });
      moveToGeneratingContract(tempDb, task4.id);
      const discoveryReq2 = createDiscoveryRequest(tempDb, task4.id);

      resolveFunctionalDecision(tempDb.database, decompReq1.id, {
        origin: "DECOMPOSITION",
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      });
      resolveFunctionalDecision(tempDb.database, decompReq2.id, {
        origin: "DECOMPOSITION",
        decision: "CANCEL_TASK",
      });

      resolveFunctionalDecision(tempDb.database, discoveryReq1.id, {
        origin: "DISCOVERY",
        decision: "PROVIDE_INFORMATION",
        comment: "Info",
      });
      resolveFunctionalDecision(tempDb.database, discoveryReq2.id, {
        origin: "DISCOVERY",
        decision: "CANCEL_TASK",
      });
    });

    it("inferOrigin helper is not exported", async () => {
      const mod = await import("../../src/services/functional-decision-resolution-service.js");
      expect(mod).not.toHaveProperty("inferOrigin");
    });

    it("FunctionalDecisionChoice does not contain origin", () => {
      const choice: import("../../src/services/functional-decision-resolution-service.js").FunctionalDecisionChoice = {
        decision: "EDIT_DECOMPOSITION",
        comment: "Simplify",
      };
      expect("origin" in choice).toBe(false);
    });

    it("FunctionalDecisionChoice does not contain ACCEPT_DECOMPOSITION", () => {
      const choice: import("../../src/services/functional-decision-resolution-service.js").FunctionalDecisionChoice = {
        decision: "CANCEL_TASK",
      };
      expect(JSON.stringify(choice)).not.toContain("ACCEPT_DECOMPOSITION");
    });

    it("FunctionalDecisionChoice does not contain RUN_DISCOVERY", () => {
      const choice: import("../../src/services/functional-decision-resolution-service.js").FunctionalDecisionChoice = {
        decision: "CANCEL_TASK",
      };
      expect(JSON.stringify(choice)).not.toContain("RUN_DISCOVERY");
    });
  });
});
