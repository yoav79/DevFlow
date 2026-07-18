/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { TaskWorkspace } from "../types.js";
import { getTaskWorkspaceById } from "../repositories/task-workspace-repository.js";
import { getTaskById } from "../repositories/task-repository.js";
import { getProjectById } from "../repositories/project-repository.js";
import {
  executeGitWorktreeReconciliation,
  GitWorktreeReconciliationError,
  type GitWorktreeReconciliationExecutionResult,
  type GitWorktreeReconciliationErrorCode,
} from "./git-worktree-reconciliation-executor.js";

export type WorkspaceReconciliationOutcome =
  | "ALREADY_CLEAN"
  | "CLEANED"
  | "COMPLETE"
  | "MANUAL_INTERVENTION_REQUIRED";

export type WorkspaceReconciliationPhase =
  | "LOAD_WORKSPACE"
  | "VALIDATE_WORKSPACE"
  | "LOAD_TASK"
  | "LOAD_PROJECT"
  | "BUILD_EXECUTOR_INPUT"
  | "EXECUTE_RECONCILIATION"
  | "VERIFY_POST_STATE";

export interface ReconcileFailedWorkspaceResult {
  workspace: TaskWorkspace;
  outcome: WorkspaceReconciliationOutcome;
  execution: GitWorktreeReconciliationExecutionResult | null;
  reconciliationError: GitWorktreeReconciliationError | null;
}

export class WorkspaceReconciliationError extends Error {
  readonly phase: WorkspaceReconciliationPhase;
  readonly workspaceId?: string;
  readonly taskId?: string;
  readonly projectId?: string;

  constructor(
    message: string,
    options: {
      phase: WorkspaceReconciliationPhase;
      workspaceId?: string;
      taskId?: string;
      projectId?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "WorkspaceReconciliationError";
    this.phase = options.phase;
    this.workspaceId = options.workspaceId;
    this.taskId = options.taskId;
    this.projectId = options.projectId;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function validatePersistedFields(
  workspace: TaskWorkspace,
  phase: WorkspaceReconciliationPhase,
): void {
  if (workspace.taskId.trim().length === 0) {
    throw new WorkspaceReconciliationError(
      "El workspace persistido tiene taskId vacío.",
      { phase, workspaceId: workspace.id },
    );
  }

  if (workspace.baseCommit.trim().length === 0) {
    throw new WorkspaceReconciliationError(
      "El workspace persistido tiene baseCommit vacío.",
      { phase, workspaceId: workspace.id },
    );
  }

  if (workspace.branchName.trim().length === 0) {
    throw new WorkspaceReconciliationError(
      "El workspace persistido tiene branchName vacío.",
      { phase, workspaceId: workspace.id },
    );
  }

  if (workspace.workspacePath.trim().length === 0) {
    throw new WorkspaceReconciliationError(
      "El workspace persistido tiene workspacePath vacío.",
      { phase, workspaceId: workspace.id },
    );
  }

  if (
    !Number.isFinite(workspace.executionNumber)
    || !Number.isInteger(workspace.executionNumber)
    || workspace.executionNumber < 1
  ) {
    throw new WorkspaceReconciliationError(
      "El workspace persistido tiene executionNumber inválido.",
      { phase, workspaceId: workspace.id },
    );
  }
}

function assertIdentical(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  fields: string[],
  label: string,
): void {
  for (const field of fields) {
    if (a[field] !== b[field]) {
      throw new WorkspaceReconciliationError(
        `Cambio concurrente detectado en ${label}: campo ${field} cambió durante la reconciliación.`,
        { phase: "VERIFY_POST_STATE" },
      );
    }
  }
}

export function reconcileFailedTaskWorkspace(
  database: DatabaseSync,
  workspaceId: string,
): ReconcileFailedWorkspaceResult {
  const normalizedId = workspaceId.trim();

  if (normalizedId.length === 0) {
    throw new WorkspaceReconciliationError(
      "El id del workspace no puede estar vacío.",
      { phase: "LOAD_WORKSPACE", workspaceId: normalizedId },
    );
  }

  const workspace = getTaskWorkspaceById(database, normalizedId);

  if (workspace === null) {
    throw new WorkspaceReconciliationError(
      `No existe el workspace: ${normalizedId}`,
      { phase: "LOAD_WORKSPACE", workspaceId: normalizedId },
    );
  }

  if (workspace.status !== "FAILED") {
    throw new WorkspaceReconciliationError(
      `El workspace ${normalizedId} no está en estado FAILED: ${workspace.status}`,
      { phase: "VALIDATE_WORKSPACE", workspaceId: normalizedId },
    );
  }

  validatePersistedFields(workspace, "VALIDATE_WORKSPACE");

  const task = getTaskById(database, workspace.taskId);

  if (task === null) {
    throw new WorkspaceReconciliationError(
      `No existe la tarea: ${workspace.taskId}`,
      {
        phase: "LOAD_TASK",
        workspaceId: normalizedId,
        taskId: workspace.taskId,
      },
    );
  }

  if (task.id !== workspace.taskId) {
    throw new WorkspaceReconciliationError(
      `El task.id recuperado no coincide con workspace.taskId: ${task.id} vs ${workspace.taskId}`,
      { phase: "VALIDATE_WORKSPACE", workspaceId: normalizedId, taskId: task.id },
    );
  }

  const project = getProjectById(database, task.projectId);

  if (project === null) {
    throw new WorkspaceReconciliationError(
      `No existe el proyecto: ${task.projectId}`,
      {
        phase: "LOAD_PROJECT",
        workspaceId: normalizedId,
        taskId: task.id,
        projectId: task.projectId,
      },
    );
  }

  if (project.id !== task.projectId) {
    throw new WorkspaceReconciliationError(
      `El project.id recuperado no coincide con task.projectId: ${project.id} vs ${task.projectId}`,
      {
        phase: "VALIDATE_WORKSPACE",
        workspaceId: normalizedId,
        taskId: task.id,
        projectId: project.id,
      },
    );
  }

  if (project.repositoryPath.trim().length === 0) {
    throw new WorkspaceReconciliationError(
      "El proyecto tiene repositoryPath vacío.",
      {
        phase: "BUILD_EXECUTOR_INPUT",
        workspaceId: normalizedId,
        taskId: task.id,
        projectId: project.id,
      },
    );
  }

  const input = {
    repositoryRoot: project.repositoryPath,
    baseCommit: workspace.baseCommit,
    branchName: workspace.branchName,
    workspacePath: workspace.workspacePath,
  };

  let execution: GitWorktreeReconciliationExecutionResult | null = null;
  let reconciliationError: GitWorktreeReconciliationError | null = null;
  let outcome: WorkspaceReconciliationOutcome;

  try {
    execution = executeGitWorktreeReconciliation(input);
    outcome = execution.executedAction === "REMOVE_BRANCH" ? "CLEANED" : "ALREADY_CLEAN";
  } catch (error) {
    if (error instanceof GitWorktreeReconciliationError) {
      if (error.code === "COMPLETE_WORKTREE") {
        reconciliationError = error;
        outcome = "COMPLETE";
      } else if (error.code === "ACTION_BLOCKED") {
        reconciliationError = error;
        outcome = "MANUAL_INTERVENTION_REQUIRED";
      } else {
        throw new WorkspaceReconciliationError(
          `La reconciliación Git falló: ${error.code}`,
          {
            phase: "EXECUTE_RECONCILIATION",
            workspaceId: normalizedId,
            taskId: task.id,
            projectId: project.id,
            cause: error,
          },
        );
      }
    } else {
      throw new WorkspaceReconciliationError(
        "La reconciliación Git falló con un error inesperado.",
        {
          phase: "EXECUTE_RECONCILIATION",
          workspaceId: normalizedId,
          taskId: task.id,
          projectId: project.id,
          cause: error,
        },
      );
    }
  }

  const reloadedWorkspace = getTaskWorkspaceById(database, normalizedId);

  if (reloadedWorkspace === null) {
    throw new WorkspaceReconciliationError(
      `El workspace fue eliminado durante la reconciliación: ${normalizedId}`,
      { phase: "VERIFY_POST_STATE", workspaceId: normalizedId },
    );
  }

  if (reloadedWorkspace.status !== "FAILED") {
    throw new WorkspaceReconciliationError(
      `El workspace cambió de estado durante la reconciliación: ${reloadedWorkspace.status}`,
      { phase: "VERIFY_POST_STATE", workspaceId: normalizedId },
    );
  }

  const reloadedTask = getTaskById(database, workspace.taskId);

  if (reloadedTask === null) {
    throw new WorkspaceReconciliationError(
      `La tarea fue eliminada durante la reconciliación: ${workspace.taskId}`,
      { phase: "VERIFY_POST_STATE", workspaceId: normalizedId, taskId: workspace.taskId },
    );
  }

  assertIdentical(
    task as unknown as Record<string, unknown>,
    reloadedTask as unknown as Record<string, unknown>,
    ["id", "projectId", "state", "attempt", "maxAttempts"],
    "Task",
  );

  const reloadedProject = getProjectById(database, task.projectId);

  if (reloadedProject === null) {
    throw new WorkspaceReconciliationError(
      `El proyecto fue eliminado durante la reconciliación: ${task.projectId}`,
      { phase: "VERIFY_POST_STATE", workspaceId: normalizedId, taskId: task.id, projectId: task.projectId },
    );
  }

  assertIdentical(
    project as unknown as Record<string, unknown>,
    reloadedProject as unknown as Record<string, unknown>,
    ["id", "repositoryPath"],
    "Project",
  );

  assertIdentical(
    workspace as unknown as Record<string, unknown>,
    reloadedWorkspace as unknown as Record<string, unknown>,
    ["id", "taskId", "baseCommit", "branchName", "workspacePath", "executionNumber", "status"],
    "TaskWorkspace",
  );

  return {
    workspace: reloadedWorkspace,
    outcome,
    execution,
    reconciliationError,
  };
}
