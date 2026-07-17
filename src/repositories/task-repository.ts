/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { Task, TaskState } from "../types.js";

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
