/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { Task, TaskContract, TaskState } from "../types.js";
import { executableTaskContractSchema } from "../schemas/supervisor-result-schema.js";
import { validateSupervisorResultSemantics } from "../services/supervisor-result-semantic-validator.js";

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
