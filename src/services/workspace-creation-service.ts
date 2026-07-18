/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { TaskWorkspace } from "../types.js";
import { getTaskById, updateTaskState } from "../repositories/task-repository.js";
import { getProjectById } from "../repositories/project-repository.js";
import {
  createTaskWorkspace,
  getTaskWorkspaceByTaskAndExecutionNumber,
  getTaskWorkspaceById,
  updateTaskWorkspaceStatus,
} from "../repositories/task-workspace-repository.js";
import { buildWorkspaceId } from "./workspace-id.js";
import { getWorkspacePath } from "./devflow-paths.js";
import { buildBranchName } from "./branch-name.js";
import { inspectGitRepository } from "./git-inspection.js";
import { createGitWorktree } from "./git-worktree-service.js";

export type WorkspaceCreationPhase =
  | "LOAD_TASK"
  | "VALIDATE_TASK"
  | "LOAD_PROJECT"
  | "CALCULATE_EXECUTION_NUMBER"
  | "INSPECT_GIT"
  | "BUILD_IDENTITY"
  | "CHECK_EXISTING_WORKSPACE"
  | "PERSIST_PREPARING"
  | "CREATE_WORKTREE"
  | "MARK_READY"
  | "MARK_EXECUTING"
  | "LOAD_RESULT";

export interface CreateTaskWorkspaceResult {
  workspace: TaskWorkspace;
  repositoryRoot: string;
}

export class WorkspaceCreationError extends Error {
  readonly taskId: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly phase: WorkspaceCreationPhase;

  constructor(
    message: string,
    options: {
      taskId: string;
      phase: WorkspaceCreationPhase;
      projectId?: string;
      workspaceId?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "WorkspaceCreationError";
    this.taskId = options.taskId;
    this.phase = options.phase;
    this.projectId = options.projectId;
    this.workspaceId = options.workspaceId;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function beginImmediate(database: DatabaseSync): void {
  database.prepare("BEGIN IMMEDIATE").run();
}

function commit(database: DatabaseSync): void {
  database.prepare("COMMIT").run();
}

function rollback(database: DatabaseSync): void {
  try {
    database.prepare("ROLLBACK").run();
  } catch {
    // Preserve the original failure.
  }
}

function markWorkspaceFailed(
  database: DatabaseSync,
  workspaceId: string,
): void {
  try {
    beginImmediate(database);

    const workspace = getTaskWorkspaceById(database, workspaceId);

    if (workspace === null) {
      rollback(database);
      return;
    }

    if (workspace.status === "FAILED") {
      commit(database);
      return;
    }

    if (workspace.status === "REMOVED") {
      rollback(database);
      return;
    }

    try {
      updateTaskWorkspaceStatus(database, workspaceId, "FAILED");
    } catch {
      rollback(database);
      return;
    }

    commit(database);
  } catch {
    rollback(database);
  }
}

export function createTaskWorkspaceForExecution(
  database: DatabaseSync,
  taskId: string,
): CreateTaskWorkspaceResult {
  const normalizedTaskId = taskId.trim();

  if (normalizedTaskId.length === 0) {
    throw new WorkspaceCreationError(
      "El id de la tarea no puede estar vacío.",
      { taskId: normalizedTaskId, phase: "LOAD_TASK" },
    );
  }

  const task = getTaskById(database, normalizedTaskId);

  if (task === null) {
    throw new WorkspaceCreationError(
      `No existe la tarea: ${normalizedTaskId}`,
      { taskId: normalizedTaskId, phase: "LOAD_TASK" },
    );
  }

  if (task.state !== "PREPARING_WORKSPACE") {
    throw new WorkspaceCreationError(
      `La tarea ${normalizedTaskId} no puede preparar un workspace desde el estado ${task.state}.`,
      { taskId: normalizedTaskId, phase: "VALIDATE_TASK" },
    );
  }

  if (!Number.isSafeInteger(task.attempt) || task.attempt < 0) {
    throw new WorkspaceCreationError(
      `El attempt de la tarea ${normalizedTaskId} debe ser un entero seguro mayor o igual que 0.`,
      { taskId: normalizedTaskId, phase: "CALCULATE_EXECUTION_NUMBER" },
    );
  }

  if (!Number.isSafeInteger(task.maxAttempts) || task.maxAttempts < 1) {
    throw new WorkspaceCreationError(
      `El máximo de intentos de la tarea ${normalizedTaskId} debe ser un entero seguro mayor o igual que 1.`,
      { taskId: normalizedTaskId, phase: "CALCULATE_EXECUTION_NUMBER" },
    );
  }

  if (task.attempt >= task.maxAttempts) {
    throw new WorkspaceCreationError(
      `La tarea ${normalizedTaskId} no puede preparar un nuevo workspace porque alcanzó el máximo de intentos: ${task.attempt}/${task.maxAttempts}.`,
      { taskId: normalizedTaskId, phase: "CALCULATE_EXECUTION_NUMBER" },
    );
  }

  const executionNumber = task.attempt + 1;

  if (!Number.isSafeInteger(executionNumber)) {
    throw new WorkspaceCreationError(
      `El número de ejecución calculado para la tarea ${normalizedTaskId} excede el máximo entero seguro.`,
      { taskId: normalizedTaskId, phase: "CALCULATE_EXECUTION_NUMBER" },
    );
  }

  const project = getProjectById(database, task.projectId);

  if (project === null) {
    throw new WorkspaceCreationError(
      `No existe el proyecto: ${task.projectId}`,
      { taskId: normalizedTaskId, projectId: task.projectId, phase: "LOAD_PROJECT" },
    );
  }

  if (project.id !== task.projectId) {
    throw new WorkspaceCreationError(
      `El proyecto recuperado no coincide con la tarea ${normalizedTaskId}: se esperaba ${task.projectId} y se obtuvo ${project.id}.`,
      { taskId: normalizedTaskId, projectId: task.projectId, phase: "LOAD_PROJECT" },
    );
  }

  let inspection: { repositoryRoot: string; baseCommit: string };

  try {
    inspection = inspectGitRepository(project.repositoryPath);
  } catch (error) {
    throw new WorkspaceCreationError(
      `No se pudo inspeccionar el repositorio Git del proyecto ${task.projectId}.`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        phase: "INSPECT_GIT",
        cause: error,
      },
    );
  }

  let workspaceId: string;

  try {
    workspaceId = buildWorkspaceId({
      projectId: task.projectId,
      taskId: task.id,
      executionNumber,
    });
  } catch (error) {
    throw new WorkspaceCreationError(
      `No se pudo construir la identidad del workspace para la tarea ${normalizedTaskId}.`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        phase: "BUILD_IDENTITY",
        cause: error,
      },
    );
  }

  let workspacePath: string;
  let branchName: string;

  try {
    workspacePath = getWorkspacePath({
      projectId: task.projectId,
      taskId: task.id,
      attempt: executionNumber,
    });
  } catch (error) {
    throw new WorkspaceCreationError(
      `No se pudo construir la identidad del workspace para la tarea ${normalizedTaskId}.`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: "BUILD_IDENTITY",
        cause: error,
      },
    );
  }

  try {
    branchName = buildBranchName({
      projectId: task.projectId,
      taskId: task.id,
      executionNumber,
    });
  } catch (error) {
    throw new WorkspaceCreationError(
      `No se pudo construir la identidad del workspace para la tarea ${normalizedTaskId}.`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: "BUILD_IDENTITY",
        cause: error,
      },
    );
  }

  const repositoryRoot = inspection.repositoryRoot;
  const baseCommit = inspection.baseCommit;

  const existingWorkspace = getTaskWorkspaceByTaskAndExecutionNumber(
    database,
    task.id,
    executionNumber,
  );

  if (existingWorkspace !== null) {
    throw new WorkspaceCreationError(
      `Ya existe un workspace ${existingWorkspace.status} para la tarea ${normalizedTaskId} y la ejecución ${executionNumber}: ${existingWorkspace.id}.`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId: existingWorkspace.id,
        phase: "CHECK_EXISTING_WORKSPACE",
      },
    );
  }

  beginImmediate(database);

  try {
    const recheck = getTaskWorkspaceByTaskAndExecutionNumber(
      database,
      task.id,
      executionNumber,
    );

    if (recheck !== null) {
      throw new WorkspaceCreationError(
        `Ya existe un workspace ${recheck.status} para la tarea ${normalizedTaskId} y la ejecución ${executionNumber}: ${recheck.id}.`,
        {
          taskId: normalizedTaskId,
          projectId: task.projectId,
          workspaceId: recheck.id,
          phase: "CHECK_EXISTING_WORKSPACE",
        },
      );
    }

    const created = createTaskWorkspace(database, {
      id: workspaceId,
      taskId: task.id,
      executionNumber,
      workspacePath,
      branchName,
      baseCommit,
    });

    if (created.status !== "PREPARING") {
      throw new WorkspaceCreationError(
        `No se pudo persistir el workspace PREPARING para la tarea ${normalizedTaskId}.`,
        {
          taskId: normalizedTaskId,
          projectId: task.projectId,
          workspaceId,
          phase: "PERSIST_PREPARING",
        },
      );
    }

    commit(database);
  } catch (error) {
    rollback(database);

    if (error instanceof WorkspaceCreationError) {
      throw error;
    }

    throw new WorkspaceCreationError(
      `No se pudo persistir el workspace PREPARING para la tarea ${normalizedTaskId}.`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: "PERSIST_PREPARING",
        cause: error,
      },
    );
  }

  try {
    createGitWorktree({
      repositoryRoot,
      baseCommit,
      branchName,
      workspacePath,
    });
  } catch (error) {
    markWorkspaceFailed(database, workspaceId);

    throw new WorkspaceCreationError(
      `No se pudo crear el worktree del workspace ${workspaceId}.`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: "CREATE_WORKTREE",
        cause: error,
      },
    );
  }

  beginImmediate(database);

  let failurePhase: WorkspaceCreationPhase = "MARK_READY";

  try {
    let updatedWorkspace: TaskWorkspace;

    try {
      updatedWorkspace = updateTaskWorkspaceStatus(database, workspaceId, "READY");
    } catch (error) {
      throw new WorkspaceCreationError(
        `No se pudo marcar el workspace ${workspaceId} como READY.`,
        {
          taskId: normalizedTaskId,
          projectId: task.projectId,
          workspaceId,
          phase: failurePhase,
          cause: error,
        },
      );
    }

    if (updatedWorkspace.status !== "READY") {
      throw new WorkspaceCreationError(
        `No se pudo marcar el workspace ${workspaceId} como READY.`,
        {
          taskId: normalizedTaskId,
          projectId: task.projectId,
          workspaceId,
          phase: failurePhase,
        },
      );
    }

    failurePhase = "MARK_EXECUTING";

    const now = new Date().toISOString();
    const updatedTask = updateTaskState(database, task.id, "EXECUTING", now);

    if (updatedTask === null || updatedTask.state !== "EXECUTING") {
      throw new WorkspaceCreationError(
        `No se pudo pasar la tarea ${normalizedTaskId} al estado EXECUTING.`,
        {
          taskId: normalizedTaskId,
          projectId: task.projectId,
          workspaceId,
          phase: failurePhase,
        },
      );
    }

    commit(database);
  } catch (error) {
    rollback(database);

    markWorkspaceFailed(database, workspaceId);

    if (error instanceof WorkspaceCreationError) {
      throw error;
    }

    throw new WorkspaceCreationError(
      `No se pudo marcar el workspace ${workspaceId} como READY.`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: failurePhase,
        cause: error,
      },
    );
  }

  const finalWorkspace = getTaskWorkspaceById(database, workspaceId);

  if (finalWorkspace === null) {
    throw new WorkspaceCreationError(
      `No se pudo recuperar el workspace creado: ${workspaceId}`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: "LOAD_RESULT",
      },
    );
  }

  if (finalWorkspace.status !== "READY") {
    throw new WorkspaceCreationError(
      `El workspace creado no coincide con los datos esperados: ${workspaceId}`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: "LOAD_RESULT",
      },
    );
  }

  if (finalWorkspace.taskId !== task.id) {
    throw new WorkspaceCreationError(
      `El workspace creado no coincide con los datos esperados: ${workspaceId}`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: "LOAD_RESULT",
      },
    );
  }

  if (finalWorkspace.executionNumber !== executionNumber) {
    throw new WorkspaceCreationError(
      `El workspace creado no coincide con los datos esperados: ${workspaceId}`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: "LOAD_RESULT",
      },
    );
  }

  if (finalWorkspace.workspacePath !== workspacePath) {
    throw new WorkspaceCreationError(
      `El workspace creado no coincide con los datos esperados: ${workspaceId}`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: "LOAD_RESULT",
      },
    );
  }

  if (finalWorkspace.branchName !== branchName) {
    throw new WorkspaceCreationError(
      `El workspace creado no coincide con los datos esperados: ${workspaceId}`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: "LOAD_RESULT",
      },
    );
  }

  if (finalWorkspace.baseCommit !== baseCommit) {
    throw new WorkspaceCreationError(
      `El workspace creado no coincide con los datos esperados: ${workspaceId}`,
      {
        taskId: normalizedTaskId,
        projectId: task.projectId,
        workspaceId,
        phase: "LOAD_RESULT",
      },
    );
  }

  return {
    workspace: finalWorkspace,
    repositoryRoot,
  };
}
