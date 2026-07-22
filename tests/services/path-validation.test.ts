import { describe, expect, it } from "vitest";

import {
  validateChangedPaths,
  PathConfigError,
} from "../../src/services/path-validation.js";
import type {
  PathViolation,
  PathValidationResult,
} from "../../src/services/path-validation.js";
import type { ChangedFile, ChangedFileStatus, GitFileMode } from "../../src/services/git-change-detector.js";

const PLACEHOLDER_HASH = "a".repeat(40);

function file(path: string, status: ChangedFileStatus): ChangedFile {
  if (status === "RENAMED") {
    throw new Error("Use fileRenamed for RENAMED status");
  }
  if (status === "ADDED") {
    return { path, status: "ADDED", currentMode: "100644" };
  }
  if (status === "MODIFIED") {
    return { path, status: "MODIFIED", previousMode: "100644", currentMode: "100644", previousObjectId: PLACEHOLDER_HASH };
  }
  if (status === "DELETED") {
    return { path, status: "DELETED", previousMode: "100644", previousObjectId: PLACEHOLDER_HASH };
  }
  return { path, status: "UNTRACKED", currentMode: "100644" };
}

function fileRenamed(
  previousPath: string,
  path: string,
): ChangedFile {
  return {
    path,
    status: "RENAMED",
    previousPath,
    previousMode: "100644",
    currentMode: "100644",
    previousObjectId: PLACEHOLDER_HASH,
    similarityScore: 100,
  };
}

describe("validateChangedPaths", () => {
  describe("empty inputs", () => {
    it("empty changedFiles produces passed true", () => {
      const result = validateChangedPaths([], ["src"], []);
      expect(result.passed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("empty allowedPaths with changedFiles produces NOT_ALLOWED", () => {
      const result = validateChangedPaths(
        [file("src/index.ts", "MODIFIED")],
        [],
        [],
      );
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.code).toBe("NOT_ALLOWED");
    });

    it("empty forbiddenPaths produces no FORBIDDEN", () => {
      const result = validateChangedPaths(
        [file("src/index.ts", "MODIFIED")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe("allowed matching", () => {
    it("exact match passes", () => {
      const result = validateChangedPaths(
        [file("src/index.ts", "MODIFIED")],
        ["src/index.ts"],
        [],
      );
      expect(result.passed).toBe(true);
    });

    it("descendant match passes", () => {
      const result = validateChangedPaths(
        [file("src/lib/utils.ts", "ADDED")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(true);
    });

    it("sibling prefix does not match", () => {
      const result = validateChangedPaths(
        [file("src-old/file.ts", "MODIFIED")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(false);
      expect(result.violations[0]!.code).toBe("NOT_ALLOWED");
    });

    it("suffix does not match", () => {
      const result = validateChangedPaths(
        [file("src/index.ts.bak", "MODIFIED")],
        ["src/index.ts"],
        [],
      );
      expect(result.passed).toBe(false);
    });

    it("case-sensitive matching", () => {
      const result = validateChangedPaths(
        [file("SRC/file.ts", "MODIFIED")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(false);
    });

    it("exact file rule does not authorize derived files", () => {
      const result = validateChangedPaths(
        [file("src/index.ts.bak", "MODIFIED")],
        ["src/index.ts"],
        [],
      );
      expect(result.passed).toBe(false);
    });

    it("multiple rules: file matches one", () => {
      const result = validateChangedPaths(
        [file("test/file.ts", "ADDED")],
        ["src", "test"],
        [],
      );
      expect(result.passed).toBe(true);
    });
  });

  describe("forbidden matching", () => {
    it("exact match produces FORBIDDEN", () => {
      const result = validateChangedPaths(
        [file("package.json", "MODIFIED")],
        ["package.json", "src"],
        ["package.json"],
      );
      expect(result.passed).toBe(false);
      expect(result.violations[0]!.code).toBe("FORBIDDEN");
    });

    it("descendant match produces FORBIDDEN", () => {
      const result = validateChangedPaths(
        [file("src/db.ts", "MODIFIED")],
        ["src"],
        ["src/db.ts"],
      );
      expect(result.passed).toBe(false);
      expect(result.violations[0]!.code).toBe("FORBIDDEN");
    });

    it("forbidden prevails over allowed", () => {
      const result = validateChangedPaths(
        [file("src/db.ts", "MODIFIED")],
        ["src"],
        ["src/db.ts"],
      );
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.code).toBe("FORBIDDEN");
      expect(result.violations[0]!.message).toContain("prohibido");
    });

    it("forbidden sibling does not match", () => {
      const result = validateChangedPaths(
        [file("src-db/file.ts", "MODIFIED")],
        ["src", "src-db"],
        ["src/db.ts"],
      );
      expect(result.passed).toBe(true);
    });

    it("empty forbidden produces no FORBIDDEN", () => {
      const result = validateChangedPaths(
        [file("any.ts", "MODIFIED")],
        ["any.ts"],
        [],
      );
      expect(result.passed).toBe(true);
    });
  });

  describe("precedence: forbidden over allowed", () => {
    it("path in both: only FORBIDDEN generated", () => {
      const result = validateChangedPaths(
        [file("src/db.ts", "MODIFIED")],
        ["src"],
        ["src/db.ts"],
      );
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.code).toBe("FORBIDDEN");
    });

    it("not allowed + not forbidden: NOT_ALLOWED", () => {
      const result = validateChangedPaths(
        [file("secret.ts", "MODIFIED")],
        ["src"],
        ["src/db.ts"],
      );
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.code).toBe("NOT_ALLOWED");
    });
  });

  describe("status handling", () => {
    it("ADDED validates path", () => {
      const result = validateChangedPaths(
        [file("src/new.ts", "ADDED")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(true);
    });

    it("MODIFIED validates path", () => {
      const result = validateChangedPaths(
        [file("src/existing.ts", "MODIFIED")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(true);
    });

    it("DELETED validates path", () => {
      const result = validateChangedPaths(
        [file("src/old.ts", "DELETED")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(true);
    });

    it("UNTRACKED validates path", () => {
      const result = validateChangedPaths(
        [file("src/untracked.ts", "UNTRACKED")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(true);
    });

    it("RENAMED validates both paths", () => {
      const result = validateChangedPaths(
        [fileRenamed("src/old.ts", "src/new.ts")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(true);
    });
  });

  describe("rename handling", () => {
    it("both origin and destination allowed", () => {
      const result = validateChangedPaths(
        [fileRenamed("src/a.ts", "src/b.ts")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(true);
    });

    it("origin forbidden", () => {
      const result = validateChangedPaths(
        [fileRenamed("src/db.ts", "src/util.ts")],
        ["src"],
        ["src/db.ts"],
      );
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.code).toBe("FORBIDDEN");
      expect(result.violations[0]!.previousPath).toBe("src/db.ts");
      expect(result.violations[0]!.path).toBe("src/db.ts");
    });

    it("destination forbidden", () => {
      const result = validateChangedPaths(
        [fileRenamed("src/util.ts", "src/db.ts")],
        ["src"],
        ["src/db.ts"],
      );
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.code).toBe("FORBIDDEN");
      expect(result.violations[0]!.path).toBe("src/db.ts");
      expect(result.violations[0]!.previousPath).toBe("src/util.ts");
    });

    it("origin not allowed", () => {
      const result = validateChangedPaths(
        [fileRenamed("secret/a.ts", "src/b.ts")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.code).toBe("NOT_ALLOWED");
      expect(result.violations[0]!.previousPath).toBe("secret/a.ts");
      expect(result.violations[0]!.path).toBe("secret/a.ts");
    });

    it("destination not allowed", () => {
      const result = validateChangedPaths(
        [fileRenamed("src/a.ts", "secret/b.ts")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.code).toBe("NOT_ALLOWED");
      expect(result.violations[0]!.path).toBe("secret/b.ts");
      expect(result.violations[0]!.previousPath).toBe("src/a.ts");
    });

    it("both origin and destination invalid: two violations", () => {
      const result = validateChangedPaths(
        [fileRenamed("secret/a.ts", "other/b.ts")],
        ["src"],
        [],
      );
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(2);
      expect(result.violations[0]!.previousPath).toBe("secret/a.ts");
      expect(result.violations[0]!.path).toBe("other/b.ts");
      expect(result.violations[1]!.previousPath).toBe("secret/a.ts");
      expect(result.violations[1]!.path).toBe("secret/a.ts");
    });

    it("RENAMED without previousPath throws", () => {
      expect(() =>
        validateChangedPaths(
          [{ path: "src/new.ts", status: "RENAMED" } as ChangedFile],
          ["src"],
          [],
        ),
      ).toThrow(PathConfigError);
    });

    it("non-RENAMED with previousPath throws", () => {
      expect(() =>
        validateChangedPaths(
          [{ path: "src/file.ts", status: "MODIFIED", previousPath: "old.ts" } as ChangedFile],
          ["src"],
          [],
        ),
      ).toThrow(PathConfigError);
    });
  });

  describe("config validation", () => {
    it("rejects empty allowedPaths entry", () => {
      expect(() =>
        validateChangedPaths([], [""], []),
      ).toThrow(PathConfigError);
    });

    it("rejects whitespace-only allowedPaths entry", () => {
      expect(() =>
        validateChangedPaths([], ["   "], []),
      ).toThrow(PathConfigError);
    });

    it("rejects absolute allowedPaths entry", () => {
      expect(() =>
        validateChangedPaths([], ["/src"], []),
      ).toThrow(PathConfigError);
    });

    it("rejects ./ allowedPaths entry", () => {
      expect(() =>
        validateChangedPaths([], ["./src"], []),
      ).toThrow(PathConfigError);
    });

    it("rejects backslash allowedPaths entry", () => {
      expect(() =>
        validateChangedPaths([], ["src\\file"], []),
      ).toThrow(PathConfigError);
    });

    it("rejects // allowedPaths entry", () => {
      expect(() =>
        validateChangedPaths([], ["src//file"], []),
      ).toThrow(PathConfigError);
    });

    it("rejects . allowedPaths entry", () => {
      expect(() =>
        validateChangedPaths([], ["."], []),
      ).toThrow(PathConfigError);
    });

    it("rejects trailing slash allowedPaths entry", () => {
      expect(() =>
        validateChangedPaths([], ["src/"], []),
      ).toThrow(PathConfigError);
    });

    it("rejects .. allowedPaths entry", () => {
      expect(() =>
        validateChangedPaths([], ["src/.."], []),
      ).toThrow(PathConfigError);
    });

    it("rejects duplicate allowedPaths", () => {
      expect(() =>
        validateChangedPaths([], ["src", "src"], []),
      ).toThrow(PathConfigError);
    });

    it("rejects duplicate forbiddenPaths", () => {
      expect(() =>
        validateChangedPaths([], [], ["db.ts", "db.ts"]),
      ).toThrow(PathConfigError);
    });

    it("PathConfigError has correct properties", () => {
      try {
        validateChangedPaths([], [""], []);
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PathConfigError);
        const err = error as PathConfigError;
        expect(err.name).toBe("PathConfigError");
        expect(err.code).toBe("INVALID_ALLOWED_PATH");
        expect(typeof err.message).toBe("string");
        expect(err.message.length).toBeGreaterThan(0);
      }
    });
  });

  describe("deterministic order", () => {
    it("violations sorted by path, code, status, previousPath", () => {
      const result = validateChangedPaths(
        [
          fileRenamed("z/file.ts", "a/file.ts"),
          file("m/file.ts", "MODIFIED"),
          file("b/file.ts", "ADDED"),
        ],
        [],
        [],
      );

      expect(result.violations).toHaveLength(4);
      expect(result.violations[0]!.path).toBe("a/file.ts");
      expect(result.violations[1]!.path).toBe("b/file.ts");
      expect(result.violations[2]!.path).toBe("m/file.ts");
      expect(result.violations[3]!.path).toBe("z/file.ts");
    });

    it("same input produces same output", () => {
      const files = [
        file("z.ts", "MODIFIED"),
        file("a.ts", "ADDED"),
      ];

      const r1 = validateChangedPaths(files, [], []);
      const r2 = validateChangedPaths(files, [], []);

      expect(r1.violations).toEqual(r2.violations);
    });

    it("non-ASCII order by code unit", () => {
      const result = validateChangedPaths(
        [
          file("\u00e9.txt", "MODIFIED"),
          file("\u00e0.txt", "MODIFIED"),
        ],
        [],
        [],
      );

      expect(result.violations).toHaveLength(2);
      const eCode = "\u00e9".charCodeAt(0);
      const aCode = "\u00e0".charCodeAt(0);
      if (aCode < eCode) {
        expect(result.violations[0]!.path).toBe("\u00e0.txt");
        expect(result.violations[1]!.path).toBe("\u00e9.txt");
      } else {
        expect(result.violations[0]!.path).toBe("\u00e9.txt");
        expect(result.violations[1]!.path).toBe("\u00e0.txt");
      }
    });
  });

  describe("immutability", () => {
    it("does not mutate changedFiles", () => {
      const files = [file("src.ts", "MODIFIED")];
      const snapshot = [...files];

      validateChangedPaths(files, ["src.ts"], []);

      expect(files).toEqual(snapshot);
    });

    it("does not mutate allowedPaths", () => {
      const allowed = ["src"];
      const snapshot = [...allowed];

      validateChangedPaths([file("src.ts", "MODIFIED")], allowed, []);

      expect(allowed).toEqual(snapshot);
    });

    it("does not mutate forbiddenPaths", () => {
      const forbidden = ["db.ts"];
      const snapshot = [...forbidden];

      validateChangedPaths([file("src.ts", "MODIFIED")], ["src"], forbidden);

      expect(forbidden).toEqual(snapshot);
    });

    it("returns new violations array", () => {
      const r1 = validateChangedPaths([file("x.ts", "MODIFIED")], [], []);
      const r2 = validateChangedPaths([file("x.ts", "MODIFIED")], [], []);

      expect(r1.violations).not.toBe(r2.violations);
    });
  });

  describe("message stability", () => {
    it("NOT_ALLOWED message is stable", () => {
      const result = validateChangedPaths(
        [file("secret.ts", "MODIFIED")],
        ["src"],
        [],
      );
      expect(result.violations[0]!.message).toBe(
        "Path no permitido: secret.ts no coincide con ninguna regla allowed.",
      );
    });

    it("FORBIDDEN message is stable", () => {
      const result = validateChangedPaths(
        [file("src/db.ts", "MODIFIED")],
        ["src"],
        ["src/db.ts"],
      );
      expect(result.violations[0]!.message).toBe(
        'Path prohibido: src/db.ts coincide con la regla forbidden "src/db.ts".',
      );
    });
  });
});
