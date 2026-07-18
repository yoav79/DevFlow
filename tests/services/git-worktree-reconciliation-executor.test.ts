import { writeFileSync, mkdirSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTempDirectory } from "../helpers/temp-directory.js";
import { createTempGitRepository } from "../helpers/temp-git-repository.js";
import {
  executeGitWorktreeReconciliation,
  GitWorktreeReconciliationError,
} from "../../src/services/git-worktree-reconciliation-executor.js";

function createOrphanBranchRepo(): { repoPath: string; head: string; branchName: string; cleanup(): void } {
  const repo = createTempGitRepository();
  const head = repo.runGit(["rev-parse", "HEAD"]);
  const branchName = "devflow/project-a/TASK-001/execution-1";

  repo.runGit(["branch", branchName]);

  return {
    repoPath: repo.path,
    head: head.toLowerCase(),
    branchName,
    cleanup(): void {
      try {
        repo.runGit(["branch", "-D", branchName]);
      } catch {
        // branch may already be deleted
      }
      repo.cleanup();
    },
  };
}

function createWorktreeUsingBranch(
  repoPath: string,
): { worktreePath: string; cleanup(): void } {
  const dir = createTempDirectory("devflow-worktree-usage");
  const worktreePath = join(dir.path, "workspace");

  spawnSync("git", ["-C", repoPath, "worktree", "add", worktreePath, "HEAD"], {
    encoding: "utf8",
    shell: false,
  });

  return {
    worktreePath,
    cleanup(): void {
      spawnSync("git", ["-C", repoPath, "worktree", "remove", worktreePath, "--force"], {
        encoding: "utf8",
        shell: false,
      });
      dir.cleanup();
    },
  };
}

function createGitBranchDeleteShim(failExitCode: number): { path: string; cleanup(): void } {
  const dir = createTempDirectory("devflow-git-del-shim");
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
if [ "$1" = "-C" ] && [ "$3" = "branch" ] && [ "$4" = "-D" ]; then
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

function expectReconciliationError(
  action: () => unknown,
  code: string,
): GitWorktreeReconciliationError {
  try {
    action();
    throw new Error(`Expected GitWorktreeReconciliationError with code ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(GitWorktreeReconciliationError);
    expect((error as GitWorktreeReconciliationError).code).toBe(code);
    return error as GitWorktreeReconciliationError;
  }
}

describe("executeGitWorktreeReconciliation", () => {
  describe("NO ACTION", () => {
    it("returns NO_ACTION for a clean state", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");
        const branchName = "devflow/project-a/TASK-001/execution-1";

        const result = executeGitWorktreeReconciliation({
          repositoryRoot: repo.path,
          baseCommit: head,
          branchName,
          workspacePath,
        });

        expect(result.executedAction).toBe("NO_ACTION");
        expect(result.initialInspection.state).toBe("CLEAN");
        expect(result.finalInspection.state).toBe("CLEAN");
        expect(result.initialPlan.action).toBe("NO_ACTION");
        expect(result.initialPlan.reason).toBe("ALREADY_CLEAN");
        expect(result.finalPlan.action).toBe("NO_ACTION");
        expect(result.finalPlan.reason).toBe("ALREADY_CLEAN");
      } finally {
        repo.cleanup();
      }
    });

    it("does not execute branch -D for a clean state", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");
        const branchName = "devflow/project-a/TASK-001/execution-1";
        const branchesBefore = repo.runGit(["branch", "--list"]);

        executeGitWorktreeReconciliation({
          repositoryRoot: repo.path,
          baseCommit: head,
          branchName,
          workspacePath,
        });

        const branchesAfter = repo.runGit(["branch", "--list"]);
        expect(branchesAfter).toBe(branchesBefore);
      } finally {
        repo.cleanup();
      }
    });

    it("blocks COMPLETE worktree with COMPLETE_WORKTREE", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-complete-wt");
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const workspacePath = join(tempDir.path, "workspace");
      const branchName = "devflow/project-a/TASK-001/execution-1";
      try {
        repo.runGit(["worktree", "add", "-b", branchName, workspacePath, "HEAD"]);

        expectReconciliationError(
          () => executeGitWorktreeReconciliation({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName,
            workspacePath,
          }),
          "COMPLETE_WORKTREE",
        );
      } finally {
        try {
          const wt = spawnSync("git", ["-C", repo.path, "worktree", "list", "--porcelain"], { encoding: "utf8", shell: false });
          if (wt.stdout.includes("worktree " + join(tempDir.path, "workspace"))) {
            spawnSync("git", ["-C", repo.path, "worktree", "remove", join(tempDir.path, "workspace"), "--force"], { encoding: "utf8", shell: false });
          }
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], { encoding: "utf8", shell: false });
        } catch {
          // cleanup best effort
        }
        tempDir.cleanup();
        repo.cleanup();
      }
    });

    it("COMPLETE worktree preserves its branch", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-complete-branch");
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const workspacePath = join(tempDir.path, "workspace");
      const branchName = "devflow/project-a/TASK-001/execution-1";
      try {
        repo.runGit(["worktree", "add", "-b", branchName, workspacePath, "HEAD"]);

        try {
          executeGitWorktreeReconciliation({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName,
            workspacePath,
          });
        } catch {
          // expected
        }

        const branchCheck = spawnSync("git", ["-C", repo.path, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { encoding: "utf8", shell: false });
        expect(branchCheck.status).toBe(0);
      } finally {
        try {
          spawnSync("git", ["-C", repo.path, "worktree", "remove", join(tempDir.path, "workspace"), "--force"], { encoding: "utf8", shell: false });
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], { encoding: "utf8", shell: false });
        } catch {
          // cleanup best effort
        }
        tempDir.cleanup();
        repo.cleanup();
      }
    });
  });

  describe("REMOVE BRANCH", () => {
    it("removes branch-only with matching tip", () => {
      const orphan = createOrphanBranchRepo();
      try {
        const workspacePath = join(orphan.repoPath, "worktrees", "nonexistent", "task", "1");

        const result = executeGitWorktreeReconciliation({
          repositoryRoot: orphan.repoPath,
          baseCommit: orphan.head,
          branchName: orphan.branchName,
          workspacePath,
        });

        expect(result.executedAction).toBe("REMOVE_BRANCH");
        expect(result.initialInspection.state).toBe("RECOVERABLE");
        expect(result.initialInspection.branchExists).toBe(true);
        expect(result.initialPlan.action).toBe("REMOVE_BRANCH");
        expect(result.initialPlan.reason).toBe("ORPHAN_BRANCH");
      } finally {
        orphan.cleanup();
      }
    });

    it("produces a CLEAN final state", () => {
      const orphan = createOrphanBranchRepo();
      try {
        const workspacePath = join(orphan.repoPath, "worktrees", "nonexistent", "task", "1");

        const result = executeGitWorktreeReconciliation({
          repositoryRoot: orphan.repoPath,
          baseCommit: orphan.head,
          branchName: orphan.branchName,
          workspacePath,
        });

        expect(result.finalInspection.state).toBe("CLEAN");
      } finally {
        orphan.cleanup();
      }
    });

    it("final plan is ALREADY_CLEAN", () => {
      const orphan = createOrphanBranchRepo();
      try {
        const workspacePath = join(orphan.repoPath, "worktrees", "nonexistent", "task", "1");

        const result = executeGitWorktreeReconciliation({
          repositoryRoot: orphan.repoPath,
          baseCommit: orphan.head,
          branchName: orphan.branchName,
          workspacePath,
        });

        expect(result.finalPlan.action).toBe("NO_ACTION");
        expect(result.finalPlan.reason).toBe("ALREADY_CLEAN");
      } finally {
        orphan.cleanup();
      }
    });

    it("executedAction is REMOVE_BRANCH", () => {
      const orphan = createOrphanBranchRepo();
      try {
        const workspacePath = join(orphan.repoPath, "worktrees", "nonexistent", "task", "1");

        const result = executeGitWorktreeReconciliation({
          repositoryRoot: orphan.repoPath,
          baseCommit: orphan.head,
          branchName: orphan.branchName,
          workspacePath,
        });

        expect(result.executedAction).toBe("REMOVE_BRANCH");
      } finally {
        orphan.cleanup();
      }
    });

    it("branch no longer exists after execution", () => {
      const orphan = createOrphanBranchRepo();
      try {
        const workspacePath = join(orphan.repoPath, "worktrees", "nonexistent", "task", "1");

        executeGitWorktreeReconciliation({
          repositoryRoot: orphan.repoPath,
          baseCommit: orphan.head,
          branchName: orphan.branchName,
          workspacePath,
        });

        const branchCheck = spawnSync("git", ["-C", orphan.repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${orphan.branchName}`], { encoding: "utf8", shell: false });
        expect(branchCheck.status).toBe(1);
      } finally {
        orphan.cleanup();
      }
    });

    it("HEAD of the main repository does not change", () => {
      const orphan = createOrphanBranchRepo();
      try {
        const headBefore = spawnSync("git", ["-C", orphan.repoPath, "rev-parse", "HEAD"], { encoding: "utf8", shell: false }).stdout.trim();
        const workspacePath = join(orphan.repoPath, "worktrees", "nonexistent", "task", "1");

        executeGitWorktreeReconciliation({
          repositoryRoot: orphan.repoPath,
          baseCommit: orphan.head,
          branchName: orphan.branchName,
          workspacePath,
        });

        const headAfter = spawnSync("git", ["-C", orphan.repoPath, "rev-parse", "HEAD"], { encoding: "utf8", shell: false }).stdout.trim();
        expect(headAfter).toBe(headBefore);
      } finally {
        orphan.cleanup();
      }
    });

    it("main branch of the main repository does not change", () => {
      const orphan = createOrphanBranchRepo();
      try {
        const mainBefore = spawnSync("git", ["-C", orphan.repoPath, "branch", "--list", "main"], { encoding: "utf8", shell: false }).stdout.trim();
        const workspacePath = join(orphan.repoPath, "worktrees", "nonexistent", "task", "1");

        executeGitWorktreeReconciliation({
          repositoryRoot: orphan.repoPath,
          baseCommit: orphan.head,
          branchName: orphan.branchName,
          workspacePath,
        });

        const mainAfter = spawnSync("git", ["-C", orphan.repoPath, "branch", "--list", "main"], { encoding: "utf8", shell: false }).stdout.trim();
        expect(mainAfter).toBe(mainBefore);
      } finally {
        orphan.cleanup();
      }
    });

    it("main repository status remains clean", () => {
      const orphan = createOrphanBranchRepo();
      try {
        const statusBefore = spawnSync("git", ["-C", orphan.repoPath, "status", "--short"], { encoding: "utf8", shell: false }).stdout.trim();
        const workspacePath = join(orphan.repoPath, "worktrees", "nonexistent", "task", "1");

        executeGitWorktreeReconciliation({
          repositoryRoot: orphan.repoPath,
          baseCommit: orphan.head,
          branchName: orphan.branchName,
          workspacePath,
        });

        const statusAfter = spawnSync("git", ["-C", orphan.repoPath, "status", "--short"], { encoding: "utf8", shell: false }).stdout.trim();
        expect(statusAfter).toBe(statusBefore);
      } finally {
        orphan.cleanup();
      }
    });
  });

  describe("BLOCKS", () => {
    it("mismatched tip produces BRANCH_TIP_MISMATCH", () => {
      const repo = createTempGitRepository();
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/project-a/TASK-001/execution-1";
      const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");
      try {
        repo.runGit(["branch", branchName]);
        repo.runGit(["commit", "--allow-empty", "-m", "second commit"]);
        const secondCommit = repo.runGit(["rev-parse", "HEAD"]);

        expectReconciliationError(
          () => executeGitWorktreeReconciliation({
            repositoryRoot: repo.path,
            baseCommit: secondCommit,
            branchName,
            workspacePath,
          }),
          "BRANCH_TIP_MISMATCH",
        );
      } finally {
        try { repo.runGit(["branch", "-D", branchName]); } catch { /* */ }
        repo.cleanup();
      }
    });

    it("branch used by another worktree produces BRANCH_IN_USE", () => {
      const repo = createTempGitRepository();
      const dir = createTempDirectory("devflow-worktree-usage-branch");
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/project-a/TASK-001/execution-1";
      const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");
      try {
        repo.runGit(["branch", branchName]);
        const worktreePath = join(dir.path, "workspace");
        spawnSync("git", ["-C", repo.path, "worktree", "add", worktreePath, branchName], {
          encoding: "utf8",
          shell: false,
        });

        expectReconciliationError(
          () => executeGitWorktreeReconciliation({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName,
            workspacePath,
          }),
          "BRANCH_IN_USE",
        );
      } finally {
        try {
          spawnSync("git", ["-C", repo.path, "worktree", "remove", join(dir.path, "workspace"), "--force"], { encoding: "utf8", shell: false });
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], { encoding: "utf8", shell: false });
        } catch {
          // cleanup best effort
        }
        dir.cleanup();
        repo.cleanup();
      }
    });

    it("directory residual produces ACTION_BLOCKED", () => {
      const repo = createTempGitRepository();
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/project-a/TASK-001/execution-1";
      const workspacePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
      try {
        mkdirSync(workspacePath, { recursive: true });

        expectReconciliationError(
          () => executeGitWorktreeReconciliation({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName,
            workspacePath,
          }),
          "ACTION_BLOCKED",
        );
      } finally {
        rmSync(join(repo.path, "worktrees"), { recursive: true, force: true });
        repo.cleanup();
      }
    });

    it("file residual produces ACTION_BLOCKED", () => {
      const repo = createTempGitRepository();
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/project-a/TASK-001/execution-1";
      const dirPath = join(repo.path, "worktrees", "project-a", "TASK-001");
      const workspacePath = join(dirPath, "1");
      try {
        mkdirSync(dirPath, { recursive: true });
        writeFileSync(workspacePath, "content");

        expectReconciliationError(
          () => executeGitWorktreeReconciliation({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName,
            workspacePath,
          }),
          "ACTION_BLOCKED",
        );
      } finally {
        rmSync(join(repo.path, "worktrees"), { recursive: true, force: true });
        repo.cleanup();
      }
    });

    it("symlink residual produces ACTION_BLOCKED", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-symlink-test");
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/project-a/TASK-001/execution-1";
      const dirPath = join(repo.path, "worktrees", "project-a", "TASK-001");
      const workspacePath = join(dirPath, "1");
      try {
        mkdirSync(dirPath, { recursive: true });
        symlinkSync(tempDir.path, workspacePath);

        expectReconciliationError(
          () => executeGitWorktreeReconciliation({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName,
            workspacePath,
          }),
          "ACTION_BLOCKED",
        );
      } finally {
        rmSync(join(repo.path, "worktrees"), { recursive: true, force: true });
        tempDir.cleanup();
        repo.cleanup();
      }
    });

    it("INCONSISTENT state produces ACTION_BLOCKED when reachable", () => {
      const repo = createTempGitRepository();
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/project-a/TASK-001/execution-1";
      const workspacePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
      try {
        repo.runGit(["branch", branchName]);
        spawnSync("git", ["-C", repo.path, "worktree", "add", "--detach", workspacePath, "HEAD"], {
          encoding: "utf8",
          shell: false,
        });

        expectReconciliationError(
          () => executeGitWorktreeReconciliation({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName,
            workspacePath,
          }),
          "ACTION_BLOCKED",
        );
      } finally {
        try {
          spawnSync("git", ["-C", repo.path, "worktree", "remove", join(repo.path, "worktrees", "project-a", "TASK-001", "1"), "--force"], { encoding: "utf8", shell: false });
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], { encoding: "utf8", shell: false });
        } catch {
          // cleanup best effort
        }
        repo.cleanup();
      }
    });

    it("locked worktree produces ACTION_BLOCKED", () => {
      const repo = createTempGitRepository();
      const tempDir = createTempDirectory("devflow-locked-test");
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/project-a/TASK-001/execution-1";
      const workspacePath = join(tempDir.path, "workspace");
      try {
        repo.runGit(["worktree", "add", "-b", branchName, workspacePath, "HEAD"]);
        spawnSync("git", ["-C", repo.path, "worktree", "lock", workspacePath], { encoding: "utf8", shell: false });

        expectReconciliationError(
          () => executeGitWorktreeReconciliation({
            repositoryRoot: repo.path,
            baseCommit: head,
            branchName,
            workspacePath,
          }),
          "ACTION_BLOCKED",
        );
      } finally {
        try {
          spawnSync("git", ["-C", repo.path, "worktree", "unlock", workspacePath], { encoding: "utf8", shell: false });
          spawnSync("git", ["-C", repo.path, "worktree", "remove", workspacePath, "--force"], { encoding: "utf8", shell: false });
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], { encoding: "utf8", shell: false });
        } catch {
          // cleanup best effort
        }
        tempDir.cleanup();
        repo.cleanup();
      }
    });
  });

  describe("IDIEMPOTENCY", () => {
    it("second execution after deletion returns NO_ACTION", () => {
      const orphan = createOrphanBranchRepo();
      try {
        const workspacePath = join(orphan.repoPath, "worktrees", "nonexistent", "task", "1");

        executeGitWorktreeReconciliation({
          repositoryRoot: orphan.repoPath,
          baseCommit: orphan.head,
          branchName: orphan.branchName,
          workspacePath,
        });

        const result = executeGitWorktreeReconciliation({
          repositoryRoot: orphan.repoPath,
          baseCommit: orphan.head,
          branchName: orphan.branchName,
          workspacePath,
        });

        expect(result.executedAction).toBe("NO_ACTION");
        expect(result.finalInspection.state).toBe("CLEAN");
        expect(result.finalPlan.action).toBe("NO_ACTION");
        expect(result.finalPlan.reason).toBe("ALREADY_CLEAN");
      } finally {
        orphan.cleanup();
      }
    });

    it("absent branch with CLEAN state returns NO_ACTION", () => {
      const repo = createTempGitRepository();
      try {
        const head = repo.runGit(["rev-parse", "HEAD"]);
        const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");
        const branchName = "devflow/project-a/TASK-001/execution-1";

        const result = executeGitWorktreeReconciliation({
          repositoryRoot: repo.path,
          baseCommit: head,
          branchName,
          workspacePath,
        });

        expect(result.executedAction).toBe("NO_ACTION");
        expect(result.finalInspection.state).toBe("CLEAN");
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("ERRORS", () => {
    it("branch -D failure with non-clean state produces BRANCH_DELETE_FAILED", () => {
      const repo = createTempGitRepository();
      const shim = createGitBranchDeleteShim(128);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/project-a/TASK-001/execution-1";
      const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");
      try {
        repo.runGit(["branch", branchName]);

        withGitShim(shim, () => {
          expectReconciliationError(
            () => executeGitWorktreeReconciliation({
              repositoryRoot: repo.path,
              baseCommit: head,
              branchName,
              workspacePath,
            }),
            "BRANCH_DELETE_FAILED",
          );
        });
      } finally {
        try { repo.runGit(["branch", "-D", branchName]); } catch { /* */ }
        repo.cleanup();
      }
    });

    it("branch -D failure with branch still present produces BRANCH_DELETE_FAILED", () => {
      const repo = createTempGitRepository();
      const shim = createGitBranchDeleteShim(128);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/project-a/TASK-001/execution-1";
      const workspacePath = join(repo.path, "worktrees", "nonexistent", "task", "1");
      try {
        repo.runGit(["branch", branchName]);

        withGitShim(shim, () => {
          const error = expectReconciliationError(
            () => executeGitWorktreeReconciliation({
              repositoryRoot: repo.path,
              baseCommit: head,
              branchName,
              workspacePath,
            }),
            "BRANCH_DELETE_FAILED",
          );

          expect(error.finalInspection).toBeDefined();
          expect(error.initialInspection).toBeDefined();
        });
      } finally {
        try { repo.runGit(["branch", "-D", branchName]); } catch { /* */ }
        repo.cleanup();
      }
    });
  });
});
