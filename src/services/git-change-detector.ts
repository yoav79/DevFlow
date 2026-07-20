/// <reference types="node" />

import { spawnSync } from "node:child_process";

const MAX_STDERR_PREVIEW = 200;

export type ChangedFileStatus =
  | "ADDED"
  | "MODIFIED"
  | "DELETED"
  | "RENAMED"
  | "UNTRACKED";

export interface ChangedFile {
  readonly path: string;
  readonly status: ChangedFileStatus;
  readonly previousPath?: string;
}

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

function isSupportedStatus(status: string): boolean {
  return status === "A" || status === "M" || status === "D";
}

function isRenameStatus(status: string): boolean {
  return status.startsWith("R");
}

function isValidRenameScore(status: string): boolean {
  if (!status.startsWith("R")) {
    return false;
  }

  const scoreStr = status.slice(1);

  if (scoreStr.length === 0) {
    return false;
  }

  for (let i = 0; i < scoreStr.length; i++) {
    const ch = scoreStr.charCodeAt(i);
    if (ch < 48 || ch > 57) {
      return false;
    }
  }

  const score = Number(scoreStr);
  return score >= 0 && score <= 100;
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

function parseTrackedOutput(tracked: string): ChangedFile[] {
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

    const statusChar = token[0]!;

    if (isRenameStatus(statusChar)) {
      if (!isValidRenameScore(token)) {
        throw new GitChangeDetectionError(
          `Status de rename inválido: ${token}`,
          { code: "UNSUPPORTED_GIT_STATUS" },
        );
      }

      if (statusChar === "C") {
        throw new GitChangeDetectionError(
          `Status de copy no soportado: ${token}`,
          { code: "UNSUPPORTED_GIT_STATUS" },
        );
      }

      const previousPath = tokens[i + 1];
      const newPath = tokens[i + 2];

      if (previousPath === undefined || newPath === undefined) {
        throw new GitChangeDetectionError(
          `Rename incompleto: se esperaban dos paths después de ${token}`,
          { code: "INVALID_TRACKED_OUTPUT" },
        );
      }

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
      });

      i += 3;
      continue;
    }

    if (!isSupportedStatus(statusChar)) {
      throw new GitChangeDetectionError(
        `Status no soportado: ${token}`,
        { code: "UNSUPPORTED_GIT_STATUS" },
      );
    }

    const filePath = tokens[i + 1];

    if (filePath === undefined) {
      throw new GitChangeDetectionError(
        `Path faltante para status ${statusChar}`,
        { code: "INVALID_TRACKED_OUTPUT" },
      );
    }

    validateChangedPath(filePath, "path", "INVALID_TRACKED_OUTPUT");

    let fileStatus: ChangedFileStatus;

    if (statusChar === "A") {
      fileStatus = "ADDED";
    } else if (statusChar === "M") {
      fileStatus = "MODIFIED";
    } else {
      fileStatus = "DELETED";
    }

    result.push({
      path: filePath,
      status: fileStatus,
    });

    i += 2;
  }

  return result;
}

function parseUntrackedOutput(untracked: string): ChangedFile[] {
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

    result.push({
      path: token,
      status: "UNTRACKED",
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

    const prevA = a.previousPath ?? "";
    const prevB = b.previousPath ?? "";
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

  const trackedArgs = [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=50%",
    baseCommit,
    "--",
  ];

  let trackedResult: GitCommandResult;

  try {
    trackedResult = runGit(workspacePath, trackedArgs);
  } catch (error) {
    throwGitNotfound(trackedArgs, error);
  }

  if (trackedResult.error !== undefined) {
    throwGitNotfound(trackedArgs, trackedResult.error);
  }

  if (trackedResult.exitCode !== 0) {
    throwGitCommandFailed(trackedArgs, trackedResult);
  }

  const tracked = parseTrackedOutput(trackedResult.stdout);

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

  const untracked = parseUntrackedOutput(untrackedResult.stdout);

  const allFiles = [...tracked, ...untracked];

  detectDuplicates(allFiles);

  return {
    baseCommit,
    changedFiles: sortChangedFiles(allFiles),
  };
}
