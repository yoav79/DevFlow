/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { HumanRequest } from "../types.js";
import {
  getHumanRequestById,
  resolveHumanRequest,
} from "../repositories/human-request-repository.js";
import { getTaskById, updateTaskState } from "../repositories/task-repository.js";

export type FunctionalDecisionOrigin =
  | "DECOMPOSITION"
  | "DISCOVERY";

export type FunctionalDecisionResolution =
  | {
      origin: "DECOMPOSITION";
      decision: "EDIT_DECOMPOSITION";
      comment: string;
    }
  | {
      origin: "DECOMPOSITION";
      decision: "CANCEL_TASK";
      comment?: string;
    }
  | {
      origin: "DISCOVERY";
      decision: "PROVIDE_INFORMATION";
      comment: string;
    }
  | {
      origin: "DISCOVERY";
      decision: "CANCEL_TASK";
      comment?: string;
    };

export interface ResolveFunctionalDecisionResult {
  requestId: string;
  taskId: string;
  origin: FunctionalDecisionOrigin;
  decision: FunctionalDecisionResolution["decision"];
  previousTaskState: "HUMAN_REQUIRED";
  currentTaskState: "GENERATING_CONTRACT" | "CANCELLED";
  humanRequest: HumanRequest;
}

export class FunctionalDecisionResolutionError extends Error {
  readonly requestId: string;

  constructor(requestId: string, message: string) {
    super(message);
    this.name = "FunctionalDecisionResolutionError";
    this.requestId = requestId;
  }
}

const DECOMPOSITION_OPTIONS = [
  "ACCEPT_DECOMPOSITION",
  "EDIT_DECOMPOSITION",
  "CANCEL_TASK",
];

const DISCOVERY_OPTIONS = [
  "PROVIDE_INFORMATION",
  "RUN_DISCOVERY",
  "CANCEL_TASK",
];

function inferOrigin(requestId: string, optionsJson: string): FunctionalDecisionOrigin {
  let parsed: unknown;

  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    throw new FunctionalDecisionResolutionError(
      requestId,
      `No se puede determinar el origen de la solicitud funcional ${requestId}.`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new FunctionalDecisionResolutionError(
      requestId,
      `No se puede determinar el origen de la solicitud funcional ${requestId}.`,
    );
  }

  const isStringArray = (value: unknown[]): value is string[] =>
    value.every((item) => typeof item === "string");

  if (!isStringArray(parsed)) {
    throw new FunctionalDecisionResolutionError(
      requestId,
      `No se puede determinar el origen de la solicitud funcional ${requestId}.`,
    );
  }

  if (parsed.length === DECOMPOSITION_OPTIONS.length &&
      parsed.every((val, i) => val === DECOMPOSITION_OPTIONS[i])) {
    return "DECOMPOSITION";
  }

  if (parsed.length === DISCOVERY_OPTIONS.length &&
      parsed.every((val, i) => val === DISCOVERY_OPTIONS[i])) {
    return "DISCOVERY";
  }

  throw new FunctionalDecisionResolutionError(
    requestId,
    `No se puede determinar el origen de la solicitud funcional ${requestId}.`,
  );
}

function buildResolutionJson(
  origin: FunctionalDecisionOrigin,
  decision: FunctionalDecisionResolution["decision"],
  comment?: string,
): string {
  if (decision === "CANCEL_TASK") {
    const payload: Record<string, string> = { origin, decision };
    if (comment !== undefined) {
      payload.comment = comment;
    }
    return JSON.stringify(payload);
  }

  return JSON.stringify({ origin, decision, comment });
}

export function resolveFunctionalDecision(
  database: DatabaseSync,
  requestId: string,
  resolution: FunctionalDecisionResolution,
): ResolveFunctionalDecisionResult {
  const id = requestId.trim();

  if (id.length === 0) {
    throw new Error("El id de la solicitud no puede estar vacío.");
  }

  const initialRequest = getHumanRequestById(database, id);
  if (initialRequest === null) {
    throw new Error(`No existe la solicitud humana: ${id}`);
  }

  if (initialRequest.type !== "FUNCTIONAL_DECISION") {
    throw new FunctionalDecisionResolutionError(
      id,
      `La solicitud ${id} no es una decisión funcional.`,
    );
  }

  if (initialRequest.status !== "PENDING") {
    throw new FunctionalDecisionResolutionError(
      id,
      `La solicitud ${id} ya está cerrada con estado ${initialRequest.status}.`,
    );
  }

  const inferredOrigin = inferOrigin(id, initialRequest.optionsJson);

  if (inferredOrigin !== resolution.origin) {
    throw new FunctionalDecisionResolutionError(
      id,
      `La decisión ${resolution.decision} no es compatible con el origen ${inferredOrigin} de la solicitud ${id}.`,
    );
  }

  const initialTask = getTaskById(database, initialRequest.taskId);
  if (initialTask === null) {
    throw new Error(`No existe la tarea: ${initialRequest.taskId}`);
  }

  if (initialTask.state !== "HUMAN_REQUIRED") {
    throw new FunctionalDecisionResolutionError(
      id,
      `La tarea ${initialTask.id} no puede resolver una decisión funcional desde el estado ${initialTask.state}.`,
    );
  }

  if (resolution.decision === "EDIT_DECOMPOSITION") {
    const trimmed = resolution.comment.trim();
    if (trimmed.length === 0) {
      throw new FunctionalDecisionResolutionError(
        id,
        "La decisión EDIT_DECOMPOSITION requiere un comentario.",
      );
    }
  }

  if (resolution.decision === "PROVIDE_INFORMATION") {
    const trimmed = resolution.comment.trim();
    if (trimmed.length === 0) {
      throw new FunctionalDecisionResolutionError(
        id,
        "La decisión PROVIDE_INFORMATION requiere información.",
      );
    }
  }

  let normalizedComment: string | undefined;

  if (resolution.decision === "CANCEL_TASK") {
    if (resolution.comment !== undefined) {
      const trimmed = resolution.comment.trim();
      normalizedComment = trimmed.length === 0 ? undefined : trimmed;
    }
  } else if (resolution.decision === "EDIT_DECOMPOSITION" || resolution.decision === "PROVIDE_INFORMATION") {
    normalizedComment = (resolution.comment as string).trim();
  }

  const targetState =
    resolution.decision === "CANCEL_TASK" ? "CANCELLED" : "GENERATING_CONTRACT";

  const resolutionJson = buildResolutionJson(
    inferredOrigin,
    resolution.decision,
    normalizedComment,
  );

  const resolvedAt = new Date().toISOString();

  database.prepare("BEGIN IMMEDIATE").run();

  try {
    const request = getHumanRequestById(database, id);
    if (request === null) {
      throw new Error(`No existe la solicitud humana: ${id}`);
    }

    if (request.type !== "FUNCTIONAL_DECISION") {
      throw new FunctionalDecisionResolutionError(
        id,
        `La solicitud ${id} no es una decisión funcional.`,
      );
    }

    if (request.status !== "PENDING") {
      throw new FunctionalDecisionResolutionError(
        id,
        `La solicitud ${id} ya está cerrada con estado ${request.status}.`,
      );
    }

    const currentOrigin = inferOrigin(id, request.optionsJson);

    if (currentOrigin !== resolution.origin) {
      throw new FunctionalDecisionResolutionError(
        id,
        `La decisión ${resolution.decision} no es compatible con el origen ${currentOrigin} de la solicitud ${id}.`,
      );
    }

    const task = getTaskById(database, request.taskId);
    if (task === null) {
      throw new Error(`No existe la tarea: ${request.taskId}`);
    }

    if (task.state !== "HUMAN_REQUIRED") {
      throw new FunctionalDecisionResolutionError(
        id,
        `La tarea ${task.id} no puede resolver una decisión funcional desde el estado ${task.state}.`,
      );
    }

    const resolvedRequest = resolveHumanRequest(
      database,
      id,
      "RESOLVED",
      resolutionJson,
      resolvedAt,
    );

    if (resolvedRequest === null) {
      throw new Error(`No existe la solicitud humana: ${id}`);
    }

    updateTaskState(database, task.id, targetState, resolvedAt);

    const finalTask = getTaskById(database, task.id);
    if (finalTask === null || finalTask.state !== targetState) {
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
      origin: inferredOrigin,
      decision: resolution.decision,
      previousTaskState: "HUMAN_REQUIRED",
      currentTaskState: targetState,
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
