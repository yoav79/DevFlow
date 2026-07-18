/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { TaskWorkspace } from "../types.js";
import {
  getTaskWorkspaceById,
  updateTaskWorkspaceStatus,
} from "../repositories/task-workspace-repository.js";
import { getTaskById } from "../repositories/task-repository.js";
import { getProjectById } from "../repositories/project-repository.js";
import {
  reconcileFailedTaskWorkspace,
  type WorkspaceReconciliationOutcome,
} from "./workspace-reconciliation-service.js";
import { createGitWorktree } from "./git-worktree-service.js";

export type WorkspaceRetryPhase =
  | "LOAD_WORKSPACE"
  | "VALIDATE_WORKSPACE"
  | "RECONCILE_WORKSPACE"
  | "VERIFY_RECONCILED_STATE"
  | "MARK_PREPARING"
  | "CREATE_WORKTREE"
  | "MARK_READY"
  | "MARK_FAILED"
  | "LOAD_RESULT"
  | "VERIFY_IDENTITY";

export class WorkspaceRetryError extends Error {
  readonly phase: WorkspaceRetryPhase;
  readonly workspaceId?: string;
  readonly taskId?: string;
  readonly reconciliationOutcome?: WorkspaceReconciliationOutcome;
  readonly secondaryCause?: unknown;

  constructor(
    message: string,
    options: {
      phase: WorkspaceRetryPhase;
      workspaceId?: string;
      taskId?: string;
      reconciliationOutcome?: WorkspaceReconciliationOutcome;
      cause?: unknown;
      secondaryCause?: unknown;
    },
  ) {
    super(message);
    this.name = "WorkspaceRetryError";
    this.phase = options.phase;
    this.workspaceId = options.workspaceId;
    this.taskId = options.taskId;
    this.reconciliationOutcome = options.reconciliationOutcome;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options.secondaryCause !== undefined) {
      this.secondaryCause = options.secondaryCause;
    }
  }
}

function assertIdentical(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  fields: string[],
  label: string,
  phase: WorkspaceRetryPhase,
  workspaceId?: string,
): void {
  for (const field of fields) {
    if (a[field] !== b[field]) {
      throw new WorkspaceRetryError(
        `Cambio concurrente detectado en ${label}: campo ${field} cambió.`,
        { phase, workspaceId },
      );
    }
  }
}

export function retryFailedTaskWorkspace(
  database: DatabaseSync,
  workspaceId: string,
): TaskWorkspace {
  const normalizedId = workspaceId.trim();

  if (normalizedId.length === 0) {
    throw new WorkspaceRetryError(
      "El id del workspace no puede estar vacío.",
      { phase: "LOAD_WORKSPACE", workspaceId: normalizedId },
    );
  }

  const workspace = getTaskWorkspaceById(database, normalizedId);

  if (workspace === null) {
    throw new WorkspaceRetryError(
      `No existe el workspace: ${normalizedId}`,
      { phase: "LOAD_WORKSPACE", workspaceId: normalizedId },
    );
  }

  if (workspace.status !== "FAILED") {
    throw new WorkspaceRetryError(
      `El workspace ${normalizedId} no está en estado FAILED: ${workspace.status}`,
      { phase: "VALIDATE_WORKSPACE", workspaceId: normalizedId },
    );
  }

  const task = getTaskById(database, workspace.taskId);

  if (task === null) {
    throw new WorkspaceRetryError(
      `No existe la tarea: ${workspace.taskId}`,
      { phase: "LOAD_WORKSPACE", workspaceId: normalizedId, taskId: workspace.taskId },
    );
  }

  if (task.id !== workspace.taskId) {
    throw new WorkspaceRetryError(
      `El task.id recuperado no coincide con workspace.taskId: ${task.id} vs ${workspace.taskId}`,
      { phase: "VALIDATE_WORKSPACE", workspaceId: normalizedId, taskId: task.id },
    );
  }

  const project = getProjectById(database, task.projectId);

  if (project === null) {
    throw new WorkspaceRetryError(
      `No existe el proyecto: ${task.projectId}`,
      { phase: "LOAD_WORKSPACE", workspaceId: normalizedId, taskId: task.id },
    );
  }

  if (project.id !== task.projectId) {
    throw new WorkspaceRetryError(
      `El project.id no coincide con task.projectId: ${project.id} vs ${task.projectId}`,
      { phase: "VALIDATE_WORKSPACE", workspaceId: normalizedId, taskId: task.id },
    );
  }

  if (project.repositoryPath.trim().length === 0) {
    throw new WorkspaceRetryError(
      "El proyecto tiene repositoryPath vacío.",
      { phase: "VALIDATE_WORKSPACE", workspaceId: normalizedId, taskId: task.id },
    );
  }

  const initialWorkspaceSnapshot = {
    id: workspace.id,
    taskId: workspace.taskId,
    executionNumber: workspace.executionNumber,
    branchName: workspace.branchName,
    workspacePath: workspace.workspacePath,
    baseCommit: workspace.baseCommit,
  };

  const initialTaskSnapshot = {
    id: task.id,
    projectId: task.projectId,
    state: task.state,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
  };

  const initialProjectSnapshot = {
    id: project.id,
    repositoryPath: project.repositoryPath,
  };

  let reconciliationResult;

  try {
    reconciliationResult = reconcileFailedTaskWorkspace(database, normalizedId);
  } catch (error) {
    throw new WorkspaceRetryError("La reconciliación falló.", {
      phase: "RECONCILE_WORKSPACE",
      workspaceId: normalizedId,
      taskId: task.id,
      cause: error,
    });
  }

  const { outcome } = reconciliationResult;

  if (outcome === "COMPLETE" || outcome === "MANUAL_INTERVENTION_REQUIRED") {
    throw new WorkspaceRetryError(
      `La reconciliación requiere intervención manual: ${outcome}`,
      {
        phase: "RECONCILE_WORKSPACE",
        workspaceId: normalizedId,
        taskId: task.id,
        reconciliationOutcome: outcome,
      },
    );
  }

  const reloadedWorkspace = getTaskWorkspaceById(database, normalizedId);

  if (reloadedWorkspace === null) {
    throw new WorkspaceRetryError(
      `El workspace fue eliminado durante la reconciliación: ${normalizedId}`,
      { phase: "VERIFY_RECONCILED_STATE", workspaceId: normalizedId },
    );
  }

  if (reloadedWorkspace.status !== "FAILED") {
    throw new WorkspaceRetryError(
      `El workspace cambió de estado durante la reconciliación: ${reloadedWorkspace.status}`,
      { phase: "VERIFY_RECONCILED_STATE", workspaceId: normalizedId },
    );
  }

  assertIdentical(
    initialWorkspaceSnapshot as unknown as Record<string, unknown>,
    reloadedWorkspace as unknown as Record<string, unknown>,
    ["id", "taskId", "executionNumber", "branchName", "workspacePath", "baseCommit"],
    "TaskWorkspace",
    "VERIFY_RECONCILED_STATE",
    normalizedId,
  );

  const reloadedTask = getTaskById(database, task.id);

  if (reloadedTask === null) {
    throw new WorkspaceRetryError(
      `La tarea fue eliminada durante la reconciliación: ${task.id}`,
      { phase: "VERIFY_RECONCILED_STATE", workspaceId: normalizedId, taskId: task.id },
    );
  }

  assertIdentical(
    initialTaskSnapshot as unknown as Record<string, unknown>,
    reloadedTask as unknown as Record<string, unknown>,
    ["id", "projectId", "state", "attempt", "maxAttempts"],
    "Task",
    "VERIFY_RECONCILED_STATE",
    normalizedId,
  );

  const reloadedProject = getProjectById(database, task.projectId);

  if (reloadedProject === null) {
    throw new WorkspaceRetryError(
      `El proyecto fue eliminado durante la reconciliación: ${task.projectId}`,
      { phase: "VERIFY_RECONCILED_STATE", workspaceId: normalizedId, taskId: task.id },
    );
  }

  assertIdentical(
    initialProjectSnapshot as unknown as Record<string, unknown>,
    reloadedProject as unknown as Record<string, unknown>,
    ["id", "repositoryPath"],
    "Project",
    "VERIFY_RECONCILED_STATE",
    normalizedId,
  );

  let preparingWorkspace: TaskWorkspace;

  try {
    preparingWorkspace = updateTaskWorkspaceStatus(database, normalizedId, "PREPARING");
  } catch (error) {
    throw new WorkspaceRetryError("No se pudo marcar el workspace como PREPARING.", {
      phase: "MARK_PREPARING",
      workspaceId: normalizedId,
      taskId: task.id,
      cause: error,
    });
  }

  const postPreparingWorkspace = getTaskWorkspaceById(database, normalizedId);

  if (postPreparingWorkspace === null) {
    throw new WorkspaceRetryError(
      `El workspace desapareció al marcar PREPARING: ${normalizedId}`,
      { phase: "MARK_PREPARING", workspaceId: normalizedId },
    );
  }

  if (postPreparingWorkspace.status !== "PREPARING") {
    throw new WorkspaceRetryError(
      `El workspace no quedó en PREPARING: ${postPreparingWorkspace.status}`,
      { phase: "MARK_PREPARING", workspaceId: normalizedId },
    );
  }

  assertIdentical(
    initialWorkspaceSnapshot as unknown as Record<string, unknown>,
    postPreparingWorkspace as unknown as Record<string, unknown>,
    ["id", "taskId", "executionNumber", "branchName", "workspacePath", "baseCommit"],
    "TaskWorkspace",
    "VERIFY_IDENTITY",
    normalizedId,
  );

  const identity = {
    repositoryRoot: project.repositoryPath,
    baseCommit: workspace.baseCommit,
    branchName: workspace.branchName,
    workspacePath: workspace.workspacePath,
  };

  try {
    createGitWorktree(identity);
  } catch (gitError) {
    try {
      updateTaskWorkspaceStatus(database, normalizedId, "FAILED");
    } catch (markFailedError) {
      throw new WorkspaceRetryError("No se pudo crear el worktree ni restaurar el estado FAILED.", {
        phase: "CREATE_WORKTREE",
        workspaceId: normalizedId,
        taskId: task.id,
        cause: gitError,
        secondaryCause: markFailedError,
      });
    }

    throw new WorkspaceRetryError("No se pudo crear el worktree.", {
      phase: "CREATE_WORKTREE",
      workspaceId: normalizedId,
      taskId: task.id,
      cause: gitError,
    });
  }

  let readyWorkspace: TaskWorkspace;

  try {
    readyWorkspace = updateTaskWorkspaceStatus(database, normalizedId, "READY");
  } catch (error) {
    throw new WorkspaceRetryError("No se pudo marcar el workspace como READY.", {
      phase: "MARK_READY",
      workspaceId: normalizedId,
      taskId: task.id,
      cause: error,
    });
  }

  const finalWorkspace = getTaskWorkspaceById(database, normalizedId);

  if (finalWorkspace === null) {
    throw new WorkspaceRetryError(
      `El workspace desapareció al marcar READY: ${normalizedId}`,
      { phase: "LOAD_RESULT", workspaceId: normalizedId },
    );
  }

  if (finalWorkspace.status !== "READY") {
    throw new WorkspaceRetryError(
      `El workspace no quedó en READY: ${finalWorkspace.status}`,
      { phase: "LOAD_RESULT", workspaceId: normalizedId },
    );
  }

  const finalTask = getTaskById(database, task.id);

  if (finalTask === null) {
    throw new WorkspaceRetryError(
      `La tarea desapareció durante el retry: ${task.id}`,
      { phase: "LOAD_RESULT", workspaceId: normalizedId, taskId: task.id },
    );
  }

  const finalProject = getProjectById(database, task.projectId);

  if (finalProject === null) {
    throw new WorkspaceRetryError(
      `El proyecto desapareció durante el retry: ${task.projectId}`,
      { phase: "LOAD_RESULT", workspaceId: normalizedId, taskId: task.id },
    );
  }

  assertIdentical(
    initialWorkspaceSnapshot as unknown as Record<string, unknown>,
    finalWorkspace as unknown as Record<string, unknown>,
    ["id", "taskId", "executionNumber", "branchName", "workspacePath", "baseCommit"],
    "TaskWorkspace",
    "VERIFY_IDENTITY",
    normalizedId,
  );

  assertIdentical(
    initialTaskSnapshot as unknown as Record<string, unknown>,
    finalTask as unknown as Record<string, unknown>,
    ["id", "projectId", "state", "attempt", "maxAttempts"],
    "Task",
    "VERIFY_IDENTITY",
    normalizedId,
  );

  assertIdentical(
    initialProjectSnapshot as unknown as Record<string, unknown>,
    finalProject as unknown as Record<string, unknown>,
    ["id", "repositoryPath"],
    "Project",
    "VERIFY_IDENTITY",
    normalizedId,
  );

  return finalWorkspace;
}
