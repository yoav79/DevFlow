/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { TaskReview } from "../types.js";

export interface ClaimReviewerRunInput {
  readonly reviewId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly reviewerClaimJson: string;
  readonly snapshotBaseCommit: string;
  readonly snapshotHeadCommit: string;
  readonly snapshotFingerprint: string;
}

export class ReviewerClaimError extends Error {
  readonly code: string;
  readonly taskId?: string;
  readonly reviewId?: string;

  constructor(
    message: string,
    options: { code: string; taskId?: string; reviewId?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "ReviewerClaimError";
    this.code = options.code;
    this.taskId = options.taskId;
    this.reviewId = options.reviewId;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

type SqliteLikeError = {
  code?: string;
  message?: string;
};

function beginImmediate(database: DatabaseSync): void {
  database.prepare("BEGIN IMMEDIATE").run();
}

function commit(database: DatabaseSync): void {
  database.prepare("COMMIT").run();
}

function rollback(database: DatabaseSync): void {
  try {
    database.prepare("ROLLBACK").run();
  } catch (rollbackError: unknown) {
    void rollbackError;
  }
}

export function claimReviewerRun(
  database: DatabaseSync,
  input: ClaimReviewerRunInput,
): TaskReview {
  const reviewId = input.reviewId.trim();
  const taskId = input.taskId.trim();
  const workspaceId = input.workspaceId.trim();
  const reviewerClaimJson = input.reviewerClaimJson;
  const snapshotBaseCommit = input.snapshotBaseCommit;
  const snapshotHeadCommit = input.snapshotHeadCommit;
  const snapshotFingerprint = input.snapshotFingerprint;

  if (reviewId.length === 0) {
    throw new ReviewerClaimError("reviewId no puede estar vacío.", {
      code: "REVIEWER_CLAIM_CONFLICT",
    });
  }

  if (taskId.length === 0) {
    throw new ReviewerClaimError("taskId no puede estar vacío.", {
      code: "REVIEWER_CLAIM_CONFLICT",
    });
  }

  if (workspaceId.length === 0) {
    throw new ReviewerClaimError("workspaceId no puede estar vacío.", {
      code: "REVIEWER_CLAIM_CONFLICT",
    });
  }

  if (reviewerClaimJson.length === 0) {
    throw new ReviewerClaimError("reviewerClaimJson no puede estar vacío.", {
      code: "REVIEWER_CLAIM_CONFLICT",
    });
  }

  if (snapshotBaseCommit.length === 0) {
    throw new ReviewerClaimError("snapshotBaseCommit no puede estar vacío.", {
      code: "REVIEWER_CLAIM_CONFLICT",
    });
  }

  if (snapshotHeadCommit.length === 0) {
    throw new ReviewerClaimError("snapshotHeadCommit no puede estar vacío.", {
      code: "REVIEWER_CLAIM_CONFLICT",
    });
  }

  if (snapshotFingerprint.length === 0) {
    throw new ReviewerClaimError("snapshotFingerprint no puede estar vacío.", {
      code: "REVIEWER_CLAIM_CONFLICT",
    });
  }

  let transactionStarted = false;
  let committed = false;

  try {
    beginImmediate(database);
    transactionStarted = true;

    // 1. Re-read Task by taskId.
    const taskRow = database
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as Record<string, unknown> | undefined;

    if (taskRow === undefined) {
      throw new ReviewerClaimError(`No existe la tarea: ${taskId}`, {
        code: "REVIEWER_CLAIM_TASK_NOT_FOUND",
        taskId,
      });
    }

    const taskState = String(taskRow["state"]);

    if (taskState !== "REVIEWING") {
      throw new ReviewerClaimError(
        `La tarea ${taskId} no está en REVIEWING (estado actual: ${taskState}).`,
        { code: "REVIEWER_CLAIM_TASK_NOT_REVIEWING", taskId },
      );
    }

    const correctionCount = Number(taskRow["correctionCount"]);

    if (!Number.isFinite(correctionCount) || !Number.isInteger(correctionCount) || correctionCount < 0) {
      throw new ReviewerClaimError(
        `correctionCount inválido en la tarea ${taskId}: ${correctionCount}`,
        { code: "REVIEWER_CLAIM_PERSISTENCE_FAILED", taskId },
      );
    }

    // 3. Calculate reviewNumber.
    const reviewNumber = correctionCount + 1;

    // 4. Re-read Workspace by workspaceId.
    const workspaceRow = database
      .prepare("SELECT * FROM task_workspaces WHERE id = ?")
      .get(workspaceId) as Record<string, unknown> | undefined;

    if (workspaceRow === undefined) {
      throw new ReviewerClaimError(`No existe el workspace: ${workspaceId}`, {
        code: "REVIEWER_CLAIM_WORKSPACE_NOT_FOUND",
        taskId,
      });
    }

    const workspaceTaskId = String(workspaceRow["taskId"]);

    if (workspaceTaskId !== taskId) {
      throw new ReviewerClaimError(
        `El workspace ${workspaceId} pertenece a la tarea ${workspaceTaskId}, no a ${taskId}.`,
        { code: "REVIEWER_CLAIM_WORKSPACE_TASK_MISMATCH", taskId },
      );
    }

    const workspaceStatus = String(workspaceRow["status"]);

    if (workspaceStatus !== "READY") {
      throw new ReviewerClaimError(
        `El workspace ${workspaceId} no está en READY (estado actual: ${workspaceStatus}).`,
        { code: "REVIEWER_CLAIM_WORKSPACE_NOT_READY", taskId },
      );
    }

    // Validate baseCommit compatibility.
    const workspaceBaseCommit = String(workspaceRow["baseCommit"]);

    if (workspaceBaseCommit !== snapshotBaseCommit) {
      throw new ReviewerClaimError(
        `El baseCommit del workspace ${workspaceId} (${workspaceBaseCommit}) no coincide con snapshotBaseCommit (${snapshotBaseCommit}).`,
        { code: "REVIEWER_CLAIM_WORKSPACE_NOT_READY", taskId },
      );
    }

    // 6. Check no RUNNING row exists for this taskId.
    const runningRow = database
      .prepare("SELECT id FROM task_reviews WHERE taskId = ? AND status = 'RUNNING'")
      .get(taskId) as Record<string, unknown> | undefined;

    if (runningRow !== undefined) {
      throw new ReviewerClaimError(
        `Ya existe un review RUNNING para la tarea ${taskId}.`,
        { code: "REVIEWER_CLAIM_ALREADY_RUNNING", taskId },
      );
    }

    // 7. Check no COMPLETED row exists for this taskId + reviewNumber.
    const completedRow = database
      .prepare(
        "SELECT id FROM task_reviews WHERE taskId = ? AND reviewNumber = ? AND status = 'COMPLETED'",
      )
      .get(taskId, reviewNumber) as Record<string, unknown> | undefined;

    if (completedRow !== undefined) {
      throw new ReviewerClaimError(
        `Ya existe un review COMPLETED para la tarea ${taskId}, review ${reviewNumber}.`,
        { code: "REVIEWER_CLAIM_REVIEW_ALREADY_COMPLETED", taskId },
      );
    }

    // 8. Calculate runNumber = COALESCE(MAX(runNumber), 0) + 1.
    const maxRunRow = database
      .prepare(
        "SELECT COALESCE(MAX(runNumber), 0) as maxRunNumber FROM task_reviews WHERE taskId = ? AND reviewNumber = ?",
      )
      .get(taskId, reviewNumber) as { maxRunNumber: number } | undefined;

    const runNumber = (maxRunRow?.maxRunNumber ?? 0) + 1;

    // 9. Insert RUNNING row.
    const now = new Date().toISOString();

    database
      .prepare(
        `INSERT INTO task_reviews
          (id, taskId, reviewNumber, runNumber, status, reviewerClaimJson,
           snapshotWorkspaceId, snapshotBaseCommit, snapshotHeadCommit, snapshotFingerprint,
           createdAt)
         VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reviewId,
        taskId,
        reviewNumber,
        runNumber,
        reviewerClaimJson,
        workspaceId,
        snapshotBaseCommit,
        snapshotHeadCommit,
        snapshotFingerprint,
        now,
      );

    // 10. Re-read the inserted row.
    const insertedRow = database
      .prepare("SELECT * FROM task_reviews WHERE id = ?")
      .get(reviewId) as Record<string, unknown> | undefined;

    if (insertedRow === undefined) {
      throw new ReviewerClaimError(
        `No se pudo recuperar el review creado: ${reviewId}`,
        { code: "REVIEWER_CLAIM_PERSISTENCE_FAILED", reviewId, taskId },
      );
    }

    // 11. COMMIT.
    commit(database);
    committed = true;

    return mapRowToTaskReview(insertedRow);
  } catch (error) {
    if (transactionStarted && !committed) {
      rollback(database);
    }

    if (error instanceof ReviewerClaimError) {
      throw error;
    }

    const sqliteError = error as SqliteLikeError;
    const message = sqliteError.message ?? String(error);
    const code = sqliteError.code;

    if (message.includes("UNIQUE constraint failed") || message.includes("CHECK constraint failed")) {
      throw new ReviewerClaimError(
        `Conflicto de persistencia durante claimReviewerRun: ${message}`,
        { code: "REVIEWER_CLAIM_CONFLICT", reviewId, taskId, cause: error },
      );
    }

    throw new ReviewerClaimError(
      `Error inesperado durante claimReviewerRun: ${message}`,
      {
        code: "REVIEWER_CLAIM_PERSISTENCE_FAILED",
        reviewId,
        taskId,
        cause: code === undefined ? error : error,
      },
    );
  }
}

function mapRowToTaskReview(row: Record<string, unknown>): TaskReview {
  const status = String(row["status"]);
  const reviewNumber = Number(row["reviewNumber"]);
  const runNumber = Number(row["runNumber"]);
  const verdict = row["verdict"] === null ? null : String(row["verdict"]);

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
    verdict: verdict as TaskReview["verdict"],
    summary: row["summary"] === null ? null : String(row["summary"]),
    findingsJson: row["findingsJson"] === null ? null : String(row["findingsJson"]),
    requiredChangesJson: row["requiredChangesJson"] === null ? null : String(row["requiredChangesJson"]),
    discardReason: row["discardReason"] === null ? null : String(row["discardReason"]),
    createdAt: String(row["createdAt"]),
    completedAt: row["completedAt"] === null ? null : String(row["completedAt"]),
    discardedAt: row["discardedAt"] === null ? null : String(row["discardedAt"]),
  };
}
