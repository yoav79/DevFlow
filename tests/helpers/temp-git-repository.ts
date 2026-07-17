import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { createTempDirectory } from "./temp-directory.js";

export interface TempGitRepository {
  path: string;
  cleanup(): void;
  runGit(args: string[]): string;
}

function runGitCommand(repositoryPath: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
  });

  if (result.error !== undefined) {
    throw new Error(`No se pudo ejecutar git: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const details = stderr.length > 0 ? stderr : stdout;
    throw new Error(`Git falló ejecutando ${args.join(" ")}${details.length > 0 ? `: ${details}` : ""}`);
  }

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

export function createTempGitRepository(): TempGitRepository {
  const directory = createTempDirectory("devflow-git-test");
  let cleaned = false;

  try {
    runGitCommand(directory.path, ["init"]);
    runGitCommand(directory.path, ["config", "user.name", "DevFlow Test"]);
    runGitCommand(directory.path, ["config", "user.email", "devflow-test@example.invalid"]);
    runGitCommand(directory.path, ["branch", "-M", "main"]);
    writeFileSync(join(directory.path, "README.md"), "# DevFlow Test\n");
    runGitCommand(directory.path, ["add", "README.md"]);
    runGitCommand(directory.path, ["commit", "-m", "init"]);

    const status = runGitCommand(directory.path, ["status", "--short"]);

    if (status.stdout.length > 0) {
      throw new Error(`El working tree no está limpio: ${status.stdout}`);
    }
  } catch (error) {
    directory.cleanup();

    if (error instanceof Error) {
      throw new Error(`No se pudo crear el repositorio temporal: ${error.message}`);
    }

    throw new Error("No se pudo crear el repositorio temporal.");
  }

  return {
    path: directory.path,
    cleanup(): void {
      if (cleaned) {
        return;
      }

      cleaned = true;
      directory.cleanup();
    },
    runGit(args: string[]): string {
      return runGitCommand(directory.path, args).stdout;
    },
  };
}
