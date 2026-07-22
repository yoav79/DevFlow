/// <reference types="node" />

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import type { EvidenceFile } from "../schemas/evidence-bundle-schema.js";
import type { ChangedFile, GitFileMode } from "./git-change-detector.js";

export type EvidenceFileCollectorErrorCode =
  | "INVALID_INPUT"
  | "PATH_ESCAPE"
  | "FILE_MISSING"
  | "FILE_UNREADABLE"
  | "FILE_TYPE_CHANGED"
  | "UNSUPPORTED_FILE_TYPE"
  | "BINARY_CLASSIFICATION_FAILED"
  | "PREVIOUS_BLOB_READ_FAILED"
  | "CURRENT_FILE_READ_FAILED"
  | "SYMLINK_READ_FAILED"
  | "PATCH_REQUIRED"
  | "PATCH_READ_FAILED"
  | "HASH_FAILED";

export class EvidenceFileCollectorError extends Error {
  readonly code: EvidenceFileCollectorErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: {
      readonly code: EvidenceFileCollectorErrorCode;
      readonly cause?: unknown;
      readonly details?: Record<string, unknown>;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EvidenceFileCollectorError";
    this.code = options.code;
    if (options.details !== undefined) {
      this.details = Object.freeze({ ...options.details });
    }
  }
}

export interface EvidenceFileCollectorInput {
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly changedFiles: readonly ChangedFile[];
}

export interface EvidenceFileStat {
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export type EvidenceByteClassification = "TEXT" | "BINARY";

export interface EvidenceFileCollectorDeps {
  readonly lstat?: (fullPath: string) => EvidenceFileStat;
  readonly readCurrentFileBytes?: (fullPath: string) => Buffer;
  readonly readPreviousBlobBytes?: (
    workspacePath: string,
    baseCommit: string,
    filePath: string,
    objectId: string,
  ) => Buffer;
  readonly readCurrentSymlinkTarget?: (fullPath: string) => string;
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
  readonly classifyBytes?: (content: Buffer) => EvidenceByteClassification;
}

interface ResolvedPath {
  readonly relativePath: string;
  readonly fullPath: string;
}

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function validateNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EvidenceFileCollectorError(`${fieldName} no puede estar vacío.`, {
      code: "INVALID_INPUT",
      details: { fieldName },
    });
  }
  return value;
}

function validateChangedFiles(value: readonly ChangedFile[]): void {
  if (!Array.isArray(value)) {
    throw new EvidenceFileCollectorError("changedFiles debe ser un array.", {
      code: "INVALID_INPUT",
      details: { fieldName: "changedFiles" },
    });
  }
}

function validateRelativePath(filePath: string): string {
  validateNonEmptyString(filePath, "path");

  if (isAbsolute(filePath)) {
    throw new EvidenceFileCollectorError(`Path absoluto no permitido: ${filePath}`, {
      code: "PATH_ESCAPE",
      details: { path: filePath },
    });
  }

  if (filePath.startsWith("./") || filePath.includes("\\") || filePath.includes("//") || filePath === ".") {
    throw new EvidenceFileCollectorError(`Path inválido: ${filePath}`, {
      code: "PATH_ESCAPE",
      details: { path: filePath },
    });
  }

  for (const segment of filePath.split("/")) {
    if (segment.length === 0 || segment === "..") {
      throw new EvidenceFileCollectorError(`Path contiene segmento inválido: ${filePath}`, {
        code: "PATH_ESCAPE",
        details: { path: filePath },
      });
    }
  }

  return filePath;
}

function resolveWorkspacePath(workspacePath: string, filePath: string): ResolvedPath {
  const workspaceRoot = resolve(validateNonEmptyString(workspacePath, "workspacePath"));
  const relativePath = validateRelativePath(filePath);
  const fullPath = resolve(workspaceRoot, relativePath);
  const workspacePrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;

  if (fullPath !== workspaceRoot && !fullPath.startsWith(workspacePrefix)) {
    throw new EvidenceFileCollectorError(`Path escape detectado: ${filePath}`, {
      code: "PATH_ESCAPE",
      details: { path: filePath, workspacePath: workspaceRoot },
    });
  }

  return { relativePath, fullPath };
}

function defaultLstat(fullPath: string): EvidenceFileStat {
  try {
    const stat = lstatSync(fullPath);
    return { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink() };
  } catch (error) {
    const nodeError = error as { code?: string };
    if (nodeError.code === "ENOENT") {
      throw new EvidenceFileCollectorError(`Archivo no encontrado: ${fullPath}`, {
        code: "FILE_MISSING",
        cause: error,
        details: { fullPath },
      });
    }
    throw new EvidenceFileCollectorError(`No se pudo leer metadata: ${fullPath}`, {
      code: "FILE_UNREADABLE",
      cause: error,
      details: { fullPath },
    });
  }
}

function currentStat(fullPath: string, deps: EvidenceFileCollectorDeps): EvidenceFileStat {
  try {
    return (deps.lstat ?? defaultLstat)(fullPath);
  } catch (error) {
    if (error instanceof EvidenceFileCollectorError) throw error;
    throw new EvidenceFileCollectorError(`No se pudo leer metadata: ${fullPath}`, {
      code: "FILE_UNREADABLE",
      cause: error,
      details: { fullPath },
    });
  }
}

function defaultReadCurrentFileBytes(fullPath: string): Buffer {
  try {
    return readFileSync(fullPath);
  } catch (error) {
    const nodeError = error as { code?: string };
    if (nodeError.code === "ENOENT") {
      throw new EvidenceFileCollectorError(`Archivo desapareció: ${fullPath}`, {
        code: "FILE_MISSING",
        cause: error,
        details: { fullPath },
      });
    }
    throw new EvidenceFileCollectorError(`No se pudo leer archivo actual: ${fullPath}`, {
      code: "CURRENT_FILE_READ_FAILED",
      cause: error,
      details: { fullPath },
    });
  }
}

function readCurrentFileBytes(fullPath: string, deps: EvidenceFileCollectorDeps): Buffer {
  try {
    return Buffer.from((deps.readCurrentFileBytes ?? defaultReadCurrentFileBytes)(fullPath));
  } catch (error) {
    if (error instanceof EvidenceFileCollectorError) throw error;
    throw new EvidenceFileCollectorError(`No se pudo leer archivo actual: ${fullPath}`, {
      code: "CURRENT_FILE_READ_FAILED",
      cause: error,
      details: { fullPath },
    });
  }
}

function requireReadPreviousBlobBytes(deps: EvidenceFileCollectorDeps): NonNullable<EvidenceFileCollectorDeps["readPreviousBlobBytes"]> {
  if (deps.readPreviousBlobBytes === undefined) {
    throw new EvidenceFileCollectorError("readPreviousBlobBytes es obligatorio para leer blobs anteriores.", {
      code: "INVALID_INPUT",
      details: { dependency: "readPreviousBlobBytes" },
    });
  }
  return deps.readPreviousBlobBytes;
}

function readPreviousBlobBytes(
  workspacePath: string,
  baseCommit: string,
  filePath: string,
  objectId: string,
  deps: EvidenceFileCollectorDeps,
): Buffer {
  try {
    return Buffer.from(requireReadPreviousBlobBytes(deps)(workspacePath, baseCommit, filePath, objectId));
  } catch (error) {
    if (error instanceof EvidenceFileCollectorError) throw error;
    throw new EvidenceFileCollectorError(`No se pudo leer blob anterior: ${filePath}`, {
      code: "PREVIOUS_BLOB_READ_FAILED",
      cause: error,
      details: { path: filePath, objectId },
    });
  }
}

function defaultReadCurrentSymlinkTarget(fullPath: string): string {
  try {
    return readlinkSync(fullPath);
  } catch (error) {
    throw new EvidenceFileCollectorError(`No se pudo leer symlink actual: ${fullPath}`, {
      code: "SYMLINK_READ_FAILED",
      cause: error,
      details: { fullPath },
    });
  }
}

function readCurrentSymlinkTarget(fullPath: string, deps: EvidenceFileCollectorDeps): string {
  try {
    return (deps.readCurrentSymlinkTarget ?? defaultReadCurrentSymlinkTarget)(fullPath);
  } catch (error) {
    if (error instanceof EvidenceFileCollectorError) throw error;
    throw new EvidenceFileCollectorError(`No se pudo leer symlink actual: ${fullPath}`, {
      code: "SYMLINK_READ_FAILED",
      cause: error,
      details: { fullPath },
    });
  }
}

function requireReadPreviousSymlinkTarget(deps: EvidenceFileCollectorDeps): NonNullable<EvidenceFileCollectorDeps["readPreviousSymlinkTarget"]> {
  if (deps.readPreviousSymlinkTarget === undefined) {
    throw new EvidenceFileCollectorError("readPreviousSymlinkTarget es obligatorio para symlinks anteriores.", {
      code: "INVALID_INPUT",
      details: { dependency: "readPreviousSymlinkTarget" },
    });
  }
  return deps.readPreviousSymlinkTarget;
}

function readPreviousSymlinkTarget(
  workspacePath: string,
  baseCommit: string,
  filePath: string,
  objectId: string,
  deps: EvidenceFileCollectorDeps,
): string {
  try {
    return requireReadPreviousSymlinkTarget(deps)(workspacePath, baseCommit, filePath, objectId);
  } catch (error) {
    if (error instanceof EvidenceFileCollectorError) throw error;
    throw new EvidenceFileCollectorError(`No se pudo leer symlink anterior: ${filePath}`, {
      code: "SYMLINK_READ_FAILED",
      cause: error,
      details: { path: filePath, objectId },
    });
  }
}

function requireReadPatch(deps: EvidenceFileCollectorDeps): NonNullable<EvidenceFileCollectorDeps["readPatch"]> {
  if (deps.readPatch === undefined) {
    throw new EvidenceFileCollectorError("readPatch es obligatorio para cambios textuales con patch.", {
      code: "INVALID_INPUT",
      details: { dependency: "readPatch" },
    });
  }
  return deps.readPatch;
}

function readRequiredPatch(
  workspacePath: string,
  baseCommit: string,
  filePath: string,
  previousPath: string | undefined,
  deps: EvidenceFileCollectorDeps,
): string {
  let patch: string;
  try {
    patch = requireReadPatch(deps)(workspacePath, baseCommit, filePath, previousPath);
  } catch (error) {
    if (error instanceof EvidenceFileCollectorError) throw error;
    throw new EvidenceFileCollectorError(`No se pudo leer patch: ${filePath}`, {
      code: "PATCH_READ_FAILED",
      cause: error,
      details: { path: filePath, previousPath },
    });
  }

  if (patch.length === 0) {
    throw new EvidenceFileCollectorError(`Patch requerido vacío: ${filePath}`, {
      code: "PATCH_REQUIRED",
      details: { path: filePath, previousPath },
    });
  }
  return patch;
}

function defaultClassifyBytes(content: Buffer): EvidenceByteClassification {
  try {
    if (content.includes(0)) return "BINARY";
    fatalUtf8Decoder.decode(content);
    return "TEXT";
  } catch (error) {
    if (error instanceof TypeError) return "BINARY";
    throw new EvidenceFileCollectorError("No se pudo clasificar contenido.", {
      code: "BINARY_CLASSIFICATION_FAILED",
      cause: error,
    });
  }
}

function classifyBytes(content: Buffer, deps: EvidenceFileCollectorDeps): EvidenceByteClassification {
  try {
    return (deps.classifyBytes ?? defaultClassifyBytes)(content);
  } catch (error) {
    if (error instanceof EvidenceFileCollectorError) throw error;
    throw new EvidenceFileCollectorError("No se pudo clasificar contenido.", {
      code: "BINARY_CLASSIFICATION_FAILED",
      cause: error,
    });
  }
}

function sha256Hex(content: Buffer): string {
  try {
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    throw new EvidenceFileCollectorError("No se pudo calcular SHA-256.", {
      code: "HASH_FAILED",
      cause: error,
    });
  }
}

function targetHash(target: string): string {
  return sha256Hex(Buffer.from(target, "utf8"));
}

function displayText(content: Buffer): string {
  return content.toString("utf8").replace(/\r\n/g, "\n");
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") count++;
  }
  return count;
}

function assertCurrentTypeMatchesMode(mode: GitFileMode, stat: EvidenceFileStat, path: string): void {
  if (mode === "120000") {
    if (!stat.isSymbolicLink) {
      throw new EvidenceFileCollectorError(`El path ya no es symlink: ${path}`, {
        code: "FILE_TYPE_CHANGED",
        details: { path, expectedMode: mode },
      });
    }
    return;
  }

  if (stat.isSymbolicLink || !stat.isFile) {
    throw new EvidenceFileCollectorError(`Tipo actual incompatible con modo Git: ${path}`, {
      code: stat.isSymbolicLink ? "FILE_TYPE_CHANGED" : "UNSUPPORTED_FILE_TYPE",
      details: { path, expectedMode: mode },
    });
  }
}

function assertPreviousObjectId(objectId: string, path: string): void {
  if (!/^[0-9a-f]+$/.test(objectId) || (objectId.length !== 40 && objectId.length !== 64) || /^0+$/.test(objectId)) {
    throw new EvidenceFileCollectorError(`previousObjectId inválido: ${path}`, {
      code: "INVALID_INPUT",
      details: { path, objectId },
    });
  }
}

function collectAddedOrUntracked(
  file: Extract<ChangedFile, { status: "ADDED" | "UNTRACKED" }>,
  workspacePath: string,
  deps: EvidenceFileCollectorDeps,
): EvidenceFile {
  const { relativePath, fullPath } = resolveWorkspacePath(workspacePath, file.path);
  const stat = currentStat(fullPath, deps);
  assertCurrentTypeMatchesMode(file.currentMode, stat, relativePath);

  if (file.currentMode === "120000") {
    const target = readCurrentSymlinkTarget(fullPath, deps);
    return {
      fileKind: "SYMLINK",
      status: file.status,
      path: relativePath,
      currentMode: "120000",
      currentTarget: target,
      currentTargetHash: targetHash(target),
    };
  }

  const currentBytes = readCurrentFileBytes(fullPath, deps);
  const currentHash = sha256Hex(currentBytes);
  const currentByteLength = currentBytes.length;
  const classification = classifyBytes(currentBytes, deps);

  if (classification === "BINARY") {
    return {
      fileKind: "BINARY",
      status: file.status,
      path: relativePath,
      currentMode: file.currentMode,
      currentHash,
      currentByteLength,
      reviewabilityLimited: true,
    };
  }

  const currentContent = displayText(currentBytes);
  return {
    fileKind: "TEXT",
    status: file.status,
    path: relativePath,
    currentMode: file.currentMode,
    currentContent,
    currentHash,
    currentByteLength,
    currentLineCount: countLines(currentContent),
  };
}

function collectModified(
  file: Extract<ChangedFile, { status: "MODIFIED" }>,
  workspacePath: string,
  baseCommit: string,
  deps: EvidenceFileCollectorDeps,
): EvidenceFile {
  assertPreviousObjectId(file.previousObjectId, file.path);
  const { relativePath, fullPath } = resolveWorkspacePath(workspacePath, file.path);
  const stat = currentStat(fullPath, deps);
  assertCurrentTypeMatchesMode(file.currentMode, stat, relativePath);

  if (file.previousMode === "120000" || file.currentMode === "120000") {
    if (file.previousMode !== "120000" || file.currentMode !== "120000") {
      throw new EvidenceFileCollectorError(`Cambio de tipo symlink no soportado: ${relativePath}`, {
        code: "FILE_TYPE_CHANGED",
        details: { path: relativePath, previousMode: file.previousMode, currentMode: file.currentMode },
      });
    }

    const currentTarget = readCurrentSymlinkTarget(fullPath, deps);
    const previousTarget = readPreviousSymlinkTarget(workspacePath, baseCommit, relativePath, file.previousObjectId, deps);
    return {
      fileKind: "SYMLINK",
      status: "MODIFIED",
      path: relativePath,
      previousObjectId: file.previousObjectId,
      currentTarget,
      previousTarget,
      currentTargetHash: targetHash(currentTarget),
      previousTargetHash: targetHash(previousTarget),
    };
  }

  const currentBytes = readCurrentFileBytes(fullPath, deps);
  const previousBytes = readPreviousBlobBytes(workspacePath, baseCommit, relativePath, file.previousObjectId, deps);
  const currentHash = sha256Hex(currentBytes);
  const previousHash = sha256Hex(previousBytes);
  const currentKind = classifyBytes(currentBytes, deps);
  const previousKind = classifyBytes(previousBytes, deps);

  if (currentKind === "BINARY" || previousKind === "BINARY") {
    return {
      fileKind: "BINARY",
      status: "MODIFIED",
      path: relativePath,
      previousMode: file.previousMode,
      currentMode: file.currentMode,
      previousObjectId: file.previousObjectId,
      previousHash,
      currentHash,
      previousByteLength: previousBytes.length,
      currentByteLength: currentBytes.length,
      reviewabilityLimited: true,
    };
  }

  const currentContent = displayText(currentBytes);
  const patch = readRequiredPatch(workspacePath, baseCommit, relativePath, undefined, deps);
  return {
    fileKind: "TEXT",
    status: "MODIFIED",
    path: relativePath,
    previousMode: file.previousMode,
    currentMode: file.currentMode,
    previousObjectId: file.previousObjectId,
    patch,
    currentHash,
    previousHash,
    currentByteLength: currentBytes.length,
    previousByteLength: previousBytes.length,
    currentContent,
    currentContentTruncated: false,
  };
}

function collectDeleted(
  file: Extract<ChangedFile, { status: "DELETED" }>,
  workspacePath: string,
  baseCommit: string,
  deps: EvidenceFileCollectorDeps,
): EvidenceFile {
  assertPreviousObjectId(file.previousObjectId, file.path);
  const relativePath = validateRelativePath(file.path);

  if (file.previousMode === "120000") {
    const previousTarget = readPreviousSymlinkTarget(workspacePath, baseCommit, relativePath, file.previousObjectId, deps);
    return {
      fileKind: "SYMLINK",
      status: "DELETED",
      path: relativePath,
      previousObjectId: file.previousObjectId,
      previousTarget,
      previousTargetHash: targetHash(previousTarget),
    };
  }

  const previousBytes = readPreviousBlobBytes(workspacePath, baseCommit, relativePath, file.previousObjectId, deps);
  const previousHash = sha256Hex(previousBytes);
  const previousKind = classifyBytes(previousBytes, deps);

  if (previousKind === "BINARY") {
    return {
      fileKind: "BINARY",
      status: "DELETED",
      path: relativePath,
      previousMode: file.previousMode,
      previousObjectId: file.previousObjectId,
      previousHash,
      previousByteLength: previousBytes.length,
      reviewabilityLimited: true,
    };
  }

  const previousContent = displayText(previousBytes);
  return {
    fileKind: "TEXT",
    status: "DELETED",
    path: relativePath,
    previousMode: file.previousMode,
    previousObjectId: file.previousObjectId,
    previousContent,
    previousHash,
    previousByteLength: previousBytes.length,
    previousLineCount: countLines(previousContent),
  };
}

function collectRenamed(
  file: Extract<ChangedFile, { status: "RENAMED" }>,
  workspacePath: string,
  baseCommit: string,
  deps: EvidenceFileCollectorDeps,
): EvidenceFile {
  assertPreviousObjectId(file.previousObjectId, file.path);
  const previousPath = validateRelativePath(file.previousPath);
  const { relativePath, fullPath } = resolveWorkspacePath(workspacePath, file.path);
  const stat = currentStat(fullPath, deps);
  assertCurrentTypeMatchesMode(file.currentMode, stat, relativePath);

  if (file.previousMode === "120000" || file.currentMode === "120000") {
    if (file.previousMode !== "120000" || file.currentMode !== "120000") {
      throw new EvidenceFileCollectorError(`Cambio de tipo symlink no soportado: ${relativePath}`, {
        code: "FILE_TYPE_CHANGED",
        details: { path: relativePath, previousMode: file.previousMode, currentMode: file.currentMode },
      });
    }

    const currentTarget = readCurrentSymlinkTarget(fullPath, deps);
    const previousTarget = readPreviousSymlinkTarget(workspacePath, baseCommit, previousPath, file.previousObjectId, deps);
    const currentTargetHash = targetHash(currentTarget);
    const previousTargetHash = targetHash(previousTarget);

    if (file.similarityScore === 100 && currentTarget === previousTarget && currentTargetHash === previousTargetHash) {
      return {
        fileKind: "SYMLINK",
        status: "RENAMED",
        renameKind: "PURE",
        path: relativePath,
        previousPath,
        previousObjectId: file.previousObjectId,
        similarityScore: 100,
        currentTarget,
        previousTarget,
        currentTargetHash,
        previousTargetHash,
      };
    }

    return {
      fileKind: "SYMLINK",
      status: "RENAMED",
      renameKind: "MODIFIED",
      path: relativePath,
      previousPath,
      previousObjectId: file.previousObjectId,
      similarityScore: file.similarityScore,
      currentTarget,
      previousTarget,
      currentTargetHash,
      previousTargetHash,
    };
  }

  const currentBytes = readCurrentFileBytes(fullPath, deps);
  const previousBytes = readPreviousBlobBytes(workspacePath, baseCommit, previousPath, file.previousObjectId, deps);
  const currentHash = sha256Hex(currentBytes);
  const previousHash = sha256Hex(previousBytes);
  const currentByteLength = currentBytes.length;
  const previousByteLength = previousBytes.length;
  const currentKind = classifyBytes(currentBytes, deps);
  const previousKind = classifyBytes(previousBytes, deps);

  if (currentKind === "BINARY" || previousKind === "BINARY") {
    if (file.similarityScore === 100 && currentHash === previousHash && currentByteLength === previousByteLength && file.currentMode === file.previousMode) {
      return {
        fileKind: "BINARY",
        status: "RENAMED",
        renameKind: "PURE",
        path: relativePath,
        previousPath,
        previousMode: file.previousMode,
        currentMode: file.currentMode,
        previousObjectId: file.previousObjectId,
        similarityScore: 100,
        previousHash,
        currentHash,
        previousByteLength,
        currentByteLength,
        reviewabilityLimited: true,
      };
    }

    return {
      fileKind: "BINARY",
      status: "RENAMED",
      renameKind: "MODIFIED",
      path: relativePath,
      previousPath,
      previousMode: file.previousMode,
      currentMode: file.currentMode,
      previousObjectId: file.previousObjectId,
      similarityScore: file.similarityScore,
      previousHash,
      currentHash,
      previousByteLength,
      currentByteLength,
      reviewabilityLimited: true,
    };
  }

  if (file.similarityScore === 100 && currentHash === previousHash && currentByteLength === previousByteLength && file.currentMode === file.previousMode) {
    return {
      fileKind: "TEXT",
      status: "RENAMED",
      renameKind: "PURE",
      path: relativePath,
      previousPath,
      previousMode: file.previousMode,
      currentMode: file.currentMode,
      previousObjectId: file.previousObjectId,
      similarityScore: 100,
      currentHash,
      previousHash,
      currentByteLength,
      previousByteLength,
    };
  }

  const currentContent = displayText(currentBytes);
  const patch = readRequiredPatch(workspacePath, baseCommit, relativePath, previousPath, deps);
  return {
    fileKind: "TEXT",
    status: "RENAMED",
    renameKind: "MODIFIED",
    path: relativePath,
    previousPath,
    previousMode: file.previousMode,
    currentMode: file.currentMode,
    previousObjectId: file.previousObjectId,
    similarityScore: file.similarityScore,
    patch,
    currentHash,
    previousHash,
    currentByteLength,
    previousByteLength,
    currentContent,
    currentContentTruncated: false,
  };
}

function collectEvidenceFile(
  file: ChangedFile,
  workspacePath: string,
  baseCommit: string,
  deps: EvidenceFileCollectorDeps,
): EvidenceFile {
  switch (file.status) {
    case "ADDED":
    case "UNTRACKED":
      return collectAddedOrUntracked(file, workspacePath, deps);
    case "MODIFIED":
      return collectModified(file, workspacePath, baseCommit, deps);
    case "DELETED":
      return collectDeleted(file, workspacePath, baseCommit, deps);
    case "RENAMED":
      return collectRenamed(file, workspacePath, baseCommit, deps);
  }
}

export function collectEvidenceFiles(
  input: EvidenceFileCollectorInput,
  deps: EvidenceFileCollectorDeps = {},
): readonly EvidenceFile[] {
  const workspacePath = validateNonEmptyString(input.workspacePath, "workspacePath");
  const baseCommit = validateNonEmptyString(input.baseCommit, "baseCommit");
  validateChangedFiles(input.changedFiles);

  return input.changedFiles.map((file) => collectEvidenceFile(file, workspacePath, baseCommit, deps));
}
