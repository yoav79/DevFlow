/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";

const MAX_STDERR_PREVIEW = 200;

export type ChangedFileStatus =
  | "ADDED"
  | "MODIFIED"
  | "DELETED"
  | "RENAMED"
  | "UNTRACKED";

export type GitFileMode = "100644" | "100755" | "120000";

export interface ChangedFileAdded {
  readonly path: string;
  readonly status: "ADDED";
  readonly currentMode: GitFileMode;
}

export interface ChangedFileModified {
  readonly path: string;
  readonly status: "MODIFIED";
  readonly previousMode: GitFileMode;
  readonly currentMode: GitFileMode;
  readonly previousObjectId: string;
}

export interface ChangedFileDeleted {
  readonly path: string;
  readonly status: "DELETED";
  readonly previousMode: GitFileMode;
  readonly previousObjectId: string;
}

export interface ChangedFileRenamed {
  readonly path: string;
  readonly status: "RENAMED";
  readonly previousPath: string;
  readonly previousMode: GitFileMode;
  readonly currentMode: GitFileMode;
  readonly previousObjectId: string;
  readonly similarityScore: number;
}

export interface ChangedFileUntracked {
  readonly path: string;
  readonly status: "UNTRACKED";
  readonly currentMode: GitFileMode;
}

export type ChangedFile =
  | ChangedFileAdded
  | ChangedFileModified
  | ChangedFileDeleted
  | ChangedFileRenamed
  | ChangedFileUntracked;

export interface GitChangeDetectionResult {
  readonly baseCommit: string;
  readonly changedFiles: readonly ChangedFile[];
}

export type GitChangeDetectionErrorCode =
  | "INVALID_WORKSPACE_PATH"
  | "INVALID_BASE_COMMIT"
  | "GIT_NOT_FOUND"
  | "GIT_COMMAND_FAILED"
  | "INVALID_TRACKED_OUTPUT"
  | "INVALID_UNTRACKED_OUTPUT"
  | "UNSUPPORTED_GIT_STATUS"
  | "UNSUPPORTED_GIT_TYPE_CHANGE"
  | "DUPLICATE_CHANGED_PATH";

export class GitChangeDetectionError extends Error {
  readonly code: GitChangeDetectionErrorCode;
  readonly command?: readonly string[];
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderrPreview?: string;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code: GitChangeDetectionErrorCode;
      command?: readonly string[];
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "GitChangeDetectionError";
    this.code = options.code;
    this.command = options.command;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.cause = options.cause;

    if (options.stderr !== undefined && options.stderr.length > 0) {
      this.stderrPreview = options.stderr.slice(0, MAX_STDERR_PREVIEW);
    }
  }
}

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: unknown;
}

type RunGitFn = (workspacePath: string, args: string[]) => GitCommandResult;

function runGitSync(workspacePath: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", ["-C", workspacePath, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error !== undefined) {
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: result.error,
    };
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
    signal: result.signal ?? null,
  };
}

function validateWorkspacePath(workspacePath: string): void {
  if (typeof workspacePath !== "string") {
    throw new GitChangeDetectionError(
      "La ruta del workspace debe ser un string.",
      { code: "INVALID_WORKSPACE_PATH" },
    );
  }

  if (workspacePath.length === 0) {
    throw new GitChangeDetectionError(
      "La ruta del workspace no puede estar vacía.",
      { code: "INVALID_WORKSPACE_PATH" },
    );
  }

  if (workspacePath.trim().length === 0) {
    throw new GitChangeDetectionError(
      "La ruta del workspace no puede ser solo espacios en blanco.",
      { code: "INVALID_WORKSPACE_PATH" },
    );
  }
}

function validateBaseCommit(baseCommit: string): void {
  if (typeof baseCommit !== "string") {
    throw new GitChangeDetectionError(
      "El commit base debe ser un string.",
      { code: "INVALID_BASE_COMMIT" },
    );
  }

  if (baseCommit.length === 0) {
    throw new GitChangeDetectionError(
      "El commit base no puede estar vacío.",
      { code: "INVALID_BASE_COMMIT" },
    );
  }

  if (baseCommit.trim().length === 0) {
    throw new GitChangeDetectionError(
      "El commit base no puede ser solo espacios en blanco.",
      { code: "INVALID_BASE_COMMIT" },
    );
  }
}

function throwGitNotfound(args: readonly string[], error: unknown): never {
  throw new GitChangeDetectionError(
    "No se encontró el binario de Git.",
    { code: "GIT_NOT_FOUND", command: args, cause: error },
  );
}

function throwGitCommandFailed(
  args: readonly string[],
  result: GitCommandResult,
): never {
  throw new GitChangeDetectionError(
    `Git terminó con código de salida distinto de 0: ${args.join(" ")}`,
    {
      code: "GIT_COMMAND_FAILED",
      command: args,
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
    },
  );
}

function validateGitMode(
  mode: string,
  label: string,
): GitFileMode {
  if (mode === "100644" || mode === "100755" || mode === "120000") {
    return mode;
  }

  throw new GitChangeDetectionError(
    `${label}: modo Git no soportado: ${mode}`,
    { code: "UNSUPPORTED_GIT_STATUS" },
  );
}

function validateObjectId(
  id: string,
  label: string,
): void {
  if (!/^[0-9a-f]+$/.test(id)) {
    throw new GitChangeDetectionError(
      `${label}: object ID inválido (no es hexadecimal lowercase): ${id}`,
      { code: "INVALID_TRACKED_OUTPUT" },
    );
  }

  if (id.length !== 40 && id.length !== 64) {
    throw new GitChangeDetectionError(
      `${label}: object ID longitud inválida (${id.length} chars, esperado 40 o 64).`,
      { code: "INVALID_TRACKED_OUTPUT" },
    );
  }

  let allZero = true;
  for (let j = 0; j < id.length; j++) {
    if (id.charCodeAt(j) !== 48) {
      allZero = false;
      break;
    }
  }

  if (allZero) {
    throw new GitChangeDetectionError(
      `${label}: object ID es sentinel de ceros.`,
      { code: "INVALID_TRACKED_OUTPUT" },
    );
  }
}

function validateChangedPath(
  path: string,
  label: string,
  errorCode: GitChangeDetectionErrorCode,
): void {
  if (typeof path !== "string") {
    throw new GitChangeDetectionError(
      `${label}: el path debe ser un string.`,
      { code: errorCode },
    );
  }

  if (path.length === 0) {
    throw new GitChangeDetectionError(
      `${label}: el path no puede estar vacío.`,
      { code: errorCode },
    );
  }

  if (path === ".") {
    throw new GitChangeDetectionError(
      `${label}: el path no puede ser ".".`,
      { code: errorCode },
    );
  }

  if (path.startsWith("/")) {
    throw new GitChangeDetectionError(
      `${label}: el path no puede ser absoluto: ${path}`,
      { code: errorCode },
    );
  }

  if (path.startsWith("./")) {
    throw new GitChangeDetectionError(
      `${label}: el path no puede empezar con "./": ${path}`,
      { code: errorCode },
    );
  }

  if (path.includes("\\")) {
    throw new GitChangeDetectionError(
      `${label}: el path no puede usar backslash: ${path}`,
      { code: errorCode },
    );
  }

  if (path.includes("//")) {
    throw new GitChangeDetectionError(
      `${label}: el path no puede contener "//": ${path}`,
      { code: errorCode },
    );
  }

  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new GitChangeDetectionError(
        `${label}: el path no puede contener "..": ${path}`,
        { code: errorCode },
      );
    }

    if (segment.length === 0) {
      throw new GitChangeDetectionError(
        `${label}: el path no puede contener segmentos vacíos: ${path}`,
        { code: errorCode },
      );
    }
  }
}

function parseRawOutput(tracked: string): ChangedFile[] {
  const result: ChangedFile[] = [];

  if (tracked.length === 0) {
    return result;
  }

  if (!tracked.endsWith("\0")) {
    throw new GitChangeDetectionError(
      "El output tracked no termina en NUL.",
      { code: "INVALID_TRACKED_OUTPUT" },
    );
  }

  const nulChar = "\0";
  const tokens = tracked.split(nulChar);

  const lastToken = tokens[tokens.length - 1]!;
  if (lastToken.length !== 0) {
    throw new GitChangeDetectionError(
      "El output tracked no termina en NUL.",
      { code: "INVALID_TRACKED_OUTPUT" },
    );
  }

  tokens.pop();

  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i]!;

    if (token.length === 0) {
      throw new GitChangeDetectionError(
        "Token vacío intermedio en output tracked.",
        { code: "INVALID_TRACKED_OUTPUT" },
      );
    }

    const parts = token.split(" ");

    if (parts.length === 1 && token.startsWith(":")) {
      i++;
      continue;
    }

    if (parts.length < 5 || !parts[0]!.startsWith(":")) {
      throw new GitChangeDetectionError(
        `Registro raw inválido: ${token}`,
        { code: "INVALID_TRACKED_OUTPUT" },
      );
    }

    const statusToken = parts[4]!;
    const statusChar = statusToken[0]!;

    if (statusChar === "T") {
      throw new GitChangeDetectionError(
        `Cambio de tipo no soportado: ${token}`,
        { code: "UNSUPPORTED_GIT_TYPE_CHANGE" },
      );
    }

    if (statusChar === "C") {
      throw new GitChangeDetectionError(
        `Status de copy no soportado: ${token}`,
        { code: "UNSUPPORTED_GIT_STATUS" },
      );
    }

    if (statusChar === "R") {
      const scoreStr = statusToken.slice(1);
      if (scoreStr.length === 0) {
        throw new GitChangeDetectionError(
          `Status de rename sin score: ${token}`,
          { code: "UNSUPPORTED_GIT_STATUS" },
        );
      }
      for (let j = 0; j < scoreStr.length; j++) {
        const ch = scoreStr.charCodeAt(j);
        if (ch < 48 || ch > 57) {
          throw new GitChangeDetectionError(
            `Score de rename inválido: ${token}`,
            { code: "UNSUPPORTED_GIT_STATUS" },
          );
        }
      }
      const score = Number(scoreStr);
      if (score < 0 || score > 100) {
        throw new GitChangeDetectionError(
          `Score de rename fuera de rango: ${token}`,
          { code: "UNSUPPORTED_GIT_STATUS" },
        );
      }

      const oldModeStr = parts[0]!.slice(1);
      const newModeStr = parts[1]!;
      const oldObjectId = parts[2]!;
      const newObjectId = parts[3]!;

      const previousPath = tokens[i + 1];
      const newPath = tokens[i + 2];

      if (
        oldModeStr === undefined || newModeStr === undefined ||
        oldObjectId === undefined || newObjectId === undefined ||
        previousPath === undefined || newPath === undefined
      ) {
        throw new GitChangeDetectionError(
          `Registro rename incompleto: ${token}`,
          { code: "INVALID_TRACKED_OUTPUT" },
        );
      }

      const previousMode = validateGitMode(oldModeStr, "previousMode");
      const currentMode = validateGitMode(newModeStr, "currentMode");
      validateObjectId(oldObjectId, "previousObjectId");

      if (previousPath.length === 0 || newPath.length === 0) {
        throw new GitChangeDetectionError(
          `Rename con path vacío: ${token}`,
          { code: "INVALID_TRACKED_OUTPUT" },
        );
      }

      validateChangedPath(previousPath, "previousPath", "INVALID_TRACKED_OUTPUT");
      validateChangedPath(newPath, "path", "INVALID_TRACKED_OUTPUT");

      result.push({
        path: newPath,
        status: "RENAMED",
        previousPath,
        previousMode,
        currentMode,
        previousObjectId: oldObjectId,
        similarityScore: score,
      });

      i += 3;
      continue;
    }

    if (statusChar !== "A" && statusChar !== "M" && statusChar !== "D") {
      throw new GitChangeDetectionError(
        `Status no soportado: ${token}`,
        { code: "UNSUPPORTED_GIT_STATUS" },
      );
    }

    const oldModeStr = parts[0]!.slice(1);
    const newModeStr = parts[1]!;
    const oldObjectId = parts[2]!;
    const newObjectId = parts[3]!;

    const filePath = tokens[i + 1];

    if (
      oldModeStr === undefined || newModeStr === undefined ||
      oldObjectId === undefined || newObjectId === undefined ||
      filePath === undefined
    ) {
      throw new GitChangeDetectionError(
        `Registro incompleto para status ${statusChar}: ${token}`,
        { code: "INVALID_TRACKED_OUTPUT" },
      );
    }

    validateChangedPath(filePath, "path", "INVALID_TRACKED_OUTPUT");

    if (statusChar === "A") {
      const currentMode = validateGitMode(newModeStr, "currentMode");

      result.push({
        path: filePath,
        status: "ADDED",
        currentMode,
      });
    } else if (statusChar === "M") {
      const previousMode = validateGitMode(oldModeStr, "previousMode");
      const currentMode = validateGitMode(newModeStr, "currentMode");
      validateObjectId(oldObjectId, "previousObjectId");

      result.push({
        path: filePath,
        status: "MODIFIED",
        previousMode,
        currentMode,
        previousObjectId: oldObjectId,
      });
    } else {
      const previousMode = validateGitMode(oldModeStr, "previousMode");
      validateObjectId(oldObjectId, "previousObjectId");

      result.push({
        path: filePath,
        status: "DELETED",
        previousMode,
        previousObjectId: oldObjectId,
      });
    }

    i += 2;
  }

  return result;
}

function determineUntrackedMode(fullPath: string): GitFileMode {
  let stats;
  try {
    stats = lstatSync(fullPath);
  } catch (error) {
    throw new GitChangeDetectionError(
      `No se pudo obtener metadata de untracked: ${fullPath}`,
      { code: "INVALID_UNTRACKED_OUTPUT", cause: error },
    );
  }

  if (stats.isSymbolicLink()) {
    return "120000";
  }

  if (!stats.isFile()) {
    throw new GitChangeDetectionError(
      `Tipo de entrada no soportado para untracked: ${fullPath} (mode: ${stats.mode})`,
      { code: "UNSUPPORTED_GIT_STATUS" },
    );
  }

  const isExecutable = (stats.mode & 0o111) !== 0;
  return isExecutable ? "100755" : "100644";
}

function parseUntrackedOutput(
  untracked: string,
  workspacePath: string,
): ChangedFile[] {
  const result: ChangedFile[] = [];

  if (untracked.length === 0) {
    return result;
  }

  if (!untracked.endsWith("\0")) {
    throw new GitChangeDetectionError(
      "El output untracked no termina en NUL.",
      { code: "INVALID_UNTRACKED_OUTPUT" },
    );
  }

  const nulChar = "\0";
  const tokens = untracked.split(nulChar);

  const lastToken = tokens[tokens.length - 1]!;
  if (lastToken.length !== 0) {
    throw new GitChangeDetectionError(
      "El output untracked no termina en NUL.",
      { code: "INVALID_UNTRACKED_OUTPUT" },
    );
  }

  tokens.pop();

  for (const token of tokens) {
    if (token.length === 0) {
      throw new GitChangeDetectionError(
        "Token vacío intermedio en output untracked.",
        { code: "INVALID_UNTRACKED_OUTPUT" },
      );
    }

    validateChangedPath(token, "untracked path", "INVALID_UNTRACKED_OUTPUT");

    const fullPath = join(workspacePath, token);
    const currentMode = determineUntrackedMode(fullPath);

    result.push({
      path: token,
      status: "UNTRACKED",
      currentMode,
    });
  }

  return result;
}

function detectDuplicates(files: readonly ChangedFile[]): void {
  const seen = new Set<string>();

  for (const file of files) {
    if (seen.has(file.path)) {
      throw new GitChangeDetectionError(
        `Path duplicado: ${file.path}`,
        { code: "DUPLICATE_CHANGED_PATH" },
      );
    }

    seen.add(file.path);
  }
}

function sortChangedFiles(files: ChangedFile[]): readonly ChangedFile[] {
  return [...files].sort((a, b) => {
    const pathCmp = compareLexicographic(a.path, b.path);
    if (pathCmp !== 0) {
      return pathCmp;
    }

    const statusCmp = compareLexicographic(a.status, b.status);
    if (statusCmp !== 0) {
      return statusCmp;
    }

    const prevA = "previousPath" in a ? a.previousPath : "";
    const prevB = "previousPath" in b ? b.previousPath : "";
    return compareLexicographic(prevA, prevB);
  });
}

function compareLexicographic(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const aCode = a.charCodeAt(i);
    const bCode = b.charCodeAt(i);
    if (aCode < bCode) return -1;
    if (aCode > bCode) return 1;
  }
  return a.length - b.length;
}

export function detectGitChanges(
  workspacePath: string,
  baseCommit: string,
  deps?: { readonly runGit?: RunGitFn },
): GitChangeDetectionResult {
  validateWorkspacePath(workspacePath);
  validateBaseCommit(baseCommit);

  const runGit = deps?.runGit ?? runGitSync;

  const trackedCommandArgs = [
    "diff",
    "--raw",
    "-z",
    "--no-abbrev",
    "--find-renames=50%",
    baseCommit,
    "--",
  ];

  let trackedResult: GitCommandResult;

  try {
    trackedResult = runGit(workspacePath, trackedCommandArgs);
  } catch (error) {
    throwGitNotfound(trackedCommandArgs, error);
  }

  if (trackedResult.error !== undefined) {
    throwGitNotfound(trackedCommandArgs, trackedResult.error);
  }

  if (trackedResult.exitCode !== 0) {
    throwGitCommandFailed(trackedCommandArgs, trackedResult);
  }

  const tracked = parseRawOutput(trackedResult.stdout);

  const untrackedArgs = [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
  ];

  let untrackedResult: GitCommandResult;

  try {
    untrackedResult = runGit(workspacePath, untrackedArgs);
  } catch (error) {
    throwGitNotfound(untrackedArgs, error);
  }

  if (untrackedResult.error !== undefined) {
    throwGitNotfound(untrackedArgs, untrackedResult.error);
  }

  if (untrackedResult.exitCode !== 0) {
    throwGitCommandFailed(untrackedArgs, untrackedResult);
  }

  const untracked = parseUntrackedOutput(untrackedResult.stdout, workspacePath);

  const allFiles = [...tracked, ...untracked];

  detectDuplicates(allFiles);

  return {
    baseCommit,
    changedFiles: sortChangedFiles(allFiles),
  };
}
