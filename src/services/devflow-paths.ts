/// <reference types="node" />

import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export interface DevFlowPathOptions {
  dataRoot?: string;
}

export interface WorkspacePathInput {
  projectId: string;
  taskId: string;
  attempt: number;
}

export interface RunPathInput {
  projectId: string;
  taskId: string;
  runId: string;
}

export class DevFlowPathError extends Error {
  readonly field: string;
  readonly value: unknown;

  constructor(field: string, value: unknown, message: string) {
    super(message);
    this.name = "DevFlowPathError";
    this.field = field;
    this.value = value;
  }
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_IDENTIFIER_LENGTH = 80;

function buildUnsafeIdentifierError(field: string, value: string): DevFlowPathError {
  return new DevFlowPathError(
    field,
    value,
    `El identificador ${field} no es seguro para usarlo en una ruta: ${value}`,
  );
}

function ensurePathWithinRoot(rootPath: string, candidatePath: string, field: string, value: unknown): string {
  const normalizedRoot = resolve(rootPath);
  const normalizedCandidate = resolve(candidatePath);

  if (
    normalizedCandidate !== normalizedRoot
    && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new DevFlowPathError(
      field,
      value,
      `El identificador ${field} no es seguro para usarlo en una ruta: ${String(value)}`,
    );
  }

  return normalizedCandidate;
}

export function getDevFlowDataRoot(options?: DevFlowPathOptions): string {
  if (options?.dataRoot === undefined) {
    return join(homedir(), ".devflow");
  }

  const trimmed = options.dataRoot.trim();
  if (trimmed.length === 0) {
    throw new Error("El directorio de datos de DevFlow no puede estar vacío.");
  }

  if (!isAbsolute(trimmed)) {
    throw new Error(`El directorio de datos de DevFlow debe ser una ruta absoluta: ${trimmed}`);
  }

  return resolve(trimmed);
}

export function validatePathIdentifier(field: string, value: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new DevFlowPathError(field, value, `El identificador ${field} no puede estar vacío.`);
  }

  if (normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new DevFlowPathError(
      field,
      value,
      `El identificador ${field} no puede superar 80 caracteres.`,
    );
  }

  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith(".")
    || normalized.includes("/")
    || normalized.includes("\\")
    || normalized.includes("\0")
    || isAbsolute(normalized)
    || !SAFE_IDENTIFIER_PATTERN.test(normalized)
  ) {
    throw buildUnsafeIdentifierError(field, value);
  }

  return normalized;
}

export function validateAttempt(attempt: number): number {
  if (!Number.isFinite(attempt) || !Number.isInteger(attempt) || attempt < 1) {
    throw new Error("El intento debe ser un entero mayor o igual que 1.");
  }

  return attempt;
}

export function getWorktreesRoot(options?: DevFlowPathOptions): string {
  return resolve(getDevFlowDataRoot(options), "worktrees");
}

export function getRunsRoot(options?: DevFlowPathOptions): string {
  return resolve(getDevFlowDataRoot(options), "runs");
}

export function getArtifactsRoot(options?: DevFlowPathOptions): string {
  return resolve(getDevFlowDataRoot(options), "artifacts");
}

export function getLogsRoot(options?: DevFlowPathOptions): string {
  return resolve(getDevFlowDataRoot(options), "logs");
}

export function getWorkspacePath(
  input: WorkspacePathInput,
  options?: DevFlowPathOptions,
): string {
  const projectId = validatePathIdentifier("projectId", input.projectId);
  const taskId = validatePathIdentifier("taskId", input.taskId);
  const attempt = validateAttempt(input.attempt);
  const root = getWorktreesRoot(options);

  return ensurePathWithinRoot(root, join(root, projectId, taskId, String(attempt)), "taskId", input.taskId);
}

export function getRunPath(
  input: RunPathInput,
  options?: DevFlowPathOptions,
): string {
  const projectId = validatePathIdentifier("projectId", input.projectId);
  const taskId = validatePathIdentifier("taskId", input.taskId);
  const runId = validatePathIdentifier("runId", input.runId);
  const root = getRunsRoot(options);

  return ensurePathWithinRoot(root, join(root, projectId, taskId, runId), "runId", input.runId);
}

export function getArtifactPath(
  input: RunPathInput,
  options?: DevFlowPathOptions,
): string {
  const projectId = validatePathIdentifier("projectId", input.projectId);
  const taskId = validatePathIdentifier("taskId", input.taskId);
  const runId = validatePathIdentifier("runId", input.runId);
  const root = getArtifactsRoot(options);

  return ensurePathWithinRoot(root, join(root, projectId, taskId, runId), "runId", input.runId);
}

export function getLogPath(
  input: RunPathInput,
  options?: DevFlowPathOptions,
): string {
  const projectId = validatePathIdentifier("projectId", input.projectId);
  const taskId = validatePathIdentifier("taskId", input.taskId);
  const runId = validatePathIdentifier("runId", input.runId);
  const root = getLogsRoot(options);

  return ensurePathWithinRoot(root, join(root, projectId, taskId, runId), "runId", input.runId);
}
