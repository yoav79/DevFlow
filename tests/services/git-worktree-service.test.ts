import { writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync, chmodSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createTempDirectory } from "../helpers/temp-directory.js";
import { createTempGitRepository } from "../helpers/temp-git-repository.js";
import { createGitWorktree, GitWorktreeError, inspectGitWorktreeState, preflightGitWorktree } from "../../src/services/git-worktree-service.js";

function expectWorktreeError(action: () => unknown, message: string): void {
  try {
    action();
    throw new Error("Expected GitWorktreeError.");
  } catch (error) {
    expect(error).toBeInstanceOf(GitWorktreeError);
    expect((error as GitWorktreeError).message).toBe(message);
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

function createWorktreeAddShim(failExitCode: number = 128): { path: string; cleanup(): void } {
  const dir = createTempDirectory("devflow-git-add-shim");
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
if [ "$1" = "-C" ] && [ "$3" = "worktree" ] && [ "$4" = "add" ]; then
  exit ${failExitCode}
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

  describe("createGitWorktree", () => {
    describe("happy path", () => {
      it("creates a worktree and returns normalized result", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          const result = createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            expect(result.repositoryRoot).toBe(repo.path);
            expect(result.baseCommit).toBe(head.toLowerCase());
            expect(result.branchName).toBe("devflow/project-a/TASK-001/execution-1");
            expect(result.workspacePath).toBe(worktreePath);
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("creates the expected branch", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const branchCheck = spawnSync("git", ["-C", repo.path, "show-ref", "--verify", "--quiet", "refs/heads/devflow/project-a/TASK-001/execution-1"], { encoding: "utf8", shell: false });
            expect(branchCheck.status).toBe(0);
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("HEAD of the worktree matches baseCommit", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const worktreeHead = spawnSync("git", ["-C", worktreePath, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", shell: false }).stdout.trim().toLowerCase();
            expect(worktreeHead).toBe(head.toLowerCase());
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("active branch matches branchName", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const branch = spawnSync("git", ["-C", worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8", shell: false }).stdout.trim();
            expect(branch).toBe("devflow/project-a/TASK-001/execution-1");
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("worktree appears in worktree list --porcelain", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const list = repo.runGit(["worktree", "list", "--porcelain"]);
            expect(list).toContain(`worktree ${worktreePath}`);
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("main repository preserves its HEAD", async () => {
        const repo = createTempGitRepository();
        try {
          const headBefore = repo.runGit(["rev-parse", "HEAD"]);
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const headAfter = repo.runGit(["rev-parse", "HEAD"]);
            expect(headAfter).toBe(headBefore);
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("main repository preserves its branch", async () => {
        const repo = createTempGitRepository();
        try {
          const mainBranchBefore = repo.runGit(["branch", "--list", "main"]);
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const mainBranchAfter = repo.runGit(["branch", "--list", "main"]);
            expect(mainBranchAfter).toBe(mainBranchBefore);
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("main repository preserves its git status", async () => {
        const repo = createTempGitRepository();
        try {
          const diffBefore = repo.runGit(["diff", "HEAD"]);
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const diffAfter = repo.runGit(["diff", "HEAD"]);
            expect(diffAfter).toBe(diffBefore);
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });
    });

    describe("preflight reutilizado", () => {
      it("rejects existing branch before creating", () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          repo.runGit(["branch", "devflow/project-a/TASK-001/execution-1"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          expectWorktreeError(
            () => createGitWorktree({
              repositoryRoot: repo.path,
              baseCommit: head,
              branchName: "devflow/project-a/TASK-001/execution-1",
              workspacePath: worktreePath,
            }),
            "La rama ya existe: devflow/project-a/TASK-001/execution-1",
          );
        } finally {
          repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          repo.cleanup();
        }
      });

      it("rejects existing workspacePath before creating", () => {
        const repo = createTempGitRepository();
        const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          mkdirSync(worktreePath, { recursive: true });

          expectWorktreeError(
            () => createGitWorktree({
              repositoryRoot: repo.path,
              baseCommit: head,
              branchName: "devflow/project-a/TASK-001/execution-1",
              workspacePath: worktreePath,
            }),
            `La ruta del workspace ya existe: ${worktreePath}`,
          );
        } finally {
          rmSync(worktreePath, { recursive: true, force: true });
          repo.cleanup();
        }
      });

      it("rejects invalid baseCommit", () => {
        const repo = createTempGitRepository();
        try {
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          expectWorktreeError(
            () => createGitWorktree({
              repositoryRoot: repo.path,
              baseCommit: "abc1234",
              branchName: "devflow/project-a/TASK-001/execution-1",
              workspacePath: worktreePath,
            }),
            "El commit base no es un SHA hexadecimal minúsculo de 40 caracteres: abc1234",
          );
        } finally {
          repo.cleanup();
        }
      });

      it("does not create resources when preflight fails", () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          repo.runGit(["branch", "devflow/project-a/TASK-001/execution-1"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          try {
            expectWorktreeError(
              () => createGitWorktree({
                repositoryRoot: repo.path,
                baseCommit: head,
                branchName: "devflow/project-a/TASK-001/execution-1",
                workspacePath: worktreePath,
              }),
              "La rama ya existe: devflow/project-a/TASK-001/execution-1",
            );

            expect(existsSync(worktreePath)).toBe(false);
          } finally {
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });
    });

    describe("errors", () => {
      it("translates a git worktree add failure to GitWorktreeError", () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
          const shim = createWorktreeAddShim(128);

          withGitShim(shim, () => {
            expectWorktreeError(
              () => createGitWorktree({
                repositoryRoot: repo.path,
                baseCommit: head,
                branchName: "devflow/project-a/TASK-001/execution-1",
                workspacePath: worktreePath,
              }),
              "Git devolvió un código de salida distinto de 0 al crear el worktree: " + repo.path,
            );
          });
        } finally {
          repo.cleanup();
        }
      });

      it("preserves command and exitCode", () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
          const shim = createWorktreeAddShim(128);

          withGitShim(shim, () => {
            expectWorktreeError(
              () => createGitWorktree({
                repositoryRoot: repo.path,
                baseCommit: head,
                branchName: "devflow/project-a/TASK-001/execution-1",
                workspacePath: worktreePath,
              }),
              "Git devolvió un código de salida distinto de 0 al crear el worktree: " + repo.path,
            );
          });
        } finally {
          repo.cleanup();
        }
      });

      it("does not expose stderr in the public message", () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
          const shim = createWorktreeAddShim(128);

          withGitShim(shim, () => {
            expectWorktreeError(
              () => createGitWorktree({
                repositoryRoot: repo.path,
                baseCommit: head,
                branchName: "devflow/project-a/TASK-001/execution-1",
                workspacePath: worktreePath,
              }),
              "Git devolvió un código de salida distinto de 0 al crear el worktree: " + repo.path,
            );
          });
        } finally {
          repo.cleanup();
        }
      });
    });

    describe("post-validation", () => {
      it("confirms created path is a directory", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const stat = lstatSync(worktreePath);
            expect(stat.isDirectory()).toBe(true);
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("confirms correct HEAD", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const worktreeHead = spawnSync("git", ["-C", worktreePath, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", shell: false }).stdout.trim().toLowerCase();
            expect(worktreeHead).toBe(head.toLowerCase());
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("confirms correct branch", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const branch = spawnSync("git", ["-C", worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8", shell: false }).stdout.trim();
            expect(branch).toBe("devflow/project-a/TASK-001/execution-1");
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("confirms correct registration", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const list = repo.runGit(["worktree", "list", "--porcelain"]);
            expect(list).toContain(`worktree ${worktreePath}`);
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });
    });

    describe("residues", () => {
      it("does not execute git worktree remove on failure", () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
          const shim = createWorktreeAddShim(128);

          withGitShim(shim, () => {
            try {
              createGitWorktree({
                repositoryRoot: repo.path,
                baseCommit: head,
                branchName: "devflow/project-a/TASK-001/execution-1",
                workspacePath: worktreePath,
              });
            } catch {
              // expected
            }
          });

          const worktreeList = repo.runGit(["worktree", "list"]);
          expect(worktreeList).not.toContain("project-a");
        } finally {
          repo.cleanup();
        }
      });

      it("does not execute git branch -D on failure", () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
          const branchesBefore = repo.runGit(["branch", "--list"]);
          const shim = createWorktreeAddShim(128);

          withGitShim(shim, () => {
            try {
              createGitWorktree({
                repositoryRoot: repo.path,
                baseCommit: head,
                branchName: "devflow/project-a/TASK-001/execution-1",
                workspacePath: worktreePath,
              });
            } catch {
              // expected
            }
          });

          const branchesAfter = repo.runGit(["branch", "--list"]);
          expect(branchesAfter).toBe(branchesBefore);
        } finally {
          repo.cleanup();
        }
      });

      it("does not remove pre-existing branch or path when preflight fails", () => {
        const repo = createTempGitRepository();
        const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          repo.runGit(["branch", "devflow/project-a/TASK-001/execution-1"]);
          mkdirSync(worktreePath, { recursive: true });

          try {
            expectWorktreeError(
              () => createGitWorktree({
                repositoryRoot: repo.path,
                baseCommit: head,
                branchName: "devflow/project-a/TASK-001/execution-1",
                workspacePath: worktreePath,
              }),
              "La rama ya existe: devflow/project-a/TASK-001/execution-1",
            );
          } catch {
            // expected
          }

          expect(existsSync(worktreePath)).toBe(true);

          const branchCheck = spawnSync("git", ["-C", repo.path, "show-ref", "--verify", "--quiet", "refs/heads/devflow/project-a/TASK-001/execution-1"], { encoding: "utf8", shell: false });
          expect(branchCheck.status).toBe(0);
        } finally {
          rmSync(worktreePath, { recursive: true, force: true });
          repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          repo.cleanup();
        }
      });
    });

    describe("isolation", () => {
      it("does not access SQLite", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const dbFiles = spawnSync("find", [repo.path, "-name", "*.db", "-o", "-name", "*.sqlite"], { encoding: "utf8", shell: false }).stdout.trim();
            expect(dbFiles).toBe("");
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("does not modify Task", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const diff = repo.runGit(["diff", "HEAD"]);
            expect(diff).toBe("");
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });

      it("does not start Executor", async () => {
        const repo = createTempGitRepository();
        try {
          const head = repo.runGit(["rev-parse", "HEAD"]);
          const worktreePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");

          createGitWorktree({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName: "devflow/project-a/TASK-001/execution-1",
            workspacePath: worktreePath,
          });

          try {
            const executorCheck = spawnSync("pgrep", ["-f", "executor"], { encoding: "utf8", shell: false });
            expect(executorCheck.status).not.toBe(0);
          } finally {
            repo.runGit(["worktree", "remove", worktreePath]);
            repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
          }
        } finally {
          repo.cleanup();
        }
      });
    });
  });
});

describe("inspectGitWorktreeState", () => {
  function expectWorktreeInspectionError(action: () => unknown, message: string): void {
    try {
      action();
      throw new Error("Expected GitWorktreeError.");
    } catch (error) {
      expect(error).toBeInstanceOf(GitWorktreeError);
      expect((error as GitWorktreeError).message).toBe(message);
    }
  }

  describe("CLEAN", () => {
    it("returns CLEAN when no branch, path, or registration exists", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath,
        });

        expect(result.state).toBe("CLEAN");
        expect(result.branchExists).toBe(false);
        expect(result.pathKind).toBe("MISSING");
        expect(result.worktreeRegistered).toBe(false);
        expect(result.headMatchesBaseCommit).toBeNull();
        expect(result.branchMatchesExpected).toBeNull();
        expect(result.detached).toBeNull();
        expect(result.locked).toBe(false);
        expect(result.prunable).toBe(false);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("RECOVERABLE", () => {
    it("branch only", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        repo.runGit(["branch", "devflow/project-a/TASK-001/execution-1"]);
        const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath,
        });

        expect(result.state).toBe("RECOVERABLE");
        expect(result.branchExists).toBe(true);
        expect(result.pathKind).toBe("MISSING");
        expect(result.worktreeRegistered).toBe(false);
      } finally {
        repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
        repo.cleanup();
      }
    });

    it("directory only", () => {
      const repo = createTempGitRepository();
      const workspacePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        mkdirSync(workspacePath, { recursive: true });

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath,
        });

        expect(result.state).toBe("RECOVERABLE");
        expect(result.branchExists).toBe(false);
        expect(result.pathKind).toBe("DIRECTORY");
        expect(result.worktreeRegistered).toBe(false);
      } finally {
        rmSync(workspacePath, { recursive: true, force: true });
        repo.cleanup();
      }
    });

    it("branch + directory without registration", () => {
      const repo = createTempGitRepository();
      const workspacePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        repo.runGit(["branch", "devflow/project-a/TASK-001/execution-1"]);
        mkdirSync(workspacePath, { recursive: true });

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath,
        });

        expect(result.state).toBe("RECOVERABLE");
        expect(result.branchExists).toBe(true);
        expect(result.pathKind).toBe("DIRECTORY");
        expect(result.worktreeRegistered).toBe(false);
      } finally {
        rmSync(workspacePath, { recursive: true, force: true });
        repo.runGit(["branch", "-D", "devflow/project-a/TASK-001/execution-1"]);
        repo.cleanup();
      }
    });

    it("prunable worktree", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
        repo.runGit(["worktree", "add", workspacePath, "HEAD"]);
        rmSync(workspacePath, { recursive: true, force: true });

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "main",
          workspacePath,
        });

        expect(result.state).toBe("RECOVERABLE");
        expect(result.worktreeRegistered).toBe(true);
        expect(result.prunable).toBe(true);
        expect(result.pathKind).toBe("MISSING");
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("MANUAL_INTERVENTION", () => {
    it("file path", () => {
      const repo = createTempGitRepository();
      const workspacePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        mkdirSync(join(repo.path, "worktrees", "project-a", "TASK-001"), { recursive: true });
        writeFileSync(workspacePath, "content");

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath,
        });

        expect(result.state).toBe("MANUAL_INTERVENTION");
        expect(result.pathKind).toBe("FILE");
      } finally {
        rmSync(workspacePath, { force: true });
        rmSync(join(repo.path, "worktrees", "project-a"), { recursive: true, force: true });
        repo.cleanup();
      }
    });

    it("symlink path", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-inspect-symlink");
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const target = join(tempDir.path, "target");
        const workspacePath = join(tempDir.path, "workspace-link");
        mkdirSync(target);
        symlinkSync(target, workspacePath);

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath,
        });

        expect(result.state).toBe("MANUAL_INTERVENTION");
        expect(result.pathKind).toBe("SYMLINK");
      } finally {
        tempDir.cleanup();
        repo.cleanup();
      }
    });

    it("locked worktree", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-inspect-locked");
      const workspacePath = join(tempDir.path, "locked-worktree");
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        repo.runGit(["worktree", "add", workspacePath, "HEAD"]);
        repo.runGit(["worktree", "lock", workspacePath]);

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "main",
          workspacePath,
        });

        expect(result.state).toBe("MANUAL_INTERVENTION");
        expect(result.locked).toBe(true);
      } finally {
        repo.runGit(["worktree", "unlock", workspacePath]);
        repo.runGit(["worktree", "remove", workspacePath, "--force"]);
        tempDir.cleanup();
        repo.cleanup();
      }
    });
  });

  describe("COMPLETE", () => {
    it("returns COMPLETE for a fully correct worktree", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-inspect-complete");
      const workspacePath = join(tempDir.path, "complete-worktree");
      const branchName = "devflow/project-a/TASK-001/execution-1";
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        repo.runGit(["worktree", "add", "-b", branchName, workspacePath, "HEAD"]);

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName,
          workspacePath,
        });

        expect(result.state).toBe("COMPLETE");
        expect(result.branchExists).toBe(true);
        expect(result.pathKind).toBe("DIRECTORY");
        expect(result.worktreeRegistered).toBe(true);
        expect(result.headMatchesBaseCommit).toBe(true);
        expect(result.branchMatchesExpected).toBe(true);
        expect(result.detached).toBe(false);
        expect(result.locked).toBe(false);
        expect(result.prunable).toBe(false);
      } finally {
        repo.runGit(["worktree", "remove", workspacePath, "--force"]);
        repo.runGit(["branch", "-D", branchName]);
        tempDir.cleanup();
        repo.cleanup();
      }
    });
  });

  describe("INCONSISTENT", () => {
    it("HEAD mismatch", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-inspect-head-mismatch");
      const workspacePath = join(tempDir.path, "head-mismatch");
      const branchName = "devflow/project-a/TASK-001/execution-1";
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        repo.runGit(["worktree", "add", "-b", branchName, workspacePath, "HEAD"]);

        writeFileSync(join(workspacePath, "new-file.txt"), "content");
        repo.runGit(["-C", workspacePath, "add", "new-file.txt"]);
        repo.runGit(["-C", workspacePath, "commit", "-m", "second commit"]);
        const newHead = repo.runGit(["-C", workspacePath, "rev-parse", "HEAD"]);

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName,
          workspacePath,
        });

        expect(result.state).toBe("INCONSISTENT");
        expect(result.headMatchesBaseCommit).toBe(false);
      } finally {
        repo.runGit(["worktree", "remove", workspacePath, "--force"]);
        repo.runGit(["branch", "-D", branchName]);
        tempDir.cleanup();
        repo.cleanup();
      }
    });

    it("branch mismatch", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-inspect-branch-mismatch");
      const workspacePath = join(tempDir.path, "branch-mismatch");
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        repo.runGit(["worktree", "add", workspacePath, "HEAD"]);

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "devflow/project-a/TASK-001/execution-1",
          workspacePath,
        });

        expect(result.state).toBe("INCONSISTENT");
        expect(result.branchMatchesExpected).toBe(false);
      } finally {
        repo.runGit(["worktree", "remove", workspacePath, "--force"]);
        tempDir.cleanup();
        repo.cleanup();
      }
    });

    it("detached worktree", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-inspect-detached");
      const workspacePath = join(tempDir.path, "detached-worktree");
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        repo.runGit(["worktree", "add", "--detach", workspacePath, "HEAD"]);

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "main",
          workspacePath,
        });

        expect(result.state).toBe("INCONSISTENT");
        expect(result.detached).toBe(true);
      } finally {
        repo.runGit(["worktree", "remove", workspacePath, "--force"]);
        tempDir.cleanup();
        repo.cleanup();
      }
    });

    it("similar path does not count as registration", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-inspect-prefix");
      const worktreePath = join(tempDir.path, "workspace");
      const prefixPath = `${worktreePath}-other`;
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        repo.runGit(["worktree", "add", worktreePath, "HEAD"]);

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "main",
          workspacePath: prefixPath,
        });

        expect(result.worktreeRegistered).toBe(false);
        expect(result.pathKind).toBe("MISSING");
      } finally {
        repo.runGit(["worktree", "remove", worktreePath, "--force"]);
        tempDir.cleanup();
        repo.cleanup();
      }
    });

    it("registered without physical path when not prunable", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-inspect-registered-no-path");
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(tempDir.path, "registered-only");
        repo.runGit(["worktree", "add", workspacePath, "HEAD"]);
        rmSync(workspacePath, { recursive: true, force: true });

        const worktreeList = repo.runGit(["worktree", "list", "--porcelain"]);
        const isPrunable = worktreeList.includes("prunable");

        const result = inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "main",
          workspacePath,
        });

        if (!isPrunable) {
          expect(result.state).toBe("INCONSISTENT");
          expect(result.worktreeRegistered).toBe(true);
          expect(result.pathKind).toBe("MISSING");
        }
      } finally {
        repo.runGit(["worktree", "prune"]);
        tempDir.cleanup();
        repo.cleanup();
      }
    });
  });

  describe("errors", () => {
    it("rejects invalid repositoryRoot", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");

        expectWorktreeInspectionError(
          () => inspectGitWorktreeState({
            repositoryRoot: "/tmp/devflow-nonexistent-repo-12345",
            baseCommit: head.toLowerCase(),
            branchName: "main",
            workspacePath,
          }),
          `No existe la ruta del repositorio: /tmp/devflow-nonexistent-repo-12345`,
        );
      } finally {
        repo.cleanup();
      }
    });

    it("rejects invalid baseCommit format", () => {
      const repo = createTempGitRepository();
      try {
        const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");

        expectWorktreeInspectionError(
          () => inspectGitWorktreeState({
            repositoryRoot: repo.path,
            baseCommit: "abc1234",
            branchName: "main",
            workspacePath,
          }),
          "El commit base no es un SHA hexadecimal minúsculo de 40 caracteres: abc1234",
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
        const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");

        withGitShim(shim, () => {
          expectWorktreeInspectionError(
            () => inspectGitWorktreeState({
              repositoryRoot: repo.path,
              baseCommit: head.toLowerCase(),
              branchName: "main",
              workspacePath,
            }),
            `Git devolvió una salida inválida al inspeccionar el estado del worktree: ${repo.path}`,
          );
        });
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("isolation", () => {
    it("does not modify HEAD, branch, status, or create paths", () => {
      const repo = createTempGitRepository();
      try {
        const headBefore = repo.runGit(["rev-parse", "HEAD"]);
        const branchesBefore = repo.runGit(["branch", "--list"]);
        const statusBefore = repo.runGit(["status", "--short"]);
        const worktreesBefore = repo.runGit(["worktree", "list", "--porcelain"]);
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");

        inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "main",
          workspacePath,
        });

        expect(repo.runGit(["rev-parse", "HEAD"])).toBe(headBefore);
        expect(repo.runGit(["branch", "--list"])).toBe(branchesBefore);
        expect(repo.runGit(["status", "--short"])).toBe(statusBefore);
        expect(repo.runGit(["worktree", "list", "--porcelain"])).toBe(worktreesBefore);
        expect(existsSync(workspacePath)).toBe(false);
      } finally {
        repo.cleanup();
      }
    });

    it("does not access SQLite", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");

        inspectGitWorktreeState({
          repositoryRoot: repo.path,
          baseCommit: head.toLowerCase(),
          branchName: "main",
          workspacePath,
        });

        const dbFiles = spawnSync("find", [repo.path, "-name", "*.db", "-o", "-name", "*.sqlite"], { encoding: "utf8", shell: false }).stdout.trim();
        expect(dbFiles).toBe("");
      } finally {
        repo.cleanup();
      }
    });
  });
});
