import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "../../src/repositories/project-repository.js";
import { createTask, getTaskById } from "../../src/repositories/task-repository.js";
import type { Project, Task } from "../../src/types.js";
import {
  createTaskWorkspace,
  getTaskWorkspaceById,
  updateTaskWorkspaceStatus,
} from "../../src/repositories/task-workspace-repository.js";
import { createTempDatabase, type TempDatabase } from "../helpers/temp-database.js";
import { createTempDirectory, type TempDirectory } from "../helpers/temp-directory.js";
import { createTempGitRepository } from "../helpers/temp-git-repository.js";
import type { TempGitRepository } from "../helpers/temp-git-repository.js";
import {
  reconcileFailedTaskWorkspace,
  WorkspaceReconciliationError,
  type ReconcileFailedWorkspaceResult,
} from "../../src/services/workspace-reconciliation-service.js";
import { GitWorktreeReconciliationError } from "../../src/services/git-worktree-reconciliation-executor.js";

function setupProjectAndTask(
  tempDb: TempDatabase,
  repo: TempGitRepository,
  overrides: {
    attempt?: number;
    maxAttempts?: number;
    state?: Task["state"];
  } = {},
): { project: Project; task: Task } {
  const project = createProject(tempDb.database, {
    id: "proj-1",
    name: "Test Project",
    repositoryPath: repo.path,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });

  const task = createTask(tempDb.database, {
    id: "TASK-001",
    projectId: project.id,
    title: "Test Task",
    description: "A test task",
    state: overrides.state ?? "PREPARING_WORKSPACE",
    attempt: overrides.attempt ?? 0,
    maxAttempts: overrides.maxAttempts ?? 2,
    contractJson: null,
    currentRevisionJson: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return { project, task };
}

function createFailedWorkspace(
  tempDb: TempDatabase,
  task: Task,
  repo: TempGitRepository,
  overrides: Record<string, unknown> = {},
): { id: string } {
  const wsId = (overrides.id as string) ?? `${task.projectId}:${task.id}:1`;
  const ws = createTaskWorkspace(tempDb.database, {
    id: wsId,
    taskId: task.id,
    executionNumber: (overrides.executionNumber as number) ?? 1,
    workspacePath: (overrides.workspacePath as string) ?? join(repo.path, "worktrees", "nonexistent", "task", "1"),
    branchName: (overrides.branchName as string) ?? "devflow/proj-1/TASK-001/execution-1",
    baseCommit: (overrides.baseCommit as string) ?? repo.runGit(["rev-parse", "HEAD"]),
  });
  updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");
  return { id: ws.id };
}

function getGitWorktreeList(repoPath: string): string {
  return spawnSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  }).stdout;
}

describe("workspace reconciliation service", () => {
  let tempDb: TempDatabase | null = null;
  let repo: TempGitRepository | null = null;

  afterEach(() => {
    try {
      if (repo !== null) {
        try {
          const worktreeList = getGitWorktreeList(repo.path);
          const blocks = worktreeList.split("\n\n").filter((b) => b.trim().length > 0);
          for (const block of blocks) {
            const worktreeMatch = block.match(/^worktree (.+)$/m);
            const worktreePath = worktreeMatch?.[1];
            if (worktreePath !== undefined && worktreePath !== repo.path) {
              spawnSync("git", ["-C", repo.path, "worktree", "remove", worktreePath, "--force"], {
                encoding: "utf8",
              });
            }
          }

          const branchList = repo.runGit(["branch", "--list"]);
          const branches = branchList
            .split("\n")
            .map((b) => b.replace(/^\*?\s+/, "").trim())
            .filter((b) => b.length > 0 && b !== "main");
          for (const branch of branches) {
            repo.runGit(["branch", "-D", branch]);
          }
        } catch {
          // Cleanup is best-effort.
        }

        repo.cleanup();
        repo = null;
      }
    } finally {
      tempDb?.cleanup();
      tempDb = null;
    }
  });

  describe("load and validation", () => {
    it("rejects empty workspaceId", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();

      try {
        reconcileFailedTaskWorkspace(tempDb.database, "");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceReconciliationError);
        expect((error as WorkspaceReconciliationError).phase).toBe("LOAD_WORKSPACE");
      }
    });

    it("rejects nonexistent workspace", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();

      try {
        reconcileFailedTaskWorkspace(tempDb.database, "missing");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceReconciliationError);
        expect((error as WorkspaceReconciliationError).phase).toBe("LOAD_WORKSPACE");
      }
    });

    it("rejects workspace with status PREPARING", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath: "/tmp/test",
        branchName: "devflow/proj-1/TASK-001/execution-1",
        baseCommit: repo.runGit(["rev-parse", "HEAD"]),
      });

      try {
        reconcileFailedTaskWorkspace(tempDb.database, "proj-1:TASK-001:1");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceReconciliationError);
        expect((error as WorkspaceReconciliationError).phase).toBe("VALIDATE_WORKSPACE");
        expect((error as WorkspaceReconciliationError).message).toContain("FAILED");
      }
    });

    it("rejects workspace with status READY", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath: "/tmp/test",
        branchName: "devflow/proj-1/TASK-001/execution-1",
        baseCommit: repo.runGit(["rev-parse", "HEAD"]),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "READY");

      try {
        reconcileFailedTaskWorkspace(tempDb.database, "proj-1:TASK-001:1");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceReconciliationError);
        expect((error as WorkspaceReconciliationError).phase).toBe("VALIDATE_WORKSPACE");
      }
    });

    it("rejects workspace with status REMOVED", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath: "/tmp/test",
        branchName: "devflow/proj-1/TASK-001/execution-1",
        baseCommit: repo.runGit(["rev-parse", "HEAD"]),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "READY");
      tempDb.database
        .prepare("UPDATE task_workspaces SET status = 'REMOVED', removedAt = ? WHERE id = ?")
        .run(new Date().toISOString(), ws.id);

      try {
        reconcileFailedTaskWorkspace(tempDb.database, "proj-1:TASK-001:1");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceReconciliationError);
        expect((error as WorkspaceReconciliationError).phase).toBe("VALIDATE_WORKSPACE");
      }
    });

    it("rejects nonexistent task", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { project } = setupProjectAndTask(tempDb, repo);

      tempDb.database.prepare("PRAGMA foreign_keys = OFF").run();
      const now = new Date().toISOString();
      tempDb.database
        .prepare(
          "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt, removedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws-orphan", "GHOST-TASK", 1, "/tmp/test", "branch", "abc", "FAILED", now, null);
      tempDb.database.prepare("PRAGMA foreign_keys = ON").run();

      try {
        reconcileFailedTaskWorkspace(tempDb.database, "ws-orphan");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceReconciliationError);
        expect((error as WorkspaceReconciliationError).phase).toBe("LOAD_TASK");
      }
    });

    it("rejects nonexistent project", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);

      tempDb.database.prepare("PRAGMA foreign_keys = OFF").run();
      tempDb.database
        .prepare("UPDATE tasks SET projectId = ? WHERE id = ?")
        .run("GHOST-PROJECT", task.id);
      tempDb.database.prepare("PRAGMA foreign_keys = ON").run();

      const now = new Date().toISOString();
      tempDb.database
        .prepare(
          "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt, removedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("GHOST-PROJECT:TASK-001:1", task.id, 1, "/tmp/test", "branch", "abc", "FAILED", now, null);

      try {
        reconcileFailedTaskWorkspace(tempDb.database, "GHOST-PROJECT:TASK-001:1");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceReconciliationError);
        expect((error as WorkspaceReconciliationError).phase).toBe("LOAD_PROJECT");
      }
    });

    it("builds executor input from persisted identity without deriving project from workspace id", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const { id } = createFailedWorkspace(tempDb, task, repo, {
        id: "unexpected-workspace-id",
        baseCommit: head,
      });

      const result = reconcileFailedTaskWorkspace(tempDb.database, id);

      expect(result.workspace.id).toBe(id);
      expect(result.workspace.baseCommit).toBe(head.toLowerCase());
      expect(result.workspace.branchName).toBe("devflow/proj-1/TASK-001/execution-1");
      expect(result.outcome).toBe("ALREADY_CLEAN");
    });
  });

  describe("ALREADY_CLEAN", () => {
    it("returns ALREADY_CLEAN for a clean physical state", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      const result = reconcileFailedTaskWorkspace(tempDb.database, id);

      expect(result.outcome).toBe("ALREADY_CLEAN");
      expect(result.execution).not.toBeNull();
      expect(result.execution!.executedAction).toBe("NO_ACTION");
      expect(result.reconciliationError).toBeNull();
    });

    it("workspace continues FAILED", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      reconcileFailedTaskWorkspace(tempDb.database, id);

      const ws = getTaskWorkspaceById(tempDb.database, id);
      expect(ws!.status).toBe("FAILED");
    });

    it("task.state does not change", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, { state: "PREPARING_WORKSPACE" });
      const { id } = createFailedWorkspace(tempDb, task, repo);

      reconcileFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.state).toBe("PREPARING_WORKSPACE");
    });

    it("task.attempt does not change", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, { attempt: 1 });
      const { id } = createFailedWorkspace(tempDb, task, repo);

      reconcileFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.attempt).toBe(1);
    });
  });

  describe("CLEANED", () => {
    it("returns CLEANED for a valid orphan branch", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      repo.runGit(["branch", branchName]);
      const { id } = createFailedWorkspace(tempDb, task, repo, {
        baseCommit: head.toLowerCase(),
        branchName,
      });

      const result = reconcileFailedTaskWorkspace(tempDb.database, id);

      expect(result.outcome).toBe("CLEANED");
      expect(result.execution).not.toBeNull();
      expect(result.execution!.executedAction).toBe("REMOVE_BRANCH");
      expect(result.reconciliationError).toBeNull();
    });

    it("branch is deleted", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      repo.runGit(["branch", branchName]);
      const { id } = createFailedWorkspace(tempDb, task, repo, {
        baseCommit: head.toLowerCase(),
        branchName,
      });

      reconcileFailedTaskWorkspace(tempDb.database, id);

      const check = spawnSync("git", ["-C", repo.path, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
        encoding: "utf8",
        shell: false,
      });
      expect(check.status).toBe(1);
    });

    it("workspace continues FAILED", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      repo.runGit(["branch", branchName]);
      const { id } = createFailedWorkspace(tempDb, task, repo, {
        baseCommit: head.toLowerCase(),
        branchName,
      });

      reconcileFailedTaskWorkspace(tempDb.database, id);

      const ws = getTaskWorkspaceById(tempDb.database, id);
      expect(ws!.status).toBe("FAILED");
    });

    it("task.state does not change", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, { state: "EXECUTING" });
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      repo.runGit(["branch", branchName]);
      const { id } = createFailedWorkspace(tempDb, task, repo, {
        baseCommit: head.toLowerCase(),
        branchName,
      });

      reconcileFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.state).toBe("EXECUTING");
    });

    it("task.attempt does not change", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, { attempt: 0 });
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      repo.runGit(["branch", branchName]);
      const { id } = createFailedWorkspace(tempDb, task, repo, {
        baseCommit: head.toLowerCase(),
        branchName,
      });

      reconcileFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.attempt).toBe(0);
    });

    it("main repository status remains clean", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const statusBefore = repo.runGit(["status", "--short"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      repo.runGit(["branch", branchName]);
      const { id } = createFailedWorkspace(tempDb, task, repo, {
        baseCommit: head.toLowerCase(),
        branchName,
      });

      reconcileFailedTaskWorkspace(tempDb.database, id);

      expect(repo.runGit(["status", "--short"])).toBe(statusBefore);
    });
  });

  describe("idempotency", () => {
    it("second call after CLEANED produces ALREADY_CLEAN", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      repo.runGit(["branch", branchName]);
      const { id } = createFailedWorkspace(tempDb, task, repo, {
        baseCommit: head.toLowerCase(),
        branchName,
      });

      reconcileFailedTaskWorkspace(tempDb.database, id);
      const second = reconcileFailedTaskWorkspace(tempDb.database, id);

      expect(second.outcome).toBe("ALREADY_CLEAN");
      expect(second.execution!.executedAction).toBe("NO_ACTION");
    });

    it("second call does not change SQLite", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, { attempt: 1 });
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      repo.runGit(["branch", branchName]);
      const { id } = createFailedWorkspace(tempDb, task, repo, {
        baseCommit: head.toLowerCase(),
        branchName,
      });

      reconcileFailedTaskWorkspace(tempDb.database, id);
      reconcileFailedTaskWorkspace(tempDb.database, id);

      const ws = getTaskWorkspaceById(tempDb.database, id);
      expect(ws!.status).toBe("FAILED");
      const t = getTaskById(tempDb.database, task.id);
      expect(t!.attempt).toBe(1);
      expect(t!.state).toBe("PREPARING_WORKSPACE");
    });
  });

  describe("COMPLETE", () => {
    it("returns COMPLETE for a complete worktree", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      const tempDir = createTempDirectory("devflow-complete-test");
      const workspacePath = join(tempDir.path, "workspace");
      spawnSync("git", ["-C", repo.path, "worktree", "add", "-b", branchName, workspacePath, "HEAD"], {
        encoding: "utf8",
        shell: false,
      });

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath,
        branchName,
        baseCommit: head.toLowerCase(),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");

      try {
        const result = reconcileFailedTaskWorkspace(tempDb.database, ws.id);

        expect(result.outcome).toBe("COMPLETE");
        expect(result.execution).toBeNull();
        expect(result.reconciliationError).not.toBeNull();
        expect(result.reconciliationError!.code).toBe("COMPLETE_WORKTREE");

        const branchCheck = spawnSync("git", ["-C", repo.path, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
          encoding: "utf8",
          shell: false,
        });
        expect(branchCheck.status).toBe(0);

        expect(existsSync(workspacePath)).toBe(true);

        const wsAfter = getTaskWorkspaceById(tempDb.database, ws.id);
        expect(wsAfter!.status).toBe("FAILED");
      } finally {
        try {
          spawnSync("git", ["-C", repo.path, "worktree", "remove", workspacePath, "--force"], { encoding: "utf8", shell: false });
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], { encoding: "utf8", shell: false });
        } catch {
          // cleanup best effort
        }
        tempDir.cleanup();
      }
    });

    it("execution is null for COMPLETE", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      const tempDir = createTempDirectory("devflow-complete-test");
      const workspacePath = join(tempDir.path, "workspace");
      spawnSync("git", ["-C", repo.path, "worktree", "add", "-b", branchName, workspacePath, "HEAD"], {
        encoding: "utf8",
        shell: false,
      });

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath,
        branchName,
        baseCommit: head.toLowerCase(),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");

      try {
        const result = reconcileFailedTaskWorkspace(tempDb.database, ws.id);
        expect(result.execution).toBeNull();
      } finally {
        try {
          spawnSync("git", ["-C", repo.path, "worktree", "remove", workspacePath, "--force"], { encoding: "utf8", shell: false });
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], { encoding: "utf8", shell: false });
        } catch {
          // cleanup best effort
        }
        tempDir.cleanup();
      }
    });
  });

  describe("MANUAL_INTERVENTION_REQUIRED", () => {
    it("returns MANUAL_INTERVENTION_REQUIRED for a directory residual", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      const workspacePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
      mkdirSync(workspacePath, { recursive: true });

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath,
        branchName,
        baseCommit: head.toLowerCase(),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");

      try {
        const result = reconcileFailedTaskWorkspace(tempDb.database, ws.id);

        expect(result.outcome).toBe("MANUAL_INTERVENTION_REQUIRED");
        expect(result.execution).toBeNull();
        expect(result.reconciliationError).not.toBeNull();
        expect(result.reconciliationError!.code).toBe("ACTION_BLOCKED");
      } finally {
        rmSync(join(repo.path, "worktrees"), { recursive: true, force: true });
      }
    });

    it("workspace continues FAILED after MANUAL_INTERVENTION_REQUIRED", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      const workspacePath = join(repo.path, "worktrees", "project-a", "TASK-001", "1");
      mkdirSync(workspacePath, { recursive: true });

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath,
        branchName,
        baseCommit: head.toLowerCase(),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");

      try {
        reconcileFailedTaskWorkspace(tempDb.database, ws.id);
        const wsAfter = getTaskWorkspaceById(tempDb.database, ws.id);
        expect(wsAfter!.status).toBe("FAILED");
      } finally {
        rmSync(join(repo.path, "worktrees"), { recursive: true, force: true });
      }
    });
  });

  describe("technical errors", () => {
    it("wraps BRANCH_TIP_MISMATCH in WorkspaceReconciliationError", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      repo.runGit(["branch", branchName]);
      repo.runGit(["commit", "--allow-empty", "-m", "second commit"]);
      const secondCommit = repo.runGit(["rev-parse", "HEAD"]);

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath: join(repo.path, "worktrees", "nonexistent", "task", "1"),
        branchName,
        baseCommit: secondCommit.toLowerCase(),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");

      try {
        reconcileFailedTaskWorkspace(tempDb.database, ws.id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceReconciliationError);
        const wErr = error as WorkspaceReconciliationError;
        expect(wErr.phase).toBe("EXECUTE_RECONCILIATION");
        expect(wErr.cause).toBeInstanceOf(GitWorktreeReconciliationError);
        expect((wErr.cause as InstanceType<typeof GitWorktreeReconciliationError>).code).toBe("BRANCH_TIP_MISMATCH");
      } finally {
        try { repo.runGit(["branch", "-D", branchName]); } catch { /* */ }
      }
    });

    it("wraps BRANCH_IN_USE in WorkspaceReconciliationError", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      repo.runGit(["branch", branchName]);
      const usageDir = createTempDirectory("devflow-usage-test");
      const worktreePath = join(usageDir.path, "workspace");
      spawnSync("git", ["-C", repo.path, "worktree", "add", worktreePath, branchName], {
        encoding: "utf8",
        shell: false,
      });

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath: join(repo.path, "worktrees", "nonexistent", "task", "1"),
        branchName,
        baseCommit: head.toLowerCase(),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");

      try {
        reconcileFailedTaskWorkspace(tempDb.database, ws.id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceReconciliationError);
        const wErr = error as WorkspaceReconciliationError;
        expect(wErr.phase).toBe("EXECUTE_RECONCILIATION");
        expect(wErr.cause).toBeInstanceOf(GitWorktreeReconciliationError);
        expect((wErr.cause as InstanceType<typeof GitWorktreeReconciliationError>).code).toBe("BRANCH_IN_USE");
      } finally {
        try {
          spawnSync("git", ["-C", repo.path, "worktree", "remove", worktreePath, "--force"], { encoding: "utf8", shell: false });
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], { encoding: "utf8", shell: false });
        } catch {
          // cleanup best effort
        }
        usageDir.cleanup();
      }
    });
  });

  describe("isolation", () => {
    it("does not create worktrees", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);
      const worktreesBefore = getGitWorktreeList(repo.path);

      reconcileFailedTaskWorkspace(tempDb.database, id);

      expect(getGitWorktreeList(repo.path)).toBe(worktreesBefore);
    });

    it("does not modify Task.state", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, { state: "EXECUTING" });
      const { id } = createFailedWorkspace(tempDb, task, repo);

      reconcileFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.state).toBe("EXECUTING");
    });

    it("does not modify Task.attempt", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, { attempt: 3, maxAttempts: 5 });
      const { id } = createFailedWorkspace(tempDb, task, repo);

      reconcileFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.attempt).toBe(3);
    });

    it("main repository HEAD does not change", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const headBefore = repo.runGit(["rev-parse", "HEAD"]);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      reconcileFailedTaskWorkspace(tempDb.database, id);

      expect(repo.runGit(["rev-parse", "HEAD"])).toBe(headBefore);
    });

    it("main branch does not change", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const mainBefore = repo.runGit(["branch", "--list", "main"]);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      reconcileFailedTaskWorkspace(tempDb.database, id);

      expect(repo.runGit(["branch", "--list", "main"])).toBe(mainBefore);
    });
  });

  describe("error domain", () => {
    it("WorkspaceReconciliationError extends Error", () => {
      const error = new WorkspaceReconciliationError("test", { phase: "LOAD_WORKSPACE" });
      expect(error).toBeInstanceOf(Error);
    });

    it("name is WorkspaceReconciliationError", () => {
      const error = new WorkspaceReconciliationError("test", { phase: "LOAD_WORKSPACE" });
      expect(error.name).toBe("WorkspaceReconciliationError");
    });

    it("preserves phase, workspaceId, taskId, projectId", () => {
      const cause = new Error("original");
      const error = new WorkspaceReconciliationError("test", {
        phase: "EXECUTE_RECONCILIATION",
        workspaceId: "ws-001",
        taskId: "TASK-001",
        projectId: "proj-1",
        cause,
      });
      expect(error.phase).toBe("EXECUTE_RECONCILIATION");
      expect(error.workspaceId).toBe("ws-001");
      expect(error.taskId).toBe("TASK-001");
      expect(error.projectId).toBe("proj-1");
      expect(error.cause).toBe(cause);
    });
  });
});
