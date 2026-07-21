/// <reference types="node" />

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readlinkSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const WORKSPACE_FINGERPRINT_VERSION = 1;

export interface WorkspaceFingerprintInput {
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly workspaceId: string;
}

export interface WorkspaceFingerprint {
  readonly workspaceId: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly workingTreeFingerprint: string;
}

export type WorkspaceFingerprintErrorCode =
  | "WORKSPACE_FINGERPRINT_GIT_FAILED"
  | "WORKSPACE_FINGERPRINT_INVALID_GIT_OUTPUT"
  | "WORKSPACE_CHANGED_DURING_FINGERPRINT"
  | "WORKSPACE_FINGERPRINT_IO_FAILED"
  | "WORKSPACE_FINGERPRINT_UNSUPPORTED_ENTRY"
  | "WORKSPACE_FINGERPRINT_PATH_ESCAPE";

export class WorkspaceFingerprintError extends Error {
  readonly code: WorkspaceFingerprintErrorCode;
  readonly command?: readonly string[];
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderrPreview?: string;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code: WorkspaceFingerprintErrorCode;
      command?: readonly string[];
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "WorkspaceFingerprintError";
    this.code = options.code;
    this.command = options.command;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.cause = options.cause;

    if (options.stderr !== undefined && options.stderr.length > 0) {
      this.stderrPreview = options.stderr.slice(0, 200);
    }
  }
}

interface GitCommandResult {
  readonly stdout: Buffer;
  readonly stdoutStr: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: unknown;
}

function runGit(workspacePath: string, args: string[], binary = "git"): GitCommandResult {
  const result = spawnSync(binary, ["-C", workspacePath, ...args], {
    encoding: "buffer",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error !== undefined) {
    return {
      stdout: Buffer.alloc(0),
      stdoutStr: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: result.error,
    };
  }

  return {
    stdout: result.stdout ?? Buffer.alloc(0),
    stdoutStr: (result.stdout ?? Buffer.alloc(0)).toString("utf8"),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
    exitCode: result.status,
    signal: result.signal ?? null,
  };
}

function requireGitSuccess(
  workspacePath: string,
  args: readonly string[],
  result: GitCommandResult,
): void {
  if (result.error !== undefined) {
    throw new WorkspaceFingerprintError(
      `No se encontró el binario de Git.`,
      { code: "WORKSPACE_FINGERPRINT_GIT_FAILED", command: args, cause: result.error },
    );
  }

  if (result.exitCode !== 0) {
    throw new WorkspaceFingerprintError(
      `Git terminó con código distinto de 0: ${args.join(" ")}`,
      {
        code: "WORKSPACE_FINGERPRINT_GIT_FAILED",
        command: args,
        exitCode: result.exitCode,
        signal: result.signal,
        stderr: result.stderr,
      },
    );
  }
}

function validateNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkspaceFingerprintError(
      `${label} no puede estar vacío.`,
      { code: "WORKSPACE_FINGERPRINT_INVALID_GIT_OUTPUT" },
    );
  }
}

function encodeUtf8Bytes(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function writeLengthPrefixed(hash: import("crypto").Hash, tag: string, data: Buffer): void {
  hash.update(encodeUtf8Bytes(tag));
  hash.update(encodeUtf8Bytes(String(data.length)));
  hash.update(encodeUtf8Bytes(":"));
  hash.update(data);
}

function writeField(hash: import("crypto").Hash, tag: string, value: string): void {
  writeLengthPrefixed(hash, tag, encodeUtf8Bytes(value));
}

function writeNullTerminatedArray(
  hash: import("crypto").Hash,
  tag: string,
  items: readonly string[],
): void {
  hash.update(encodeUtf8Bytes(tag));
  hash.update(encodeUtf8Bytes(String(items.length)));
  hash.update(encodeUtf8Bytes(":"));

  for (const item of items) {
    hash.update(encodeUtf8Bytes(String(item.length)));
    hash.update(encodeUtf8Bytes(":"));
    hash.update(encodeUtf8Bytes(item));
    hash.update(encodeUtf8Bytes("\0"));
  }
}

function validatePathEscape(workspacePath: string, filePath: string): void {
  const resolved = resolve(workspacePath, filePath);
  const normalizedWorkspace = resolve(workspacePath);

  if (!resolved.startsWith(normalizedWorkspace) && resolved !== normalizedWorkspace) {
    throw new WorkspaceFingerprintError(
      `Path escape detectado: ${filePath} resuelve fuera del workspace.`,
      { code: "WORKSPACE_FINGERPRINT_PATH_ESCAPE" },
    );
  }
}

function hashFileContent(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function hashBuffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function statOrNull(filePath: string): import("node:fs").Stats | null {
  try {
    return lstatSync(filePath);
  } catch {
    return null;
  }
}

interface UntrackedEntry {
  readonly path: string;
  readonly type: "file" | "symlink";
  readonly mode: string;
  readonly size: number;
  readonly contentHash: string;
}

function processUntrackedFile(
  workspacePath: string,
  untrackedPath: string,
): UntrackedEntry {
  validatePathEscape(workspacePath, untrackedPath);

  const fullPath = join(workspacePath, untrackedPath);
  const stats = statOrNull(fullPath);

  if (stats === null) {
    throw new WorkspaceFingerprintError(
      `Archivo untracked desapareció durante hashing: ${untrackedPath}`,
      { code: "WORKSPACE_CHANGED_DURING_FINGERPRINT" },
    );
  }

  if (stats.isSymbolicLink()) {
    let target: string;

    try {
      target = readlinkSync(fullPath);
    } catch (error: unknown) {
      const nodeError = error as { code?: string };

      if (nodeError.code === "ENOENT") {
        throw new WorkspaceFingerprintError(
          `Symlink desapareció durante lectura: ${untrackedPath}`,
          { code: "WORKSPACE_CHANGED_DURING_FINGERPRINT" },
        );
      }

      throw new WorkspaceFingerprintError(
        `Error leyendo symlink: ${untrackedPath}`,
        { code: "WORKSPACE_FINGERPRINT_IO_FAILED", cause: error },
      );
    }

    return {
      path: untrackedPath,
      type: "symlink",
      mode: String(stats.mode & 0o777),
      size: 0,
      contentHash: hashBuffer(encodeUtf8Bytes(target)),
    };
  }

  if (!stats.isFile()) {
    throw new WorkspaceFingerprintError(
      `Tipo de entrada no soportado: ${untrackedPath} (mode: ${stats.mode})`,
      { code: "WORKSPACE_FINGERPRINT_UNSUPPORTED_ENTRY" },
    );
  }

  const statsBefore = { size: stats.size, mtimeMs: stats.mtimeMs };

  let contentHash: string;

  try {
    contentHash = hashFileContent(fullPath);
  } catch (error: unknown) {
    const nodeError = error as { code?: string };

    if (nodeError.code === "ENOENT") {
      throw new WorkspaceFingerprintError(
        `Archivo desapareció durante hashing: ${untrackedPath}`,
        { code: "WORKSPACE_CHANGED_DURING_FINGERPRINT" },
      );
    }

    if (nodeError.code === "EACCES" || nodeError.code === "EIO") {
      throw new WorkspaceFingerprintError(
        `Error de I/O leyendo archivo: ${untrackedPath} (${nodeError.code})`,
        { code: "WORKSPACE_FINGERPRINT_IO_FAILED", cause: error },
      );
    }

    throw new WorkspaceFingerprintError(
      `Error leyendo archivo: ${untrackedPath}`,
      { code: "WORKSPACE_FINGERPRINT_IO_FAILED", cause: error },
    );
  }

  const statsAfter = statOrNull(fullPath);

  if (statsAfter === null) {
    throw new WorkspaceFingerprintError(
      `Archivo desapareció post-hash: ${untrackedPath}`,
      { code: "WORKSPACE_CHANGED_DURING_FINGERPRINT" },
    );
  }

  if (
    statsAfter.size !== statsBefore.size
    || statsAfter.mtimeMs !== statsBefore.mtimeMs
  ) {
    throw new WorkspaceFingerprintError(
      `Archivo modificado durante hashing: ${untrackedPath}`,
      { code: "WORKSPACE_CHANGED_DURING_FINGERPRINT" },
    );
  }

  return {
    path: untrackedPath,
    type: "file",
    mode: String(stats.mode & 0o777),
    size: stats.size,
    contentHash,
  };
}

function sortUtf8(a: string, b: string): number {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  const minLen = Math.min(aBuf.length, bBuf.length);

  for (let i = 0; i < minLen; i++) {
    if (aBuf[i]! < bBuf[i]!) return -1;
    if (aBuf[i]! > bBuf[i]!) return 1;
  }

  return aBuf.length - bBuf.length;
}

function splitNulDelimited(buffer: Buffer): string[] {
  if (buffer.length === 0) {
    return [];
  }

  if (buffer[buffer.length - 1] !== 0) {
    throw new WorkspaceFingerprintError(
      "Output NUL-delimited no termina en NUL.",
      { code: "WORKSPACE_FINGERPRINT_INVALID_GIT_OUTPUT" },
    );
  }

  const result: string[] = [];
  let start = 0;

  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      if (i > start) {
        result.push(buffer.subarray(start, i).toString("utf8"));
      }
      start = i + 1;
    }
  }

  return result;
}

export function computeWorkspaceFingerprint(
  input: WorkspaceFingerprintInput,
): WorkspaceFingerprint {
  validateNonEmptyString(input.workspacePath, "workspacePath");
  validateNonEmptyString(input.baseCommit, "baseCommit");
  validateNonEmptyString(input.workspaceId, "workspaceId");

  const workspacePath = resolve(input.workspacePath);

  const headResult = runGit(workspacePath, ["rev-parse", "HEAD"]);
  requireGitSuccess(workspacePath, ["rev-parse", "HEAD"], headResult);

  const headCommit = headResult.stdoutStr.trim();
  validateNonEmptyString(headCommit, "HEAD commit");

  if (headCommit.includes("\n")) {
    throw new WorkspaceFingerprintError(
      "HEAD commit contiene múltiples líneas.",
      { code: "WORKSPACE_FINGERPRINT_INVALID_GIT_OUTPUT" },
    );
  }

  const diffResult = runGit(workspacePath, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "-z",
    input.baseCommit,
    "--",
  ]);
  requireGitSuccess(workspacePath, ["diff", "--binary", "--no-ext-diff", "-z", input.baseCommit, "--"], diffResult);

  const nameStatusResult = runGit(workspacePath, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=50%",
    input.baseCommit,
    "--",
  ]);
  requireGitSuccess(workspacePath, ["diff", "--name-status", "-z", "--find-renames=50%", input.baseCommit, "--"], nameStatusResult);

  const untrackedResult = runGit(workspacePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
  ]);
  requireGitSuccess(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z", "--"], untrackedResult);

  const untrackedPaths = splitNulDelimited(untrackedResult.stdout).sort(sortUtf8);

  const untrackedEntries: UntrackedEntry[] = [];

  for (const untrackedPath of untrackedPaths) {
    untrackedEntries.push(processUntrackedFile(workspacePath, untrackedPath));
  }

  const nameStatusTokens = splitNulDelimited(nameStatusResult.stdout);
  const nameStatusEntries: string[] = [];

  let i = 0;

  while (i < nameStatusTokens.length) {
    const token = nameStatusTokens[i]!;

    if (token.length === 0) {
      i++;
      continue;
    }

    const statusChar = token[0]!;

    if (statusChar === "R" || statusChar === "C") {
      const prevPath = nameStatusTokens[i + 1];
      const newPath = nameStatusTokens[i + 2];

      if (prevPath === undefined || newPath === undefined) {
        throw new WorkspaceFingerprintError(
          `Name-status incompleto para rename/copy: ${token}`,
          { code: "WORKSPACE_FINGERPRINT_INVALID_GIT_OUTPUT" },
        );
      }

      nameStatusEntries.push(`${statusChar}\0${prevPath}\0${newPath}`);
      i += 3;
    } else {
      const filePath = nameStatusTokens[i + 1];

      if (filePath === undefined) {
        throw new WorkspaceFingerprintError(
          `Name-status incompleto: ${token}`,
          { code: "WORKSPACE_FINGERPRINT_INVALID_GIT_OUTPUT" },
        );
      }

      nameStatusEntries.push(`${statusChar}\0${filePath}`);
      i += 2;
    }
  }

  const hash = createHash("sha256");

  writeField(hash, "version:", String(WORKSPACE_FINGERPRINT_VERSION));
  writeField(hash, "workspaceId:", input.workspaceId);
  writeField(hash, "baseCommit:", input.baseCommit);
  writeField(hash, "headCommit:", headCommit);
  writeLengthPrefixed(hash, "diff:", diffResult.stdout);
  writeNullTerminatedArray(hash, "nameStatus:", nameStatusEntries);

  hash.update(encodeUtf8Bytes("untrackedCount:"));
  hash.update(encodeUtf8Bytes(String(untrackedEntries.length)));
  hash.update(encodeUtf8Bytes(":"));

  for (const entry of untrackedEntries) {
    writeField(hash, "path:", entry.path);
    writeField(hash, "type:", entry.type);
    writeField(hash, "mode:", entry.mode);
    writeField(hash, "size:", String(entry.size));
    writeField(hash, "contentHash:", entry.contentHash);

    if (entry.type === "symlink") {
      const fullPath = join(workspacePath, entry.path);
      let target: string;

      try {
      target = readlinkSync(fullPath);
      } catch (error: unknown) {
        throw new WorkspaceFingerprintError(
          `Error releyendo symlink post-hash: ${entry.path}`,
          { code: "WORKSPACE_CHANGED_DURING_FINGERPRINT", cause: error },
        );
      }

      writeField(hash, "target:", target);
    }
  }

  const workingTreeFingerprint = hash.digest("hex");

  return {
    workspaceId: input.workspaceId,
    baseCommit: input.baseCommit,
    headCommit,
    workingTreeFingerprint,
  };
}
