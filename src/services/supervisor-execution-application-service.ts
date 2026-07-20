/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import { getProjectById } from "../repositories/project-repository.js";
import { getTaskById } from "../repositories/task-repository.js";
import { listPendingHumanRequests } from "../repositories/human-request-repository.js";
import {
  runSupervisorWithOpenCode,
  type SupervisorRuntimeOptions,
} from "./supervisor-opencode-executor.js";
import type { SupervisorPromptInput } from "./supervisor-prompt-builder.js";
import type { SupervisorOpenCodeInterpretation } from "./supervisor-opencode-integration.js";
import {
  applySupervisorResult,
  SupervisorResultApplicationError,
  type AppliedSupervisorOutcome,
} from "./supervisor-result-application-service.js";
import type { SupervisorResult } from "../types.js";

export interface SupervisorExecutionApplicationDeps {
  readonly runSupervisor?: typeof runSupervisorWithOpenCode;
  readonly applyResult?: typeof applySupervisorResult;
}

export interface ExecuteSupervisorForTaskResult {
  readonly taskId: string;
  readonly projectId: string;
  readonly sessionID: string | null;
  readonly messageID: string;
  readonly supervisorResult: SupervisorResult;
  readonly application: AppliedSupervisorOutcome;
}

function normalizeTaskId(taskId: string): string {
  return taskId.trim();
}

function buildPromptInput(database: DatabaseSync, taskId: string): {
  readonly taskId: string;
  readonly projectId: string;
  readonly promptInput: SupervisorPromptInput;
} {
  const id = normalizeTaskId(taskId);

  if (id.length === 0) {
    throw new Error("El id de la tarea no puede estar vacío.");
  }

  const task = getTaskById(database, id);
  if (task === null) {
    throw new Error(`No existe la tarea: ${id}`);
  }

  if (task.state !== "GENERATING_CONTRACT") {
    throw new SupervisorResultApplicationError(
      id,
      `La tarea ${id} no puede aplicar un resultado del supervisor desde el estado ${task.state}.`,
    );
  }

  const project = getProjectById(database, task.projectId);
  if (project === null) {
    throw new Error(`La tarea ${id} referencia un proyecto inexistente: ${task.projectId}`);
  }

  const pendingHumanRequests = listPendingHumanRequests(database)
    .filter((request) => request.taskId === task.id)
    .map((request) => ({
      id: request.id,
      type: request.type,
      question: request.question,
      optionsJson: request.optionsJson,
    }));

  return {
    taskId: task.id,
    projectId: project.id,
    promptInput: {
      project: {
        name: project.name,
        repositoryPath: project.repositoryPath,
      },
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        state: task.state,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        contractJson: task.contractJson,
        currentRevisionJson: task.currentRevisionJson,
      },
      pendingHumanRequests,
    },
  };
}

export async function executeSupervisorForTask(
  database: DatabaseSync,
  taskId: string,
  runtime: SupervisorRuntimeOptions,
  deps?: SupervisorExecutionApplicationDeps,
): Promise<ExecuteSupervisorForTaskResult> {
  const { taskId: normalizedTaskId, projectId, promptInput } = buildPromptInput(database, taskId);
  const runSupervisor = deps?.runSupervisor ?? runSupervisorWithOpenCode;
  const applyResult = deps?.applyResult ?? applySupervisorResult;
  const interpretation: SupervisorOpenCodeInterpretation = await runSupervisor(promptInput, runtime);
  const application = applyResult(database, normalizedTaskId, interpretation.supervisorResult);

  return {
    taskId: normalizedTaskId,
    projectId,
    sessionID: interpretation.sessionID,
    messageID: interpretation.messageID,
    supervisorResult: interpretation.supervisorResult,
    application,
  };
}
