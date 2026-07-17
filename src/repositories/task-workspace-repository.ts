/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { CreateTaskWorkspaceInput, TaskWorkspace, TaskWorkspaceStatus } from "../types.js";
import { TASK_WORKSPACE_STATUSES } from "../types.js";
import { getTaskById } from "./task-repository.js";

export class TaskWorkspaceRepositoryError extends Error {
  readonly workspaceId?: string;
  readonly taskId?: string;

  constructor(
    message: string,
    options?: { workspaceId?: string; taskId?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "TaskWorkspaceRepositoryError";
    this.workspaceId = options?.workspaceId;
    this.taskId = options?.taskId;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

const VALID_TRANSITIONS: Record<TaskWorkspaceStatus, TaskWorkspaceStatus[]> = {
  PREPARING: ["READY", "FAILED"],
  READY: ["FAILED"],
  FAILED: ["PREPARING"],
  REMOVED: [],
};

function mapRowToTaskWorkspace(row: Record<string, unknown>): TaskWorkspace {
  const status = String(row["status"]);

  if (!(TASK_WORKSPACE_STATUSES as readonly string[]).includes(status)) {
    throw new TaskWorkspaceRepositoryError(
      `Estado inválido en workspace persistido: ${status}`,
    );
  }

  const executionNumber = Number(row["executionNumber"]);

  if (!Number.isFinite(executionNumber) || !Number.isInteger(executionNumber) || executionNumber < 1) {
    throw new TaskWorkspaceRepositoryError(
      `executionNumber inválido en workspace persistido: ${executionNumber}`,
    );
  }

  const removedAt = row["removedAt"] === null ? null : String(row["removedAt"]);

  return {
    id: String(row["id"]),
    taskId: String(row["taskId"]),
    executionNumber,
    workspacePath: String(row["workspacePath"]),
    branchName: String(row["branchName"]),
    baseCommit: String(row["baseCommit"]),
    status: status as TaskWorkspaceStatus,
    createdAt: String(row["createdAt"]),
    removedAt,
  };
}

function getWorkspaceById(database: DatabaseSync, workspaceId: string): TaskWorkspace | null {
  const row = database.prepare("SELECT * FROM task_workspaces WHERE id = ?").get(workspaceId) as
    | Record<string, unknown>
    | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRowToTaskWorkspace(row);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function createTaskWorkspace(
  database: DatabaseSync,
  input: CreateTaskWorkspaceInput,
): TaskWorkspace {
  const id = input.id.trim();

  if (id.length === 0) {
    throw new TaskWorkspaceRepositoryError("El id del workspace no puede estar vacío.");
  }

  const taskId = input.taskId.trim();

  if (taskId.length === 0) {
    throw new TaskWorkspaceRepositoryError("El id de la tarea no puede estar vacío.");
  }

  const workspacePath = input.workspacePath.trim();

  if (workspacePath.length === 0) {
    throw new TaskWorkspaceRepositoryError("La ruta del workspace no puede estar vacía.");
  }

  const branchName = input.branchName.trim();

  if (branchName.length === 0) {
    throw new TaskWorkspaceRepositoryError("El nombre de la rama no puede estar vacío.");
  }

  const baseCommit = input.baseCommit.trim();

  if (baseCommit.length === 0) {
    throw new TaskWorkspaceRepositoryError("El commit base no puede estar vacío.");
  }

  if (
    !Number.isFinite(input.executionNumber)
    || !Number.isInteger(input.executionNumber)
    || input.executionNumber < 1
  ) {
    throw new TaskWorkspaceRepositoryError(
      "El número de ejecución debe ser un entero mayor o igual que 1.",
    );
  }

  const existingTask = getTaskById(database, taskId);

  if (existingTask === null) {
    throw new TaskWorkspaceRepositoryError(`No existe la tarea: ${taskId}`, { taskId });
  }

  const now = new Date().toISOString();

  try {
    database
      .prepare(
        "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt, removedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, taskId, input.executionNumber, workspacePath, branchName, baseCommit, "PREPARING", now, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("UNIQUE constraint failed: task_workspaces.taskId, task_workspaces.executionNumber")) {
      throw new TaskWorkspaceRepositoryError(
        `Ya existe un workspace para la tarea ${taskId} y la ejecución ${input.executionNumber}.`,
        { workspaceId: id, taskId, cause: error },
      );
    }

    if (message.includes("UNIQUE constraint failed: task_workspaces.workspacePath")) {
      throw new TaskWorkspaceRepositoryError(
        `Ya existe un workspace con la ruta: ${workspacePath}`,
        { workspaceId: id, cause: error },
      );
    }

    if (message.includes("UNIQUE constraint failed: task_workspaces.id")) {
      throw new TaskWorkspaceRepositoryError(`Ya existe el workspace: ${id}`, {
        workspaceId: id,
        cause: error,
      });
    }

    throw new TaskWorkspaceRepositoryError("Error al crear el workspace.", {
      workspaceId: id,
      taskId,
      cause: error,
    });
  }

  const created = getWorkspaceById(database, id);

  if (created === null) {
    throw new TaskWorkspaceRepositoryError("No se pudo recuperar el workspace creado.", {
      workspaceId: id,
      taskId,
    });
  }

  return created;
}

export function getTaskWorkspaceById(
  database: DatabaseSync,
  workspaceId: string,
): TaskWorkspace | null {
  const id = workspaceId.trim();

  if (id.length === 0) {
    throw new TaskWorkspaceRepositoryError("El id del workspace no puede estar vacío.");
  }

  return getWorkspaceById(database, id);
}

export function getTaskWorkspaceByTaskAndExecutionNumber(
  database: DatabaseSync,
  taskId: string,
  executionNumber: number,
): TaskWorkspace | null {
  const normalizedTaskId = taskId.trim();

  if (normalizedTaskId.length === 0) {
    throw new TaskWorkspaceRepositoryError("El id de la tarea no puede estar vacío.");
  }

  if (
    !Number.isFinite(executionNumber)
    || !Number.isInteger(executionNumber)
    || executionNumber < 1
  ) {
    throw new TaskWorkspaceRepositoryError(
      "El número de ejecución debe ser un entero mayor o igual que 1.",
    );
  }

  const row = database
    .prepare("SELECT * FROM task_workspaces WHERE taskId = ? AND executionNumber = ?")
    .get(normalizedTaskId, executionNumber) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRowToTaskWorkspace(row);
}

export function listTaskWorkspacesByTaskId(
  database: DatabaseSync,
  taskId: string,
): TaskWorkspace[] {
  const normalizedTaskId = taskId.trim();

  if (normalizedTaskId.length === 0) {
    throw new TaskWorkspaceRepositoryError("El id de la tarea no puede estar vacío.");
  }

  const rows = database
    .prepare("SELECT * FROM task_workspaces WHERE taskId = ? ORDER BY executionNumber ASC")
    .all(normalizedTaskId) as Record<string, unknown>[];

  return rows.map(mapRowToTaskWorkspace);
}

export function updateTaskWorkspaceStatus(
  database: DatabaseSync,
  workspaceId: string,
  nextStatus: Exclude<TaskWorkspaceStatus, "REMOVED">,
): TaskWorkspace {
  const id = workspaceId.trim();

  if (id.length === 0) {
    throw new TaskWorkspaceRepositoryError("El id del workspace no puede estar vacío.");
  }

  const workspace = getWorkspaceById(database, id);

  if (workspace === null) {
    throw new TaskWorkspaceRepositoryError(`No existe el workspace: ${id}`, { workspaceId: id });
  }

  if (workspace.status === nextStatus) {
    return workspace;
  }

  if (workspace.status === "REMOVED") {
    throw new TaskWorkspaceRepositoryError(
      `El workspace ${id} no puede cambiar de ${workspace.status} a ${nextStatus}.`,
      { workspaceId: id },
    );
  }

  const allowed = VALID_TRANSITIONS[workspace.status];

  if (!allowed.includes(nextStatus)) {
    throw new TaskWorkspaceRepositoryError(
      `El workspace ${id} no puede cambiar de ${workspace.status} a ${nextStatus}.`,
      { workspaceId: id },
    );
  }

  database
    .prepare("UPDATE task_workspaces SET status = ?, removedAt = NULL WHERE id = ?")
    .run(nextStatus, id);

  const updated = getWorkspaceById(database, id);

  if (updated === null) {
    throw new TaskWorkspaceRepositoryError("No se pudo recuperar el workspace actualizado.", {
      workspaceId: id,
    });
  }

  return updated;
}

export function markTaskWorkspaceRemoved(
  database: DatabaseSync,
  workspaceId: string,
): TaskWorkspace {
  const id = workspaceId.trim();

  if (id.length === 0) {
    throw new TaskWorkspaceRepositoryError("El id del workspace no puede estar vacío.");
  }

  const workspace = getWorkspaceById(database, id);

  if (workspace === null) {
    throw new TaskWorkspaceRepositoryError(`No existe el workspace: ${id}`, { workspaceId: id });
  }

  if (workspace.status === "REMOVED") {
    return workspace;
  }

  if (workspace.status === "PREPARING") {
    throw new TaskWorkspaceRepositoryError(
      `El workspace ${id} no puede eliminarse desde el estado PREPARING.`,
      { workspaceId: id },
    );
  }

  const now = new Date().toISOString();

  database
    .prepare("UPDATE task_workspaces SET status = ?, removedAt = ? WHERE id = ?")
    .run("REMOVED", now, id);

  const updated = getWorkspaceById(database, id);

  if (updated === null) {
    throw new TaskWorkspaceRepositoryError("No se pudo recuperar el workspace actualizado.", {
      workspaceId: id,
    });
  }

  return updated;
}
