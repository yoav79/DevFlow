/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

export interface GitWorktreePreflightInput {
  repositoryRoot: string;
  baseCommit: string;
  branchName: string;
  workspacePath: string;
}

export interface GitWorktreePreflightResult {
  repositoryRoot: string;
  baseCommit: string;
  branchName: string;
  workspacePath: string;
}

export type GitWorktreePathKind =
  | "MISSING"
  | "FILE"
  | "DIRECTORY"
  | "SYMLINK";

export type GitWorktreePhysicalState =
  | "CLEAN"
  | "RECOVERABLE"
  | "COMPLETE"
  | "INCONSISTENT"
  | "MANUAL_INTERVENTION";

export interface InspectGitWorktreeStateInput {
  repositoryRoot: string;
  baseCommit: string;
  branchName: string;
  workspacePath: string;
}

export interface GitWorktreeInspectionResult {
  state: GitWorktreePhysicalState;
  repositoryRoot: string;
  baseCommit: string;
  branchName: string;
  workspacePath: string;
  branchExists: boolean;
  pathKind: GitWorktreePathKind;
  worktreeRegistered: boolean;
  headMatchesBaseCommit: boolean | null;
  branchMatchesExpected: boolean | null;
  detached: boolean | null;
  locked: boolean;
  prunable: boolean;
}

export class GitWorktreeError extends Error {
  readonly repositoryRoot: string;
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly branchName?: string;
  readonly workspacePath?: string;
  readonly baseCommit?: string;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      repositoryRoot: string;
      command?: string;
      exitCode?: number | null;
      branchName?: string;
      workspacePath?: string;
      baseCommit?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "GitWorktreeError";
    this.repositoryRoot = options.repositoryRoot;
    this.command = options.command;
    this.exitCode = options.exitCode;
    this.branchName = options.branchName;
    this.workspacePath = options.workspacePath;
    this.baseCommit = options.baseCommit;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function runGitCommand(repositoryRoot: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error !== undefined) {
    throw new GitWorktreeError("No se pudo ejecutar Git para validar el worktree: " + repositoryRoot, {
      repositoryRoot,
      command: args.join(" "),
      cause: result.error,
    });
  }

  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
  };
}

function normalizeRepositoryRoot(repositoryRoot: string): string {
  const trimmed = repositoryRoot.trim();

  if (trimmed.length === 0) {
    throw new GitWorktreeError("La ruta del repositorio no puede estar vacía.", {
      repositoryRoot,
    });
  }

  const resolved = resolve(trimmed);

  try {
    if (!existsSync(resolved)) {
      throw new GitWorktreeError(`No existe la ruta del repositorio: ${resolved}`, {
        repositoryRoot: resolved,
      });
    }

    const stat = lstatSync(resolved);
    if (!stat.isDirectory()) {
      throw new GitWorktreeError(`La ruta del repositorio no es un directorio: ${resolved}`, {
        repositoryRoot: resolved,
      });
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) {
      throw error;
    }

    throw new GitWorktreeError(`No se pudo inspeccionar la ruta del repositorio: ${resolved}`, {
      repositoryRoot: resolved,
      cause: error,
    });
  }

  return resolved;
}

function validateBaseCommit(repositoryRoot: string, baseCommit: string): string {
  const trimmed = baseCommit.trim();

  if (trimmed.length === 0) {
    throw new GitWorktreeError("El commit base no puede estar vacío.", {
      repositoryRoot,
      baseCommit,
    });
  }

  if (!COMMIT_SHA_PATTERN.test(trimmed)) {
    throw new GitWorktreeError(`El commit base no es un SHA hexadecimal minúsculo de 40 caracteres: ${trimmed}`, {
      repositoryRoot,
      baseCommit: trimmed,
    });
  }

  const result = runGitCommand(repositoryRoot, ["rev-parse", "--verify", "--end-of-options", `${trimmed}^{commit}`]);

  if (result.status === null) {
    throw new GitWorktreeError(`No se pudo ejecutar Git para validar el worktree: ${repositoryRoot}`, {
      repositoryRoot,
      command: `rev-parse --verify --end-of-options ${trimmed}^{commit}`,
      baseCommit: trimmed,
    });
  }

  if (result.status !== 0) {
    throw new GitWorktreeError(`El commit base no existe en el repositorio: ${trimmed}`, {
      repositoryRoot,
      command: `rev-parse --verify --end-of-options ${trimmed}^{commit}`,
      exitCode: result.status,
      baseCommit: trimmed,
    });
  }

  const resolvedBaseCommit = result.stdout.trim();

  if (!COMMIT_SHA_PATTERN.test(resolvedBaseCommit)) {
    throw new GitWorktreeError(`Git devolvió un commit base inválido para el repositorio: ${repositoryRoot}`, {
      repositoryRoot,
      command: `rev-parse --verify --end-of-options ${trimmed}^{commit}`,
      exitCode: result.status,
      baseCommit: trimmed,
    });
  }

  return resolvedBaseCommit;
}

function normalizeBranchName(repositoryRoot: string, branchName: string): string {
  const trimmed = branchName.trim();

  if (trimmed.length === 0) {
    throw new GitWorktreeError("El nombre de la rama no puede estar vacío.", {
      repositoryRoot,
      branchName: branchName,
    });
  }

  return trimmed;
}

function validateBranchAbsent(repositoryRoot: string, branchName: string): void {
  const result = runGitCommand(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);

  if (result.status === null) {
    throw new GitWorktreeError(`No se pudo ejecutar Git para validar el worktree: ${repositoryRoot}`, {
      repositoryRoot,
      command: `show-ref --verify --quiet refs/heads/${branchName}`,
      branchName,
    });
  }

  if (result.status === 0) {
    throw new GitWorktreeError(`La rama ya existe: ${branchName}`, {
      repositoryRoot,
      command: `show-ref --verify --quiet refs/heads/${branchName}`,
      exitCode: result.status,
      branchName,
    });
  }

  if (result.status !== 1) {
    throw new GitWorktreeError(`No se pudo comprobar la rama Git: ${branchName}`, {
      repositoryRoot,
      command: `show-ref --verify --quiet refs/heads/${branchName}`,
      exitCode: result.status,
      branchName,
    });
  }
}

function normalizeWorkspacePath(repositoryRoot: string, workspacePath: string): string {
  const trimmed = workspacePath.trim();

  if (trimmed.length === 0) {
    throw new GitWorktreeError("La ruta del workspace no puede estar vacía.", {
      repositoryRoot,
      workspacePath,
    });
  }

  return resolve(trimmed);
}

function validateWorkspacePathAbsent(repositoryRoot: string, workspacePath: string): void {
  if (existsSync(workspacePath)) {
    throw new GitWorktreeError(`La ruta del workspace ya existe: ${workspacePath}`, {
      repositoryRoot,
      workspacePath,
    });
  }
}

interface ParsedWorktreeEntry {
  readonly worktreePath: string;
  readonly head: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly lockedReason: string | null;
  readonly prunable: boolean;
  readonly prunableReason: string | null;
}

function parseWorktreeListPorcelain(repositoryRoot: string, stdout: string): ParsedWorktreeEntry[] {
  const normalized = stdout.replace(/\r\n/g, "\n");

  if (normalized.trim().length === 0) {
    throw new GitWorktreeError(`Git devolvió una salida inválida al listar worktrees del repositorio: ${repositoryRoot}`, {
      repositoryRoot,
      command: "worktree list --porcelain",
    });
  }

  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of normalized.split("\n")) {
    if (line.trim().length === 0) {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }

      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current);
  }

  if (blocks.length === 0) {
    throw new GitWorktreeError(`Git devolvió una salida inválida al listar worktrees del repositorio: ${repositoryRoot}`, {
      repositoryRoot,
      command: "worktree list --porcelain",
    });
  }

  const entries: ParsedWorktreeEntry[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    let worktreePath: string | undefined;
    let head: string | undefined;
    let branch: string | null = null;
    let detached = false;
    let locked = false;
    let lockedReason: string | null = null;
    let prunable = false;
    let prunableReason: string | null = null;
    let worktreeCount = 0;
    let headCount = 0;
    let branchCount = 0;
    let detachedCount = 0;

    for (const line of block) {
      if (line.startsWith("worktree ")) {
        worktreeCount += 1;
        if (worktreeCount > 1) {
          throw new GitWorktreeError(`Git devolvió una salida inválida al listar worktrees del repositorio: ${repositoryRoot}`, {
            repositoryRoot,
            command: "worktree list --porcelain",
          });
        }

        const value = line.slice("worktree ".length);
        if (value.trim().length === 0) {
          throw new GitWorktreeError(`Git devolvió una salida inválida al listar worktrees del repositorio: ${repositoryRoot}`, {
            repositoryRoot,
            command: "worktree list --porcelain",
          });
        }

        worktreePath = resolve(value);
        continue;
      }

      if (line.startsWith("HEAD ")) {
        headCount += 1;
        if (headCount > 1) {
          throw new GitWorktreeError(`Git devolvió una salida inválida al listar worktrees del repositorio: ${repositoryRoot}`, {
            repositoryRoot,
            command: "worktree list --porcelain",
          });
        }

        const value = line.slice("HEAD ".length).trim();
        if (!COMMIT_SHA_PATTERN.test(value)) {
          throw new GitWorktreeError(`Git devolvió una salida inválida al listar worktrees del repositorio: ${repositoryRoot}`, {
            repositoryRoot,
            command: "worktree list --porcelain",
          });
        }

        head = value;
        continue;
      }

      if (line === "detached") {
        detachedCount += 1;
        if (detachedCount > 1) {
          throw new GitWorktreeError(`Git devolvió una salida inválida al listar worktrees del repositorio: ${repositoryRoot}`, {
            repositoryRoot,
            command: "worktree list --porcelain",
          });
        }
        detached = true;
        continue;
      }

      if (line.startsWith("branch ")) {
        branchCount += 1;
        if (branchCount > 1) {
          throw new GitWorktreeError(`Git devolvió una salida inválida al listar worktrees del repositorio: ${repositoryRoot}`, {
            repositoryRoot,
            command: "worktree list --porcelain",
          });
        }
        const value = line.slice("branch ".length).trim();
        branch = value.length > 0 ? value : null;
        continue;
      }

      if (line === "locked" || line.startsWith("locked ")) {
        locked = true;
        if (line.startsWith("locked ") && line.slice("locked ".length).trim().length > 0) {
          lockedReason = line.slice("locked ".length).trim();
        }
        continue;
      }

      if (line === "prunable" || line.startsWith("prunable ")) {
        prunable = true;
        if (line.startsWith("prunable ") && line.slice("prunable ".length).trim().length > 0) {
          prunableReason = line.slice("prunable ".length).trim();
        }
        continue;
      }

      // Future porcelain metadata is allowed as long as worktree and HEAD are present.
    }

    if (worktreeCount !== 1 || headCount !== 1 || worktreePath === undefined || head === undefined) {
      throw new GitWorktreeError(`Git devolvió una salida inválida al listar worktrees del repositorio: ${repositoryRoot}`, {
        repositoryRoot,
        command: "worktree list --porcelain",
      });
    }

    if (seen.has(worktreePath)) {
      throw new GitWorktreeError(`Git devolvió una salida inválida al listar worktrees del repositorio: ${repositoryRoot}`, {
        repositoryRoot,
        command: "worktree list --porcelain",
      });
    }

    seen.add(worktreePath);
    entries.push({ worktreePath, head, branch, detached, locked, lockedReason, prunable, prunableReason });
  }

  return entries;
}

function validateWorkspaceNotRegistered(repositoryRoot: string, workspacePath: string): void {
  const result = runGitCommand(repositoryRoot, ["worktree", "list", "--porcelain"]);

  if (result.status === null) {
    throw new GitWorktreeError(`No se pudo ejecutar Git para validar el worktree: ${repositoryRoot}`, {
      repositoryRoot,
      command: "worktree list --porcelain",
    });
  }

  if (result.status !== 0) {
    throw new GitWorktreeError(`No se pudieron listar los worktrees del repositorio: ${repositoryRoot}`, {
      repositoryRoot,
      command: "worktree list --porcelain",
      exitCode: result.status,
    });
  }

  const entries = parseWorktreeListPorcelain(repositoryRoot, result.stdout);

  for (const entry of entries) {
    if (resolve(entry.worktreePath) === workspacePath) {
      throw new GitWorktreeError(`Ya existe un worktree registrado en la ruta: ${workspacePath}`, {
        repositoryRoot,
        command: "worktree list --porcelain",
        workspacePath,
      });
    }
  }
}

export function preflightGitWorktree(input: GitWorktreePreflightInput): GitWorktreePreflightResult {
  const repositoryRoot = normalizeRepositoryRoot(input.repositoryRoot);
  const baseCommit = validateBaseCommit(repositoryRoot, input.baseCommit);
  const branchName = normalizeBranchName(repositoryRoot, input.branchName);
  const workspacePath = normalizeWorkspacePath(repositoryRoot, input.workspacePath);

  validateBranchAbsent(repositoryRoot, branchName);
  validateWorkspaceNotRegistered(repositoryRoot, workspacePath);
  validateWorkspacePathAbsent(repositoryRoot, workspacePath);

  // The preflight does not eliminate races; createGitWorktree must still handle real Git conflicts.
  return {
    repositoryRoot,
    baseCommit,
    branchName,
    workspacePath,
  };
}

function isWorktreePathRegistered(repositoryRoot: string, workspacePath: string): boolean {
  const result = runGitCommand(repositoryRoot, ["worktree", "list", "--porcelain"]);

  if (result.status !== 0) {
    return false;
  }

  const entries = parseWorktreeListPorcelain(repositoryRoot, result.stdout);

  for (const entry of entries) {
    if (resolve(entry.worktreePath) === workspacePath) {
      return true;
    }
  }

  return false;
}

// createGitWorktree is the first write operation. The preflight does not prevent
// race conditions; the Git command remains the authority. Residues are reported
// and will be reconciled in a subsequent task.
export function createGitWorktree(
  input: GitWorktreePreflightInput,
): GitWorktreePreflightResult {
  const { repositoryRoot, baseCommit, branchName, workspacePath } =
    preflightGitWorktree(input);

  const command = `worktree add -b ${branchName} ${workspacePath} ${baseCommit}`;

  const result = spawnSync(
    "git",
    [
      "-C",
      repositoryRoot,
      "worktree",
      "add",
      "-b",
      branchName,
      workspacePath,
      baseCommit,
    ],
    {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  if (result.error !== undefined) {
    const originalError = result.error;

    try {
      const branchExists =
        runGitCommand(repositoryRoot, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branchName}`,
        ]).status === 0;
      const pathCreated = existsSync(workspacePath);
      const worktreeRegistered = isWorktreePathRegistered(
        repositoryRoot,
        workspacePath,
      );

      if (branchExists || pathCreated || worktreeRegistered) {
        throw new GitWorktreeError(
          `Se detectó un estado residual tras fallar la creación del worktree: ${workspacePath}`,
          {
            repositoryRoot,
            command,
            branchName,
            workspacePath,
            baseCommit,
            cause: originalError,
          },
        );
      }
    } catch (residueError) {
      if (residueError instanceof GitWorktreeError) {
        throw residueError;
      }
    }

    throw new GitWorktreeError(
      `No se pudo ejecutar Git para crear el worktree: ${repositoryRoot}`,
      {
        repositoryRoot,
        command,
        branchName,
        workspacePath,
        baseCommit,
        cause: originalError,
      },
    );
  }

  if (result.status !== 0) {
    const exitCode = result.status;

    try {
      const branchExists =
        runGitCommand(repositoryRoot, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branchName}`,
        ]).status === 0;
      const pathCreated = existsSync(workspacePath);
      const worktreeRegistered = isWorktreePathRegistered(
        repositoryRoot,
        workspacePath,
      );

      if (branchExists || pathCreated || worktreeRegistered) {
        throw new GitWorktreeError(
          `Se detectó un estado residual tras fallar la creación del worktree: ${workspacePath}`,
          {
            repositoryRoot,
            command,
            exitCode,
            branchName,
            workspacePath,
            baseCommit,
          },
        );
      }
    } catch (residueError) {
      if (residueError instanceof GitWorktreeError) {
        throw residueError;
      }
    }

    throw new GitWorktreeError(
      `Git devolvió un código de salida distinto de 0 al crear el worktree: ${repositoryRoot}`,
      {
        repositoryRoot,
        command,
        exitCode,
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  try {
    const stat = lstatSync(workspacePath);

    if (!stat.isDirectory()) {
      throw new GitWorktreeError(
        `La ruta del worktree no es un directorio: ${workspacePath}`,
        {
          repositoryRoot,
          command,
          branchName,
          workspacePath,
          baseCommit,
        },
      );
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) {
      throw error;
    }

    throw new GitWorktreeError(
      `La ruta del worktree no fue creada: ${workspacePath}`,
      {
        repositoryRoot,
        command,
        branchName,
        workspacePath,
        baseCommit,
        cause: error,
      },
    );
  }

  if (!isWorktreePathRegistered(repositoryRoot, workspacePath)) {
    throw new GitWorktreeError(
      `El worktree no está registrado en el repositorio: ${workspacePath}`,
      {
        repositoryRoot,
        command,
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  const headResult = spawnSync(
    "git",
    ["-C", workspacePath, "rev-parse", "--verify", "HEAD"],
    {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  if (headResult.error !== undefined) {
    throw new GitWorktreeError(
      `No se pudo ejecutar Git para validar el worktree creado: ${workspacePath}`,
      {
        repositoryRoot,
        command,
        branchName,
        workspacePath,
        baseCommit,
        cause: headResult.error,
      },
    );
  }

  if (headResult.status !== 0) {
    throw new GitWorktreeError(
      `Git devolvió una salida inválida al validar el worktree creado: ${repositoryRoot}`,
      {
        repositoryRoot,
        command,
        exitCode: headResult.status,
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  const worktreeHead = headResult.stdout.trim().toLowerCase();

  if (!COMMIT_SHA_PATTERN.test(worktreeHead)) {
    throw new GitWorktreeError(
      `Git devolvió una salida inválida al validar el worktree creado: ${repositoryRoot}`,
      {
        repositoryRoot,
        command,
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  if (worktreeHead !== baseCommit) {
    throw new GitWorktreeError(
      `El HEAD del worktree no coincide con el commit base: ${workspacePath}`,
      {
        repositoryRoot,
        command,
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  const branchResult = spawnSync(
    "git",
    ["-C", workspacePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  if (branchResult.error !== undefined) {
    throw new GitWorktreeError(
      `No se pudo ejecutar Git para validar el worktree creado: ${workspacePath}`,
      {
        repositoryRoot,
        command,
        branchName,
        workspacePath,
        baseCommit,
        cause: branchResult.error,
      },
    );
  }

  if (branchResult.status !== 0) {
    throw new GitWorktreeError(
      `Git devolvió una salida inválida al validar el worktree creado: ${repositoryRoot}`,
      {
        repositoryRoot,
        command,
        exitCode: branchResult.status,
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  const worktreeBranch = branchResult.stdout.trim();

  if (worktreeBranch.length === 0) {
    throw new GitWorktreeError(
      `Git devolvió una salida inválida al validar el worktree creado: ${repositoryRoot}`,
      {
        repositoryRoot,
        command,
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  if (worktreeBranch !== branchName) {
    throw new GitWorktreeError(
      `La rama del worktree no coincide con la rama esperada: ${workspacePath}`,
      {
        repositoryRoot,
        command,
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  return {
    repositoryRoot,
    baseCommit,
    branchName,
    workspacePath,
  };
}

function classifyWorktreeState(
  branchExists: boolean,
  pathKind: GitWorktreePathKind,
  worktreeRegistered: boolean,
  headMatchesBaseCommit: boolean | null,
  branchMatchesExpected: boolean | null,
  detached: boolean | null,
  locked: boolean,
  prunable: boolean,
): GitWorktreePhysicalState {
  if (pathKind === "FILE" || pathKind === "SYMLINK" || locked) {
    return "MANUAL_INTERVENTION";
  }

  if (!branchExists && pathKind === "MISSING" && !worktreeRegistered) {
    return "CLEAN";
  }

  if (
    branchExists
    && pathKind === "DIRECTORY"
    && worktreeRegistered
    && headMatchesBaseCommit === true
    && branchMatchesExpected === true
    && detached === false
    && !prunable
    && !locked
  ) {
    return "COMPLETE";
  }

  if (
    worktreeRegistered
    && pathKind !== "DIRECTORY"
    && !prunable
  ) {
    return "INCONSISTENT";
  }

  if (headMatchesBaseCommit === false) {
    return "INCONSISTENT";
  }

  if (branchMatchesExpected === false) {
    return "INCONSISTENT";
  }

  if (detached === true) {
    return "INCONSISTENT";
  }

  if (
    !branchExists
    && worktreeRegistered
    && branchMatchesExpected !== null
    && branchMatchesExpected
  ) {
    return "INCONSISTENT";
  }

  return "RECOVERABLE";
}

export function inspectGitWorktreeState(
  input: InspectGitWorktreeStateInput,
): GitWorktreeInspectionResult {
  const repositoryRoot = normalizeRepositoryRoot(input.repositoryRoot);
  const baseCommit = validateBaseCommit(repositoryRoot, input.baseCommit);
  const branchName = normalizeBranchName(repositoryRoot, input.branchName);
  const workspacePath = normalizeWorkspacePath(repositoryRoot, input.workspacePath);

  const branchResult = runGitCommand(repositoryRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branchName}`,
  ]);

  if (branchResult.status === null) {
    throw new GitWorktreeError(
      `No se pudo ejecutar Git para inspeccionar el estado del worktree: ${repositoryRoot}`,
      {
        repositoryRoot,
        command: `show-ref --verify --quiet refs/heads/${branchName}`,
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  if (branchResult.status !== 0 && branchResult.status !== 1) {
    throw new GitWorktreeError(
      `No se pudo ejecutar Git para inspeccionar el estado del worktree: ${repositoryRoot}`,
      {
        repositoryRoot,
        command: `show-ref --verify --quiet refs/heads/${branchName}`,
        exitCode: branchResult.status,
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  const branchExists = branchResult.status === 0;

  let pathKind: GitWorktreePathKind = "MISSING";

  try {
    const stat = lstatSync(workspacePath);

    if (stat.isDirectory()) {
      pathKind = "DIRECTORY";
    } else if (stat.isSymbolicLink()) {
      pathKind = "SYMLINK";
    } else if (stat.isFile()) {
      pathKind = "FILE";
    } else {
      pathKind = "FILE";
    }
  } catch {
    pathKind = "MISSING";
  }

  const worktreeListResult = runGitCommand(repositoryRoot, [
    "worktree",
    "list",
    "--porcelain",
  ]);

  if (worktreeListResult.status === null) {
    throw new GitWorktreeError(
      `No se pudo ejecutar Git para inspeccionar el estado del worktree: ${repositoryRoot}`,
      {
        repositoryRoot,
        command: "worktree list --porcelain",
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  if (worktreeListResult.status !== 0) {
    throw new GitWorktreeError(
      `No se pudo ejecutar Git para inspeccionar el estado del worktree: ${repositoryRoot}`,
      {
        repositoryRoot,
        command: "worktree list --porcelain",
        exitCode: worktreeListResult.status,
        branchName,
        workspacePath,
        baseCommit,
      },
    );
  }

  let entries: ParsedWorktreeEntry[];

  try {
    entries = parseWorktreeListPorcelain(repositoryRoot, worktreeListResult.stdout);
  } catch (error) {
    if (error instanceof GitWorktreeError) {
      throw new GitWorktreeError(
        `Git devolvió una salida inválida al inspeccionar el estado del worktree: ${repositoryRoot}`,
        {
          repositoryRoot,
          command: "worktree list --porcelain",
          branchName,
          workspacePath,
          baseCommit,
          cause: error,
        },
      );
    }

    throw error;
  }

  let worktreeRegistered = false;
  let locked = false;
  let prunable = false;

  for (const entry of entries) {
    if (resolve(entry.worktreePath) === workspacePath) {
      worktreeRegistered = true;
      locked = entry.locked;
      prunable = entry.prunable;
      break;
    }
  }

  let headMatchesBaseCommit: boolean | null = null;
  let branchMatchesExpected: boolean | null = null;
  let detached: boolean | null = null;

  if (pathKind === "DIRECTORY" && worktreeRegistered) {
    const headResult = spawnSync(
      "git",
      ["-C", workspacePath, "rev-parse", "--verify", "HEAD"],
      {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    if (headResult.error !== undefined || headResult.status !== 0) {
      throw new GitWorktreeError(
        `Git devolvió una salida inválida al inspeccionar el estado del worktree: ${workspacePath}`,
        {
          repositoryRoot,
          command: "rev-parse --verify HEAD",
          exitCode: headResult.status,
          branchName,
          workspacePath,
          baseCommit,
          cause: headResult.error,
        },
      );
    }

    const worktreeHead = headResult.stdout.trim().toLowerCase();

    if (!COMMIT_SHA_PATTERN.test(worktreeHead)) {
      throw new GitWorktreeError(
        `Git devolvió una salida inválida al inspeccionar el estado del worktree: ${workspacePath}`,
        {
          repositoryRoot,
          command: "rev-parse --verify HEAD",
          branchName,
          workspacePath,
          baseCommit,
        },
      );
    }

    headMatchesBaseCommit = worktreeHead === baseCommit;

    const symbolicRefResult = spawnSync(
      "git",
      ["-C", workspacePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
      {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    if (symbolicRefResult.error !== undefined) {
      throw new GitWorktreeError(
        `No se pudo ejecutar Git para inspeccionar el estado del worktree: ${workspacePath}`,
        {
          repositoryRoot,
          command: "symbolic-ref --quiet --short HEAD",
          branchName,
          workspacePath,
          baseCommit,
          cause: symbolicRefResult.error,
        },
      );
    }

    if (symbolicRefResult.status === 0) {
      const activeBranch = symbolicRefResult.stdout.trim();
      detached = false;
      branchMatchesExpected = activeBranch === branchName;
    } else if (symbolicRefResult.status === 1) {
      detached = true;
      branchMatchesExpected = false;
    } else {
      throw new GitWorktreeError(
        `No se pudo ejecutar Git para inspeccionar el estado del worktree: ${workspacePath}`,
        {
          repositoryRoot,
          command: "symbolic-ref --quiet --short HEAD",
          exitCode: symbolicRefResult.status,
          branchName,
          workspacePath,
          baseCommit,
        },
      );
    }

    for (const entry of entries) {
      if (resolve(entry.worktreePath) === workspacePath && entry.detached && !detached) {
        return {
          state: "INCONSISTENT",
          repositoryRoot,
          baseCommit,
          branchName,
          workspacePath,
          branchExists,
          pathKind,
          worktreeRegistered,
          headMatchesBaseCommit,
          branchMatchesExpected,
          detached,
          locked,
          prunable,
        };
      }
    }
  }

  const state = classifyWorktreeState(
    branchExists,
    pathKind,
    worktreeRegistered,
    headMatchesBaseCommit,
    branchMatchesExpected,
    detached,
    locked,
    prunable,
  );

  return {
    state,
    repositoryRoot,
    baseCommit,
    branchName,
    workspacePath,
    branchExists,
    pathKind,
    worktreeRegistered,
    headMatchesBaseCommit,
    branchMatchesExpected,
    detached,
    locked,
    prunable,
  };
}
