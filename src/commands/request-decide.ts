/// <reference types="node" />

import process from "node:process";

import { getDefaultDatabasePath, initializeSchema, openDatabase } from "../db.js";
import {
  resolveFunctionalDecisionByChoice,
  type FunctionalDecisionChoice,
} from "../services/functional-decision-resolution-service.js";

export interface RequestDecideOptions {
  request: string;
  decision: string;
  comment?: string;
}

function buildChoice(options: RequestDecideOptions): FunctionalDecisionChoice {
  const normalizedDecision = options.decision.trim().toUpperCase();

  switch (normalizedDecision) {
    case "EDIT_DECOMPOSITION":
      return { decision: "EDIT_DECOMPOSITION", comment: options.comment ?? "" };
    case "PROVIDE_INFORMATION":
      return { decision: "PROVIDE_INFORMATION", comment: options.comment ?? "" };
    case "CANCEL_TASK":
      return options.comment === undefined
        ? { decision: "CANCEL_TASK" }
        : { decision: "CANCEL_TASK", comment: options.comment };
    default:
      throw new Error(`Decisión funcional no válida: ${normalizedDecision}`);
  }
}

export function runRequestDecideCommand(options: RequestDecideOptions): void {
  const requestId = options.request.trim();

  if (requestId.length === 0) {
    throw new Error("El id de la solicitud no puede estar vacío.");
  }

  const choice = buildChoice(options);

  const database = openDatabase(getDefaultDatabasePath());

  try {
    initializeSchema(database);

    const result = resolveFunctionalDecisionByChoice(database, requestId, choice);

    process.stdout.write(
      `Decisión funcional aplicada: ${requestId}\n` +
        `Tarea: ${result.taskId}\n` +
        `Origen: ${result.origin}\n` +
        `Decisión: ${result.decision}\n` +
        `Estado anterior: HUMAN_REQUIRED\n` +
        `Estado actual: ${result.currentTaskState}\n` +
        `Estado de solicitud: ${result.humanRequest.status}\n`,
    );
  } finally {
    database.close();
  }
}
