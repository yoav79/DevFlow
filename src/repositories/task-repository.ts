/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { Task, TaskContract, TaskState } from "../types.js";
import { executableTaskContractSchema } from "../schemas/supervisor-result-schema.js";
import { validateSupervisorResultSemantics } from "../services/supervisor-result-semantic-validator.js";

export interface DeterministicRevisionClaim {
  readonly kind: "DETERMINISTIC_REVISION_CLAIM";
  readonly claimId: string;
  readonly taskId: string;
  readonly claimedAt: string;
}

export type DeterministicRevisionFinalState = "REVIEWING" | "REVISION_REQUIRED";

function requireNonEmptyString(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} no puede estar vacío.`);
  }

  return value;
}

function mapRowToTask(row: Record<string, unknown>): Task {
  return {
    id: String(row["id"]),
    projectId: String(row["projectId"]),
    title: String(row["title"]),
    description: String(row["description"]),
    state: String(row["state"]) as TaskState,
    attempt: Number(row["attempt"]),
    maxAttempts: Number(row["maxAttempts"]),
    contractJson: row["contractJson"] === null ? null : String(row["contractJson"]),
    currentRevisionJson: row["currentRevisionJson"] === null ? null : String(row["currentRevisionJson"]),
    createdAt: String(row["createdAt"]),
    updatedAt: String(row["updatedAt"]),
  };
}

export function createTask(database: DatabaseSync, task: Task): Task {
  database
    .prepare(
      "INSERT INTO tasks (id, projectId, title, description, state, attempt, maxAttempts, contractJson, currentRevisionJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      task.id,
      task.projectId,
      task.title,
      task.description,
      task.state,
      task.attempt,
      task.maxAttempts,
      task.contractJson,
      task.currentRevisionJson,
      task.createdAt,
      task.updatedAt,
    );

  return task;
}

export function getTaskById(database: DatabaseSync, taskId: string): Task | null {
  const row = database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
    | Record<string, unknown>
    | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRowToTask(row);
}

export function listTasksByProjectId(database: DatabaseSync, projectId: string): Task[] {
  const rows = database
    .prepare("SELECT * FROM tasks WHERE projectId = ? ORDER BY createdAt ASC, id ASC")
    .all(projectId) as Record<string, unknown>[];

  return rows.map(mapRowToTask);
}

export function updateTaskState(
  database: DatabaseSync,
  taskId: string,
  state: TaskState,
  updatedAt: string,
): Task | null {
  database
    .prepare("UPDATE tasks SET state = ?, updatedAt = ? WHERE id = ?")
    .run(state, updatedAt, taskId);

  return getTaskById(database, taskId);
}

export function claimTaskDeterministicRevision(
  database: DatabaseSync,
  taskId: string,
  expectedCurrentRevisionJson: string | null,
  claimJson: string,
  updatedAt: string,
): boolean {
  const id = requireNonEmptyString(taskId, "El id de la tarea");
  const nextRevisionJson = requireNonEmptyString(claimJson, "claimJson");
  const nextUpdatedAt = requireNonEmptyString(updatedAt, "updatedAt");

  let result: { changes: number | bigint };

  if (expectedCurrentRevisionJson === null) {
    result = database
      .prepare(
        "UPDATE tasks SET currentRevisionJson = ?, updatedAt = ? WHERE id = ? AND state = 'VERIFYING' AND currentRevisionJson IS NULL",
      )
      .run(nextRevisionJson, nextUpdatedAt, id) as { changes: number | bigint };
  } else {
    const expectedRevisionJson = requireNonEmptyString(
      expectedCurrentRevisionJson,
      "expectedCurrentRevisionJson",
    );

    result = database
      .prepare(
        "UPDATE tasks SET currentRevisionJson = ?, updatedAt = ? WHERE id = ? AND state = 'VERIFYING' AND currentRevisionJson = ?",
      )
      .run(nextRevisionJson, nextUpdatedAt, id, expectedRevisionJson) as {
        changes: number | bigint;
      };
  }

  return Number(result.changes) === 1;
}

export function finalizeTaskDeterministicRevision(
  database: DatabaseSync,
  taskId: string,
  expectedClaimJson: string,
  finalRevisionJson: string,
  nextState: DeterministicRevisionFinalState,
  updatedAt: string,
): boolean {
  const id = requireNonEmptyString(taskId, "El id de la tarea");
  const expectedRevisionJson = requireNonEmptyString(
    expectedClaimJson,
    "expectedClaimJson",
  );
  const nextRevisionJson = requireNonEmptyString(
    finalRevisionJson,
    "finalRevisionJson",
  );
  const nextUpdatedAt = requireNonEmptyString(updatedAt, "updatedAt");

  if (nextState !== "REVIEWING" && nextState !== "REVISION_REQUIRED") {
    throw new Error(`nextState inválido: ${String(nextState)}`);
  }

  const result = database
    .prepare(
      "UPDATE tasks SET currentRevisionJson = ?, state = ?, updatedAt = ? WHERE id = ? AND state = 'VERIFYING' AND currentRevisionJson = ?",
    )
    .run(nextRevisionJson, nextState, nextUpdatedAt, id, expectedRevisionJson) as {
      changes: number | bigint;
    };

  return Number(result.changes) === 1;
}

export class PersistedTaskContractError extends Error {
  readonly taskId: string;
  readonly causeMessage: string;

  constructor(taskId: string, causeMessage: string) {
    super(`El contrato persistido de la tarea ${taskId} es inválido: ${causeMessage}`);
    this.name = "PersistedTaskContractError";
    this.taskId = taskId;
    this.causeMessage = causeMessage;
  }
}

export function updateTaskContract(
  database: DatabaseSync,
  taskId: string,
  contract: TaskContract,
): void {
  const id = taskId.trim();

  if (id.length === 0) {
    throw new Error("El id de la tarea no puede estar vacío.");
  }

  const structuralResult = executableTaskContractSchema.safeParse(contract);
  if (!structuralResult.success) {
    throw new Error(`El contrato de la tarea ${id} no es válido: estructura inválida.`);
  }

  validateSupervisorResultSemantics(contract);

  const serialized = JSON.stringify(contract);
  const now = new Date().toISOString();
  const result = database
    .prepare("UPDATE tasks SET contractJson = ?, updatedAt = ? WHERE id = ?")
    .run(serialized, now, id);

  if (result.changes === 0) {
    throw new Error(`No existe la tarea: ${id}`);
  }
}

export function getTaskContract(
  database: DatabaseSync,
  taskId: string,
): TaskContract | null {
  const id = taskId.trim();

  if (id.length === 0) {
    throw new Error("El id de la tarea no puede estar vacío.");
  }

  const row = database
    .prepare("SELECT id, contractJson FROM tasks WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (row === undefined) {
    throw new Error(`No existe la tarea: ${id}`);
  }

  if (row["contractJson"] === null) {
    return null;
  }

  const raw = String(row["contractJson"]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PersistedTaskContractError(id, "JSON inválido.");
  }

  const structuralResult = executableTaskContractSchema.safeParse(parsed);
  if (!structuralResult.success) {
    throw new PersistedTaskContractError(id, "Estructura inválida.");
  }

  try {
    validateSupervisorResultSemantics(parsed as TaskContract);
  } catch {
    throw new PersistedTaskContractError(id, "Semántica inválida.");
  }

  return parsed as TaskContract;
}
