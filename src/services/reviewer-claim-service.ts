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

export interface LoadReviewerEvidenceSnapshotInput {
  readonly taskId: string;
  readonly reviewId: string;
  readonly expectedReviewerClaimJson: string;
}

export interface ReviewerEvidenceSnapshot {
  readonly taskId: string;
  readonly projectId: string;
  readonly reviewId: string;
  readonly reviewNumber: number;
  readonly runNumber: number;
  readonly reviewStatus: "RUNNING";
  readonly reviewerClaimJson: string;
  readonly snapshotWorkspaceId: string;
  readonly snapshotBaseCommit: string;
  readonly snapshotHeadCommit: string;
  readonly snapshotFingerprint: string;
  readonly taskState: "REVIEWING";
  readonly contractJson: string;
  readonly currentRevisionJson: string;
  readonly workspaceId: string;
  readonly workspaceTaskId: string;
  readonly workspacePath: string;
  readonly workspaceBaseCommit: string;
  readonly workspaceStatus: "READY";
}

export class ReviewerClaimError extends Error {
  readonly code: string;
  readonly taskId?: string;
  readonly reviewId?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: { code: string; taskId?: string; reviewId?: string; cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "ReviewerClaimError";
    this.code = options.code;
    this.taskId = options.taskId;
    this.reviewId = options.reviewId;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options.details !== undefined) {
      this.details = Object.freeze({ ...options.details });
    }
  }
}

interface ReviewerEvidenceSnapshotRow {
  readonly reviewId: string;
  readonly reviewTaskId: string;
  readonly reviewNumber: number;
  readonly runNumber: number;
  readonly reviewStatus: string;
  readonly reviewerClaimJson: string | null;
  readonly snapshotWorkspaceId: string | null;
  readonly snapshotBaseCommit: string | null;
  readonly snapshotHeadCommit: string | null;
  readonly snapshotFingerprint: string | null;
  readonly taskId: string | null;
  readonly projectId: string | null;
  readonly taskState: string | null;
  readonly contractJson: string | null;
  readonly currentRevisionJson: string | null;
  readonly workspaceId: string | null;
  readonly workspaceTaskId: string | null;
  readonly workspacePath: string | null;
  readonly workspaceBaseCommit: string | null;
  readonly workspaceStatus: string | null;
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

function requireReviewerEvidenceInputString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ReviewerClaimError(`${fieldName} no puede estar vacío.`, {
      code: "REVIEWER_EVIDENCE_INVALID_INPUT",
      details: { fieldName },
    });
  }

  return value;
}

function isNonEmptyPersistedString(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

function reviewerEvidenceError(
  message: string,
  code: string,
  taskId: string,
  reviewId: string,
  details?: Record<string, unknown>,
): ReviewerClaimError {
  return new ReviewerClaimError(message, {
    code,
    taskId,
    reviewId,
    details,
  });
}

function readReviewerEvidenceSnapshotRow(
  database: DatabaseSync,
  reviewId: string,
  taskIdForError: string,
): ReviewerEvidenceSnapshotRow | null {
  try {
    const row = database
      .prepare(
        `SELECT
           review.id AS reviewId,
           review.taskId AS reviewTaskId,
           review.reviewNumber AS reviewNumber,
           review.runNumber AS runNumber,
           review.status AS reviewStatus,
           review.reviewerClaimJson AS reviewerClaimJson,
           review.snapshotWorkspaceId AS snapshotWorkspaceId,
           review.snapshotBaseCommit AS snapshotBaseCommit,
           review.snapshotHeadCommit AS snapshotHeadCommit,
           review.snapshotFingerprint AS snapshotFingerprint,
           task.id AS taskId,
           task.projectId AS projectId,
           task.state AS taskState,
           task.contractJson AS contractJson,
           task.currentRevisionJson AS currentRevisionJson,
           workspace.id AS workspaceId,
           workspace.taskId AS workspaceTaskId,
           workspace.workspacePath AS workspacePath,
           workspace.baseCommit AS workspaceBaseCommit,
           workspace.status AS workspaceStatus
         FROM task_reviews AS review
         LEFT JOIN tasks AS task ON task.id = review.taskId
         LEFT JOIN task_workspaces AS workspace ON workspace.id = review.snapshotWorkspaceId
         WHERE review.id = ?`,
      )
      .get(reviewId) as ReviewerEvidenceSnapshotRow | undefined;

    return row ?? null;
  } catch (error) {
    if (error instanceof ReviewerClaimError) {
      throw error;
    }

    throw new ReviewerClaimError("No se pudo leer el snapshot del reviewer run.", {
      code: "REVIEWER_EVIDENCE_PERSISTENCE_FAILED",
      taskId: taskIdForError,
      reviewId,
      cause: error,
    });
  }
}

function mapReviewerEvidenceSnapshot(
  row: ReviewerEvidenceSnapshotRow,
  taskId: string,
  reviewId: string,
  snapshotErrorCode: "REVIEWER_EVIDENCE_SNAPSHOT_INVALID" | "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED",
): ReviewerEvidenceSnapshot {
  if (!Number.isFinite(row.reviewNumber) || !Number.isInteger(row.reviewNumber) || row.reviewNumber < 1) {
    throw reviewerEvidenceError("reviewNumber persistido inválido.", "REVIEWER_EVIDENCE_SNAPSHOT_INVALID", taskId, reviewId, {
      fieldName: "reviewNumber",
    });
  }

  if (!Number.isFinite(row.runNumber) || !Number.isInteger(row.runNumber) || row.runNumber < 1) {
    throw reviewerEvidenceError("runNumber persistido inválido.", "REVIEWER_EVIDENCE_SNAPSHOT_INVALID", taskId, reviewId, {
      fieldName: "runNumber",
    });
  }

  if (row.reviewStatus !== "RUNNING") {
    throw reviewerEvidenceError("El review ya no está RUNNING.", "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED", taskId, reviewId, {
      fieldName: "reviewStatus",
      actual: row.reviewStatus,
    });
  }

  if (row.taskId === null) {
    throw reviewerEvidenceError("La tarea del review no existe.", "REVIEWER_EVIDENCE_TASK_NOT_FOUND", taskId, reviewId);
  }

  if (row.taskState !== "REVIEWING") {
    throw reviewerEvidenceError("La tarea ya no está REVIEWING.", "REVIEWER_EVIDENCE_TASK_STATE_CHANGED", taskId, reviewId, {
      fieldName: "taskState",
      actual: row.taskState,
    });
  }

  if (row.projectId === null || row.projectId.trim().length === 0) {
    throw reviewerEvidenceError("projectId persistido inválido.", "REVIEWER_EVIDENCE_TASK_STATE_CHANGED", taskId, reviewId, {
      fieldName: "projectId",
    });
  }

  if (!isNonEmptyPersistedString(row.reviewerClaimJson)) {
    throw reviewerEvidenceError("El claim del reviewer ya no existe.", "REVIEWER_EVIDENCE_CLAIM_NOT_OWNED", taskId, reviewId, {
      fieldName: "reviewerClaimJson",
    });
  }

  if (!isNonEmptyPersistedString(row.snapshotWorkspaceId)) {
    throw reviewerEvidenceError("snapshotWorkspaceId persistido inválido.", snapshotErrorCode, taskId, reviewId, {
      fieldName: "snapshotWorkspaceId",
    });
  }

  if (!isNonEmptyPersistedString(row.snapshotBaseCommit)) {
    throw reviewerEvidenceError("snapshotBaseCommit persistido inválido.", snapshotErrorCode, taskId, reviewId, {
      fieldName: "snapshotBaseCommit",
    });
  }

  if (!isNonEmptyPersistedString(row.snapshotHeadCommit)) {
    throw reviewerEvidenceError("snapshotHeadCommit persistido inválido.", snapshotErrorCode, taskId, reviewId, {
      fieldName: "snapshotHeadCommit",
    });
  }

  if (!isNonEmptyPersistedString(row.snapshotFingerprint)) {
    throw reviewerEvidenceError("snapshotFingerprint persistido inválido.", snapshotErrorCode, taskId, reviewId, {
      fieldName: "snapshotFingerprint",
    });
  }

  if (!isNonEmptyPersistedString(row.contractJson)) {
    throw reviewerEvidenceError("contractJson persistido inválido.", "REVIEWER_EVIDENCE_CONTRACT_CHANGED", taskId, reviewId, {
      fieldName: "contractJson",
    });
  }

  if (!isNonEmptyPersistedString(row.currentRevisionJson)) {
    throw reviewerEvidenceError("currentRevisionJson persistido inválido.", "REVIEWER_EVIDENCE_REVISION_CHANGED", taskId, reviewId, {
      fieldName: "currentRevisionJson",
    });
  }

  if (row.workspaceId === null) {
    throw reviewerEvidenceError("El workspace del snapshot no existe.", "REVIEWER_EVIDENCE_WORKSPACE_NOT_FOUND", taskId, reviewId, {
      fieldName: "workspaceId",
    });
  }

  if (row.workspaceId !== row.snapshotWorkspaceId) {
    throw reviewerEvidenceError("workspaceId no coincide con snapshotWorkspaceId.", snapshotErrorCode, taskId, reviewId, {
      fieldName: "workspaceId",
    });
  }

  if (row.workspaceTaskId !== row.reviewTaskId) {
    throw reviewerEvidenceError("El workspace pertenece a otra tarea.", snapshotErrorCode, taskId, reviewId, {
      fieldName: "workspaceTaskId",
    });
  }

  if (row.workspaceStatus !== "READY") {
    throw reviewerEvidenceError("El workspace ya no está READY.", snapshotErrorCode, taskId, reviewId, {
      fieldName: "workspaceStatus",
      actual: row.workspaceStatus,
    });
  }

  if (row.workspaceBaseCommit !== row.snapshotBaseCommit) {
    throw reviewerEvidenceError("El baseCommit del workspace no coincide con el snapshot.", snapshotErrorCode, taskId, reviewId, {
      fieldName: "workspaceBaseCommit",
    });
  }

  if (!isNonEmptyPersistedString(row.workspacePath)) {
    throw reviewerEvidenceError("workspacePath persistido inválido.", snapshotErrorCode, taskId, reviewId, {
      fieldName: "workspacePath",
    });
  }

  return {
    taskId: row.reviewTaskId,
    projectId: row.projectId,
    reviewId: row.reviewId,
    reviewNumber: row.reviewNumber,
    runNumber: row.runNumber,
    reviewStatus: "RUNNING",
    reviewerClaimJson: row.reviewerClaimJson,
    snapshotWorkspaceId: row.snapshotWorkspaceId,
    snapshotBaseCommit: row.snapshotBaseCommit,
    snapshotHeadCommit: row.snapshotHeadCommit,
    snapshotFingerprint: row.snapshotFingerprint,
    taskState: "REVIEWING",
    contractJson: row.contractJson,
    currentRevisionJson: row.currentRevisionJson,
    workspaceId: row.workspaceId,
    workspaceTaskId: row.workspaceTaskId,
    workspacePath: row.workspacePath,
    workspaceBaseCommit: row.workspaceBaseCommit,
    workspaceStatus: "READY",
  };
}

function validateInitialSnapshot(
  snapshot: ReviewerEvidenceSnapshot,
  input: LoadReviewerEvidenceSnapshotInput,
): void {
  if (snapshot.taskId !== input.taskId) {
    throw reviewerEvidenceError("El review pertenece a otra tarea.", "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED", input.taskId, input.reviewId, {
      fieldName: "taskId",
    });
  }

  if (snapshot.reviewerClaimJson !== input.expectedReviewerClaimJson) {
    throw reviewerEvidenceError("El claim del reviewer no coincide.", "REVIEWER_EVIDENCE_CLAIM_NOT_OWNED", input.taskId, input.reviewId, {
      fieldName: "reviewerClaimJson",
    });
  }
}

function validateSnapshotShape(snapshot: ReviewerEvidenceSnapshot): void {
  requireReviewerEvidenceInputString(snapshot.taskId, "snapshot.taskId");
  requireReviewerEvidenceInputString(snapshot.projectId, "snapshot.projectId");
  requireReviewerEvidenceInputString(snapshot.reviewId, "snapshot.reviewId");
  requireReviewerEvidenceInputString(snapshot.reviewerClaimJson, "snapshot.reviewerClaimJson");
  requireReviewerEvidenceInputString(snapshot.snapshotWorkspaceId, "snapshot.snapshotWorkspaceId");
  requireReviewerEvidenceInputString(snapshot.snapshotBaseCommit, "snapshot.snapshotBaseCommit");
  requireReviewerEvidenceInputString(snapshot.snapshotHeadCommit, "snapshot.snapshotHeadCommit");
  requireReviewerEvidenceInputString(snapshot.snapshotFingerprint, "snapshot.snapshotFingerprint");
  requireReviewerEvidenceInputString(snapshot.contractJson, "snapshot.contractJson");
  requireReviewerEvidenceInputString(snapshot.currentRevisionJson, "snapshot.currentRevisionJson");
  requireReviewerEvidenceInputString(snapshot.workspaceId, "snapshot.workspaceId");
  requireReviewerEvidenceInputString(snapshot.workspaceTaskId, "snapshot.workspaceTaskId");
  requireReviewerEvidenceInputString(snapshot.workspacePath, "snapshot.workspacePath");
  requireReviewerEvidenceInputString(snapshot.workspaceBaseCommit, "snapshot.workspaceBaseCommit");

  if (!Number.isFinite(snapshot.reviewNumber) || !Number.isInteger(snapshot.reviewNumber) || snapshot.reviewNumber < 1) {
    throw new ReviewerClaimError("snapshot.reviewNumber inválido.", {
      code: "REVIEWER_EVIDENCE_INVALID_INPUT",
      taskId: snapshot.taskId,
      reviewId: snapshot.reviewId,
      details: { fieldName: "snapshot.reviewNumber" },
    });
  }

  if (!Number.isFinite(snapshot.runNumber) || !Number.isInteger(snapshot.runNumber) || snapshot.runNumber < 1) {
    throw new ReviewerClaimError("snapshot.runNumber inválido.", {
      code: "REVIEWER_EVIDENCE_INVALID_INPUT",
      taskId: snapshot.taskId,
      reviewId: snapshot.reviewId,
      details: { fieldName: "snapshot.runNumber" },
    });
  }

  if (snapshot.reviewStatus !== "RUNNING") {
    throw new ReviewerClaimError("snapshot.reviewStatus inválido.", {
      code: "REVIEWER_EVIDENCE_INVALID_INPUT",
      taskId: snapshot.taskId,
      reviewId: snapshot.reviewId,
      details: { fieldName: "snapshot.reviewStatus" },
    });
  }

  if (snapshot.taskState !== "REVIEWING") {
    throw new ReviewerClaimError("snapshot.taskState inválido.", {
      code: "REVIEWER_EVIDENCE_INVALID_INPUT",
      taskId: snapshot.taskId,
      reviewId: snapshot.reviewId,
      details: { fieldName: "snapshot.taskState" },
    });
  }

  if (snapshot.workspaceStatus !== "READY") {
    throw new ReviewerClaimError("snapshot.workspaceStatus inválido.", {
      code: "REVIEWER_EVIDENCE_INVALID_INPUT",
      taskId: snapshot.taskId,
      reviewId: snapshot.reviewId,
      details: { fieldName: "snapshot.workspaceStatus" },
    });
  }
}

function throwIfChanged(
  expected: string | number,
  actual: string | number,
  fieldName: string,
  code: string,
  snapshot: ReviewerEvidenceSnapshot,
): void {
  if (expected !== actual) {
    throw reviewerEvidenceError(`Snapshot cambió: ${fieldName}.`, code, snapshot.taskId, snapshot.reviewId, {
      fieldName,
    });
  }
}

function compareSnapshot(
  snapshot: ReviewerEvidenceSnapshot,
  current: ReviewerEvidenceSnapshot,
): void {
  throwIfChanged(snapshot.reviewId, current.reviewId, "reviewId", "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED", snapshot);
  throwIfChanged(snapshot.taskId, current.taskId, "taskId", "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED", snapshot);
  throwIfChanged(snapshot.reviewNumber, current.reviewNumber, "reviewNumber", "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED", snapshot);
  throwIfChanged(snapshot.runNumber, current.runNumber, "runNumber", "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED", snapshot);
  throwIfChanged(snapshot.reviewStatus, current.reviewStatus, "reviewStatus", "REVIEWER_EVIDENCE_REVIEW_STATE_CHANGED", snapshot);
  throwIfChanged(snapshot.projectId, current.projectId, "projectId", "REVIEWER_EVIDENCE_TASK_STATE_CHANGED", snapshot);
  throwIfChanged(snapshot.taskState, current.taskState, "taskState", "REVIEWER_EVIDENCE_TASK_STATE_CHANGED", snapshot);
  throwIfChanged(snapshot.reviewerClaimJson, current.reviewerClaimJson, "reviewerClaimJson", "REVIEWER_EVIDENCE_CLAIM_NOT_OWNED", snapshot);
  throwIfChanged(snapshot.snapshotWorkspaceId, current.snapshotWorkspaceId, "snapshotWorkspaceId", "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED", snapshot);
  throwIfChanged(snapshot.snapshotBaseCommit, current.snapshotBaseCommit, "snapshotBaseCommit", "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED", snapshot);
  throwIfChanged(snapshot.snapshotHeadCommit, current.snapshotHeadCommit, "snapshotHeadCommit", "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED", snapshot);
  throwIfChanged(snapshot.snapshotFingerprint, current.snapshotFingerprint, "snapshotFingerprint", "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED", snapshot);
  throwIfChanged(snapshot.contractJson, current.contractJson, "contractJson", "REVIEWER_EVIDENCE_CONTRACT_CHANGED", snapshot);
  throwIfChanged(snapshot.currentRevisionJson, current.currentRevisionJson, "currentRevisionJson", "REVIEWER_EVIDENCE_REVISION_CHANGED", snapshot);
  throwIfChanged(snapshot.workspaceId, current.workspaceId, "workspaceId", "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED", snapshot);
  throwIfChanged(snapshot.workspaceTaskId, current.workspaceTaskId, "workspaceTaskId", "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED", snapshot);
  throwIfChanged(snapshot.workspacePath, current.workspacePath, "workspacePath", "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED", snapshot);
  throwIfChanged(snapshot.workspaceBaseCommit, current.workspaceBaseCommit, "workspaceBaseCommit", "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED", snapshot);
  throwIfChanged(snapshot.workspaceStatus, current.workspaceStatus, "workspaceStatus", "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED", snapshot);
}

export function loadReviewerEvidenceSnapshot(
  database: DatabaseSync,
  input: LoadReviewerEvidenceSnapshotInput,
): ReviewerEvidenceSnapshot {
  const taskId = requireReviewerEvidenceInputString(input.taskId, "taskId");
  const reviewId = requireReviewerEvidenceInputString(input.reviewId, "reviewId");
  const expectedReviewerClaimJson = requireReviewerEvidenceInputString(input.expectedReviewerClaimJson, "expectedReviewerClaimJson");

  const row = readReviewerEvidenceSnapshotRow(database, reviewId, taskId);
  if (row === null) {
    throw reviewerEvidenceError(`No existe el review: ${reviewId}`, "REVIEWER_EVIDENCE_REVIEW_NOT_FOUND", taskId, reviewId);
  }

  const snapshot = mapReviewerEvidenceSnapshot(row, taskId, reviewId, "REVIEWER_EVIDENCE_SNAPSHOT_INVALID");
  validateInitialSnapshot(snapshot, { taskId, reviewId, expectedReviewerClaimJson });
  return snapshot;
}

export function assertReviewerEvidenceSnapshotStillOwned(
  database: DatabaseSync,
  snapshot: ReviewerEvidenceSnapshot,
): void {
  validateSnapshotShape(snapshot);

  const row = readReviewerEvidenceSnapshotRow(database, snapshot.reviewId, snapshot.taskId);
  if (row === null) {
    throw reviewerEvidenceError(`No existe el review: ${snapshot.reviewId}`, "REVIEWER_EVIDENCE_REVIEW_NOT_FOUND", snapshot.taskId, snapshot.reviewId);
  }

  const current = mapReviewerEvidenceSnapshot(row, snapshot.taskId, snapshot.reviewId, "REVIEWER_EVIDENCE_SNAPSHOT_CHANGED");
  compareSnapshot(snapshot, current);
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
