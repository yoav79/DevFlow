/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import type { TaskContract, HumanRequest } from "../types.js";
import { getTaskById, updateTaskContract, updateTaskState } from "../repositories/task-repository.js";
import { createHumanRequest, getHumanRequestById, listPendingHumanRequests } from "../repositories/human-request-repository.js";

export interface PrepareContractApprovalResult {
  taskId: string;
  previousState: "GENERATING_CONTRACT";
  currentState: "CONTRACT_APPROVAL_REQUIRED";
  humanRequest: HumanRequest;
}

export class ContractApprovalPreparationError extends Error {
  readonly taskId: string;

  constructor(taskId: string, message: string) {
    super(message);
    this.name = "ContractApprovalPreparationError";
    this.taskId = taskId;
  }
}

export function prepareContractApproval(
  database: DatabaseSync,
  taskId: string,
  contract: TaskContract,
): PrepareContractApprovalResult {
  const id = taskId.trim();

  if (id.length === 0) {
    throw new Error("El id de la tarea no puede estar vacío.");
  }

  const task = getTaskById(database, id);
  if (task === null) {
    throw new Error(`No existe la tarea: ${id}`);
  }

  if (task.state !== "GENERATING_CONTRACT") {
    throw new ContractApprovalPreparationError(
      id,
      `La tarea ${id} no puede preparar aprobación de contrato desde el estado ${task.state}.`,
    );
  }

  const pendingRequests = listPendingHumanRequests(database);
  const hasPendingApproval = pendingRequests.some(
    (r) => r.taskId === id && r.type === "CONTRACT_APPROVAL",
  );
  if (hasPendingApproval) {
    throw new ContractApprovalPreparationError(
      id,
      `La tarea ${id} ya tiene una aprobación de contrato pendiente.`,
    );
  }

  database.prepare("BEGIN IMMEDIATE").run();

  try {
    const currentTask = getTaskById(database, id);
    if (currentTask === null || currentTask.state !== "GENERATING_CONTRACT") {
      throw new Error(`No existe la tarea: ${id}`);
    }

    const currentPending = listPendingHumanRequests(database);
    const stillHasPending = currentPending.some(
      (r) => r.taskId === id && r.type === "CONTRACT_APPROVAL",
    );
    if (stillHasPending) {
      throw new ContractApprovalPreparationError(
        id,
        `La tarea ${id} ya tiene una aprobación de contrato pendiente.`,
      );
    }

    updateTaskContract(database, id, contract);
    updateTaskState(database, id, "CONTRACT_APPROVAL_REQUIRED", new Date().toISOString());

    const requestId = randomUUID();
    const now = new Date().toISOString();
    const request: HumanRequest = {
      id: requestId,
      taskId: id,
      type: "CONTRACT_APPROVAL",
      question: `Revisa y aprueba el contrato de la tarea ${id}.`,
      optionsJson: JSON.stringify(["APPROVE", "REJECT", "REQUEST_CHANGES"]),
      resolutionJson: null,
      status: "PENDING",
      createdAt: now,
      resolvedAt: null,
    };

    createHumanRequest(database, request);

    const created = getHumanRequestById(database, requestId);
    if (created === null) {
      throw new Error("No se pudo recuperar la solicitud creada.");
    }

    database.prepare("COMMIT").run();

    return {
      taskId: id,
      previousState: "GENERATING_CONTRACT",
      currentState: "CONTRACT_APPROVAL_REQUIRED",
      humanRequest: created,
    };
  } catch (error) {
    try {
      database.prepare("ROLLBACK").run();
    } catch {
      // Rollback failure is logged but the original error is propagated.
    }
    throw error;
  }
}
