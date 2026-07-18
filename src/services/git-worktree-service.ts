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
    let worktreeCount = 0;
    let headCount = 0;

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

      if (
        line === "detached"
        || line === "locked"
        || line.startsWith("locked ")
        || line === "prunable"
        || line.startsWith("prunable ")
        || line.startsWith("branch ")
      ) {
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
    entries.push({ worktreePath, head });
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
