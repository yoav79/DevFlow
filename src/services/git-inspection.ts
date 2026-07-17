/// <reference types="node" />

import { spawnSync } from "node:child_process";

export interface GitInspectionResult {
  readonly isGitRepository: boolean;
  readonly gitDirectoryPath: string | null;
  readonly isHeadPresent: boolean;
}

export class GitInspectionError extends Error {
  readonly field?: string;
  readonly value?: unknown;

  constructor(
    message: string,
    options?: { field?: string; value?: unknown; cause?: unknown },
  ) {
    super(message);
    this.name = "GitInspectionError";
    this.field = options?.field;
    this.value = options?.value;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function runGitCommand(repositoryPath: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
  });

  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
  };
}

export function inspectGitRepository(repositoryPath: string): GitInspectionResult {
  if (typeof repositoryPath !== "string") {
    throw new GitInspectionError(
      "El repositoryPath debe ser una cadena de texto.",
      { field: "repositoryPath", value: repositoryPath },
    );
  }

  if (repositoryPath.trim().length === 0) {
    throw new GitInspectionError(
      "El repositoryPath no puede estar vacío.",
      { field: "repositoryPath", value: repositoryPath },
    );
  }

  const gitDirResult = runGitCommand(repositoryPath, ["rev-parse", "--git-dir"]);

  if (gitDirResult.status !== 0) {
    return {
      isGitRepository: false,
      gitDirectoryPath: null,
      isHeadPresent: false,
    };
  }

  const headResult = runGitCommand(repositoryPath, ["rev-parse", "--verify", "HEAD"]);

  return {
    isGitRepository: true,
    gitDirectoryPath: gitDirResult.stdout,
    isHeadPresent: headResult.status === 0,
  };
}
