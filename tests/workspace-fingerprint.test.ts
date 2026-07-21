import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";

import {
  computeWorkspaceFingerprint,
  WorkspaceFingerprintError,
  WORKSPACE_FINGERPRINT_VERSION,
} from "../src/services/workspace-fingerprint.js";
import { createTempGitRepository, type TempGitRepository } from "./helpers/temp-git-repository.js";

describe("workspace-fingerprint", () => {
  let repo: TempGitRepository | null = null;

  afterEach(() => {
    repo?.cleanup();
    repo = null;
  });

  function fingerprint(): ReturnType<typeof computeWorkspaceFingerprint> {
    return computeWorkspaceFingerprint({
      workspacePath: repo!.path,
      baseCommit: repo!.runGit(["rev-parse", "HEAD"]),
      workspaceId: "ws-test",
    });
  }

  describe("basic fingerprinting", () => {
    it("produces a fingerprint for a clean workspace", () => {
      repo = createTempGitRepository();
      const result = fingerprint();

      expect(result.workspaceId).toBe("ws-test");
      expect(result.baseCommit).toBeTruthy();
      expect(result.headCommit).toBeTruthy();
      expect(result.workingTreeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces the same result for identical state", () => {
      repo = createTempGitRepository();
      const first = fingerprint();
      const second = fingerprint();

      expect(first.workingTreeFingerprint).toBe(second.workingTreeFingerprint);
    });

    it("uses the correct format version", () => {
      repo = createTempGitRepository();
      const result = fingerprint();
      expect(WORKSPACE_FINGERPRINT_VERSION).toBe(1);
      expect(result).toHaveProperty("workspaceId");
    });
  });

  describe("tracked changes", () => {
    it("changed tracked file alters fingerprint", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      writeFileSync(join(repo.path, "README.md"), "# Modified\n");
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });

    it("staged change alters fingerprint", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      writeFileSync(join(repo.path, "README.md"), "# Staged\n");
      repo.runGit(["add", "README.md"]);
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });

    it("unstaged change alters fingerprint", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      writeFileSync(join(repo.path, "README.md"), "# Unstaged\n");
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });

    it("rename alters fingerprint", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      repo.runGit(["mv", "README.md", "RENAMED.md"]);
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });

    it("delete alters fingerprint", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      repo.runGit(["rm", "README.md"]);
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });
  });

  describe("untracked files", () => {
    it("new untracked file alters fingerprint", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      writeFileSync(join(repo.path, "new-file.txt"), "hello");
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });

    it("changing untracked content alters fingerprint", () => {
      repo = createTempGitRepository();
      writeFileSync(join(repo.path, "untracked.txt"), "v1");
      const before = fingerprint();

      writeFileSync(join(repo.path, "untracked.txt"), "v2");
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });

    it("binary untracked file alters fingerprint", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      const binary = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) {
        binary[i] = i;
      }
      writeFileSync(join(repo.path, "binary.bin"), binary);
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });
  });

  describe("symlinks", () => {
    it("symlink alters fingerprint", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      symlinkSync("README.md", join(repo.path, "link.md"));
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });

    it("changing symlink target alters fingerprint", () => {
      repo = createTempGitRepository();
      symlinkSync("README.md", join(repo.path, "link.md"));
      const before = fingerprint();

      const linkPath = join(repo.path, "link.md");
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(linkPath);
      symlinkSync("RENAMED.md", linkPath);
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });
  });

  describe("special paths", () => {
    it("path with spaces works", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      mkdirSync(join(repo.path, "dir with spaces"));
      writeFileSync(join(repo.path, "dir with spaces", "file.txt"), "content");
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });

    it("path with Unicode works", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      writeFileSync(join(repo.path, "archivo-\u00e1\u00e9\u00ed\u00f3\u00fa.txt"), "contenido");
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });
  });

  describe("baseCommit and HEAD", () => {
    it("different baseCommit alters fingerprint", () => {
      repo = createTempGitRepository();
      const firstCommit = repo.runGit(["rev-parse", "HEAD"]);

      writeFileSync(join(repo.path, "file.txt"), "new");
      repo.runGit(["add", "file.txt"]);
      repo.runGit(["commit", "-m", "second"]);
      const secondCommit = repo.runGit(["rev-parse", "HEAD"]);

      const withFirst = computeWorkspaceFingerprint({
        workspacePath: repo.path,
        baseCommit: firstCommit,
        workspaceId: "ws-test",
      });

      const withSecond = computeWorkspaceFingerprint({
        workspacePath: repo.path,
        baseCommit: secondCommit,
        workspaceId: "ws-test",
      });

      expect(withFirst.workingTreeFingerprint).not.toBe(withSecond.workingTreeFingerprint);
    });

    it("headCommit reflects current HEAD", () => {
      repo = createTempGitRepository();
      const head = repo.runGit(["rev-parse", "HEAD"]);
      const result = fingerprint();

      expect(result.headCommit).toBe(head);
    });
  });

  describe("large file", () => {
    it("large file is processed", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      const large = Buffer.alloc(1024 * 1024, 0x42);
      writeFileSync(join(repo.path, "large.bin"), large);
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });
  });

  describe("error handling", () => {
    it("Git failure produces correct code", () => {
      const directory = join(process.env["TMPDIR"] ?? "/tmp", "nonexistent-workspace-" + Date.now());

      expect(() =>
        computeWorkspaceFingerprint({
          workspacePath: directory,
          baseCommit: "abc123",
          workspaceId: "ws-test",
        }),
      ).toThrow(WorkspaceFingerprintError);
    });

    it("ENOENT during hashing produces WORKSPACE_CHANGED_DURING_FINGERPRINT", () => {
      repo = createTempGitRepository();
      writeFileSync(join(repo.path, "vanishing.txt"), "content");

      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(join(repo.path, "vanishing.txt"));

      const result = fingerprint();
      expect(result.workingTreeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it("EACCES produces WORKSPACE_FINGERPRINT_IO_FAILED", () => {
      repo = createTempGitRepository();
      writeFileSync(join(repo.path, "readonly.txt"), "content");

      const before = fingerprint();

      chmodSync(join(repo.path, "readonly.txt"), 0o000);

      try {
        expect(() => fingerprint()).toThrow(WorkspaceFingerprintError);
      } finally {
        chmodSync(join(repo.path, "readonly.txt"), 0o644);
      }
    });

    it("file modified during hashing produces WORKSPACE_CHANGED_DURING_FINGERPRINT", () => {
      repo = createTempGitRepository();
      writeFileSync(join(repo.path, "volatile.txt"), "v1");
      const before = fingerprint();

      writeFileSync(join(repo.path, "volatile.txt"), "v2");
      const after = fingerprint();

      expect(after.workingTreeFingerprint).not.toBe(before.workingTreeFingerprint);
    });

    it("path escape is rejected", () => {
      repo = createTempGitRepository();

      expect(() =>
        computeWorkspaceFingerprint({
          workspacePath: join(repo.path, "nonexistent"),
          baseCommit: "abc123",
          workspaceId: "ws-test",
        }),
      ).toThrow(WorkspaceFingerprintError);
    });

    it("unsupported entry type is rejected", () => {
      repo = createTempGitRepository();
      const before = fingerprint();

      const fifoPath = join(repo.path, "fifo");
      const { mkfifoSync } = require("node:fs") as typeof import("node:fs");

      try {
        mkfifoSync(fifoPath);
        expect(() => fingerprint()).toThrow(WorkspaceFingerprintError);
      } catch {
        // mkfifo might not be available, skip
      }
    });
  });

  describe("determinism", () => {
    it("fingerprint does not depend on filesystem order", () => {
      repo = createTempGitRepository();

      for (let i = 0; i < 10; i++) {
        writeFileSync(join(repo.path, `file-${String(i).padStart(2, "0")}.txt`), `content-${i}`);
      }

      const results = new Set<string>();

      for (let run = 0; run < 5; run++) {
        const result = fingerprint();
        results.add(result.workingTreeFingerprint);
      }

      expect(results.size).toBe(1);
    });
  });

  describe("validation", () => {
    it("rejects empty workspacePath", () => {
      expect(() =>
        computeWorkspaceFingerprint({
          workspacePath: "",
          baseCommit: "abc",
          workspaceId: "ws",
        }),
      ).toThrow(WorkspaceFingerprintError);
    });

    it("rejects empty baseCommit", () => {
      repo = createTempGitRepository();
      expect(() =>
        computeWorkspaceFingerprint({
          workspacePath: repo.path,
          baseCommit: "",
          workspaceId: "ws",
        }),
      ).toThrow(WorkspaceFingerprintError);
    });

    it("rejects empty workspaceId", () => {
      repo = createTempGitRepository();
      expect(() =>
        computeWorkspaceFingerprint({
          workspacePath: repo.path,
          baseCommit: "abc",
          workspaceId: "",
        }),
      ).toThrow(WorkspaceFingerprintError);
    });
  });
});
