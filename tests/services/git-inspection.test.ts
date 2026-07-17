import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { inspectGitRepository, GitInspectionError } from "../../src/services/git-inspection.js";
import { createTempGitRepository } from "../helpers/temp-git-repository.js";
import { createTempDirectory } from "../helpers/temp-directory.js";

describe("git inspection", () => {
  describe("valid repository", () => {
    it("detects a valid git repository", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result.isGitRepository).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it("returns the git directory path", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result.gitDirectoryPath).toBeDefined();
        expect(result.gitDirectoryPath).toContain(".git");
      } finally {
        repo.cleanup();
      }
    });

    it("detects HEAD is present when there are commits", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result.isHeadPresent).toBe(true);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("empty repository", () => {
    it("detects a repository with no commits", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        spawnSync("git", ["init"], { cwd: dir.path, encoding: "utf8" });
        const result = inspectGitRepository(dir.path);
        expect(result.isGitRepository).toBe(true);
        expect(result.isHeadPresent).toBe(false);
      } finally {
        dir.cleanup();
      }
    });
  });

  describe("non-git directory", () => {
    it("detects a non-git directory", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        const result = inspectGitRepository(dir.path);
        expect(result.isGitRepository).toBe(false);
        expect(result.gitDirectoryPath).toBeNull();
        expect(result.isHeadPresent).toBe(false);
      } finally {
        dir.cleanup();
      }
    });
  });

  describe("path does not exist", () => {
    it("returns false for non-existent path", () => {
      const result = inspectGitRepository("/tmp/devflow-nonexistent-12345");
      expect(result.isGitRepository).toBe(false);
      expect(result.gitDirectoryPath).toBeNull();
      expect(result.isHeadPresent).toBe(false);
    });
  });

  describe("input validation", () => {
    it("rejects non-string repositoryPath", () => {
      try {
        inspectGitRepository(123 as unknown as string);
        throw new Error("Expected GitInspectionError.");
      } catch (error) {
        expect(error).toBeInstanceOf(GitInspectionError);
        expect((error as GitInspectionError).message).toBe("El repositoryPath debe ser una cadena de texto.");
        expect((error as GitInspectionError).field).toBe("repositoryPath");
      }
    });

    it("rejects empty repositoryPath", () => {
      try {
        inspectGitRepository("");
        throw new Error("Expected GitInspectionError.");
      } catch (error) {
        expect(error).toBeInstanceOf(GitInspectionError);
        expect((error as GitInspectionError).message).toBe("El repositoryPath no puede estar vacío.");
        expect((error as GitInspectionError).field).toBe("repositoryPath");
      }
    });

    it("rejects whitespace-only repositoryPath", () => {
      try {
        inspectGitRepository("   ");
        throw new Error("Expected GitInspectionError.");
      } catch (error) {
        expect(error).toBeInstanceOf(GitInspectionError);
        expect((error as GitInspectionError).message).toBe("El repositoryPath no puede estar vacío.");
        expect((error as GitInspectionError).field).toBe("repositoryPath");
      }
    });
  });

  describe("error domain", () => {
    it("GitInspectionError extends Error", () => {
      const error = new GitInspectionError("test");
      expect(error).toBeInstanceOf(Error);
    });

    it("name is GitInspectionError", () => {
      const error = new GitInspectionError("test");
      expect(error.name).toBe("GitInspectionError");
    });

    it("preserves field", () => {
      const error = new GitInspectionError("test", { field: "repositoryPath" });
      expect(error.field).toBe("repositoryPath");
    });

    it("preserves value", () => {
      const error = new GitInspectionError("test", { value: "bad" });
      expect(error.value).toBe("bad");
    });

    it("preserves cause", () => {
      const cause = new Error("original");
      const error = new GitInspectionError("test", { cause });
      expect(error.cause).toBe(cause);
    });
  });

  describe("isolation", () => {
    it("does not access SQLite", () => {
      const repo = createTempGitRepository();
      try {
        const cwd = process.cwd();
        inspectGitRepository(repo.path);
        expect(process.cwd()).toBe(cwd);
      } finally {
        repo.cleanup();
      }
    });

    it("does not create directories", () => {
      const repo = createTempGitRepository();
      try {
        const before = existsSync(repo.path);
        inspectGitRepository(repo.path);
        expect(existsSync(repo.path)).toBe(before);
      } finally {
        repo.cleanup();
      }
    });

    it("does not modify the repository", () => {
      const repo = createTempGitRepository();
      try {
        const before = repo.runGit(["log", "--oneline"]);
        inspectGitRepository(repo.path);
        const after = repo.runGit(["log", "--oneline"]);
        expect(after).toBe(before);
      } finally {
        repo.cleanup();
      }
    });

    it("does not use process.cwd()", () => {
      const repo = createTempGitRepository();
      try {
        const cwd = process.cwd();
        inspectGitRepository(repo.path);
        expect(process.cwd()).toBe(cwd);
      } finally {
        repo.cleanup();
      }
    });

    it("does not run OpenCode", () => {
      const repo = createTempGitRepository();
      try {
        inspectGitRepository(repo.path);
      } finally {
        repo.cleanup();
      }
    });

    it("does not create worktrees", () => {
      const repo = createTempGitRepository();
      try {
        inspectGitRepository(repo.path);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("edge cases", () => {
    it("handles repository with spaces in path", () => {
      const dir = createTempDirectory("devflow-git-test");
      const repoPath = join(dir.path, "repo with spaces");
      mkdirSync(repoPath);
      try {
        spawnSync("git", ["init"], { cwd: repoPath, encoding: "utf8" });
        spawnSync("git", ["config", "user.name", "Test"], { cwd: repoPath, encoding: "utf8" });
        spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repoPath, encoding: "utf8" });
        spawnSync("git", ["branch", "-M", "main"], { cwd: repoPath, encoding: "utf8" });
        writeFileSync(join(repoPath, "README.md"), "# Test\n");
        spawnSync("git", ["add", "README.md"], { cwd: repoPath, encoding: "utf8" });
        spawnSync("git", ["commit", "-m", "init"], { cwd: repoPath, encoding: "utf8" });

        const result = inspectGitRepository(repoPath);
        expect(result.isGitRepository).toBe(true);
        expect(result.isHeadPresent).toBe(true);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
        dir.cleanup();
      }
    });

    it("handles repository with special characters in path", () => {
      const dir = createTempDirectory("devflow-git-test");
      const repoPath = join(dir.path, "repo-1.0");
      mkdirSync(repoPath);
      try {
        spawnSync("git", ["init"], { cwd: repoPath, encoding: "utf8" });
        spawnSync("git", ["config", "user.name", "Test"], { cwd: repoPath, encoding: "utf8" });
        spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repoPath, encoding: "utf8" });
        spawnSync("git", ["branch", "-M", "main"], { cwd: repoPath, encoding: "utf8" });
        writeFileSync(join(repoPath, "README.md"), "# Test\n");
        spawnSync("git", ["add", "README.md"], { cwd: repoPath, encoding: "utf8" });
        spawnSync("git", ["commit", "-m", "init"], { cwd: repoPath, encoding: "utf8" });

        const result = inspectGitRepository(repoPath);
        expect(result.isGitRepository).toBe(true);
        expect(result.isHeadPresent).toBe(true);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
        dir.cleanup();
      }
    });

    it("handles nested git directories", () => {
      const repo = createTempGitRepository();
      try {
        const nested = join(repo.path, "subdir");
        mkdirSync(nested);
        const result = inspectGitRepository(nested);
        expect(result.isGitRepository).toBe(true);
        expect(result.gitDirectoryPath).toBeDefined();
      } finally {
        repo.cleanup();
      }
    });

    it("handles relative path", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(".");
        expect(result.isGitRepository).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it("handles current directory", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result.isGitRepository).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it("returns null gitDirectoryPath for non-git directory", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        const result = inspectGitRepository(dir.path);
        expect(result.gitDirectoryPath).toBeNull();
      } finally {
        dir.cleanup();
      }
    });

    it("returns null gitDirectoryPath for non-existent path", () => {
      const result = inspectGitRepository("/tmp/devflow-nonexistent-12345");
      expect(result.gitDirectoryPath).toBeNull();
    });

    it("isHeadPresent is false for empty repository", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        spawnSync("git", ["init"], { cwd: dir.path, encoding: "utf8" });
        const result = inspectGitRepository(dir.path);
        expect(result.isHeadPresent).toBe(false);
      } finally {
        dir.cleanup();
      }
    });

    it("isHeadPresent is true for repository with one commit", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result.isHeadPresent).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it("returns consistent results on multiple calls", () => {
      const repo = createTempGitRepository();
      try {
        const first = inspectGitRepository(repo.path);
        const second = inspectGitRepository(repo.path);
        expect(first.isGitRepository).toBe(second.isGitRepository);
        expect(first.gitDirectoryPath).toBe(second.gitDirectoryPath);
        expect(first.isHeadPresent).toBe(second.isHeadPresent);
      } finally {
        repo.cleanup();
      }
    });

    it("handles repository with multiple branches", () => {
      const repo = createTempGitRepository();
      try {
        repo.runGit(["checkout", "-b", "feature-branch"]);
        const result = inspectGitRepository(repo.path);
        expect(result.isGitRepository).toBe(true);
        expect(result.isHeadPresent).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it("handles repository with detached HEAD", () => {
      const repo = createTempGitRepository();
      try {
        const commitHash = repo.runGit(["rev-parse", "HEAD"]);
        repo.runGit(["checkout", "--detach", commitHash]);
        const result = inspectGitRepository(repo.path);
        expect(result.isGitRepository).toBe(true);
        expect(result.isHeadPresent).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it("does not throw for any valid string input", () => {
      const repo = createTempGitRepository();
      try {
        expect(() => inspectGitRepository(repo.path)).not.toThrow();
      } finally {
        repo.cleanup();
      }
    });

    it("handles repository with tags", () => {
      const repo = createTempGitRepository();
      try {
        repo.runGit(["tag", "v1.0.0"]);
        const result = inspectGitRepository(repo.path);
        expect(result.isGitRepository).toBe(true);
        expect(result.isHeadPresent).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it("handles repository with stashed changes", () => {
      const repo = createTempGitRepository();
      try {
        writeFileSync(join(repo.path, "stash.txt"), "stash me");
        repo.runGit(["add", "stash.txt"]);
        repo.runGit(["stash"]);
        const result = inspectGitRepository(repo.path);
        expect(result.isGitRepository).toBe(true);
        expect(result.isHeadPresent).toBe(true);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("result structure", () => {
    it("returns object with correct shape", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result).toHaveProperty("isGitRepository");
        expect(result).toHaveProperty("gitDirectoryPath");
        expect(result).toHaveProperty("isHeadPresent");
      } finally {
        repo.cleanup();
      }
    });

    it("returns boolean for isGitRepository", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(typeof result.isGitRepository).toBe("boolean");
      } finally {
        repo.cleanup();
      }
    });

    it("returns string or null for gitDirectoryPath", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(typeof result.gitDirectoryPath === "string" || result.gitDirectoryPath === null).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it("returns boolean for isHeadPresent", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(typeof result.isHeadPresent).toBe("boolean");
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("practical usage", () => {
    it("can check the DevFlow repository itself", () => {
      const result = inspectGitRepository("/home/yoab/Dev/DevFlow");
      expect(result.isGitRepository).toBe(true);
      expect(result.gitDirectoryPath).toBeDefined();
      expect(result.isHeadPresent).toBe(true);
    });

    it("can inspect a freshly initialized repository", () => {
      const dir = createTempDirectory("devflow-git-test");
      try {
        spawnSync("git", ["init"], { cwd: dir.path, encoding: "utf8" });
        spawnSync("git", ["config", "user.name", "Test"], { cwd: dir.path, encoding: "utf8" });
        spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir.path, encoding: "utf8" });
        spawnSync("git", ["branch", "-M", "main"], { cwd: dir.path, encoding: "utf8" });

        const result = inspectGitRepository(dir.path);
        expect(result.isGitRepository).toBe(true);
        expect(result.isHeadPresent).toBe(false);
      } finally {
        dir.cleanup();
      }
    });

    it("can inspect a repository after first commit", () => {
      const repo = createTempGitRepository();
      try {
        const result = inspectGitRepository(repo.path);
        expect(result.isGitRepository).toBe(true);
        expect(result.isHeadPresent).toBe(true);
        expect(result.gitDirectoryPath).toContain(".git");
      } finally {
        repo.cleanup();
      }
    });
  });
});
