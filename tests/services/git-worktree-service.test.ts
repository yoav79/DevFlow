import { writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createTempDirectory } from "../helpers/temp-directory.js";
import { createTempGitRepository } from "../helpers/temp-git-repository.js";
import { GitWorktreeError, preflightGitWorktree } from "../../src/services/git-worktree-service.js";

function expectWorktreeError(action: () => unknown, message: string): void {
  try {
    action();
    throw new Error("Expected GitWorktreeError.");
  } catch (error) {
    expect(error).toBeInstanceOf(GitWorktreeError);
    expect((error as GitWorktreeError).message).toBe(message);
  }
}

function expectWorktreeErrorWithCause(action: () => unknown, message: string): GitWorktreeError {
  try {
    action();
    throw new Error("Expected GitWorktreeError.");
  } catch (error) {
    expect(error).toBeInstanceOf(GitWorktreeError);
    expect((error as GitWorktreeError).message).toBe(message);
    return error as GitWorktreeError;
  }
}

function createGitShim(options: { worktreeListOutput?: string; showRefExitCode?: number } = {}): { path: string; cleanup(): void } {
  const dir = createTempDirectory("devflow-git-shim");
  const realGitResult = spawnSync("sh", ["-lc", "command -v git"], { encoding: "utf8" });

  if (realGitResult.status !== 0) {
    dir.cleanup();
    throw new Error("No se pudo localizar el binario real de git.");
  }

  const realGit = realGitResult.stdout.trim();
  const scriptPath = join(dir.path, "git");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
if [ "$1" = "-C" ] && [ "$3" = "worktree" ] && [ "$4" = "list" ] && [ "$5" = "--porcelain" ]; then
  printf '%s' ${JSON.stringify(options.worktreeListOutput ?? "")}
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "show-ref" ] && [ "$4" = "--verify" ] && [ "$5" = "--quiet" ]; then
  exit ${options.showRefExitCode ?? 1}
fi
exec ${JSON.stringify(realGit)} "$@"
`,
  );
  chmodSync(scriptPath, 0o755);

  return {
    path: dir.path,
    cleanup(): void {
      dir.cleanup();
    },
  };
}

function withGitShim<T>(shim: { path: string; cleanup(): void }, action: () => T): T {
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${shim.path}:${previousPath}`;

  try {
    return action();
  } finally {
    process.env.PATH = previousPath;
    shim.cleanup();
  }
}

describe("git worktree service", () => {
  describe("repository root", () => {
    it("rejects empty repositoryRoot", () => {
      expectWorktreeError(
        () => preflightGitWorktree({
          repositoryRoot: "   ",
          baseCommit: "0".repeat(40),
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath: "/tmp/devflow/worktrees/project-a/TASK-001/1",
        }),
        "La ruta del repositorio no puede estar vacía.",
      );
    });

    it("rejects nonexistent repositoryRoot", () => {
      const repositoryRoot = "/tmp/devflow-nonexistent-repo-12345";
      expectWorktreeError(
        () => preflightGitWorktree({
          repositoryRoot,
          baseCommit: "0".repeat(40),
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath: "/tmp/devflow/worktrees/project-a/TASK-001/1",
        }),
        `No existe la ruta del repositorio: ${repositoryRoot}`,
      );
    });

    it("rejects file repositoryRoot", () => {
      const dir = createTempDirectory("devflow-git-worktree-service");
      try {
        const filePath = join(dir.path, "repo.txt");
        writeFileSync(filePath, "content");

        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: filePath,
            baseCommit: "0".repeat(40),
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: join(dir.path, "workspace"),
          }),
          `La ruta del repositorio no es un directorio: ${filePath}`,
        );
      } finally {
        dir.cleanup();
      }
    });

    it("accepts a valid repositoryRoot and returns an absolute root", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
        const statusBefore = repo.runGit(["status", "--short"]);
        const branchesBefore = repo.runGit(["branch", "--list"]);
        const worktreesBefore = repo.runGit(["worktree", "list", "--porcelain"]);
        const headBefore = repo.runGit(["rev-parse", "HEAD"]);

        const result = preflightGitWorktree({
          repositoryRoot: repo.path,
          baseCommit: head,
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath: worktreePath,
        });

        expect(result.repositoryRoot).toBe(repo.path);
        expect(result.repositoryRoot.startsWith("/")).toBe(true);
        expect(result.workspacePath).toBe(worktreePath);
        expect(result.baseCommit).toBe(head.toLowerCase());
        expect(result.branchName).toBe("devflow/project-a/TASK-001/execution-1");
        expect(repo.runGit(["status", "--short"])).toBe(statusBefore);
        expect(repo.runGit(["branch", "--list"])).toBe(branchesBefore);
        expect(repo.runGit(["worktree", "list", "--porcelain"])).toBe(worktreesBefore);
        expect(repo.runGit(["rev-parse", "HEAD"])).toBe(headBefore);
        expect(existsSync(worktreePath)).toBe(false);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("base commit", () => {
    it("accepts an existing SHA and returns the Git-normalized SHA", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const result = preflightGitWorktree({
          repositoryRoot: repo.path,
          baseCommit: `  ${head}  `,
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath: join(repo.path, "worktrees", "project-a", "TASK-001", "1"),
        });

        expect(result.baseCommit).toBe(head.toLowerCase());
      } finally {
        repo.cleanup();
      }
    });

    it("rejects empty baseCommit", () => {
      const repo = createTempGitRepository();
      try {
        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: "   ",
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: join(repo.path, "worktrees", "project-a", "TASK-001", "1"),
          }),
          "El commit base no puede estar vacío.",
        );
      } finally {
        repo.cleanup();
      }
    });

    it("rejects short baseCommit", () => {
      const repo = createTempGitRepository();
      try {
        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: "abc1234",
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: join(repo.path, "worktrees", "project-a", "TASK-001", "1"),
          }),
          "El commit base no es un SHA hexadecimal minúsculo de 40 caracteres: abc1234",
        );
      } finally {
        repo.cleanup();
      }
    });

    it("rejects uppercase baseCommit", () => {
      const repo = createTempGitRepository();
      try {
        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: "A".repeat(40),
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: join(repo.path, "worktrees", "project-a", "TASK-001", "1"),
          }),
          `El commit base no es un SHA hexadecimal minúsculo de 40 caracteres: ${"A".repeat(40)}`,
        );
      } finally {
        repo.cleanup();
      }
    });

    it("rejects a valid-format but nonexistent baseCommit", () => {
      const repo = createTempGitRepository();
      try {
        const missing = `1234567890abcdef1234567890abcdef12345678`;
        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: missing,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: join(repo.path, "worktrees", "project-a", "TASK-001", "1"),
          }),
          `El commit base no existe en el repositorio: ${missing}`,
        );
      } finally {
        repo.cleanup();
      }
    });

    it("rejects malformed porcelain output", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const shim = createGitShim({ worktreeListOutput: "garbage\n" });
        withGitShim(shim, () => {
          expectWorktreeError(
            () => preflightGitWorktree({
              repositoryRoot: repo.path,
              baseCommit: head,
              branchName: "devflow/project-a/TASK-001/execution-1",
              workspacePath: join(repo.path, "worktrees", "project-a", "TASK-001", "1"),
            }),
            `Git devolvió una salida inválida al listar worktrees del repositorio: ${repo.path}`,
          );
        });
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("branch", () => {
    it("accepts an absent branch", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const result = preflightGitWorktree({
          repositoryRoot: repo.path,
          baseCommit: head,
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath: join(repo.path, "worktrees", "project-a", "TASK-001", "1"),
        });

        expect(result.branchName).toBe("devflow/project-a/TASK-001/execution-1");
      } finally {
        repo.cleanup();
      }
    });

    it("rejects an existing branch", () => {
      const repo = createTempGitRepository();
      try {
        repo.runGit(["branch", "devflow/project-a/TASK-001/execution-1"]);
        const head = repo.runGit(["rev-parse", "HEAD"]);

        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: join(repo.path, "worktrees", "project-a", "TASK-001", "1"),
          }),
          "La rama ya existe: devflow/project-a/TASK-001/execution-1",
        );
      } finally {
        repo.cleanup();
      }
    });

    it("rejects empty branchName", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "   ",
            workspacePath: join(repo.path, "worktrees", "project-a", "TASK-001", "1"),
          }),
          "El nombre de la rama no puede estar vacío.",
        );
      } finally {
        repo.cleanup();
      }
    });

    it("distinguishes exitCode 1 from a real Git failure", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const shim = createGitShim({ showRefExitCode: 2 });
        withGitShim(shim, () => {
          expectWorktreeError(
            () => preflightGitWorktree({
              repositoryRoot: repo.path,
              baseCommit: head,
              branchName: "devflow/project-a/TASK-001/execution-1",
              workspacePath: join(repo.path, "worktrees", "project-a", "TASK-001", "1"),
            }),
            "No se pudo comprobar la rama Git: devflow/project-a/TASK-001/execution-1",
          );
        });
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("workspace path", () => {
    it("accepts an absent workspacePath", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
        const result = preflightGitWorktree({
          repositoryRoot: repo.path,
          baseCommit: head,
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath,
        });

        expect(result.workspacePath).toBe(workspacePath);
      } finally {
        repo.cleanup();
      }
    });

    it("rejects an existing file workspacePath", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "existing-file");
        writeFileSync(workspacePath, "content");

        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath,
          }),
          `La ruta del workspace ya existe: ${workspacePath}`,
        );
      } finally {
        repo.cleanup();
      }
    });

    it("rejects an existing directory workspacePath", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "existing-dir");
        mkdirSync(workspacePath);

        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath,
          }),
          `La ruta del workspace ya existe: ${workspacePath}`,
        );
      } finally {
        repo.cleanup();
      }
    });

    it("rejects an existing symlink workspacePath", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-worktree-symlink");
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const target = join(tempDir.path, "target");
        const workspacePath = join(tempDir.path, "workspace-link");
        mkdirSync(target);
        symlinkSync(target, workspacePath);

        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath,
          }),
          `La ruta del workspace ya existe: ${workspacePath}`,
        );
      } finally {
        tempDir.cleanup();
        repo.cleanup();
      }
    });

    it("normalizes whitespace and returns an absolute workspacePath", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
        const result = preflightGitWorktree({
          repositoryRoot: repo.path,
          baseCommit: head,
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath: `  ${workspacePath}  `,
        });

        expect(result.workspacePath).toBe(workspacePath);
        expect(result.workspacePath.startsWith("/")).toBe(true);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("worktree registry", () => {
    it("accepts a path not registered as worktree", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
        const result = preflightGitWorktree({
          repositoryRoot: repo.path,
          baseCommit: head,
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath,
        });

        expect(result.workspacePath).toBe(workspacePath);
      } finally {
        repo.cleanup();
      }
    });

    it("rejects a registered worktree path", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-worktree-registered");
      try {
        const worktreePath = join(tempDir.path, "registered");
        repo.runGit(["worktree", "add", worktreePath, "HEAD"]);
        const head = repo.runGit(["rev-parse", "HEAD"]);

        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          }),
          `Ya existe un worktree registrado en la ruta: ${worktreePath}`,
        );
      } finally {
        tempDir.cleanup();
        repo.cleanup();
      }
    });

    it("does not confuse prefix-matching paths", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-worktree-prefix");
      try {
        const worktreePath = join(tempDir.path, "workspace");
        const prefixPath = `${worktreePath}-other`;
        repo.runGit(["worktree", "add", worktreePath, "HEAD"]);
        const head = repo.runGit(["rev-parse", "HEAD"]);

        const result = preflightGitWorktree({
          repositoryRoot: repo.path,
          baseCommit: head,
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath: prefixPath,
        });

        expect(result.workspacePath).toBe(resolve(prefixPath));
      } finally {
        tempDir.cleanup();
        repo.cleanup();
      }
    });

    it("detects a registered path among multiple worktrees", () => {
      const repo = createTempGitRepository();
      const tempA = createTempDirectory("devflow-worktree-a");
      const tempB = createTempDirectory("devflow-worktree-b");
      try {
        const pathA = join(tempA.path, "registered-a");
        const pathB = join(tempB.path, "registered-b");
        repo.runGit(["worktree", "add", pathA, "HEAD"]);
        repo.runGit(["worktree", "add", pathB, "HEAD"]);
        const head = repo.runGit(["rev-parse", "HEAD"]);

        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: pathB,
          }),
          `Ya existe un worktree registrado en la ruta: ${pathB}`,
        );
      } finally {
        tempB.cleanup();
        tempA.cleanup();
        repo.cleanup();
      }
    });

    it("accepts detached and prunable registered entries", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-worktree-detached");
      try {
        const detachedPath = join(tempDir.path, "detached");
        repo.runGit(["worktree", "add", "--detach", detachedPath, "HEAD"]);
        const head = repo.runGit(["rev-parse", "HEAD"]);

        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: detachedPath,
          }),
          `Ya existe un worktree registrado en la ruta: ${detachedPath}`,
        );

        const prunablePath = join(tempDir.path, "prunable");
        repo.runGit(["worktree", "add", prunablePath, "HEAD"]);
        rmSync(prunablePath, { recursive: true, force: true });

        expectWorktreeError(
          () => preflightGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: prunablePath,
          }),
          `Ya existe un worktree registrado en la ruta: ${prunablePath}`,
        );
      } finally {
        tempDir.cleanup();
        repo.cleanup();
      }
    });
  });

  describe("error domain", () => {
    it("GitWorktreeError extends Error and preserves diagnostic fields", () => {
      const cause = new Error("original");
      const error = new GitWorktreeError("test", {
        repositoryRoot: "/repo",
        command: "worktree list --porcelain",
        exitCode: 2,
        branchName: "branch",
        workspacePath: "/workspace",
        baseCommit: "a".repeat(40),
        cause,
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("GitWorktreeError");
      expect(error.repositoryRoot).toBe("/repo");
      expect(error.command).toBe("worktree list --porcelain");
      expect(error.exitCode).toBe(2);
      expect(error.branchName).toBe("branch");
      expect(error.workspacePath).toBe("/workspace");
      expect(error.baseCommit).toBe("a".repeat(40));
      expect(error.cause).toBe(cause);
    });
  });
});
