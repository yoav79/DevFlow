/// <reference types="node" />

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { HumanRequest, SupervisorResult } from "../types.js";
import { getTaskById, updateTaskState } from "../repositories/task-repository.js";
import {
  createHumanRequest,
  getHumanRequestById,
  listPendingHumanRequests,
  resolveHumanRequest,
} from "../repositories/human-request-repository.js";
import { prepareContractApproval } from "./contract-approval-service.js";

export type AppliedSupervisorOutcome =
  | {
      classification: "EXECUTABLE_TASK";
      taskId: string;
      currentState: "CONTRACT_APPROVAL_REQUIRED";
      humanRequest: HumanRequest;
    }
  | {
      classification: "NEEDS_DECOMPOSITION";
      taskId: string;
      currentState: "HUMAN_REQUIRED";
      humanRequest: HumanRequest;
    }
  | {
      classification: "NEEDS_DISCOVERY";
      taskId: string;
      currentState: "HUMAN_REQUIRED";
      humanRequest: HumanRequest;
    };

export class SupervisorResultApplicationError extends Error {
  readonly taskId: string;

  constructor(taskId: string, message: string) {
    super(message);
    this.name = "SupervisorResultApplicationError";
    this.taskId = taskId;
  }
}

function normalizeTaskId(taskId: string): string {
  return taskId.trim();
}

function buildDecompositionQuestion(taskId: string, result: Extract<SupervisorResult, { classification: "NEEDS_DECOMPOSITION" }>): string {
  const lines = [
    `La tarea ${taskId} necesita descomposición antes de poder ejecutarse.`,
    `Motivo: ${result.decompositionReason}`,
    `Tareas sugeridas:`,
    ...result.suggestedTasks.map((task, index) => `${index + 1}. ${task.title}: ${task.objective}`),
  ];

  if (result.openQuestions.length > 0) {
    lines.push(`Preguntas abiertas:`, ...result.openQuestions.map((question) => `- ${question}`));
  }

  return lines.join("\n");
}

function buildDiscoveryQuestion(taskId: string, result: Extract<SupervisorResult, { classification: "NEEDS_DISCOVERY" }>): string {
  const lines = [
    `La tarea ${taskId} necesita descubrimiento antes de poder ejecutarse.`,
    `Información faltante:`,
    ...result.missingInformation.map((item) => `- ${item}`),
    `Acciones recomendadas:`,
    ...result.recommendedDiscoveryActions.map((item) => `- ${item}`),
  ];

  if (result.openQuestions.length > 0) {
    lines.push(`Preguntas abiertas:`, ...result.openQuestions.map((question) => `- ${question}`));
  }

  return lines.join("\n");
}

function createFunctionalDecisionRequest(
  taskId: string,
  question: string,
  optionsJson: string,
): HumanRequest {
  return {
    id: randomUUID(),
    taskId,
    type: "FUNCTIONAL_DECISION",
    question,
    optionsJson,
    resolutionJson: null,
    status: "PENDING",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
}

export function applySupervisorResult(
  database: DatabaseSync,
  taskId: string,
  result: SupervisorResult,
): AppliedSupervisorOutcome {
  const id = normalizeTaskId(taskId);

  if (id.length === 0) {
    throw new Error("El id de la tarea no puede estar vacío.");
  }

  const task = getTaskById(database, id);
  if (task === null) {
    throw new Error(`No existe la tarea: ${id}`);
  }

  if (task.state !== "GENERATING_CONTRACT") {
    throw new SupervisorResultApplicationError(
      id,
      `La tarea ${id} no puede aplicar un resultado del supervisor desde el estado ${task.state}.`,
    );
  }

  switch (result.classification) {
    case "EXECUTABLE_TASK": {
      const approval = prepareContractApproval(database, id, result);
      return {
        classification: "EXECUTABLE_TASK",
        taskId: id,
        currentState: "CONTRACT_APPROVAL_REQUIRED",
        humanRequest: approval.humanRequest,
      };
    }
    case "NEEDS_DECOMPOSITION":
    case "NEEDS_DISCOVERY": {
      const pendingRequests = listPendingHumanRequests(database);
      const hasPendingFunctionalDecision = pendingRequests.some(
        (request) => request.taskId === id && request.type === "FUNCTIONAL_DECISION",
      );

      if (hasPendingFunctionalDecision) {
        throw new SupervisorResultApplicationError(
          id,
          `La tarea ${id} ya tiene una decisión funcional pendiente.`,
        );
      }

      const requestId = randomUUID();
      const createdAt = new Date().toISOString();
      const question =
        result.classification === "NEEDS_DECOMPOSITION"
          ? buildDecompositionQuestion(id, result)
          : buildDiscoveryQuestion(id, result);
      const optionsJson =
        result.classification === "NEEDS_DECOMPOSITION"
          ? JSON.stringify(["ACCEPT_DECOMPOSITION", "EDIT_DECOMPOSITION", "CANCEL_TASK"])
          : JSON.stringify(["PROVIDE_INFORMATION", "RUN_DISCOVERY", "CANCEL_TASK"]);

      database.prepare("BEGIN IMMEDIATE").run();

      try {
        const currentTask = getTaskById(database, id);
        if (currentTask === null) {
          throw new Error(`No existe la tarea: ${id}`);
        }

        if (currentTask.state !== "GENERATING_CONTRACT") {
          throw new SupervisorResultApplicationError(
            id,
            `La tarea ${id} no puede aplicar un resultado del supervisor desde el estado ${currentTask.state}.`,
          );
        }

        const currentPendingRequests = listPendingHumanRequests(database);
        const stillHasPendingFunctionalDecision = currentPendingRequests.some(
          (request) => request.taskId === id && request.type === "FUNCTIONAL_DECISION",
        );

        if (stillHasPendingFunctionalDecision) {
          throw new SupervisorResultApplicationError(
            id,
            `La tarea ${id} ya tiene una decisión funcional pendiente.`,
          );
        }

        updateTaskState(database, id, "HUMAN_REQUIRED", createdAt);

        const request = createFunctionalDecisionRequest(id, question, optionsJson);
        createHumanRequest(database, request);

        const createdRequest = getHumanRequestById(database, request.id);
        if (createdRequest === null) {
          throw new Error("No se pudo recuperar la solicitud creada.");
        }

        database.prepare("COMMIT").run();

        return {
          classification: result.classification,
          taskId: id,
          currentState: "HUMAN_REQUIRED",
          humanRequest: createdRequest,
        };
      } catch (error) {
        try {
          database.prepare("ROLLBACK").run();
        } catch {
          // Preserve the original failure.
        }

        throw error;
      }
    }
    default: {
      const _exhaustive: never = result;
      throw new SupervisorResultApplicationError(id, `Resultado del supervisor desconocido: ${String(_exhaustive)}`);
    }
  }
}
