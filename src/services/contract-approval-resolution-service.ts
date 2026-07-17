/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { HumanRequest } from "../types.js";
import { getHumanRequestById, resolveHumanRequest } from "../repositories/human-request-repository.js";
import { getTaskById, updateTaskState } from "../repositories/task-repository.js";

export type ContractApprovalDecision =
  | {
      decision: "APPROVE";
      comment?: string;
    }
  | {
      decision: "REJECT";
      comment: string;
    }
  | {
      decision: "REQUEST_CHANGES";
      comment: string;
    };

export interface ResolveContractApprovalResult {
  requestId: string;
  taskId: string;
  decision: ContractApprovalDecision["decision"];
  previousTaskState: "CONTRACT_APPROVAL_REQUIRED";
  currentTaskState: "PREPARING_WORKSPACE" | "BLOCKED" | "GENERATING_CONTRACT";
  humanRequest: HumanRequest;
}

export class ContractApprovalResolutionError extends Error {
  readonly requestId: string;

  constructor(requestId: string, message: string) {
    super(message);
    this.name = "ContractApprovalResolutionError";
    this.requestId = requestId;
  }
}

function normalizeComment(comment: string | undefined): string | undefined {
  if (comment === undefined) {
    return undefined;
  }

  const normalized = comment.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function getDecisionPayload(
  requestId: string,
  decision: ContractApprovalDecision,
):
  | {
      status: "RESOLVED";
      state: "PREPARING_WORKSPACE" | "GENERATING_CONTRACT";
      resolutionJson: string;
      normalizedComment?: string;
    }
  | {
      status: "REJECTED";
      state: "BLOCKED";
      resolutionJson: string;
      normalizedComment?: string;
    } {
  switch (decision.decision) {
    case "APPROVE": {
      const normalizedComment = normalizeComment(decision.comment);
      const payload = normalizedComment === undefined
        ? { decision: "APPROVE" as const }
        : { decision: "APPROVE" as const, comment: normalizedComment };

      return {
        status: "RESOLVED",
        state: "PREPARING_WORKSPACE",
        resolutionJson: JSON.stringify(payload),
        normalizedComment,
      };
    }
    case "REQUEST_CHANGES": {
      const normalizedComment = normalizeComment(decision.comment);

      if (normalizedComment === undefined) {
        throw new ContractApprovalResolutionError(
          requestId,
          "La decisión REQUEST_CHANGES requiere un comentario.",
        );
      }

      return {
        status: "RESOLVED",
        state: "GENERATING_CONTRACT",
        resolutionJson: JSON.stringify({
          decision: "REQUEST_CHANGES" as const,
          comment: normalizedComment,
        }),
        normalizedComment,
      };
    }
    case "REJECT": {
      const normalizedComment = normalizeComment(decision.comment);

      if (normalizedComment === undefined) {
        throw new ContractApprovalResolutionError(
          requestId,
          "La decisión REJECT requiere un comentario.",
        );
      }

      return {
        status: "REJECTED",
        state: "BLOCKED",
        resolutionJson: JSON.stringify({
          decision: "REJECT" as const,
          comment: normalizedComment,
        }),
        normalizedComment,
      };
    }
    default: {
      const _exhaustive: never = decision;
      throw new ContractApprovalResolutionError(requestId, `Decisión desconocida: ${String(_exhaustive)}`);
    }
  }
}

export function resolveContractApproval(
  database: DatabaseSync,
  requestId: string,
  decision: ContractApprovalDecision,
): ResolveContractApprovalResult {
  const id = requestId.trim();

  if (id.length === 0) {
    throw new Error("El id de la solicitud no puede estar vacío.");
  }

  const initialRequest = getHumanRequestById(database, id);
  if (initialRequest === null) {
    throw new Error(`No existe la solicitud humana: ${id}`);
  }

  if (initialRequest.type !== "CONTRACT_APPROVAL") {
    throw new ContractApprovalResolutionError(id, `La solicitud ${id} no es una aprobación de contrato.`);
  }

  if (initialRequest.status !== "PENDING") {
    throw new ContractApprovalResolutionError(id, `La solicitud ${id} ya está cerrada con estado ${initialRequest.status}.`);
  }

  const initialTask = getTaskById(database, initialRequest.taskId);
  if (initialTask === null) {
    throw new Error(`No existe la tarea: ${initialRequest.taskId}`);
  }

  if (initialTask.state !== "CONTRACT_APPROVAL_REQUIRED") {
    throw new ContractApprovalResolutionError(
      id,
      `La tarea ${initialTask.id} no puede resolver una aprobación de contrato desde el estado ${initialTask.state}.`,
    );
  }

  const mapped = getDecisionPayload(id, decision);
  const resolvedAt = new Date().toISOString();

  database.prepare("BEGIN IMMEDIATE").run();

  try {
    const request = getHumanRequestById(database, id);
    if (request === null) {
      throw new Error(`No existe la solicitud humana: ${id}`);
    }

    if (request.type !== "CONTRACT_APPROVAL") {
      throw new ContractApprovalResolutionError(id, `La solicitud ${id} no es una aprobación de contrato.`);
    }

    if (request.status !== "PENDING") {
      throw new ContractApprovalResolutionError(id, `La solicitud ${id} ya está cerrada con estado ${request.status}.`);
    }

    const task = getTaskById(database, request.taskId);
    if (task === null) {
      throw new Error(`No existe la tarea: ${request.taskId}`);
    }

    if (task.state !== "CONTRACT_APPROVAL_REQUIRED") {
      throw new ContractApprovalResolutionError(
        id,
        `La tarea ${task.id} no puede resolver una aprobación de contrato desde el estado ${task.state}.`,
      );
    }

    const requestUpdate = resolveHumanRequest(
      database,
      id,
      mapped.status,
      mapped.resolutionJson,
      resolvedAt,
    );

    if (requestUpdate === null) {
      throw new Error(`No existe la solicitud humana: ${id}`);
    }

    updateTaskState(database, task.id, mapped.state, resolvedAt);

    const finalTask = getTaskById(database, task.id);
    if (finalTask === null || finalTask.state !== mapped.state) {
      throw new Error(`No se pudo confirmar el estado final de la tarea ${task.id}.`);
    }

    const finalRequest = getHumanRequestById(database, id);
    if (finalRequest === null) {
      throw new Error(`No existe la solicitud humana: ${id}`);
    }

    database.prepare("COMMIT").run();

    return {
      requestId: id,
      taskId: task.id,
      decision: decision.decision,
      previousTaskState: "CONTRACT_APPROVAL_REQUIRED",
      currentTaskState: mapped.state,
      humanRequest: finalRequest,
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
