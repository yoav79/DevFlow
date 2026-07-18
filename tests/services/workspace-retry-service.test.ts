import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
  retryFailedTaskWorkspace,
  WorkspaceRetryError,
} from "../../src/services/workspace-retry-service.js";

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
    state: overrides.state ?? "EXECUTING",
    attempt: overrides.attempt ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
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
): { id: string; branchName: string; workspacePath: string } {
  const branchName =
    (overrides.branchName as string) ?? "devflow/proj-1/TASK-001/execution-1";
  const workspacePath =
    (overrides.workspacePath as string) ??
    join(repo.path, "worktrees", "nonexistent", "task", "1");
  const wsId =
    (overrides.id as string) ?? `${task.projectId}:${task.id}:1`;
  const ws = createTaskWorkspace(tempDb.database, {
    id: wsId,
    taskId: task.id,
    executionNumber: (overrides.executionNumber as number) ?? 1,
    workspacePath,
    branchName,
    baseCommit:
      (overrides.baseCommit as string) ?? repo.runGit(["rev-parse", "HEAD"]),
  });
  updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");
  return { id: ws.id, branchName, workspacePath };
}

function getGitWorktreeList(repoPath: string): string {
  return spawnSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  }).stdout;
}

describe("workspace retry service", () => {
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
              spawnSync(
                "git",
                ["-C", repo.path, "worktree", "remove", worktreePath, "--force"],
                { encoding: "utf8" },
              );
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

  describe("validation", () => {
    it("rejects empty workspaceId", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();

      try {
        retryFailedTaskWorkspace(tempDb.database, "");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        expect((error as WorkspaceRetryError).phase).toBe("LOAD_WORKSPACE");
      }
    });

    it("rejects nonexistent workspace", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();

      try {
        retryFailedTaskWorkspace(tempDb.database, "nonexistent");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        expect((error as WorkspaceRetryError).phase).toBe("LOAD_WORKSPACE");
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
        retryFailedTaskWorkspace(tempDb.database, "proj-1:TASK-001:1");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        expect((error as WorkspaceRetryError).phase).toBe("VALIDATE_WORKSPACE");
        expect((error as WorkspaceRetryError).message).toContain("FAILED");
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
        retryFailedTaskWorkspace(tempDb.database, "proj-1:TASK-001:1");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        expect((error as WorkspaceRetryError).phase).toBe("VALIDATE_WORKSPACE");
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
        retryFailedTaskWorkspace(tempDb.database, "proj-1:TASK-001:1");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        expect((error as WorkspaceRetryError).phase).toBe("VALIDATE_WORKSPACE");
      }
    });

    it("rejects nonexistent task", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();

      tempDb.database.prepare("PRAGMA foreign_keys = OFF").run();
      const now = new Date().toISOString();
      tempDb.database
        .prepare(
          "INSERT INTO task_workspaces (id, taskId, executionNumber, workspacePath, branchName, baseCommit, status, createdAt, removedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws-orphan", "GHOST-TASK", 1, "/tmp/test", "branch", "abc", "FAILED", now, null);
      tempDb.database.prepare("PRAGMA foreign_keys = ON").run();

      try {
        retryFailedTaskWorkspace(tempDb.database, "ws-orphan");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        expect((error as WorkspaceRetryError).phase).toBe("LOAD_WORKSPACE");
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
        retryFailedTaskWorkspace(tempDb.database, "GHOST-PROJECT:TASK-001:1");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        expect((error as WorkspaceRetryError).phase).toBe("LOAD_WORKSPACE");
      }
    });
  });

  describe("retry from ALREADY_CLEAN", () => {
    it("terminates READY from clean physical state", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      const result = retryFailedTaskWorkspace(tempDb.database, id);

      expect(result.status).toBe("READY");
    });

    it("creates worktree", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      const result = retryFailedTaskWorkspace(tempDb.database, id);

      expect(existsSync(result.workspacePath)).toBe(true);
      const list = getGitWorktreeList(repo.path);
      expect(list).toContain(`worktree ${result.workspacePath}`);
    });

    it("preserves workspaceId", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      const result = retryFailedTaskWorkspace(tempDb.database, id);

      expect(result.id).toBe(id);
    });

    it("preserves taskId", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      const result = retryFailedTaskWorkspace(tempDb.database, id);

      expect(result.taskId).toBe(task.id);
    });

    it("preserves executionNumber", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo, {
        executionNumber: 2,
      });

      const result = retryFailedTaskWorkspace(tempDb.database, id);

      expect(result.executionNumber).toBe(2);
    });

    it("preserves branchName", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id, branchName } = createFailedWorkspace(tempDb, task, repo);

      const result = retryFailedTaskWorkspace(tempDb.database, id);

      expect(result.branchName).toBe(branchName);
    });

    it("preserves workspacePath", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id, workspacePath } = createFailedWorkspace(tempDb, task, repo);

      const result = retryFailedTaskWorkspace(tempDb.database, id);

      expect(result.workspacePath).toBe(workspacePath);
    });

    it("preserves baseCommit", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      const result = retryFailedTaskWorkspace(tempDb.database, id);

      expect(result.baseCommit).toBe(
        repo.runGit(["rev-parse", "HEAD"]).toLowerCase(),
      );
    });

    it("Task.state does not change", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, {
        state: "EXECUTING",
      });
      const { id } = createFailedWorkspace(tempDb, task, repo);

      retryFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.state).toBe("EXECUTING");
    });

    it("Task.attempt does not change", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, { attempt: 1 });
      const { id } = createFailedWorkspace(tempDb, task, repo);

      retryFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.attempt).toBe(1);
    });

    it("Task.maxAttempts does not change", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, { maxAttempts: 5 });
      const { id } = createFailedWorkspace(tempDb, task, repo);

      retryFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.maxAttempts).toBe(5);
    });

    it("does not insert a second workspace row", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      retryFailedTaskWorkspace(tempDb.database, id);

      const ws = getTaskWorkspaceById(tempDb.database, id);
      expect(ws).not.toBeNull();
      const allRows = tempDb.database
        .prepare("SELECT * FROM task_workspaces WHERE taskId = ?")
        .all(task.id) as Record<string, unknown>[];
      expect(allRows.length).toBe(1);
    });
  });

  describe("retry after CLEANED", () => {
    it("orphan branch produces CLEANED and retry succeeds", () => {
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

      const result = retryFailedTaskWorkspace(tempDb.database, id);

      expect(result.status).toBe("READY");
      expect(result.branchName).toBe(branchName);
    });

    it("branch is recreated after orphan was cleaned", () => {
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

      retryFailedTaskWorkspace(tempDb.database, id);

      const check = spawnSync(
        "git",
        ["-C", repo.path, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
        { encoding: "utf8" },
      );
      expect(check.status).toBe(0);
    });

    it("terminates READY after cleanup", () => {
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

      const result = retryFailedTaskWorkspace(tempDb.database, id);

      expect(result.status).toBe("READY");
      expect(existsSync(result.workspacePath)).toBe(true);
    });
  });

  describe("blocks", () => {
    it("COMPLETE blocks and leaves FAILED", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      const tempDir = createTempDirectory("devflow-retry-complete");
      const workspacePath = join(tempDir.path, "workspace");
      spawnSync(
        "git",
        ["-C", repo.path, "worktree", "add", "-b", branchName, workspacePath, "HEAD"],
        { encoding: "utf8", shell: false },
      );

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
        retryFailedTaskWorkspace(tempDb.database, ws.id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        expect((error as WorkspaceRetryError).phase).toBe("RECONCILE_WORKSPACE");
        expect((error as WorkspaceRetryError).reconciliationOutcome).toBe("COMPLETE");
      } finally {
        const wsAfter = getTaskWorkspaceById(tempDb.database, ws.id);
        expect(wsAfter!.status).toBe("FAILED");
        try {
          spawnSync("git", ["-C", repo.path, "worktree", "remove", workspacePath, "--force"], {
            encoding: "utf8",
            shell: false,
          });
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], {
            encoding: "utf8",
            shell: false,
          });
        } catch {
          // cleanup best effort
        }
        tempDir.cleanup();
      }
    });

    it("MANUAL_INTERVENTION_REQUIRED blocks and leaves FAILED", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      const workspacePath = join(
        repo.path,
        "worktrees",
        "project-a",
        "TASK-001",
        "1",
      );

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
        retryFailedTaskWorkspace(tempDb.database, ws.id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        expect((error as WorkspaceRetryError).phase).toBe("RECONCILE_WORKSPACE");
        expect((error as WorkspaceRetryError).reconciliationOutcome).toBe(
          "MANUAL_INTERVENTION_REQUIRED",
        );
      } finally {
        const wsAfter = getTaskWorkspaceById(tempDb.database, ws.id);
        expect(wsAfter!.status).toBe("FAILED");
        rmSync(join(repo.path, "worktrees"), { recursive: true, force: true });
      }
    });

    it("wraps reconciliation technical error in RECONCILE_WORKSPACE", () => {
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
        retryFailedTaskWorkspace(tempDb.database, ws.id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        const wErr = error as WorkspaceRetryError;
        expect(wErr.phase).toBe("RECONCILE_WORKSPACE");
        expect(wErr.cause).toBeDefined();
      } finally {
        try {
          repo.runGit(["branch", "-D", branchName]);
        } catch {
          // cleanup best effort
        }
      }
    });
  });

  describe("worktree failure", () => {
    it("identity preserved after worktree failure", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      const tempDir = createTempDirectory("devflow-retry-fail");
      const workspacePath = join(tempDir.path, "workspace");
      spawnSync(
        "git",
        ["-C", repo.path, "worktree", "add", "-b", branchName, workspacePath, "HEAD"],
        { encoding: "utf8", shell: false },
      );

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath,
        branchName,
        baseCommit: head.toLowerCase(),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");

      spawnSync("git", ["-C", repo.path, "worktree", "remove", workspacePath, "--force"], {
        encoding: "utf8",
        shell: false,
      });

      try {
        retryFailedTaskWorkspace(tempDb.database, ws.id);
        expect.fail("should have thrown");
      } catch {
        const wsAfter = getTaskWorkspaceById(tempDb.database, ws.id);
        expect(wsAfter!.id).toBe(ws.id);
        expect(wsAfter!.taskId).toBe(task.id);
        expect(wsAfter!.workspacePath).toBe(workspacePath);
        expect(wsAfter!.branchName).toBe(branchName);
        expect(wsAfter!.baseCommit).toBe(head.toLowerCase());
      } finally {
        try {
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], {
            encoding: "utf8",
            shell: false,
          });
        } catch {
          // cleanup best effort
        }
        tempDir.cleanup();
      }
    });

    it("Task.state preserved after worktree failure", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, {
        state: "EXECUTING",
      });
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      const tempDir = createTempDirectory("devflow-retry-fail");
      const workspacePath = join(tempDir.path, "workspace");
      spawnSync(
        "git",
        ["-C", repo.path, "worktree", "add", "-b", branchName, workspacePath, "HEAD"],
        { encoding: "utf8", shell: false },
      );

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath,
        branchName,
        baseCommit: head.toLowerCase(),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");

      spawnSync("git", ["-C", repo.path, "worktree", "remove", workspacePath, "--force"], {
        encoding: "utf8",
        shell: false,
      });

      try {
        retryFailedTaskWorkspace(tempDb.database, ws.id);
        expect.fail("should have thrown");
      } catch {
        const after = getTaskById(tempDb.database, task.id);
        expect(after!.state).toBe("EXECUTING");
      } finally {
        try {
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], {
            encoding: "utf8",
            shell: false,
          });
        } catch {
          // cleanup best effort
        }
        tempDir.cleanup();
      }
    });

    it("Task.attempt preserved after worktree failure", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, { attempt: 1 });
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      const tempDir = createTempDirectory("devflow-retry-fail");
      const workspacePath = join(tempDir.path, "workspace");
      spawnSync(
        "git",
        ["-C", repo.path, "worktree", "add", "-b", branchName, workspacePath, "HEAD"],
        { encoding: "utf8", shell: false },
      );

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath,
        branchName,
        baseCommit: head.toLowerCase(),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");

      spawnSync("git", ["-C", repo.path, "worktree", "remove", workspacePath, "--force"], {
        encoding: "utf8",
        shell: false,
      });

      try {
        retryFailedTaskWorkspace(tempDb.database, ws.id);
        expect.fail("should have thrown");
      } catch {
        const after = getTaskById(tempDb.database, task.id);
        expect(after!.attempt).toBe(1);
      } finally {
        try {
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], {
            encoding: "utf8",
            shell: false,
          });
        } catch {
          // cleanup best effort
        }
        tempDir.cleanup();
      }
    });

    it("no second workspace row inserted after worktree failure", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const branchName = "devflow/proj-1/TASK-001/execution-1";
      const tempDir = createTempDirectory("devflow-retry-fail");
      const workspacePath = join(tempDir.path, "workspace");
      spawnSync(
        "git",
        ["-C", repo.path, "worktree", "add", "-b", branchName, workspacePath, "HEAD"],
        { encoding: "utf8", shell: false },
      );

      const ws = createTaskWorkspace(tempDb.database, {
        id: "proj-1:TASK-001:1",
        taskId: task.id,
        executionNumber: 1,
        workspacePath,
        branchName,
        baseCommit: head.toLowerCase(),
      });
      updateTaskWorkspaceStatus(tempDb.database, ws.id, "FAILED");

      spawnSync("git", ["-C", repo.path, "worktree", "remove", workspacePath, "--force"], {
        encoding: "utf8",
        shell: false,
      });

      try {
        retryFailedTaskWorkspace(tempDb.database, ws.id);
        expect.fail("should have thrown");
      } catch {
        const allRows = tempDb.database
          .prepare("SELECT * FROM task_workspaces WHERE taskId = ?")
          .all(task.id) as Record<string, unknown>[];
        expect(allRows.length).toBe(1);
      } finally {
        try {
          spawnSync("git", ["-C", repo.path, "branch", "-D", branchName], {
            encoding: "utf8",
            shell: false,
          });
        } catch {
          // cleanup best effort
        }
        tempDir.cleanup();
      }
    });
  });

  describe("idempotency", () => {
    it("second call on READY is rejected", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      retryFailedTaskWorkspace(tempDb.database, id);

      try {
        retryFailedTaskWorkspace(tempDb.database, id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        expect((error as WorkspaceRetryError).phase).toBe("VALIDATE_WORKSPACE");
        expect((error as WorkspaceRetryError).message).toContain("FAILED");
      }
    });

    it("second call on PREPARING is rejected", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      const ws = getTaskWorkspaceById(tempDb.database, id);
      expect(ws!.status).toBe("FAILED");

      updateTaskWorkspaceStatus(tempDb.database, id, "PREPARING");

      try {
        retryFailedTaskWorkspace(tempDb.database, id);
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceRetryError);
        expect((error as WorkspaceRetryError).phase).toBe("VALIDATE_WORKSPACE");
      }
    });
  });

  describe("isolation", () => {
    it("does not change Task.state", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, {
        state: "PREPARING_WORKSPACE",
      });
      const { id } = createFailedWorkspace(tempDb, task, repo);

      retryFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.state).toBe("PREPARING_WORKSPACE");
    });

    it("does not change Task.attempt", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, { attempt: 2 });
      const { id } = createFailedWorkspace(tempDb, task, repo);

      retryFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.attempt).toBe(2);
    });

    it("does not advance to EXECUTING", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo, {
        state: "PREPARING_WORKSPACE",
      });
      const { id } = createFailedWorkspace(tempDb, task, repo);

      retryFailedTaskWorkspace(tempDb.database, id);

      const after = getTaskById(tempDb.database, task.id);
      expect(after!.state).not.toBe("EXECUTING");
    });

    it("workspace remains the only row for the task", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      retryFailedTaskWorkspace(tempDb.database, id);

      const allRows = tempDb.database
        .prepare("SELECT * FROM task_workspaces WHERE taskId = ?")
        .all(task.id) as Record<string, unknown>[];
      expect(allRows.length).toBe(1);
      expect(String(allRows[0]!["id"])).toBe(id);
    });

    it("main repository HEAD does not change", () => {
      tempDb = createTempDatabase();
      repo = createTempGitRepository();
      const { task } = setupProjectAndTask(tempDb, repo);
      const headBefore = repo.runGit(["rev-parse", "HEAD"]);
      const { id } = createFailedWorkspace(tempDb, task, repo);

      retryFailedTaskWorkspace(tempDb.database, id);

      expect(repo.runGit(["rev-parse", "HEAD"])).toBe(headBefore);
    });
  });

  describe("error domain", () => {
    it("WorkspaceRetryError extends Error", () => {
      const error = new WorkspaceRetryError("test", {
        phase: "LOAD_WORKSPACE",
      });
      expect(error).toBeInstanceOf(Error);
    });

    it("name is WorkspaceRetryError", () => {
      const error = new WorkspaceRetryError("test", {
        phase: "LOAD_WORKSPACE",
      });
      expect(error.name).toBe("WorkspaceRetryError");
    });

    it("preserves phase, workspaceId, taskId", () => {
      const cause = new Error("original");
      const error = new WorkspaceRetryError("test", {
        phase: "CREATE_WORKTREE",
        workspaceId: "ws-001",
        taskId: "TASK-001",
        cause,
      });
      expect(error.phase).toBe("CREATE_WORKTREE");
      expect(error.workspaceId).toBe("ws-001");
      expect(error.taskId).toBe("TASK-001");
      expect(error.cause).toBe(cause);
    });

    it("preserves reconciliationOutcome", () => {
      const error = new WorkspaceRetryError("test", {
        phase: "RECONCILE_WORKSPACE",
        reconciliationOutcome: "COMPLETE",
      });
      expect(error.reconciliationOutcome).toBe("COMPLETE");
    });

    it("preserves secondaryCause", () => {
      const primary = new Error("git");
      const secondary = new Error("mark failed");
      const error = new WorkspaceRetryError("test", {
        phase: "CREATE_WORKTREE",
        cause: primary,
        secondaryCause: secondary,
      });
      expect(error.cause).toBe(primary);
      expect(error.secondaryCause).toBe(secondary);
    });
  });
});
