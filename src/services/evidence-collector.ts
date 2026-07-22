/// <reference types="node" />

import { spawnSync } from "node:child_process";

import type { DatabaseSync } from "node:sqlite";

import type { EvidenceFile } from "../schemas/evidence-bundle-schema.js";
import type {
  EvidenceBundle,
} from "../schemas/evidence-bundle-schema.js";
import {
  deterministicRevisionEvidenceSchema,
} from "../schemas/evidence-bundle-schema.js";
import {
  approvedContractEvidenceSchema,
} from "../schemas/evidence-bundle-schema.js";
import { previousCorrectionSchema } from "../schemas/evidence-bundle-schema.js";
import type { PreviousCorrection } from "../schemas/evidence-bundle-schema.js";
import type { DeterministicRevisionResult } from "./deterministic-revision-result.js";
import type { ChangedFile } from "./git-change-detector.js";
import { detectGitChanges, GitChangeDetectionError } from "./git-change-detector.js";
import { collectEvidenceFiles, EvidenceFileCollectorError } from "./evidence-file-collector.js";
import type { EvidenceFileCollectorDeps } from "./evidence-file-collector.js";
import { createEvidenceBundle, EvidenceBundleError } from "./evidence-bundle-service.js";
import { computeWorkspaceFingerprint, WorkspaceFingerprintError } from "./workspace-fingerprint.js";
import type { WorkspaceFingerprint } from "./workspace-fingerprint.js";
import {
  loadReviewerEvidenceSnapshot,
  assertReviewerEvidenceSnapshotStillOwned,
  ReviewerClaimError,
} from "./reviewer-claim-service.js";
import type { ReviewerEvidenceSnapshot } from "./reviewer-claim-service.js";
import { PersistedTaskContractError, getTaskContract } from "../repositories/task-repository.js";
import { listCompletedReviewsByTaskId } from "../repositories/task-review-repository.js";
import type { TaskReview } from "../types.js";
import { reviewerResultSchema } from "../schemas/reviewer-result-schema.js";
import type { ReviewerResult } from "../schemas/reviewer-result-schema.js";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type EvidenceCollectorErrorCode =
  | "INVALID_INPUT"
  | "GIT_DETECTION_FAILED"
  | "HEAD_COMMIT_MISMATCH"
  | "WORKSPACE_CHANGED_DURING_COLLECTION"
  | "CONTRACT_NOT_APPROVED"
  | "CONTRACT_INVALID"
  | "DETERMINISTIC_REVISION_INVALID"
  | "PREVIOUS_REVIEW_INVALID"
  | "PREVIOUS_REVIEW_APPROVED"
  | "DUPLICATE_REVIEW_NUMBER";

export class EvidenceCollectorError extends Error {
  readonly code: EvidenceCollectorErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: {
      readonly code: EvidenceCollectorErrorCode;
      readonly cause?: unknown;
      readonly details?: Record<string, unknown>;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EvidenceCollectorError";
    this.code = options.code;
    if (options.details !== undefined) {
      this.details = Object.freeze({ ...options.details });
    }
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EvidenceCollectorInput {
  readonly taskId: string;
  readonly reviewId: string;
  readonly expectedReviewerClaimJson: string;
}

export interface EvidenceCollectorDeps {
  readonly loadSnapshot?: (
    database: DatabaseSync,
    input: { taskId: string; reviewId: string; expectedReviewerClaimJson: string },
  ) => ReviewerEvidenceSnapshot;
  readonly assertSnapshotStillOwned?: (
    database: DatabaseSync,
    snapshot: ReviewerEvidenceSnapshot,
  ) => void;
  readonly computeFingerprint?: (input: {
    workspacePath: string;
    workspaceId: string;
    baseCommit: string;
  }) => WorkspaceFingerprint;
  readonly detectChanges?: (workspacePath: string, baseCommit: string) => { changedFiles: readonly ChangedFile[] };
  readonly collectFiles?: (
    input: { workspacePath: string; baseCommit: string; changedFiles: readonly ChangedFile[] },
    deps?: EvidenceFileCollectorDeps,
  ) => readonly EvidenceFile[];
  readonly createBundle?: (input: unknown) => EvidenceBundle;
  readonly listCompletedReviews?: (database: DatabaseSync, taskId: string) => readonly TaskReview[];
  readonly getTaskContract?: (database: DatabaseSync, taskId: string) => import("../types.js").TaskContract | null;
  readonly readPreviousBlobBytes?: (
    workspacePath: string,
    baseCommit: string,
    filePath: string,
    objectId: string,
  ) => Buffer;
  readonly readPreviousSymlinkTarget?: (
    workspacePath: string,
    baseCommit: string,
    filePath: string,
    objectId: string,
  ) => string;
  readonly readPatch?: (
    workspacePath: string,
    baseCommit: string,
    filePath: string,
    previousPath?: string,
  ) => string;
}

// ---------------------------------------------------------------------------
// Default git readers
// ---------------------------------------------------------------------------

function defaultReadPreviousBlobBytes(
  workspacePath: string,
  baseCommit: string,
  filePath: string,
  objectId: string,
): Buffer {
  const args = ["cat-file", "blob", objectId];
  const result = spawnSync("git", ["-C", workspacePath, ...args], {
    encoding: "buffer",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error !== undefined) {
    throw new EvidenceCollectorError("No se encontró el binario de Git.", {
      code: "GIT_DETECTION_FAILED",
      cause: result.error,
    });
  }

  if (result.status !== 0) {
    throw new EvidenceCollectorError(
      `Git falló al leer blob anterior: ${args.join(" ")}`,
      {
        code: "GIT_DETECTION_FAILED",
        details: {
          path: filePath,
          objectId,
          exitCode: result.status,
          signal: result.signal ?? null,
        },
      },
    );
  }

  return result.stdout as Buffer;
}

function defaultReadPreviousSymlinkTarget(
  workspacePath: string,
  baseCommit: string,
  filePath: string,
  objectId: string,
): string {
  const args = ["cat-file", "blob", objectId];
  const result = spawnSync("git", ["-C", workspacePath, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error !== undefined) {
    throw new EvidenceCollectorError("No se encontró el binario de Git.", {
      code: "GIT_DETECTION_FAILED",
      cause: result.error,
    });
  }

  if (result.status !== 0) {
    throw new EvidenceCollectorError(
      `Git falló al leer symlink anterior: ${args.join(" ")}`,
      {
        code: "GIT_DETECTION_FAILED",
        details: {
          path: filePath,
          objectId,
          exitCode: result.status,
          signal: result.signal ?? null,
        },
      },
    );
  }

  return result.stdout;
}

function defaultReadPatch(
  workspacePath: string,
  baseCommit: string,
  filePath: string,
  previousPath?: string,
): string {
  const paths = previousPath !== undefined ? [previousPath, filePath] : [filePath];
  const args = ["diff", baseCommit, "--", ...paths];
  const result = spawnSync("git", ["-C", workspacePath, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error !== undefined) {
    throw new EvidenceCollectorError("No se encontró el binario de Git.", {
      code: "GIT_DETECTION_FAILED",
      cause: result.error,
    });
  }

  if (result.status !== 0) {
    throw new EvidenceCollectorError(
      `Git falló al leer patch: ${args.join(" ")}`,
      {
        code: "GIT_DETECTION_FAILED",
        details: {
          path: filePath,
          previousPath,
          exitCode: result.status,
          signal: result.signal ?? null,
        },
      },
    );
  }

  if (result.stdout.length === 0) {
    throw new EvidenceCollectorError("Git devolvió un patch vacío.", {
      code: "GIT_DETECTION_FAILED",
      details: {
        path: filePath,
        previousPath,
      },
    });
  }

  return result.stdout;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: string, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EvidenceCollectorError(`${fieldName} no puede estar vacío.`, {
      code: "INVALID_INPUT",
      details: { fieldName },
    });
  }
  return value;
}

function requireDatabase(database: unknown): DatabaseSync {
  if (database === null || database === undefined || typeof database !== "object") {
    throw new EvidenceCollectorError("database es requerido.", {
      code: "INVALID_INPUT",
      details: { fieldName: "database" },
    });
  }
  return database as DatabaseSync;
}

// ---------------------------------------------------------------------------
// Snapshot stability
// ---------------------------------------------------------------------------

function verifyInitialSnapshotState(
  snapshot: ReviewerEvidenceSnapshot,
  fingerprint: WorkspaceFingerprint,
): void {
  if (fingerprint.headCommit !== snapshot.snapshotHeadCommit) {
    throw new EvidenceCollectorError("headCommit del snapshot no coincide con el workspace actual.", {
      code: "HEAD_COMMIT_MISMATCH",
      details: {
        expected: snapshot.snapshotHeadCommit,
        actual: fingerprint.headCommit,
      },
    });
  }

  if (fingerprint.workingTreeFingerprint !== snapshot.snapshotFingerprint) {
    throw new EvidenceCollectorError("fingerprint del snapshot no coincide con el workspace actual.", {
      code: "WORKSPACE_CHANGED_DURING_COLLECTION",
      details: {
        expected: snapshot.snapshotFingerprint,
        actual: fingerprint.workingTreeFingerprint,
      },
    });
  }
}

function verifyFinalSnapshotState(
  snapshot: ReviewerEvidenceSnapshot,
  fingerprint: WorkspaceFingerprint,
): void {
  if (fingerprint.headCommit !== snapshot.snapshotHeadCommit) {
    throw new EvidenceCollectorError("headCommit del workspace cambió durante la recolección.", {
      code: "WORKSPACE_CHANGED_DURING_COLLECTION",
      details: {
        expected: snapshot.snapshotHeadCommit,
        actual: fingerprint.headCommit,
      },
    });
  }

  if (fingerprint.workingTreeFingerprint !== snapshot.snapshotFingerprint) {
    throw new EvidenceCollectorError("fingerprint del workspace cambió durante la recolección.", {
      code: "WORKSPACE_CHANGED_DURING_COLLECTION",
      details: {
        expected: snapshot.snapshotFingerprint,
        actual: fingerprint.workingTreeFingerprint,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Deterministic revision
// ---------------------------------------------------------------------------

function buildRevisionEvidence(
  snapshot: ReviewerEvidenceSnapshot,
): DeterministicRevisionResult["status"] extends infer S
  ? { status: S; pathValidation: DeterministicRevisionResult["pathValidation"]; commandsResult: DeterministicRevisionResult["commandsResult"] }
  : never {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.currentRevisionJson);
  } catch (error) {
    throw new EvidenceCollectorError("currentRevisionJson no es JSON válido.", {
      code: "DETERMINISTIC_REVISION_INVALID",
      cause: error,
    });
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).taskId !== snapshot.taskId
  ) {
    throw new EvidenceCollectorError("La revisión determinista no pertenece a esta tarea.", {
      code: "DETERMINISTIC_REVISION_INVALID",
      details: { taskId: snapshot.taskId },
    });
  }

  const revision = parsed as Record<string, unknown>;
  if (revision.projectId !== snapshot.projectId) {
    throw new EvidenceCollectorError("La revisión determinista no pertenece a este proyecto.", {
      code: "DETERMINISTIC_REVISION_INVALID",
      details: { projectId: snapshot.projectId },
    });
  }

  if (revision.workspaceId !== snapshot.snapshotWorkspaceId) {
    throw new EvidenceCollectorError("La revisión determinista no pertenece a este workspace.", {
      code: "DETERMINISTIC_REVISION_INVALID",
      details: { workspaceId: snapshot.snapshotWorkspaceId },
    });
  }

  if (revision.baseCommit !== snapshot.snapshotBaseCommit) {
    throw new EvidenceCollectorError("La revisión determinista no corresponde al baseCommit del snapshot.", {
      code: "DETERMINISTIC_REVISION_INVALID",
      details: { baseCommit: snapshot.snapshotBaseCommit },
    });
  }

  if (
    revision.status !== "REVIEWING" &&
    revision.status !== "REVISION_REQUIRED"
  ) {
    throw new EvidenceCollectorError("La revisión determinista tiene status inválido.", {
      code: "DETERMINISTIC_REVISION_INVALID",
      details: { status: revision.status },
    });
  }

  const pathValidation = revision.pathValidation as DeterministicRevisionResult["pathValidation"];
  const commandsResult = revision.commandsResult as DeterministicRevisionResult["commandsResult"];

  if (pathValidation === undefined || pathValidation === null) {
    throw new EvidenceCollectorError("La revisión determinista no tiene pathValidation.", {
      code: "DETERMINISTIC_REVISION_INVALID",
    });
  }

  const evidenceData = {
    status: revision.status,
    pathValidation,
    commandsResult,
  };

  const schemaResult = deterministicRevisionEvidenceSchema.safeParse(evidenceData);
  if (!schemaResult.success) {
    throw new EvidenceCollectorError("La evidencia de revisión determinista no pasa validación de esquema.", {
      code: "DETERMINISTIC_REVISION_INVALID",
      details: {
        schemaErrors: schemaResult.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    });
  }

  return evidenceData as { status: typeof revision.status; pathValidation: DeterministicRevisionResult["pathValidation"]; commandsResult: DeterministicRevisionResult["commandsResult"] };
}

// ---------------------------------------------------------------------------
// Approved contract
// ---------------------------------------------------------------------------

type ApprovedContractEvidence = {
  objective: string;
  context: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  requiredCommands: string[];
  assumptions: string[];
  risks: string[];
};

function buildApprovedContractEvidence(
  database: DatabaseSync,
  taskId: string,
  getTaskContractFn: (database: DatabaseSync, taskId: string) => import("../types.js").TaskContract | null,
): ApprovedContractEvidence {
  let contract;
  try {
    contract = getTaskContractFn(database, taskId);
  } catch (error) {
    if (error instanceof PersistedTaskContractError) {
      throw new EvidenceCollectorError("El contrato de la tarea persistido es inválido.", {
        code: "CONTRACT_INVALID",
        cause: error,
      });
    }

    if (error instanceof Error) {
      throw new EvidenceCollectorError("No se pudo cargar el contrato de la tarea.", {
        code: "CONTRACT_INVALID",
        cause: error,
      });
    }

    throw error;
  }

  if (contract === null) {
    throw new EvidenceCollectorError("El contrato de la tarea no está aprobado.", {
      code: "CONTRACT_NOT_APPROVED",
    });
  }

  const evidenceData: ApprovedContractEvidence = {
    objective: contract.objective,
    context: contract.context,
    acceptanceCriteria: contract.acceptanceCriteria,
    allowedPaths: contract.allowedPaths,
    forbiddenPaths: contract.forbiddenPaths,
    requiredCommands: contract.requiredCommands,
    assumptions: contract.assumptions,
    risks: contract.risks,
  };

  const schemaResult = approvedContractEvidenceSchema.safeParse(evidenceData);
  if (!schemaResult.success) {
    throw new EvidenceCollectorError("La evidencia del contrato aprobado no pasa validación de esquema.", {
      code: "CONTRACT_INVALID",
      details: {
        schemaErrors: schemaResult.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    });
  }

  return evidenceData;
}

// ---------------------------------------------------------------------------
// Previous corrections
// ---------------------------------------------------------------------------

function buildPreviousCorrections(
  snapshot: ReviewerEvidenceSnapshot,
  listCompletedReviews: (database: DatabaseSync, taskId: string) => readonly TaskReview[],
  database: DatabaseSync,
): readonly PreviousCorrection[] {
  const allCompleted = listCompletedReviews(database, snapshot.taskId);

  const completedAsc = [...allCompleted].sort((a, b) => a.reviewNumber - b.reviewNumber);

  const corrections: PreviousCorrection[] = [];
  const seenNumbers = new Set<number>();

  for (const review of completedAsc) {
    if (review.status !== "COMPLETED") {
      throw new EvidenceCollectorError("Review no completado en reviews completados.", {
        code: "PREVIOUS_REVIEW_INVALID",
        details: {
          reviewNumber: review.reviewNumber,
          status: review.status,
          reviewId: review.id,
        },
      });
    }

    if (review.reviewNumber >= snapshot.reviewNumber) {
      throw new EvidenceCollectorError("Review con reviewNumber >= current reviewNumber.", {
        code: "PREVIOUS_REVIEW_INVALID",
        details: {
          reviewNumber: review.reviewNumber,
          currentReviewNumber: snapshot.reviewNumber,
          reviewId: review.id,
        },
      });
    }

    if (seenNumbers.has(review.reviewNumber)) {
      throw new EvidenceCollectorError("Número de review duplicado en reviews completados.", {
        code: "DUPLICATE_REVIEW_NUMBER",
        details: {
          reviewNumber: review.reviewNumber,
          reviewId: review.id,
        },
      });
    }
    seenNumbers.add(review.reviewNumber);

    if (review.verdict === "APPROVED") {
      throw new EvidenceCollectorError("Review aprobado no debería estar en reviews completados.", {
        code: "PREVIOUS_REVIEW_APPROVED",
        details: {
          reviewNumber: review.reviewNumber,
          reviewId: review.id,
        },
      });
    }

    if (review.verdict !== "REVISION_REQUIRED") {
      throw new EvidenceCollectorError("Review con verdict inválido.", {
        code: "PREVIOUS_REVIEW_INVALID",
        details: {
          reviewNumber: review.reviewNumber,
          verdict: review.verdict,
          reviewId: review.id,
        },
      });
    }

    if (review.findingsJson === null || review.requiredChangesJson === null) {
      throw new EvidenceCollectorError("Review REVISION_REQUIRED sin findingsJson o requiredChangesJson.", {
        code: "PREVIOUS_REVIEW_INVALID",
        details: { reviewId: review.id, reviewNumber: review.reviewNumber },
      });
    }

    let findings: ReviewerResult["findings"];
    try {
      findings = JSON.parse(review.findingsJson) as ReviewerResult["findings"];
    } catch (error) {
      throw new EvidenceCollectorError("findingsJson no es JSON válido.", {
        code: "PREVIOUS_REVIEW_INVALID",
        cause: error,
        details: { reviewId: review.id },
      });
    }

    let requiredChanges: ReviewerResult["requiredChanges"];
    try {
      requiredChanges = JSON.parse(review.requiredChangesJson) as ReviewerResult["requiredChanges"];
    } catch (error) {
      throw new EvidenceCollectorError("requiredChangesJson no es JSON válido.", {
        code: "PREVIOUS_REVIEW_INVALID",
        cause: error,
        details: { reviewId: review.id },
      });
    }

    const reviewerResult: ReviewerResult = {
      verdict: "REVISION_REQUIRED",
      summary: review.summary ?? "",
      findings,
      requiredChanges,
    };

    const validationResult = reviewerResultSchema.safeParse(reviewerResult);
    if (!validationResult.success) {
      throw new EvidenceCollectorError("El resultado del reviewer anterior no es válido.", {
        code: "PREVIOUS_REVIEW_INVALID",
        details: {
          reviewId: review.id,
          reviewNumber: review.reviewNumber,
          schemaErrors: validationResult.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      });
    }

    const correctionData = {
      reviewNumber: review.reviewNumber,
      verdict: "REVISION_REQUIRED" as const,
      summary: reviewerResult.summary,
      findings: reviewerResult.findings,
      requiredChanges: reviewerResult.requiredChanges,
    };

    const correctionResult = previousCorrectionSchema.safeParse(correctionData);
    if (!correctionResult.success) {
      throw new EvidenceCollectorError("La corrección anterior no es válida.", {
        code: "PREVIOUS_REVIEW_INVALID",
        details: {
          reviewId: review.id,
          reviewNumber: review.reviewNumber,
          schemaErrors: correctionResult.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      });
    }

    corrections.push(correctionResult.data);
  }

  return corrections;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapError(error: unknown): never {
  if (error instanceof EvidenceCollectorError) {
    throw error;
  }

  if (
    error instanceof ReviewerClaimError ||
    error instanceof EvidenceFileCollectorError ||
    error instanceof EvidenceBundleError
  ) {
    throw error;
  }

  if (error instanceof GitChangeDetectionError) {
    throw new EvidenceCollectorError("Error al detectar cambios Git.", {
      code: "GIT_DETECTION_FAILED",
      cause: error,
      details: {
        gitErrorCode: error.code,
        command: error.command,
        exitCode: error.exitCode,
      },
    });
  }

  if (error instanceof PersistedTaskContractError) {
    throw new EvidenceCollectorError("El contrato de la tarea persistido es inválido.", {
      code: "CONTRACT_INVALID",
      cause: error,
    });
  }

  if (error instanceof WorkspaceFingerprintError) {
    throw new EvidenceCollectorError("Error al calcular fingerprint del workspace.", {
      code: "WORKSPACE_CHANGED_DURING_COLLECTION",
      cause: error,
      details: { fingerprintErrorCode: error.code },
    });
  }

  if (error instanceof SyntaxError) {
    throw new EvidenceCollectorError("Error al parsear JSON.", {
      code: "DETERMINISTIC_REVISION_INVALID",
      cause: error,
    });
  }

  throw new EvidenceCollectorError("Error inesperado durante la recolección de evidencia.", {
    code: "INVALID_INPUT",
    cause: error,
  });
}

// ---------------------------------------------------------------------------
// ChangedFiles structural comparison
// ---------------------------------------------------------------------------

function compareChangedFile(actual: ChangedFile, expected: ChangedFile): boolean {
  if (actual.status !== expected.status) return false;
  if (actual.path !== expected.path) return false;

  switch (actual.status) {
    case "ADDED": {
      if (expected.status !== "ADDED") return false;
      if (actual.currentMode !== expected.currentMode) return false;
      return true;
    }
    case "MODIFIED": {
      if (expected.status !== "MODIFIED") return false;
      if (actual.previousMode !== expected.previousMode) return false;
      if (actual.currentMode !== expected.currentMode) return false;
      if (actual.previousObjectId !== expected.previousObjectId) return false;
      return true;
    }
    case "DELETED": {
      if (expected.status !== "DELETED") return false;
      if (actual.previousMode !== expected.previousMode) return false;
      if (actual.previousObjectId !== expected.previousObjectId) return false;
      return true;
    }
    case "RENAMED": {
      if (expected.status !== "RENAMED") return false;
      if (actual.previousPath !== expected.previousPath) return false;
      if (actual.previousMode !== expected.previousMode) return false;
      if (actual.currentMode !== expected.currentMode) return false;
      if (actual.previousObjectId !== expected.previousObjectId) return false;
      if (actual.similarityScore !== expected.similarityScore) return false;
      return true;
    }
    case "UNTRACKED": {
      if (expected.status !== "UNTRACKED") return false;
      if (actual.currentMode !== expected.currentMode) return false;
      return true;
    }
  }
}

function assertChangedFilesMatch(
  actualFiles: readonly ChangedFile[],
  expectedFiles: readonly ChangedFile[],
): void {
  if (actualFiles.length !== expectedFiles.length) {
    throw new EvidenceCollectorError("El número de changedFiles no coincide con la revisión determinista.", {
      code: "DETERMINISTIC_REVISION_INVALID",
      details: {
        expected: expectedFiles.length,
        actual: actualFiles.length,
      },
    });
  }

  for (let i = 0; i < actualFiles.length; i++) {
    const actual = actualFiles[i]!;
    const expected = expectedFiles[i]!;
    if (!compareChangedFile(actual, expected)) {
      throw new EvidenceCollectorError("El changedFile no coincide con la revisión determinista.", {
        code: "DETERMINISTIC_REVISION_INVALID",
        details: {
          index: i,
          expected,
          actual,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export function collectEvidenceBundle(
  database: DatabaseSync,
  input: EvidenceCollectorInput,
  deps: EvidenceCollectorDeps = {},
): EvidenceBundle {
  try {
    const db = requireDatabase(database);
    const taskId = requireNonEmptyString(input.taskId, "taskId");
    const reviewId = requireNonEmptyString(input.reviewId, "reviewId");
    const expectedReviewerClaimJson = requireNonEmptyString(
      input.expectedReviewerClaimJson,
      "expectedReviewerClaimJson",
    );

    const loadSnapshot = deps.loadSnapshot ?? loadReviewerEvidenceSnapshot;
    const assertSnapshotStillOwned = deps.assertSnapshotStillOwned ?? assertReviewerEvidenceSnapshotStillOwned;
    const computeFingerprint = deps.computeFingerprint ?? computeWorkspaceFingerprint;
    const detectChanges = deps.detectChanges ?? detectGitChanges;
    const collectFiles = deps.collectFiles ?? collectEvidenceFiles;
    const createBundle = deps.createBundle ?? createEvidenceBundle;
    const listCompletedReviews = deps.listCompletedReviews ?? listCompletedReviewsByTaskId;
    const getTaskContractFn = deps.getTaskContract ?? getTaskContract;

    const readPreviousBlobBytesFn = deps.readPreviousBlobBytes ?? defaultReadPreviousBlobBytes;
    const readPreviousSymlinkTargetFn = deps.readPreviousSymlinkTarget ?? defaultReadPreviousSymlinkTarget;
    const readPatchFn = deps.readPatch ?? defaultReadPatch;

    const snapshot = loadSnapshot(db, {
      taskId,
      reviewId,
      expectedReviewerClaimJson,
    });

    if (snapshot.taskId !== taskId) {
      throw new EvidenceCollectorError("El snapshot no pertenece a la tarea solicitada.", {
        code: "CONTRACT_INVALID",
        details: { taskId: snapshot.taskId },
      });
    }

    const fingerprint = computeFingerprint({
      workspacePath: snapshot.workspacePath,
      workspaceId: snapshot.snapshotWorkspaceId,
      baseCommit: snapshot.snapshotBaseCommit,
    });

    verifyInitialSnapshotState(snapshot, fingerprint);

    const detection = detectChanges(snapshot.workspacePath, snapshot.snapshotBaseCommit);
    const changedFiles = detection.changedFiles;

    const files: readonly EvidenceFile[] = collectFiles(
      {
        workspacePath: snapshot.workspacePath,
        baseCommit: snapshot.snapshotBaseCommit,
        changedFiles,
      },
      {
        readPreviousBlobBytes: readPreviousBlobBytesFn,
        readPreviousSymlinkTarget: readPreviousSymlinkTargetFn,
        readPatch: readPatchFn,
      },
    );

    const finalFingerprint = computeFingerprint({
      workspacePath: snapshot.workspacePath,
      workspaceId: snapshot.snapshotWorkspaceId,
      baseCommit: snapshot.snapshotBaseCommit,
    });

    verifyFinalSnapshotState(snapshot, finalFingerprint);

    const deterministicRevision = buildRevisionEvidence(snapshot);

    const revisionParsed = JSON.parse(snapshot.currentRevisionJson) as Record<string, unknown>;
    const revisionChangedFiles = revisionParsed.changedFiles as readonly ChangedFile[];
    assertChangedFilesMatch(changedFiles, revisionChangedFiles);

    const approvedContract = buildApprovedContractEvidence(db, snapshot.taskId, getTaskContractFn);
    const previousCorrections = buildPreviousCorrections(
      snapshot,
      listCompletedReviews,
      db,
    );

    const bundleBody: {
      version: 1;
      baseCommit: string;
      headCommit: string;
      workspaceFingerprint: string;
      files: EvidenceFile[];
      deterministicRevision: typeof deterministicRevision;
      previousCorrections: PreviousCorrection[];
      approvedContract: ApprovedContractEvidence;
    } = {
      version: 1,
      baseCommit: snapshot.snapshotBaseCommit,
      headCommit: snapshot.snapshotHeadCommit,
      workspaceFingerprint: snapshot.snapshotFingerprint,
      files: [...files],
      deterministicRevision,
      previousCorrections: [...previousCorrections],
      approvedContract,
    };

    const bundle = createBundle(bundleBody);

    assertSnapshotStillOwned(db, snapshot);

    return bundle;
  } catch (error) {
    mapError(error);
  }
}
