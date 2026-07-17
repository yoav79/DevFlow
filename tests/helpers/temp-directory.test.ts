import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTempDirectory } from "./temp-directory.js";

describe("createTempDirectory", () => {
  const createdDirectories: Array<{ cleanup(): void }> = [];

  afterEach(() => {
    while (createdDirectories.length > 0) {
      createdDirectories.pop()?.cleanup();
    }
  });

  it("creates a directory inside tmpdir", () => {
    const tempDirectory = createTempDirectory();

    createdDirectories.push(tempDirectory);

    expect(tempDirectory.path.startsWith(join(tmpdir(), "devflow-test-"))).toBe(true);
  });

  it("returns an absolute path", () => {
    const tempDirectory = createTempDirectory();

    createdDirectories.push(tempDirectory);

    expect(tempDirectory.path.startsWith("/")).toBe(true);
  });

  it("uses the default prefix", () => {
    const tempDirectory = createTempDirectory();

    createdDirectories.push(tempDirectory);

    expect(tempDirectory.path).toContain("devflow-test-");
  });

  it("uses a custom prefix", () => {
    const tempDirectory = createTempDirectory("alpha");

    createdDirectories.push(tempDirectory);

    expect(tempDirectory.path).toContain("alpha-");
  });

  it("normalizes a prefixed value with spaces", () => {
    const tempDirectory = createTempDirectory("  beta  ");

    createdDirectories.push(tempDirectory);

    expect(tempDirectory.path).toContain("beta-");
  });

  it("prevents path separators from escaping tmpdir", () => {
    const tempDirectory = createTempDirectory("nested/escape");

    createdDirectories.push(tempDirectory);

    expect(tempDirectory.path.startsWith(join(tmpdir(), "escape-"))).toBe(true);
  });

  it("cleans up the directory", () => {
    const tempDirectory = createTempDirectory();

    expect(existsSync(tempDirectory.path)).toBe(true);
    expect(() => tempDirectory.cleanup()).not.toThrow();
    expect(existsSync(tempDirectory.path)).toBe(false);
    expect(() => tempDirectory.cleanup()).not.toThrow();
  });

  it("can be cleaned up twice", () => {
    const tempDirectory = createTempDirectory();

    tempDirectory.cleanup();
    expect(existsSync(tempDirectory.path)).toBe(false);

    expect(() => tempDirectory.cleanup()).not.toThrow();
  });

  it("creates distinct paths on subsequent calls", () => {
    const first = createTempDirectory();
    const second = createTempDirectory();

    createdDirectories.push(first, second);

    expect(first.path).not.toBe(second.path);
  });

  it("can contain files and subdirectories before cleanup", () => {
    const tempDirectory = createTempDirectory();

    createdDirectories.push(tempDirectory);

    const nestedDirectory = join(tempDirectory.path, "nested");
    const nestedFile = join(nestedDirectory, "file.txt");

    mkdirSync(nestedDirectory);
    writeFileSync(nestedFile, "hello");

    expect(() => tempDirectory.cleanup()).not.toThrow();
  });
});
