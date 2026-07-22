import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { evidenceBundleBodySchema } from "../../src/schemas/evidence-bundle-schema.js";
import type { EvidenceBundleBody, EvidenceFile } from "../../src/schemas/evidence-bundle-schema.js";
import {
  collectEvidenceFiles,
  EvidenceFileCollectorError,
  type EvidenceFileCollectorDeps,
  type EvidenceFileCollectorErrorCode,
  type EvidenceFileStat,
} from "../../src/services/evidence-file-collector.js";
import type { ChangedFile, GitFileMode } from "../../src/services/git-change-detector.js";

const H40 = "a".repeat(40);
const H40_B = "b".repeat(40);
const H64 = "c".repeat(64);

function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function bytes(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function fileStat(): EvidenceFileStat {
  return { isFile: true, isSymbolicLink: false };
}

function symlinkStat(): EvidenceFileStat {
  return { isFile: false, isSymbolicLink: true };
}

function unsupportedStat(): EvidenceFileStat {
  return { isFile: false, isSymbolicLink: false };
}

function added(path = "src/new.ts", currentMode: GitFileMode = "100644"): ChangedFile {
  return { status: "ADDED", path, currentMode };
}

function untracked(path = "src/untracked.ts", currentMode: GitFileMode = "100644"): ChangedFile {
  return { status: "UNTRACKED", path, currentMode };
}

function modified(
  path = "src/existing.ts",
  previousMode: GitFileMode = "100644",
  currentMode: GitFileMode = "100644",
): ChangedFile {
  return { status: "MODIFIED", path, previousMode, currentMode, previousObjectId: H40 };
}

function deleted(path = "src/deleted.ts", previousMode: GitFileMode = "100644"): ChangedFile {
  return { status: "DELETED", path, previousMode, previousObjectId: H40 };
}

function renamed(
  previousPath = "src/old.ts",
  path = "src/new.ts",
  similarityScore = 100,
  previousMode: GitFileMode = "100644",
  currentMode: GitFileMode = "100644",
): ChangedFile {
  return { status: "RENAMED", previousPath, path, previousMode, currentMode, previousObjectId: H40, similarityScore };
}

function deps(overrides: EvidenceFileCollectorDeps = {}): EvidenceFileCollectorDeps {
  return {
    lstat: () => fileStat(),
    readCurrentFileBytes: () => bytes("current"),
    readPreviousBlobBytes: () => bytes("previous"),
    readCurrentSymlinkTarget: () => "../current-target",
    readPreviousSymlinkTarget: () => "../previous-target",
    readPatch: () => "@@ -1 +1 @@\n-previous\n+current",
    ...overrides,
  };
}

function collectOne(file: ChangedFile, overrides: EvidenceFileCollectorDeps = {}): EvidenceFile {
  const result = collectEvidenceFiles({ workspacePath: "/repo/work", baseCommit: H40_B, changedFiles: [file] }, deps(overrides));
  return result[0]!;
}

function makeBundleBody(files: readonly EvidenceFile[]): EvidenceBundleBody {
  return {
    version: 1,
    baseCommit: H40,
    headCommit: H40_B,
    workspaceFingerprint: H64,
    files: [...files],
    deterministicRevision: {
      status: "REVIEWING",
      pathValidation: { passed: true, violations: [] },
      commandsResult: null,
    },
    previousCorrections: [],
    approvedContract: {
      objective: "Implement feature",
      context: "Project context",
      acceptanceCriteria: ["Works"],
      allowedPaths: ["src"],
      forbiddenPaths: ["dist"],
      requiredCommands: [],
      assumptions: ["None"],
      risks: ["None"],
    },
  };
}

function expectCollectorError(fn: () => void, code: EvidenceFileCollectorErrorCode): void {
  try {
    fn();
    expect.fail("Expected EvidenceFileCollectorError to be thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceFileCollectorError);
    const collector = error as InstanceType<typeof EvidenceFileCollectorError>;
    expect(collector.code).toBe(code);
  }
}

describe("collectEvidenceFiles", () => {
  describe("TEXT variants", () => {
    it("collects TEXT ADDED", () => {
      const content = bytes("hello\nworld");
      const file = collectOne(added(), { readCurrentFileBytes: () => content });

      expect(file).toMatchObject({
        fileKind: "TEXT",
        status: "ADDED",
        path: "src/new.ts",
        currentMode: "100644",
        currentContent: "hello\nworld",
        currentHash: hash(content),
        currentByteLength: content.length,
        currentLineCount: 2,
      });
    });

    it("collects TEXT UNTRACKED", () => {
      const content = bytes("untracked");
      const file = collectOne(untracked(), { readCurrentFileBytes: () => content });

      expect(file).toMatchObject({ fileKind: "TEXT", status: "UNTRACKED", currentContent: "untracked", currentHash: hash(content) });
    });

    it("collects TEXT MODIFIED with required patch", () => {
      const current = bytes("current text");
      const previous = bytes("previous text");
      const file = collectOne(modified(), {
        readCurrentFileBytes: () => current,
        readPreviousBlobBytes: () => previous,
      });

      expect(file).toMatchObject({
        fileKind: "TEXT",
        status: "MODIFIED",
        previousObjectId: H40,
        patch: "@@ -1 +1 @@\n-previous\n+current",
        currentHash: hash(current),
        previousHash: hash(previous),
        currentByteLength: current.length,
        previousByteLength: previous.length,
        currentContent: "current text",
        currentContentTruncated: false,
      });
    });

    it("collects TEXT DELETED without reading current path", () => {
      const previous = bytes("deleted text");
      const file = collectOne(deleted(), {
        readCurrentFileBytes: () => {
          throw new Error("should not read current");
        },
        readPreviousBlobBytes: () => previous,
      });

      expect(file).toMatchObject({
        fileKind: "TEXT",
        status: "DELETED",
        previousContent: "deleted text",
        previousHash: hash(previous),
        previousByteLength: previous.length,
        previousLineCount: 1,
      });
    });

    it("collects TEXT RENAMED PURE", () => {
      const content = bytes("same text");
      const file = collectOne(renamed(), {
        readCurrentFileBytes: () => content,
        readPreviousBlobBytes: () => content,
      });

      expect(file).toMatchObject({
        fileKind: "TEXT",
        status: "RENAMED",
        renameKind: "PURE",
        previousPath: "src/old.ts",
        path: "src/new.ts",
        similarityScore: 100,
        currentHash: hash(content),
        previousHash: hash(content),
      });
      expect("patch" in file).toBe(false);
    });

    it("collects TEXT RENAMED MODIFIED", () => {
      const current = bytes("new text");
      const previous = bytes("old text");
      const file = collectOne(renamed("src/old.ts", "src/new.ts", 80), {
        readCurrentFileBytes: () => current,
        readPreviousBlobBytes: () => previous,
      });

      expect(file).toMatchObject({
        fileKind: "TEXT",
        status: "RENAMED",
        renameKind: "MODIFIED",
        patch: "@@ -1 +1 @@\n-previous\n+current",
        currentContent: "new text",
        currentContentTruncated: false,
      });
    });

    it("preserves empty text", () => {
      const content = Buffer.alloc(0);
      const file = collectOne(added(), { readCurrentFileBytes: () => content });

      expect(file).toMatchObject({ fileKind: "TEXT", currentContent: "", currentLineCount: 0, currentHash: hash(content) });
    });

    it("preserves unicode text and hashes original bytes", () => {
      const content = bytes("áβ🚀");
      const file = collectOne(added(), { readCurrentFileBytes: () => content });

      expect(file).toMatchObject({ fileKind: "TEXT", currentContent: "áβ🚀", currentHash: hash(content), currentByteLength: content.length });
    });

    it("normalizes CRLF only for display", () => {
      const content = bytes("a\r\nb\r\n");
      const file = collectOne(added(), { readCurrentFileBytes: () => content });

      expect(file).toMatchObject({ fileKind: "TEXT", currentContent: "a\nb\n", currentHash: hash(content), currentByteLength: content.length });
    });

    it("preserves executable mode", () => {
      const file = collectOne(added("bin/tool", "100755"));

      expect(file).toMatchObject({ fileKind: "TEXT", currentMode: "100755" });
    });

    it("supports mode-only TEXT MODIFIED when patch is present", () => {
      const content = bytes("same");
      const file = collectOne(modified("src/existing.ts", "100644", "100755"), {
        readCurrentFileBytes: () => content,
        readPreviousBlobBytes: () => content,
        readPatch: () => "old mode 100644\nnew mode 100755",
      });

      expect(file).toMatchObject({ fileKind: "TEXT", status: "MODIFIED", previousHash: hash(content), currentHash: hash(content), previousMode: "100644", currentMode: "100755" });
    });
  });

  describe("BINARY variants", () => {
    const binary = Buffer.from([1, 0, 2, 3]);
    const previousBinary = Buffer.from([1, 0, 9]);

    it("collects BINARY ADDED", () => {
      const file = collectOne(added("assets/a.bin"), { readCurrentFileBytes: () => binary });

      expect(file).toMatchObject({ fileKind: "BINARY", status: "ADDED", currentHash: hash(binary), currentByteLength: binary.length, reviewabilityLimited: true });
      expect("currentContent" in file).toBe(false);
    });

    it("collects BINARY UNTRACKED", () => {
      const file = collectOne(untracked("assets/u.bin"), { readCurrentFileBytes: () => binary });

      expect(file).toMatchObject({ fileKind: "BINARY", status: "UNTRACKED", currentHash: hash(binary), currentByteLength: binary.length, reviewabilityLimited: true });
    });

    it("collects BINARY MODIFIED", () => {
      const file = collectOne(modified("assets/m.bin"), {
        readCurrentFileBytes: () => binary,
        readPreviousBlobBytes: () => previousBinary,
      });

      expect(file).toMatchObject({ fileKind: "BINARY", status: "MODIFIED", currentHash: hash(binary), previousHash: hash(previousBinary), currentByteLength: binary.length, previousByteLength: previousBinary.length, reviewabilityLimited: true });
      expect("patch" in file).toBe(false);
    });

    it("collects BINARY DELETED", () => {
      const file = collectOne(deleted("assets/d.bin"), { readPreviousBlobBytes: () => previousBinary });

      expect(file).toMatchObject({ fileKind: "BINARY", status: "DELETED", previousHash: hash(previousBinary), previousByteLength: previousBinary.length, reviewabilityLimited: true });
    });

    it("collects BINARY RENAMED PURE", () => {
      const file = collectOne(renamed("assets/old.bin", "assets/new.bin", 100), {
        readCurrentFileBytes: () => binary,
        readPreviousBlobBytes: () => binary,
      });

      expect(file).toMatchObject({ fileKind: "BINARY", status: "RENAMED", renameKind: "PURE", currentHash: hash(binary), previousHash: hash(binary), reviewabilityLimited: true });
    });

    it("collects BINARY RENAMED MODIFIED", () => {
      const file = collectOne(renamed("assets/old.bin", "assets/new.bin", 90), {
        readCurrentFileBytes: () => binary,
        readPreviousBlobBytes: () => previousBinary,
      });

      expect(file).toMatchObject({ fileKind: "BINARY", status: "RENAMED", renameKind: "MODIFIED", currentHash: hash(binary), previousHash: hash(previousBinary), reviewabilityLimited: true });
      expect("patch" in file).toBe(false);
    });
  });

  describe("SYMLINK variants", () => {
    it("collects SYMLINK ADDED", () => {
      const file = collectOne(added("link", "120000"), { lstat: () => symlinkStat(), readCurrentSymlinkTarget: () => "../outside" });

      expect(file).toMatchObject({ fileKind: "SYMLINK", status: "ADDED", currentMode: "120000", currentTarget: "../outside", currentTargetHash: hash("../outside") });
    });

    it("collects SYMLINK UNTRACKED", () => {
      const file = collectOne(untracked("link", "120000"), { lstat: () => symlinkStat(), readCurrentSymlinkTarget: () => "/external/target" });

      expect(file).toMatchObject({ fileKind: "SYMLINK", status: "UNTRACKED", currentTarget: "/external/target", currentTargetHash: hash("/external/target") });
    });

    it("collects SYMLINK MODIFIED", () => {
      const file = collectOne(modified("link", "120000", "120000"), {
        lstat: () => symlinkStat(),
        readCurrentSymlinkTarget: () => "new-target",
        readPreviousSymlinkTarget: () => "old-target",
      });

      expect(file).toMatchObject({ fileKind: "SYMLINK", status: "MODIFIED", currentTarget: "new-target", previousTarget: "old-target", currentTargetHash: hash("new-target"), previousTargetHash: hash("old-target") });
    });

    it("collects SYMLINK DELETED", () => {
      const file = collectOne(deleted("link", "120000"), { readPreviousSymlinkTarget: () => "old-target" });

      expect(file).toMatchObject({ fileKind: "SYMLINK", status: "DELETED", previousTarget: "old-target", previousTargetHash: hash("old-target") });
    });

    it("collects SYMLINK RENAMED PURE", () => {
      const file = collectOne(renamed("old-link", "new-link", 100, "120000", "120000"), {
        lstat: () => symlinkStat(),
        readCurrentSymlinkTarget: () => "same-target",
        readPreviousSymlinkTarget: () => "same-target",
      });

      expect(file).toMatchObject({ fileKind: "SYMLINK", status: "RENAMED", renameKind: "PURE", currentTarget: "same-target", previousTarget: "same-target" });
    });

    it("collects SYMLINK RENAMED MODIFIED", () => {
      const file = collectOne(renamed("old-link", "new-link", 70, "120000", "120000"), {
        lstat: () => symlinkStat(),
        readCurrentSymlinkTarget: () => "new-target",
        readPreviousSymlinkTarget: () => "old-target",
      });

      expect(file).toMatchObject({ fileKind: "SYMLINK", status: "RENAMED", renameKind: "MODIFIED", currentTarget: "new-target", previousTarget: "old-target" });
    });

    it("does not follow symlink target", () => {
      collectOne(untracked("link", "120000"), {
        lstat: () => symlinkStat(),
        readCurrentFileBytes: () => {
          throw new Error("target followed");
        },
        readCurrentSymlinkTarget: () => "/outside/repo",
      });
    });
  });

  describe("paths and failures", () => {
    it("rejects absolute path", () => {
      expectCollectorError(() => collectOne(added("/abs.ts")), "PATH_ESCAPE");
    });

    it("rejects parent traversal", () => {
      expectCollectorError(() => collectOne(added("src/../x.ts")), "PATH_ESCAPE");
    });

    it("rejects double separator", () => {
      expectCollectorError(() => collectOne(added("src//x.ts")), "PATH_ESCAPE");
    });

    it("rejects backslash", () => {
      expectCollectorError(() => collectOne(added("src\\x.ts")), "PATH_ESCAPE");
    });

    it("rejects dot path", () => {
      expectCollectorError(() => collectOne(added(".")), "PATH_ESCAPE");
    });

    it("rejects leading dot-slash", () => {
      expectCollectorError(() => collectOne(added("./src/x.ts")), "PATH_ESCAPE");
    });

    it("rejects empty path segment", () => {
      expectCollectorError(() => collectOne(added("src//x.ts")), "PATH_ESCAPE");
    });

    it("fails when file changes to symlink", () => {
      expectCollectorError(() => collectOne(added("src/x.ts"), { lstat: () => symlinkStat() }), "FILE_TYPE_CHANGED");
    });

    it("fails when current path has unsupported type", () => {
      expectCollectorError(() => collectOne(added("src/x.ts"), { lstat: () => unsupportedStat() }), "UNSUPPORTED_FILE_TYPE");
    });

    it("fails when current file disappears", () => {
      expectCollectorError(
        () => collectOne(added("src/x.ts"), { readCurrentFileBytes: () => { throw new Error("missing"); } }),
        "CURRENT_FILE_READ_FAILED",
      );
    });

    it("fails when previous blob read fails", () => {
      expectCollectorError(
        () => collectOne(modified(), { readPreviousBlobBytes: () => { throw new Error("git show failed"); } }),
        "PREVIOUS_BLOB_READ_FAILED",
      );
    });

    it("fails when patch read fails", () => {
      expectCollectorError(
        () => collectOne(modified(), { readPatch: () => { throw new Error("diff failed"); } }),
        "PATCH_READ_FAILED",
      );
    });

    it("fails when required patch is empty", () => {
      expectCollectorError(() => collectOne(modified(), { readPatch: () => "" }), "PATCH_REQUIRED");
    });

    it("fails when classification fails", () => {
      expectCollectorError(
        () => collectOne(added(), { classifyBytes: () => { throw new Error("classify failed"); } }),
        "BINARY_CLASSIFICATION_FAILED",
      );
    });

    it("fails when lstat fails", () => {
      expectCollectorError(
        () => collectOne(added(), { lstat: () => { throw new Error("lstat failed"); } }),
        "FILE_UNREADABLE",
      );
    });

    it("fails when previousObjectId is missing", () => {
      const malformed = JSON.parse(`[{"status":"MODIFIED","path":"src/x.ts","previousMode":"100644","currentMode":"100644"}]`) as ChangedFile[];
      expectCollectorError(
        () => collectEvidenceFiles({ workspacePath: "/repo/work", baseCommit: H40_B, changedFiles: malformed }, deps()),
        "INVALID_INPUT",
      );
    });

    it("fails when previous symlink read fails", () => {
      expectCollectorError(
        () =>
          collectOne(modified("link", "120000", "120000"), {
            lstat: () => symlinkStat(),
            readCurrentSymlinkTarget: () => "new",
            readPreviousSymlinkTarget: () => { throw new Error("git show symlink failed"); },
          }),
        "SYMLINK_READ_FAILED",
      );
    });

    it("fails when current symlink read fails", () => {
      expectCollectorError(
        () =>
          collectOne(added("link", "120000"), {
            lstat: () => symlinkStat(),
            readCurrentSymlinkTarget: () => { throw new Error("readlink failed"); },
          }),
        "SYMLINK_READ_FAILED",
      );
    });
  });

  describe("error encapsulation", () => {
    it("preserves EvidenceFileCollectorError from lstat", () => {
      const original = new EvidenceFileCollectorError("custom lstat error", { code: "FILE_MISSING" });
      try {
        collectOne(added(), { lstat: () => { throw original; } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBe(original);
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).code).toBe("FILE_MISSING");
      }
    });

    it("preserves EvidenceFileCollectorError from readCurrentFileBytes", () => {
      const original = new EvidenceFileCollectorError("custom read error", { code: "FILE_MISSING" });
      try {
        collectOne(added(), { readCurrentFileBytes: () => { throw original; } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBe(original);
      }
    });

    it("preserves EvidenceFileCollectorError from readPreviousBlobBytes", () => {
      const original = new EvidenceFileCollectorError("custom blob error", { code: "PREVIOUS_BLOB_READ_FAILED" });
      try {
        collectOne(modified(), { readPreviousBlobBytes: () => { throw original; } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBe(original);
      }
    });

    it("preserves EvidenceFileCollectorError from readPatch", () => {
      const original = new EvidenceFileCollectorError("custom patch error", { code: "PATCH_READ_FAILED" });
      try {
        collectOne(modified(), { readPatch: () => { throw original; } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBe(original);
      }
    });

    it("preserves EvidenceFileCollectorError from readCurrentSymlinkTarget", () => {
      const original = new EvidenceFileCollectorError("custom symlink error", { code: "SYMLINK_READ_FAILED" });
      try {
        collectOne(added("link", "120000"), { lstat: () => symlinkStat(), readCurrentSymlinkTarget: () => { throw original; } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBe(original);
      }
    });

    it("preserves EvidenceFileCollectorError from readPreviousSymlinkTarget", () => {
      const original = new EvidenceFileCollectorError("custom prev symlink error", { code: "SYMLINK_READ_FAILED" });
      try {
        collectOne(modified("link", "120000", "120000"), {
          lstat: () => symlinkStat(),
          readCurrentSymlinkTarget: () => "new",
          readPreviousSymlinkTarget: () => { throw original; },
        });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBe(original);
      }
    });

    it("preserves EvidenceFileCollectorError from classifyBytes", () => {
      const original = new EvidenceFileCollectorError("custom classify error", { code: "BINARY_CLASSIFICATION_FAILED" });
      try {
        collectOne(added(), { classifyBytes: () => { throw original; } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBe(original);
      }
    });

    it("wraps TypeError from lstat as FILE_UNREADABLE", () => {
      try {
        collectOne(added(), { lstat: () => { throw new TypeError("bad arg"); } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceFileCollectorError);
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).code).toBe("FILE_UNREADABLE");
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).cause).toBeInstanceOf(TypeError);
      }
    });

    it("wraps RangeError from readCurrentFileBytes as CURRENT_FILE_READ_FAILED", () => {
      try {
        collectOne(added(), { readCurrentFileBytes: () => { throw new RangeError("out of bounds"); } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceFileCollectorError);
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).code).toBe("CURRENT_FILE_READ_FAILED");
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).cause).toBeInstanceOf(RangeError);
      }
    });

    it("wraps Error from readPreviousBlobBytes with cause preserved", () => {
      const cause = new Error("EACCES: permission denied");
      try {
        collectOne(modified(), { readPreviousBlobBytes: () => { throw cause; } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceFileCollectorError);
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).code).toBe("PREVIOUS_BLOB_READ_FAILED");
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).cause).toBe(cause);
      }
    });

    it("wraps Error from readCurrentSymlinkTarget with cause preserved", () => {
      const cause = new Error("ENOENT: no such file");
      try {
        collectOne(added("link", "120000"), { lstat: () => symlinkStat(), readCurrentSymlinkTarget: () => { throw cause; } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceFileCollectorError);
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).code).toBe("SYMLINK_READ_FAILED");
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).cause).toBe(cause);
      }
    });

    it("wraps Error from readPreviousSymlinkTarget with cause preserved", () => {
      const cause = new Error("EIO: i/o error");
      try {
        collectOne(modified("link", "120000", "120000"), {
          lstat: () => symlinkStat(),
          readCurrentSymlinkTarget: () => "new",
          readPreviousSymlinkTarget: () => { throw cause; },
        });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceFileCollectorError);
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).code).toBe("SYMLINK_READ_FAILED");
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).cause).toBe(cause);
      }
    });

    it("wraps Error from readPatch with cause preserved", () => {
      const cause = new Error("git diff failed");
      try {
        collectOne(modified(), { readPatch: () => { throw cause; } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceFileCollectorError);
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).code).toBe("PATCH_READ_FAILED");
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).cause).toBe(cause);
      }
    });

    it("wraps Error from classifyBytes with cause preserved", () => {
      const cause = new Error("classification error");
      try {
        collectOne(added(), { classifyBytes: () => { throw cause; } });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceFileCollectorError);
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).code).toBe("BINARY_CLASSIFICATION_FAILED");
        expect((error as InstanceType<typeof EvidenceFileCollectorError>).cause).toBe(cause);
      }
    });

    it("no native Error escapes from default lstat", () => {
      try {
        collectEvidenceFiles({ workspacePath: "/repo/work", baseCommit: H40_B, changedFiles: [added("src/missing.ts")] }, { lstat: undefined });
        expect.fail("Expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceFileCollectorError);
      }
    });

    it("details are frozen", () => {
      try {
        collectOne(added("/abs.ts"));
        expect.fail("Expected throw");
      } catch (error) {
        const details = (error as InstanceType<typeof EvidenceFileCollectorError>).details;
        expect(details).toBeDefined();
        expect(() => { (details as Record<string, unknown>).x = 1; }).toThrow();
      }
    });

    it("empty workspacePath fails with INVALID_INPUT", () => {
      expectCollectorError(
        () => collectEvidenceFiles({ workspacePath: "", baseCommit: H40_B, changedFiles: [] }, deps()),
        "INVALID_INPUT",
      );
    });

    it("empty baseCommit fails with INVALID_INPUT", () => {
      expectCollectorError(
        () => collectEvidenceFiles({ workspacePath: "/repo/work", baseCommit: "", changedFiles: [] }, deps()),
        "INVALID_INPUT",
      );
    });

    it("empty path fails with INVALID_INPUT", () => {
      expectCollectorError(
        () => collectOne(added("")),
        "INVALID_INPUT",
      );
    });
  });

  describe("no truncation, immutability and schema", () => {
    it("preserves text larger than contextual limit", () => {
      const large = "x".repeat(128 * 1024 + 33);
      const content = bytes(large);
      const file = collectOne(added(), { readCurrentFileBytes: () => content });

      expect(file.fileKind).toBe("TEXT");
      if (file.fileKind === "TEXT" && file.status === "ADDED") {
        expect(file.currentContent.length).toBe(large.length);
        expect(file.currentContent).toBe(large);
        expect(file.currentHash).toBe(hash(content));
        expect(file.currentByteLength).toBe(content.length);
      }
    });

    it("does not mutate changedFiles input", () => {
      const inputFiles = [added("src/a.ts"), modified("src/b.ts")];
      const before = JSON.stringify(inputFiles);

      collectEvidenceFiles({ workspacePath: "/repo/work", baseCommit: H40_B, changedFiles: inputFiles }, deps({ readPreviousBlobBytes: () => bytes("old") }));

      expect(JSON.stringify(inputFiles)).toBe(before);
    });

    it("copies buffers returned by dependencies before hashing", () => {
      const content = bytes("abc");
      const file = collectOne(added(), {
        readCurrentFileBytes: () => content,
      });
      content[0] = 120;

      expect(file).toMatchObject({ fileKind: "TEXT", currentHash: hash("abc") });
    });

    it("all collected files fit a valid EvidenceBundleBody fixture", () => {
      const files = collectEvidenceFiles(
        {
          workspacePath: "/repo/work",
          baseCommit: H40_B,
          changedFiles: [added("src/a.ts"), untracked("src/b.ts"), modified("src/c.ts")],
        },
        deps({
          readCurrentFileBytes: (fullPath) => fullPath.endsWith("c.ts") ? bytes("new") : bytes("text"),
          readPreviousBlobBytes: () => bytes("old"),
        }),
      );

      expect(evidenceBundleBodySchema.safeParse(makeBundleBody(files)).success).toBe(true);
    });

    it("CRLF is hashed in original bytes", () => {
      const content = bytes("a\r\nb");
      const file = collectOne(added(), { readCurrentFileBytes: () => content });

      expect(file.fileKind).toBe("TEXT");
      if (file.fileKind === "TEXT" && file.status === "ADDED") {
        expect(file.currentHash).toBe(hash(content));
        expect(file.currentByteLength).toBe(content.length);
        expect(file.currentContent).toBe("a\nb");
      }
    });

    it("binary has no currentContent or previousContent", () => {
      const binary = Buffer.from([0]);
      const file = collectOne(added("bin/file"), { readCurrentFileBytes: () => binary });

      expect(file.fileKind).toBe("BINARY");
      expect("currentContent" in file).toBe(false);
      expect("previousContent" in file).toBe(false);
      expect("patch" in file).toBe(false);
    });

    it("symlink does not read file bytes", () => {
      let readCurrentFileCalled = false;
      collectOne(added("link", "120000"), {
        lstat: () => symlinkStat(),
        readCurrentSymlinkTarget: () => "../target",
        readCurrentFileBytes: () => { readCurrentFileCalled = true; return bytes("should not happen"); },
      });

      expect(readCurrentFileCalled).toBe(false);
    });

    it("SYMLINK RENAMED uses explicit PURE branch", () => {
      const file = collectOne(renamed("a", "b", 100, "120000", "120000"), {
        lstat: () => symlinkStat(),
        readCurrentSymlinkTarget: () => "target",
        readPreviousSymlinkTarget: () => "target",
      });

      expect(file).toMatchObject({ fileKind: "SYMLINK", status: "RENAMED", renameKind: "PURE" });
    });

    it("SYMLINK RENAMED uses explicit MODIFIED branch", () => {
      const file = collectOne(renamed("a", "b", 90, "120000", "120000"), {
        lstat: () => symlinkStat(),
        readCurrentSymlinkTarget: () => "new",
        readPreviousSymlinkTarget: () => "old",
      });

      expect(file).toMatchObject({ fileKind: "SYMLINK", status: "RENAMED", renameKind: "MODIFIED" });
    });

    it("TEXT RENAMED with same content is PURE", () => {
      const content = bytes("same");
      const file = collectOne(renamed("src/a.ts", "src/b.ts", 100), {
        readCurrentFileBytes: () => content,
        readPreviousBlobBytes: () => content,
      });

      expect(file).toMatchObject({ fileKind: "TEXT", status: "RENAMED", renameKind: "PURE" });
      expect("patch" in file).toBe(false);
    });

    it("TEXT RENAMED with different content is MODIFIED", () => {
      const file = collectOne(renamed("src/a.ts", "src/b.ts", 80), {
        readCurrentFileBytes: () => bytes("new"),
        readPreviousBlobBytes: () => bytes("old"),
      });

      expect(file).toMatchObject({ fileKind: "TEXT", status: "RENAMED", renameKind: "MODIFIED" });
      expect("patch" in file).toBe(true);
    });

    it("BINARY RENAMED with same hash is PURE", () => {
      const binary = Buffer.from([1, 0, 3]);
      const file = collectOne(renamed("assets/a.bin", "assets/b.bin", 100), {
        readCurrentFileBytes: () => binary,
        readPreviousBlobBytes: () => binary,
      });

      expect(file).toMatchObject({ fileKind: "BINARY", status: "RENAMED", renameKind: "PURE" });
    });

    it("BINARY RENAMED with different hash is MODIFIED", () => {
      const file = collectOne(renamed("assets/a.bin", "assets/b.bin", 90), {
        readCurrentFileBytes: () => Buffer.from([1, 0]),
        readPreviousBlobBytes: () => Buffer.from([3, 0]),
      });

      expect(file).toMatchObject({ fileKind: "BINARY", status: "RENAMED", renameKind: "MODIFIED" });
    });
  });
});
