import type { ChangedFile, ChangedFileStatus } from "./git-change-detector.js";

export type PathViolationCode = "NOT_ALLOWED" | "FORBIDDEN";

export type PathConfigErrorCode =
  | "INVALID_ALLOWED_PATH"
  | "INVALID_FORBIDDEN_PATH"
  | "DUPLICATE_ALLOWED_PATH"
  | "DUPLICATE_FORBIDDEN_PATH";

export interface PathViolation {
  readonly path: string;
  readonly status: ChangedFileStatus;
  readonly code: PathViolationCode;
  readonly message: string;
  readonly previousPath?: string;
}

export interface PathValidationResult {
  readonly passed: boolean;
  readonly violations: readonly PathViolation[];
}

export class PathConfigError extends Error {
  readonly code: PathConfigErrorCode;
  readonly value: string;

  constructor(message: string, options: { code: PathConfigErrorCode; value: string }) {
    super(message);
    this.name = "PathConfigError";
    this.code = options.code;
    this.value = options.value;
  }
}

function validateConfigPath(
  value: unknown,
  fieldName: string,
  errorCode: "INVALID_ALLOWED_PATH" | "INVALID_FORBIDDEN_PATH",
): string {
  if (typeof value !== "string") {
    throw new PathConfigError(
      `${fieldName}: cada entrada debe ser un string.`,
      { code: errorCode, value: String(value) },
    );
  }

  if (value.length === 0) {
    throw new PathConfigError(
      `${fieldName}: la entrada no puede estar vacía.`,
      { code: errorCode, value },
    );
  }

  if (value.trim().length === 0) {
    throw new PathConfigError(
      `${fieldName}: la entrada no puede ser solo espacios en blanco.`,
      { code: errorCode, value },
    );
  }

  if (value.startsWith("/")) {
    throw new PathConfigError(
      `${fieldName}: la ruta no puede ser absoluta: ${value}`,
      { code: errorCode, value },
    );
  }

  if (value.startsWith("./")) {
    throw new PathConfigError(
      `${fieldName}: la ruta no puede empezar con "./": ${value}`,
      { code: errorCode, value },
    );
  }

  if (value.includes("\\")) {
    throw new PathConfigError(
      `${fieldName}: la ruta no puede contener backslash: ${value}`,
      { code: errorCode, value },
    );
  }

  if (value.includes("//")) {
    throw new PathConfigError(
      `${fieldName}: la ruta no puede contener "//": ${value}`,
      { code: errorCode, value },
    );
  }

  if (value === ".") {
    throw new PathConfigError(
      `${fieldName}: la ruta no puede ser ".".`,
      { code: errorCode, value },
    );
  }

  if (value.endsWith("/")) {
    throw new PathConfigError(
      `${fieldName}: la ruta no puede terminar con "/": ${value}`,
      { code: errorCode, value },
    );
  }

  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new PathConfigError(
        `${fieldName}: la ruta no puede contener "..": ${value}`,
        { code: errorCode, value },
      );
    }
  }

  return value;
}

function validateNoDuplicates(
  values: readonly string[],
  fieldName: string,
  errorCode: "DUPLICATE_ALLOWED_PATH" | "DUPLICATE_FORBIDDEN_PATH",
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new PathConfigError(
        `${fieldName}: valor duplicado: ${value}`,
        { code: errorCode, value },
      );
    }
    seen.add(value);
  }
}

function matchesRule(path: string, rule: string): boolean {
  return path === rule || path.startsWith(rule + "/");
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

function sortViolations(violations: PathViolation[]): PathViolation[] {
  return [...violations].sort((a, b) => {
    const pathCmp = compareLexicographic(a.path, b.path);
    if (pathCmp !== 0) return pathCmp;

    const codeCmp = compareLexicographic(a.code, b.code);
    if (codeCmp !== 0) return codeCmp;

    const statusCmp = compareLexicographic(a.status, b.status);
    if (statusCmp !== 0) return statusCmp;

    const prevA = a.previousPath ?? "";
    const prevB = b.previousPath ?? "";
    return compareLexicographic(prevA, prevB);
  });
}

function validateFile(
  file: ChangedFile,
  allowedPaths: readonly string[],
  forbiddenPaths: readonly string[],
): PathViolation[] {
  const violations: PathViolation[] = [];

  if (file.status === "RENAMED") {
    if (file.previousPath === undefined) {
      throw new PathConfigError(
        `ChangedFile con status RENAMED no tiene previousPath.`,
        { code: "INVALID_ALLOWED_PATH", value: file.path },
      );
    }

    const prevViolations = validateSinglePath(
      file.previousPath,
      file.status,
      allowedPaths,
      forbiddenPaths,
      file.previousPath,
    );
    violations.push(...prevViolations);

    const destViolations = validateSinglePath(
      file.path,
      file.status,
      allowedPaths,
      forbiddenPaths,
      file.previousPath,
    );
    violations.push(...destViolations);
  } else {
    if (file.previousPath !== undefined) {
      throw new PathConfigError(
        `ChangedFile con status ${file.status} tiene previousPath inesperado.`,
        { code: "INVALID_ALLOWED_PATH", value: file.path },
      );
    }

    const pathViolations = validateSinglePath(
      file.path,
      file.status,
      allowedPaths,
      forbiddenPaths,
      undefined,
    );
    violations.push(...pathViolations);
  }

  return violations;
}

function validateSinglePath(
  path: string,
  status: ChangedFileStatus,
  allowedPaths: readonly string[],
  forbiddenPaths: readonly string[],
  previousPath: string | undefined,
): PathViolation[] {
  const violations: PathViolation[] = [];

  for (const rule of forbiddenPaths) {
    if (matchesRule(path, rule)) {
      violations.push({
        path,
        status,
        code: "FORBIDDEN",
        message: `Path prohibido: ${path} coincide con la regla forbidden "${rule}".`,
        previousPath,
      });
      return violations;
    }
  }

  if (allowedPaths.length > 0) {
    let allowed = false;
    for (const rule of allowedPaths) {
      if (matchesRule(path, rule)) {
        allowed = true;
        break;
      }
    }

    if (!allowed) {
      violations.push({
        path,
        status,
        code: "NOT_ALLOWED",
        message: `Path no permitido: ${path} no coincide con ninguna regla allowed.`,
        previousPath,
      });
    }
  } else {
    violations.push({
      path,
      status,
      code: "NOT_ALLOWED",
      message: `Path no permitido: ${path} no coincide con ninguna regla allowed.`,
      previousPath,
    });
  }

  return violations;
}

export function validateChangedPaths(
  changedFiles: readonly ChangedFile[],
  allowedPaths: readonly string[],
  forbiddenPaths: readonly string[],
): PathValidationResult {
  for (const value of allowedPaths) {
    validateConfigPath(value, "allowedPaths", "INVALID_ALLOWED_PATH");
  }

  for (const value of forbiddenPaths) {
    validateConfigPath(value, "forbiddenPaths", "INVALID_FORBIDDEN_PATH");
  }

  validateNoDuplicates(allowedPaths, "allowedPaths", "DUPLICATE_ALLOWED_PATH");
  validateNoDuplicates(forbiddenPaths, "forbiddenPaths", "DUPLICATE_FORBIDDEN_PATH");

  const violations: PathViolation[] = [];

  for (const file of changedFiles) {
    const fileViolations = validateFile(file, allowedPaths, forbiddenPaths);
    violations.push(...fileViolations);
  }

  return {
    passed: violations.length === 0,
    violations: sortViolations(violations),
  };
}
