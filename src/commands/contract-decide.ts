/// <reference types="node" />

import process from "node:process";

import { getDefaultDatabasePath, initializeSchema, openDatabase } from "../db.js";
import {
  resolveContractApproval,
  type ContractApprovalDecision,
} from "../services/contract-approval-resolution-service.js";

export interface ContractDecideOptions {
  request: string;
  decision: string;
  comment?: string;
}

function buildDecision(options: ContractDecideOptions): ContractApprovalDecision {
  const normalizedDecision = options.decision.trim().toUpperCase();

  switch (normalizedDecision) {
    case "APPROVE":
      return options.comment === undefined
        ? { decision: "APPROVE" }
        : { decision: "APPROVE", comment: options.comment };
    case "REJECT":
      return { decision: "REJECT", comment: options.comment ?? "" };
    case "REQUEST_CHANGES":
      return { decision: "REQUEST_CHANGES", comment: options.comment ?? "" };
    default:
      throw new Error(`Decisión de contrato no válida: ${normalizedDecision}`);
  }
}

export function runContractDecideCommand(options: ContractDecideOptions): void {
  const requestId = options.request.trim();

  if (requestId.length === 0) {
    throw new Error("El id de la solicitud no puede estar vacío.");
  }

  const decision = buildDecision(options);

  const database = openDatabase(getDefaultDatabasePath());

  try {
    initializeSchema(database);

    const result = resolveContractApproval(database, requestId, decision);

    process.stdout.write(
      `Decisión contractual aplicada: ${requestId}\n` +
        `Tarea: ${result.taskId}\n` +
        `Decisión: ${result.decision}\n` +
        `Estado anterior: CONTRACT_APPROVAL_REQUIRED\n` +
        `Estado actual: ${result.currentTaskState}\n` +
        `Estado de solicitud: ${result.humanRequest.status}\n`,
    );
  } finally {
    database.close();
  }
}
