/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, lstatSync } from "node:fs";

export interface GitRepositoryInspection {
  readonly repositoryRoot: string;
  readonly baseCommit: string;
}

export class GitInspectionError extends Error {
  readonly repositoryPath: string;
  readonly command?: string;
  readonly exitCode?: number | null;

  constructor(
    message: string,
    options: {
      repositoryPath: string;
      command?: string;
      exitCode?: number | null;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "GitInspectionError";
    this.repositoryPath = options.repositoryPath;
    this.command = options.command;
    this.exitCode = options.exitCode;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

const HEAD_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function runGitCommand(resolvedPath: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("git", ["-C", resolvedPath, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error !== undefined) {
    throw new GitInspectionError(
      `No se pudo ejecutar Git para inspeccionar el repositorio: ${resolvedPath}`,
      { repositoryPath: resolvedPath, command: args.join(" "), cause: result.error },
    );
  }

  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
  };
}

export function inspectGitRepository(repositoryPath: string): GitRepositoryInspection {
  const trimmed = repositoryPath.trim();

  if (trimmed.length === 0) {
    throw new GitInspectionError(
      "La ruta del repositorio no puede estar vacía.",
      { repositoryPath },
    );
  }

  const resolvedPath = resolve(trimmed);

  if (!existsSync(resolvedPath)) {
    throw new GitInspectionError(
      `No existe la ruta del repositorio: ${resolvedPath}`,
      { repositoryPath: resolvedPath },
    );
  }

  const stat = lstatSync(resolvedPath);

  if (!stat.isDirectory()) {
    throw new GitInspectionError(
      `La ruta del repositorio no es un directorio: ${resolvedPath}`,
      { repositoryPath: resolvedPath },
    );
  }

  const rootResult = runGitCommand(resolvedPath, ["rev-parse", "--show-toplevel"]);

  if (rootResult.status !== 0) {
    throw new GitInspectionError(
      `La ruta no corresponde a un repositorio Git válido: ${resolvedPath}`,
      { repositoryPath: resolvedPath, command: "rev-parse --show-toplevel", exitCode: rootResult.status },
    );
  }

  if (rootResult.stdout.length === 0) {
    throw new GitInspectionError(
      `Git no devolvió la raíz del repositorio: ${resolvedPath}`,
      { repositoryPath: resolvedPath, command: "rev-parse --show-toplevel", exitCode: rootResult.status },
    );
  }

  const repositoryRoot = resolve(rootResult.stdout);

  const commitResult = runGitCommand(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);

  if (commitResult.status !== 0) {
    throw new GitInspectionError(
      `El repositorio no tiene un commit HEAD válido: ${repositoryRoot}`,
      { repositoryPath: resolvedPath, command: "rev-parse --verify HEAD", exitCode: commitResult.status },
    );
  }

  const baseCommit = commitResult.stdout.toLowerCase();

  if (!HEAD_COMMIT_PATTERN.test(baseCommit)) {
    throw new GitInspectionError(
      `Git devolvió un commit base inválido para el repositorio: ${repositoryRoot}`,
      { repositoryPath: resolvedPath, command: "rev-parse --verify HEAD", exitCode: commitResult.status },
    );
  }

  return { repositoryRoot, baseCommit };
}
