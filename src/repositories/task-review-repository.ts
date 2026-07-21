/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type {
  CompleteTaskReviewInput,
  CreateTaskReviewInput,
  TaskReview,
  TaskReviewVerdict,
} from "../types.js";
import { TASK_REVIEW_VERDICTS } from "../types.js";
import { getTaskById } from "./task-repository.js";

export class TaskReviewRepositoryError extends Error {
  readonly reviewId?: string;
  readonly taskId?: string;
  readonly code?: string;

  constructor(
    message: string,
    options?: { reviewId?: string; taskId?: string; code?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "TaskReviewRepositoryError";
    this.reviewId = options?.reviewId;
    this.taskId = options?.taskId;
    this.code = options?.code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function mapRowToTaskReview(row: Record<string, unknown>): TaskReview {
  const status = String(row["status"]);

  const reviewNumber = Number(row["reviewNumber"]);

  if (!Number.isFinite(reviewNumber) || !Number.isInteger(reviewNumber) || reviewNumber < 1) {
    throw new TaskReviewRepositoryError(
      `reviewNumber inválido en review persistido: ${reviewNumber}`,
    );
  }

  const runNumber = Number(row["runNumber"]);

  if (!Number.isFinite(runNumber) || !Number.isInteger(runNumber) || runNumber < 1) {
    throw new TaskReviewRepositoryError(
      `runNumber inválido en review persistido: ${runNumber}`,
    );
  }

  const verdict = row["verdict"] === null ? null : String(row["verdict"]);

  if (
    verdict !== null
    && !(TASK_REVIEW_VERDICTS as readonly string[]).includes(verdict)
  ) {
    throw new TaskReviewRepositoryError(
      `Verdicto inválido en review persistido: ${verdict}`,
    );
  }

  return {
    id: String(row["id"]),
    taskId: String(row["taskId"]),
    reviewNumber,
    runNumber,
    status: status as TaskReview["status"],
    reviewerClaimJson: row["reviewerClaimJson"] === null ? null : String(row["reviewerClaimJson"]),
    snapshotWorkspaceId: row["snapshotWorkspaceId"] === null ? null : String(row["snapshotWorkspaceId"]),
    snapshotBaseCommit: row["snapshotBaseCommit"] === null ? null : String(row["snapshotBaseCommit"]),
    snapshotHeadCommit: row["snapshotHeadCommit"] === null ? null : String(row["snapshotHeadCommit"]),
    snapshotFingerprint: row["snapshotFingerprint"] === null ? null : String(row["snapshotFingerprint"]),
    verdict: verdict as TaskReviewVerdict | null,
    summary: row["summary"] === null ? null : String(row["summary"]),
    findingsJson: row["findingsJson"] === null ? null : String(row["findingsJson"]),
    requiredChangesJson: row["requiredChangesJson"] === null ? null : String(row["requiredChangesJson"]),
    discardReason: row["discardReason"] === null ? null : String(row["discardReason"]),
    createdAt: String(row["createdAt"]),
    completedAt: row["completedAt"] === null ? null : String(row["completedAt"]),
    discardedAt: row["discardedAt"] === null ? null : String(row["discardedAt"]),
  };
}

function getReviewById(database: DatabaseSync, reviewId: string): TaskReview | null {
  const row = database.prepare("SELECT * FROM task_reviews WHERE id = ?").get(reviewId) as
    | Record<string, unknown>
    | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRowToTaskReview(row);
}

function requireNonEmptyString(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new TaskReviewRepositoryError(`${fieldName} no puede estar vacío.`);
  }

  return value;
}

export function createTaskReview(
  database: DatabaseSync,
  input: CreateTaskReviewInput,
): TaskReview {
  const id = requireNonEmptyString(input.id, "El id del review");
  const taskId = requireNonEmptyString(input.taskId, "El id de la tarea");
  const reviewerClaimJson = requireNonEmptyString(input.reviewerClaimJson, "reviewerClaimJson");
  const snapshotWorkspaceId = requireNonEmptyString(input.snapshotWorkspaceId, "snapshotWorkspaceId");
  const snapshotBaseCommit = requireNonEmptyString(input.snapshotBaseCommit, "snapshotBaseCommit");
  const snapshotHeadCommit = requireNonEmptyString(input.snapshotHeadCommit, "snapshotHeadCommit");
  const snapshotFingerprint = requireNonEmptyString(input.snapshotFingerprint, "snapshotFingerprint");

  if (
    !Number.isFinite(input.reviewNumber)
    || !Number.isInteger(input.reviewNumber)
    || input.reviewNumber < 1
  ) {
    throw new TaskReviewRepositoryError(
      "El número de review debe ser un entero mayor o igual que 1.",
    );
  }

  if (
    !Number.isFinite(input.runNumber)
    || !Number.isInteger(input.runNumber)
    || input.runNumber < 1
  ) {
    throw new TaskReviewRepositoryError(
      "El número de run debe ser un entero mayor o igual que 1.",
    );
  }

  const existingTask = getTaskById(database, taskId);

  if (existingTask === null) {
    throw new TaskReviewRepositoryError(`No existe la tarea: ${taskId}`, { taskId });
  }

  const now = new Date().toISOString();

  try {
    database
      .prepare(
        `INSERT INTO task_reviews
          (id, taskId, reviewNumber, runNumber, status, reviewerClaimJson,
           snapshotWorkspaceId, snapshotBaseCommit, snapshotHeadCommit, snapshotFingerprint,
           createdAt)
         VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        taskId,
        input.reviewNumber,
        input.runNumber,
        reviewerClaimJson,
        snapshotWorkspaceId,
        snapshotBaseCommit,
        snapshotHeadCommit,
        snapshotFingerprint,
        now,
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("UNIQUE constraint failed: task_reviews.taskId, task_reviews.reviewNumber, task_reviews.runNumber")) {
      throw new TaskReviewRepositoryError(
        `Ya existe un review para la tarea ${taskId}, review ${input.reviewNumber}, run ${input.runNumber}.`,
        { reviewId: id, taskId, cause: error },
      );
    }

    if (message.includes("UNIQUE constraint failed: task_reviews.id")) {
      throw new TaskReviewRepositoryError(`Ya existe el review: ${id}`, {
        reviewId: id,
        cause: error,
      });
    }

    throw new TaskReviewRepositoryError("Error al crear el review.", {
      reviewId: id,
      taskId,
      cause: error,
    });
  }

  const created = getReviewById(database, id);

  if (created === null) {
    throw new TaskReviewRepositoryError("No se pudo recuperar el review creado.", {
      reviewId: id,
      taskId,
    });
  }

  return created;
}

export function getTaskReviewById(
  database: DatabaseSync,
  reviewId: string,
): TaskReview | null {
  const id = requireNonEmptyString(reviewId, "El id del review");

  return getReviewById(database, id);
}

export function getRunningReviewForTask(
  database: DatabaseSync,
  taskId: string,
): TaskReview | null {
  const normalizedTaskId = requireNonEmptyString(taskId, "El id de la tarea");

  const row = database
    .prepare("SELECT * FROM task_reviews WHERE taskId = ? AND status = 'RUNNING'")
    .get(normalizedTaskId) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRowToTaskReview(row);
}

export function getCompletedReviewForTaskAndReviewNumber(
  database: DatabaseSync,
  taskId: string,
  reviewNumber: number,
): TaskReview | null {
  const normalizedTaskId = requireNonEmptyString(taskId, "El id de la tarea");

  if (
    !Number.isFinite(reviewNumber)
    || !Number.isInteger(reviewNumber)
    || reviewNumber < 1
  ) {
    throw new TaskReviewRepositoryError(
      "El número de review debe ser un entero mayor o igual que 1.",
    );
  }

  const row = database
    .prepare(
      "SELECT * FROM task_reviews WHERE taskId = ? AND reviewNumber = ? AND status = 'COMPLETED'",
    )
    .get(normalizedTaskId, reviewNumber) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRowToTaskReview(row);
}

export function listTaskReviewsByTaskId(
  database: DatabaseSync,
  taskId: string,
): TaskReview[] {
  const normalizedTaskId = requireNonEmptyString(taskId, "El id de la tarea");

  const rows = database
    .prepare(
      "SELECT * FROM task_reviews WHERE taskId = ? ORDER BY reviewNumber ASC, runNumber ASC",
    )
    .all(normalizedTaskId) as Record<string, unknown>[];

  return rows.map(mapRowToTaskReview);
}

export function listCompletedReviewsByTaskId(
  database: DatabaseSync,
  taskId: string,
): TaskReview[] {
  const normalizedTaskId = requireNonEmptyString(taskId, "El id de la tarea");

  const rows = database
    .prepare(
      "SELECT * FROM task_reviews WHERE taskId = ? AND status = 'COMPLETED' ORDER BY reviewNumber DESC",
    )
    .all(normalizedTaskId) as Record<string, unknown>[];

  return rows.map(mapRowToTaskReview);
}

export function completeTaskReview(
  database: DatabaseSync,
  reviewId: string,
  expectedReviewerClaimJson: string,
  input: CompleteTaskReviewInput,
): TaskReview {
  const id = requireNonEmptyString(reviewId, "El id del review");
  const claim = requireNonEmptyString(expectedReviewerClaimJson, "expectedReviewerClaimJson");
  const verdict = input.verdict;
  const summary = requireNonEmptyString(input.summary, "summary");
  const findingsJson = requireNonEmptyString(input.findingsJson, "findingsJson");
  const requiredChangesJson = requireNonEmptyString(input.requiredChangesJson, "requiredChangesJson");

  if (!(TASK_REVIEW_VERDICTS as readonly string[]).includes(verdict)) {
    throw new TaskReviewRepositoryError(`Verdicto inválido: ${verdict}`);
  }

  const now = new Date().toISOString();

  const result = database
    .prepare(
      `UPDATE task_reviews
       SET status = 'COMPLETED',
           reviewerClaimJson = NULL,
           verdict = ?,
           summary = ?,
           findingsJson = ?,
           requiredChangesJson = ?,
           completedAt = ?
       WHERE id = ?
         AND status = 'RUNNING'
         AND reviewerClaimJson = ?`,
    )
    .run(verdict, summary, findingsJson, requiredChangesJson, now, id, claim) as {
      changes: number | bigint;
    };

  if (Number(result.changes) === 0) {
    throw new TaskReviewRepositoryError(
      `No se pudo completar el review ${id}: conflicto de ownership o estado inválido.`,
      { reviewId: id, code: "TASK_REVIEW_FINALIZE_CONFLICT" },
    );
  }

  const updated = getReviewById(database, id);

  if (updated === null) {
    throw new TaskReviewRepositoryError("No se pudo recuperar el review actualizado.", {
      reviewId: id,
    });
  }

  return updated;
}

export function discardTaskReview(
  database: DatabaseSync,
  reviewId: string,
  expectedReviewerClaimJson: string,
  reason: string,
): TaskReview {
  const id = requireNonEmptyString(reviewId, "El id del review");
  const claim = requireNonEmptyString(expectedReviewerClaimJson, "expectedReviewerClaimJson");
  const discardReason = requireNonEmptyString(reason, "discardReason");

  const now = new Date().toISOString();

  const result = database
    .prepare(
      `UPDATE task_reviews
       SET status = 'DISCARDED',
           reviewerClaimJson = NULL,
           discardReason = ?,
           discardedAt = ?
       WHERE id = ?
         AND status = 'RUNNING'
         AND reviewerClaimJson = ?`,
    )
    .run(discardReason, now, id, claim) as {
      changes: number | bigint;
    };

  if (Number(result.changes) === 0) {
    throw new TaskReviewRepositoryError(
      `No se pudo descartar el review ${id}: conflicto de ownership o estado inválido.`,
      { reviewId: id, code: "TASK_REVIEW_DISCARD_CONFLICT" },
    );
  }

  const updated = getReviewById(database, id);

  if (updated === null) {
    throw new TaskReviewRepositoryError("No se pudo recuperar el review actualizado.", {
      reviewId: id,
    });
  }

  return updated;
}

export function getMaxReviewNumberForTask(
  database: DatabaseSync,
  taskId: string,
): number {
  const normalizedTaskId = requireNonEmptyString(taskId, "El id de la tarea");

  const row = database
    .prepare("SELECT COALESCE(MAX(reviewNumber), 0) as maxReviewNumber FROM task_reviews WHERE taskId = ?")
    .get(normalizedTaskId) as { maxReviewNumber: number } | undefined;

  return row?.maxReviewNumber ?? 0;
}

export function getMaxRunNumberForReview(
  database: DatabaseSync,
  taskId: string,
  reviewNumber: number,
): number {
  const normalizedTaskId = requireNonEmptyString(taskId, "El id de la tarea");

  if (
    !Number.isFinite(reviewNumber)
    || !Number.isInteger(reviewNumber)
    || reviewNumber < 1
  ) {
    throw new TaskReviewRepositoryError(
      "El número de review debe ser un entero mayor o igual que 1.",
    );
  }

  const row = database
    .prepare(
      "SELECT COALESCE(MAX(runNumber), 0) as maxRunNumber FROM task_reviews WHERE taskId = ? AND reviewNumber = ?",
    )
    .get(normalizedTaskId, reviewNumber) as { maxRunNumber: number } | undefined;

  return row?.maxRunNumber ?? 0;
}
