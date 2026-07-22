import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectGitChanges,
  GitChangeDetectionError,
} from "../../src/services/git-change-detector.js";
import type { ChangedFile, GitChangeDetectionResult } from "../../src/services/git-change-detector.js";
import {
  createTempGitRepository,
  type TempGitRepository,
} from "../helpers/temp-git-repository.js";

const H1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const H2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SENTINEL = "0000000000000000000000000000000000000000";

function createFile(repo: TempGitRepository, name: string, content: string): void {
  const fs = require("node:fs");
  const path = require("node:path");
  const filePath = path.join(repo.path, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("detectGitChanges", () => {
  let repo: TempGitRepository;

  afterEach(() => {
    repo?.cleanup();
  });

  describe("input validation", () => {
    it("rejects empty workspacePath", () => {
      expect(() => detectGitChanges("", "abc123")).toThrow(
        "La ruta del workspace no puede estar vacía.",
      );

      const err = (() => {
        try {
          detectGitChanges("", "abc123");
          return null;
        } catch (e) {
          return e;
        }
      })() as GitChangeDetectionError;

      expect(err.code).toBe("INVALID_WORKSPACE_PATH");
      expect(err.name).toBe("GitChangeDetectionError");
    });

    it("rejects whitespace-only workspacePath", () => {
      expect(() => detectGitChanges("   ", "abc123")).toThrow(
        "La ruta del workspace no puede ser solo espacios en blanco.",
      );
    });

    it("rejects empty baseCommit", () => {
      repo = createTempGitRepository();
      expect(() => detectGitChanges(repo.path, "")).toThrow(
        "El commit base no puede estar vacío.",
      );
    });

    it("rejects whitespace-only baseCommit", () => {
      repo = createTempGitRepository();
      expect(() => detectGitChanges(repo.path, "   ")).toThrow(
        "El commit base no puede ser solo espacios en blanco.",
      );
    });

    it("rejects nonexistent workspacePath", () => {
      expect(() => detectGitChanges("/nonexistent/path", "abc123")).toThrow(
        GitChangeDetectionError,
      );
    });

    it("rejects invalid baseCommit", () => {
      repo = createTempGitRepository();
      expect(() => detectGitChanges(repo.path, "nonexistent-ref-xyz")).toThrow(
        GitChangeDetectionError,
      );
    });

    it("returns typed error for nonexistent workspace", () => {
      try {
        detectGitChanges("/nonexistent/path", "abc123");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("GIT_COMMAND_FAILED");
        expect(err.command).toBeDefined();
        expect(err.exitCode).not.toBe(0);
      }
    });
  });

  describe("no changes", () => {
    it("returns empty changedFiles for clean repo", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toEqual([]);
      expect(result.baseCommit).toBe(baseCommit);
    });
  });

  describe("tracked changes", () => {
    it("detects modified file", () => {
      repo = createTempGitRepository();
      createFile(repo, "file.txt", "modified content");
      repo.runGit(["add", "file.txt"]);
      repo.runGit(["commit", "-m", "modify file"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "file.txt", "changed content");

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!.status).toBe("MODIFIED");
      expect(result.changedFiles[0]!.path).toBe("file.txt");
      expect(result.changedFiles[0]!).toEqual(expect.objectContaining({
        path: "file.txt",
        status: "MODIFIED",
        previousMode: "100644",
        currentMode: "100644",
      }));
    });

    it("detects added and staged file", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "new.txt", "new content");
      repo.runGit(["add", "new.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual(expect.objectContaining({
        path: "new.txt",
        status: "ADDED",
        currentMode: "100644",
      }));
    });

    it("detects deleted file", () => {
      repo = createTempGitRepository();
      createFile(repo, "to-delete.txt", "content");
      repo.runGit(["add", "to-delete.txt"]);
      repo.runGit(["commit", "-m", "add file"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["rm", "to-delete.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual(expect.objectContaining({
        path: "to-delete.txt",
        status: "DELETED",
        previousMode: "100644",
      }));
    });

    it("detects multiple files", () => {
      repo = createTempGitRepository();
      createFile(repo, "a.txt", "a");
      createFile(repo, "b.txt", "b");
      repo.runGit(["add", "a.txt", "b.txt"]);
      repo.runGit(["commit", "-m", "add files"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "a.txt", "a changed");
      createFile(repo, "c.txt", "c");
      repo.runGit(["add", "a.txt", "c.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(2);
      const paths = result.changedFiles.map((f) => f.path);
      expect(paths).toContain("a.txt");
      expect(paths).toContain("c.txt");
    });

    it("detects file with spaces in path", () => {
      repo = createTempGitRepository();
      createFile(repo, "dir with spaces/file.txt", "content");
      repo.runGit(["add", "dir with spaces/file.txt"]);
      repo.runGit(["commit", "-m", "add file"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "dir with spaces/file.txt", "changed");

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual(expect.objectContaining({
        path: "dir with spaces/file.txt",
        status: "MODIFIED",
      }));
    });

    it("detects file with non-ASCII characters", () => {
      repo = createTempGitRepository();
      createFile(repo, "archivo-café.txt", "content");
      repo.runGit(["add", "archivo-café.txt"]);
      repo.runGit(["commit", "-m", "add file"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "archivo-café.txt", "changed");

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual(expect.objectContaining({
        path: "archivo-café.txt",
        status: "MODIFIED",
      }));
    });

    it("detects rename with previousPath", () => {
      repo = createTempGitRepository();
      createFile(repo, "old-name.txt", "content");
      repo.runGit(["add", "old-name.txt"]);
      repo.runGit(["commit", "-m", "add file"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["mv", "old-name.txt", "new-name.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual(expect.objectContaining({
        path: "new-name.txt",
        status: "RENAMED",
        previousPath: "old-name.txt",
      }));
    });

    it("preserves exact baseCommit in result", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.baseCommit).toBe(baseCommit);
    });
  });

  describe("mode detection", () => {
    it("detects mode change 100644 to 100755", () => {
      repo = createTempGitRepository();
      createFile(repo, "file.txt", "content");
      repo.runGit(["add", "file.txt"]);
      repo.runGit(["commit", "-m", "add file"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      const fs = require("node:fs");
      const path = require("node:path");
      fs.chmodSync(path.join(repo.path, "file.txt"), 0o755);
      repo.runGit(["add", "file.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual(expect.objectContaining({
        path: "file.txt",
        status: "MODIFIED",
        previousMode: "100644",
        currentMode: "100755",
      }));
    });

    it("detects added executable file", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "script.sh", "#!/bin/bash\necho hi");
      repo.runGit(["add", "script.sh"]);
      const fs = require("node:fs");
      const path = require("node:path");
      fs.chmodSync(path.join(repo.path, "script.sh"), 0o755);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual(expect.objectContaining({
        path: "script.sh",
        status: "ADDED",
        currentMode: "100755",
      }));
    });

    it("detects added symlink", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      const fs = require("node:fs");
      const path = require("node:path");
      fs.symlinkSync("target.txt", path.join(repo.path, "link.txt"));
      repo.runGit(["add", "link.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual(expect.objectContaining({
        path: "link.txt",
        status: "ADDED",
        currentMode: "120000",
      }));
    });

    it("detects mode change with rename", () => {
      repo = createTempGitRepository();
      createFile(repo, "old.txt", "content");
      repo.runGit(["add", "old.txt"]);
      repo.runGit(["commit", "-m", "add file"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["mv", "old.txt", "new.txt"]);
      const fs = require("node:fs");
      const path = require("node:path");
      fs.chmodSync(path.join(repo.path, "new.txt"), 0o755);
      repo.runGit(["add", "new.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual(expect.objectContaining({
        path: "new.txt",
        status: "RENAMED",
        previousPath: "old.txt",
        previousMode: "100644",
        currentMode: "100755",
      }));
    });
  });

  describe("object ID detection", () => {
    it("DELETED includes previousObjectId", () => {
      repo = createTempGitRepository();
      createFile(repo, "file.txt", "content");
      repo.runGit(["add", "file.txt"]);
      repo.runGit(["commit", "-m", "init"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["rm", "file.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      const file = result.changedFiles[0]!;
      expect(file.status).toBe("DELETED");
      expect(file).toEqual(expect.objectContaining({
        previousObjectId: expect.stringMatching(/^[0-9a-f]{40}$/),
      }));
    });

    it("RENAMED includes previousObjectId and similarityScore", () => {
      repo = createTempGitRepository();
      createFile(repo, "old.txt", "content");
      repo.runGit(["add", "old.txt"]);
      repo.runGit(["commit", "-m", "init"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["mv", "old.txt", "new.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      const file = result.changedFiles[0]!;
      expect(file.status).toBe("RENAMED");
      expect(file).toEqual(expect.objectContaining({
        previousObjectId: expect.stringMatching(/^[0-9a-f]{40}$/),
        similarityScore: 100,
      }));
    });

    it("MODIFIED includes previousObjectId", () => {
      repo = createTempGitRepository();
      createFile(repo, "file.txt", "content");
      repo.runGit(["add", "file.txt"]);
      repo.runGit(["commit", "-m", "init"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "file.txt", "changed");

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      const file = result.changedFiles[0]!;
      expect(file.status).toBe("MODIFIED");
      expect(file).toEqual(expect.objectContaining({
        previousObjectId: expect.stringMatching(/^[0-9a-f]{40}$/),
      }));
    });

    it("object IDs are lowercase hex without zero sentinel", () => {
      repo = createTempGitRepository();
      createFile(repo, "file.txt", "content");
      repo.runGit(["add", "file.txt"]);
      repo.runGit(["commit", "-m", "init"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "file.txt", "changed");

      const result = detectGitChanges(repo.path, baseCommit);

      const file = result.changedFiles[0]!;
      if (file.status === "MODIFIED") {
        expect(file.previousObjectId).toMatch(/^[0-9a-f]{40}$/);
        expect(file.previousObjectId).not.toBe("0".repeat(40));
      }
      if (file.status === "DELETED") {
        expect(file.previousObjectId).toMatch(/^[0-9a-f]{40}$/);
        expect(file.previousObjectId).not.toBe("0".repeat(40));
      }
    });

    it("ADDED does not include currentObjectId", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "new.txt", "content");
      repo.runGit(["add", "new.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      const file = result.changedFiles[0]!;
      expect(file.status).toBe("ADDED");
      expect("currentObjectId" in file).toBe(false);
    });

    it("MODIFIED does not include currentObjectId", () => {
      repo = createTempGitRepository();
      createFile(repo, "file.txt", "content");
      repo.runGit(["add", "file.txt"]);
      repo.runGit(["commit", "-m", "init"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "file.txt", "changed");

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      const file = result.changedFiles[0]!;
      expect(file.status).toBe("MODIFIED");
      expect("currentObjectId" in file).toBe(false);
    });

    it("RENAMED does not include currentObjectId", () => {
      repo = createTempGitRepository();
      createFile(repo, "old.txt", "content");
      repo.runGit(["add", "old.txt"]);
      repo.runGit(["commit", "-m", "init"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["mv", "old.txt", "new.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      const file = result.changedFiles[0]!;
      expect(file.status).toBe("RENAMED");
      expect("currentObjectId" in file).toBe(false);
    });
  });

  describe("untracked files", () => {
    it("detects single untracked file", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "untracked.txt", "content");

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual({
        path: "untracked.txt",
        status: "UNTRACKED",
        currentMode: "100644",
      });
    });

    it("detects multiple untracked files", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "a.txt", "content");
      createFile(repo, "b.txt", "content");

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(2);
      const paths = result.changedFiles.map((f) => f.path);
      expect(paths).toContain("a.txt");
      expect(paths).toContain("b.txt");
    });

    it("detects untracked file in nested directory", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "src/deep/nested/file.txt", "content");

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual({
        path: "src/deep/nested/file.txt",
        status: "UNTRACKED",
        currentMode: "100644",
      });
    });

    it("detects untracked file with spaces", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "file with spaces.txt", "content");

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual({
        path: "file with spaces.txt",
        status: "UNTRACKED",
        currentMode: "100644",
      });
    });

    it("ignores files in .gitignore", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, ".gitignore", "ignored.log\n");
      createFile(repo, "ignored.log", "content");
      repo.runGit(["add", ".gitignore"]);
      repo.runGit(["commit", "-m", "add gitignore"]);

      createFile(repo, "not-ignored.txt", "content");

      const result = detectGitChanges(repo.path, baseCommit);

      const paths = result.changedFiles.map((f) => f.path);
      expect(paths).not.toContain("ignored.log");
      expect(paths).toContain("not-ignored.txt");
    });

    it("detects untracked executable file", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "script.sh", "#!/bin/bash\necho hi");
      const fs = require("node:fs");
      const path = require("node:path");
      fs.chmodSync(path.join(repo.path, "script.sh"), 0o755);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual({
        path: "script.sh",
        status: "UNTRACKED",
        currentMode: "100755",
      });
    });

    it("detects untracked symlink", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      const fs = require("node:fs");
      const path = require("node:path");
      fs.symlinkSync("target.txt", path.join(repo.path, "link.txt"));

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual({
        path: "link.txt",
        status: "UNTRACKED",
        currentMode: "120000",
      });
    });

    it("fails closed on lstat ENOENT", () => {
      const tracked = "";
      const untracked = "ghost.txt\0";
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;
        if (callCount === 1) {
          return { stdout: tracked, stderr: "", exitCode: 0, signal: null };
        }
        return { stdout: untracked, stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_UNTRACKED_OUTPUT");
      }
    });

    it("fails closed on lstat EACCES", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "git-test-"));
      const blockedDir = join(tmpDir, "blocked");
      mkdirSync(blockedDir, { recursive: true, mode: 0o000 });
      try {
        const tracked = "";
        const untracked = "blocked/secret.txt\0";
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: tracked, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: untracked, stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges(tmpDir, "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_UNTRACKED_OUTPUT");
        }
      } finally {
        chmodSync(blockedDir, 0o755);
        rmSync(tmpDir, { recursive: true });
      }
    });

    it("fails closed on unsupported entry type (directory)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "git-test-"));
      mkdirSync(join(tmpDir, "subdir"), { recursive: true });
      try {
        const tracked = "";
        const untracked = "subdir\0";
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: tracked, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: untracked, stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges(tmpDir, "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("UNSUPPORTED_GIT_STATUS");
        }
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it("detects untracked non-executable regular file", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "regular.txt", "content");

      const result = detectGitChanges(repo.path, baseCommit);
      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual({
        path: "regular.txt",
        status: "UNTRACKED",
        currentMode: "100644",
      });
    });

    it("detects untracked executable regular file", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "script.sh", "#!/bin/bash");
      chmodSync(join(repo.path, "script.sh"), 0o755);

      const result = detectGitChanges(repo.path, baseCommit);
      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!).toEqual({
        path: "script.sh",
        status: "UNTRACKED",
        currentMode: "100755",
      });
    });
  });

  describe("tracked + untracked combined", () => {
    it("detects both tracked and untracked changes", () => {
      repo = createTempGitRepository();
      createFile(repo, "tracked.txt", "content");
      repo.runGit(["add", "tracked.txt"]);
      repo.runGit(["commit", "-m", "add tracked"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "tracked.txt", "changed");
      createFile(repo, "untracked.txt", "new");

      const result = detectGitChanges(repo.path, baseCommit);

      expect(result.changedFiles).toHaveLength(2);
      const tracked = result.changedFiles.find((f) => f.path === "tracked.txt");
      const untracked = result.changedFiles.find((f) => f.path === "untracked.txt");

      expect(tracked).toEqual(expect.objectContaining({ path: "tracked.txt", status: "MODIFIED" }));
      expect(untracked).toEqual({ path: "untracked.txt", status: "UNTRACKED", currentMode: "100644" });
    });
  });

  describe("deterministic order", () => {
    it("returns files sorted by path", () => {
      repo = createTempGitRepository();
      createFile(repo, "z.txt", "z");
      createFile(repo, "a.txt", "a");
      createFile(repo, "m.txt", "m");
      repo.runGit(["add", "z.txt", "a.txt", "m.txt"]);
      repo.runGit(["commit", "-m", "add files"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "z.txt", "z changed");
      createFile(repo, "a.txt", "a changed");
      createFile(repo, "m.txt", "m changed");

      const result = detectGitChanges(repo.path, baseCommit);

      const paths = result.changedFiles.map((f) => f.path);
      expect(paths).toEqual(["a.txt", "m.txt", "z.txt"]);
    });

    it("same input produces same output on multiple calls", () => {
      repo = createTempGitRepository();
      createFile(repo, "file.txt", "content");
      repo.runGit(["add", "file.txt"]);
      repo.runGit(["commit", "-m", "add file"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "file.txt", "changed");

      const result1 = detectGitChanges(repo.path, baseCommit);
      const result2 = detectGitChanges(repo.path, baseCommit);

      expect(result1.changedFiles).toEqual(result2.changedFiles);
    });

    it("deterministic order with non-ASCII uses code unit comparison", () => {
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;
        if (callCount === 1) {
          return {
            stdout: `:100644 100644 ${H1} ${H2} M\0b.txt\0:100644 100644 ${H1} ${H2} M\0a.txt\0:100644 100644 ${H1} ${H2} M\0z.txt\0`,
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      const result = detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });

      const paths = result.changedFiles.map((f) => f.path);
      expect(paths).toEqual(["a.txt", "b.txt", "z.txt"]);

      callCount = 0;
      const fakeRunGit2 = (): GitCommandResult => {
        callCount += 1;
        if (callCount === 1) {
          return {
            stdout: `:100644 100644 ${H1} ${H2} M\0\u00e9.txt\0:100644 100644 ${H1} ${H2} M\0\u00e0.txt\0`,
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      const result2 = detectGitChanges("/repo", "abc123", { runGit: fakeRunGit2 });
      const paths2 = result2.changedFiles.map((f) => f.path);

      const eCode = "\u00e9".charCodeAt(0);
      const aCode = "\u00e0".charCodeAt(0);
      if (aCode < eCode) {
        expect(paths2).toEqual(["\u00e0.txt", "\u00e9.txt"]);
      } else {
        expect(paths2).toEqual(["\u00e9.txt", "\u00e0.txt"]);
      }
    });
  });

  describe("contract", () => {
    it("ADDED has exactly: path, status, currentMode", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "new.txt", "content");
      repo.runGit(["add", "new.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      const file = result.changedFiles[0]!;
      expect(file.status).toBe("ADDED");
      expect(Object.keys(file)).toEqual(["path", "status", "currentMode"]);
    });

    it("MODIFIED has exactly: path, status, previousMode, currentMode, previousObjectId", () => {
      repo = createTempGitRepository();
      createFile(repo, "file.txt", "content");
      repo.runGit(["add", "file.txt"]);
      repo.runGit(["commit", "-m", "init"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "file.txt", "changed");

      const result = detectGitChanges(repo.path, baseCommit);

      const file = result.changedFiles[0]!;
      expect(file.status).toBe("MODIFIED");
      expect(Object.keys(file)).toEqual(["path", "status", "previousMode", "currentMode", "previousObjectId"]);
    });

    it("DELETED has exactly: path, status, previousMode, previousObjectId", () => {
      repo = createTempGitRepository();
      createFile(repo, "file.txt", "content");
      repo.runGit(["add", "file.txt"]);
      repo.runGit(["commit", "-m", "init"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["rm", "file.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      const file = result.changedFiles[0]!;
      expect(file.status).toBe("DELETED");
      expect(Object.keys(file)).toEqual(["path", "status", "previousMode", "previousObjectId"]);
    });

    it("RENAMED has exactly: path, status, previousPath, previousMode, currentMode, previousObjectId, similarityScore", () => {
      repo = createTempGitRepository();
      createFile(repo, "old.txt", "content");
      repo.runGit(["add", "old.txt"]);
      repo.runGit(["commit", "-m", "init"]);
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      repo.runGit(["mv", "old.txt", "new.txt"]);

      const result = detectGitChanges(repo.path, baseCommit);

      const file = result.changedFiles[0]!;
      expect(file.status).toBe("RENAMED");
      expect(Object.keys(file)).toEqual(["path", "status", "previousPath", "previousMode", "currentMode", "previousObjectId", "similarityScore"]);
    });

    it("UNTRACKED has exactly: path, status, currentMode", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      createFile(repo, "untracked.txt", "content");

      const result = detectGitChanges(repo.path, baseCommit);

      const file = result.changedFiles[0]!;
      expect(file.status).toBe("UNTRACKED");
      expect(Object.keys(file)).toEqual(["path", "status", "currentMode"]);
    });

    it("changedFiles is readonly", () => {
      repo = createTempGitRepository();
      const baseCommit = repo.runGit(["rev-parse", "HEAD"]);

      const result = detectGitChanges(repo.path, baseCommit);

      expect(Array.isArray(result.changedFiles)).toBe(true);
    });
  });

  describe("error handling with injected runGit", () => {
    it("wraps Git not found error", () => {
      const failingRunGit = (): never => {
        throw new Error("spawnSync git ENOENT");
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: failingRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("GIT_NOT_FOUND");
        expect(err.cause).toBeDefined();
      }
    });

    it("wraps Git command failure with exit code", () => {
      const failingRunGit = (): GitCommandResult => ({
        stdout: "",
        stderr: "fatal: not a git repository",
        exitCode: 128,
        signal: null,
      });

      try {
        detectGitChanges("/repo", "abc123", { runGit: failingRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("GIT_COMMAND_FAILED");
        expect(err.exitCode).toBe(128);
        expect(err.stderrPreview).toBe("fatal: not a git repository");
      }
    });

    it("rejects unsupported status character", () => {
      const fakeOutput = `:100644 100644 ${H1} ${H2} X\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("UNSUPPORTED_GIT_STATUS");
      }
    });

    it("rejects copy status", () => {
      const fakeOutput = `:100644 100644 ${H1} ${H2} C100\0src.txt\0dst.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("UNSUPPORTED_GIT_STATUS");
      }
    });

    it("rejects type change T", () => {
      const fakeOutput = `:100644 120000 ${H1} ${H2} T\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("UNSUPPORTED_GIT_TYPE_CHANGE");
      }
    });

    it("rejects unsupported mode 160000", () => {
      const fakeOutput = `:160000 160000 ${H1} ${H2} M\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("UNSUPPORTED_GIT_STATUS");
      }
    });

    it("rejects unsupported mode 999999", () => {
      const fakeOutput = `:999999 100644 ${H1} ${H2} M\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("UNSUPPORTED_GIT_STATUS");
      }
    });

    it("ADDED accepts raw output with zero object IDs (git working tree)", () => {
      const fakeOutput = `:000000 100644 ${SENTINEL} ${SENTINEL} A\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      const result = detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
      expect(result.changedFiles).toHaveLength(1);
      expect(result.changedFiles[0]!.status).toBe("ADDED");
    });

    it("rejects non-hex object ID", () => {
      const fakeOutput = `:100644 100644 zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz ${H2} M\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
      }
    });

    it("rejects object ID with 39 characters (too short for SHA-1)", () => {
      const short = "a".repeat(39);
      const fakeOutput = `:100644 100644 ${short} ${H2} M\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;
        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        expect(err.message).toContain("longitud");
      }
    });

    it("rejects object ID with 41 characters (too long for SHA-1)", () => {
      const long = "a".repeat(41);
      const fakeOutput = `:100644 100644 ${long} ${H2} M\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;
        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        expect(err.message).toContain("longitud");
      }
    });

    it("rejects object ID with 63 characters (too short for SHA-256)", () => {
      const short64 = "a".repeat(63);
      const fakeOutput = `:100644 100644 ${short64} ${H2} M\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;
        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        expect(err.message).toContain("longitud");
      }
    });

    it("rejects object ID with 65 characters (too long for SHA-256)", () => {
      const long64 = "a".repeat(65);
      const fakeOutput = `:100644 100644 ${long64} ${H2} M\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;
        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        expect(err.message).toContain("longitud");
      }
    });

    it("accepts valid 64-character hex object ID (SHA-256)", () => {
      const id64 = "a".repeat(64);
      const zeroSentinel64 = "0".repeat(64);
      const fakeOutput = `:100644 100644 ${id64} ${zeroSentinel64} M\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;
        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      const result = detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
      expect(result.changedFiles).toHaveLength(1);
      const file = result.changedFiles[0]!;
      expect(file.status).toBe("MODIFIED");
      expect(file).toEqual(expect.objectContaining({ previousObjectId: id64 }));
      expect("currentObjectId" in file).toBe(false);
    });

    it("rejects zero sentinel as old object ID with 64 characters", () => {
      const zero64 = "0".repeat(64);
      const fakeOutput = `:100644 100644 ${zero64} ${H2} M\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;
        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
      }
    });

    it("rejects rename without both paths", () => {
      const fakeOutput = `:100644 100644 ${H1} ${H2} R100\0only-one-path\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
      }
    });

    it("rejects rename with invalid score R-1", () => {
      const fakeOutput = `:100644 100644 ${H1} ${H2} R-1\0old.txt\0new.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("UNSUPPORTED_GIT_STATUS");
      }
    });

    it("rejects rename with score > 100", () => {
      const fakeOutput = `:100644 100644 ${H1} ${H2} R101\0old.txt\0new.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("UNSUPPORTED_GIT_STATUS");
      }
    });

    it("rejects rename without score R", () => {
      const fakeOutput = `:100644 100644 ${H1} ${H2} R\0old.txt\0new.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("UNSUPPORTED_GIT_STATUS");
      }
    });

    it("rejects absolute path in tracked output", () => {
      const fakeOutput = `:100644 100644 ${H1} ${H2} M\0/absolute/path.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
      }
    });

    it("rejects path with .. segment", () => {
      const fakeOutput = `:100644 100644 ${H1} ${H2} M\0../../etc/passwd\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
      }
    });

    it("rejects path with ./ prefix", () => {
      const fakeOutput = `:100644 100644 ${H1} ${H2} M\0./file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
      }
    });

    it("rejects path with //", () => {
      const fakeOutput = `:100644 100644 ${H1} ${H2} M\0path//double\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
      }
    });

    it("rejects duplicate path", () => {
      const tracked = `:100644 100644 ${H1} ${H2} M\0file.txt\0:100644 100644 ${H1} ${H2} M\0file.txt\0`;
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: tracked, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("DUPLICATE_CHANGED_PATH");
      }
    });

    it("rejects empty tracked output with invalid structure", () => {
      const fakeOutput = "M\0";
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;

        if (callCount === 1) {
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        }

        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      try {
        detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        const err = error as GitChangeDetectionError;
        expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
      }
    });

    it("returns empty result for empty tracked and untracked output", () => {
      let callCount = 0;
      const fakeRunGit = (): GitCommandResult => {
        callCount += 1;
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      };

      const result = detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });

      expect(result.changedFiles).toEqual([]);
      expect(result.baseCommit).toBe("abc123");
    });

    describe("tracked output NUL strictness", () => {
      it("rejects tracked output not ending in NUL", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0file.txt`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        }
      });

      it("rejects tracked output with NUL duplicate (double NUL)", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0file.txt\0\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        }
      });

      it("rejects tracked output with intermediate empty token", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0\0file.txt\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        }
      });
    });

    describe("untracked output NUL strictness", () => {
      it("rejects untracked output not ending in NUL", () => {
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: "", stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "file.txt", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_UNTRACKED_OUTPUT");
        }
      });

      it("rejects untracked output with NUL duplicate (double NUL)", () => {
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: "", stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "file.txt\0\0", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_UNTRACKED_OUTPUT");
        }
      });

      it("rejects untracked output with intermediate empty token", () => {
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: "", stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "\0file.txt\0", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_UNTRACKED_OUTPUT");
        }
      });

      it("untracked path error uses INVALID_UNTRACKED_OUTPUT", () => {
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: "", stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "/absolute\0", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_UNTRACKED_OUTPUT");
        }
      });
    });

    describe("path validation edge cases", () => {
      it("rejects path '.'", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0.\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        }
      });

      it("rejects path with backslash", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0dir\\file.txt\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        }
      });

      it("rejects path with trailing slash", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0dir/\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        }
      });

      it("accepts path with . segment (dir/./file)", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0dir/./file.txt\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        const result = detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect(result.changedFiles).toHaveLength(1);
        expect(result.changedFiles[0]!.path).toBe("dir/./file.txt");
      });

      it("rejects path with .. segment (a/../b)", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0a/../b/file.txt\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        }
      });

      it("rejects path with backslash + n (not a Git escape in raw format)", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0file\\nname.txt\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        }
      });

      it("rejects path with backslash + t (not a Git escape in raw format)", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0file\\tname.txt\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.code).toBe("INVALID_TRACKED_OUTPUT");
        }
      });

      it("accepts path with literal newline character", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0file\nname.txt\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        const result = detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect(result.changedFiles).toHaveLength(1);
        expect(result.changedFiles[0]!.path).toBe("file\nname.txt");
      });

      it("accepts path with literal tab character", () => {
        const fakeOutput = `:100644 100644 ${H1} ${H2} M\0file\tname.txt\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        const result = detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
        expect(result.changedFiles).toHaveLength(1);
        expect(result.changedFiles[0]!.path).toBe("file\tname.txt");
      });
    });

    describe("error strengthening", () => {
      it("tracked parser error: correct class, name, code, message, no wrapper", () => {
        const fakeOutput = `:${SENTINEL} ${H1} ${SENTINEL} ${H1} X\0file.txt\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.name).toBe("GitChangeDetectionError");
          expect(err.code).toBe("UNSUPPORTED_GIT_STATUS");
          expect(typeof err.message).toBe("string");
          expect(err.message.length).toBeGreaterThan(0);
        }
      });

      it("untracked parser error: correct class, name, code, message, no wrapper", () => {
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: "", stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: "/absolute\0", stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(GitChangeDetectionError);
          const err = error as GitChangeDetectionError;
          expect(err.name).toBe("GitChangeDetectionError");
          expect(err.code).toBe("INVALID_UNTRACKED_OUTPUT");
          expect(typeof err.message).toBe("string");
          expect(err.message.length).toBeGreaterThan(0);
        }
      });

      it("tracked parser does not run untracked command on error", () => {
        const fakeOutput = `:${SENTINEL} ${H1} ${SENTINEL} ${H1} X\0file.txt\0`;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          return { stdout: fakeOutput, stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch {
          expect(callCount).toBe(1);
        }
      });

      it("error does not mutate injected output", () => {
        const trackedOutput = `:${SENTINEL} ${H1} ${SENTINEL} ${H1} X\0file.txt\0`;
        const untrackedOutput = "file.txt\0";
        const trackedRef = trackedOutput;
        const untrackedRef = untrackedOutput;
        let callCount = 0;
        const fakeRunGit = (): GitCommandResult => {
          callCount += 1;
          if (callCount === 1) {
            return { stdout: trackedRef, stderr: "", exitCode: 0, signal: null };
          }
          return { stdout: untrackedRef, stderr: "", exitCode: 0, signal: null };
        };

        try {
          detectGitChanges("/repo", "abc123", { runGit: fakeRunGit });
          expect.fail("Should have thrown");
        } catch {
          expect(trackedRef).toBe(trackedOutput);
          expect(untrackedRef).toBe(untrackedOutput);
        }
      });
    });
  });

  describe("metadata", () => {
    it("error has correct name property", () => {
      try {
        detectGitChanges("", "abc");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(GitChangeDetectionError);
        expect((error as GitChangeDetectionError).name).toBe("GitChangeDetectionError");
      }
    });

    it("error preserves command in metadata", () => {
      const failingRunGit = (): GitCommandResult => ({
        stdout: "",
        stderr: "fatal: not a git repository",
        exitCode: 128,
        signal: null,
      });

      try {
        detectGitChanges("/repo", "abc123", { runGit: failingRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        const err = error as GitChangeDetectionError;
        expect(err.command).toBeDefined();
        expect(err.command!.length).toBeGreaterThan(0);
      }
    });

    it("error truncates stderr preview", () => {
      const longStderr = "x".repeat(500);
      const failingRunGit = (): GitCommandResult => ({
        stdout: "",
        stderr: longStderr,
        exitCode: 1,
        signal: null,
      });

      try {
        detectGitChanges("/repo", "abc123", { runGit: failingRunGit });
        expect.fail("Should have thrown");
      } catch (error) {
        const err = error as GitChangeDetectionError;
        expect(err.stderrPreview).toBeDefined();
        expect(err.stderrPreview!.length).toBeLessThanOrEqual(200);
      }
    });
  });
});
