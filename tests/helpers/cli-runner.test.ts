import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli-runner.js";
import { createTempDirectory, type TempDirectory } from "./temp-directory.js";

describe("runCli", () => {
  const directories: TempDirectory[] = [];

  afterEach(() => {
    while (directories.length > 0) {
      directories.pop()?.cleanup();
    }
  });

  it("executes hello and returns exitCode 0", () => {
    const directory = createTempDirectory();
    directories.push(directory);

    const result = runCli(["hello"], { home: directory.path });

    expect(result.exitCode).toBe(0);
  });

  it("captures the exact hello message", () => {
    const directory = createTempDirectory();
    directories.push(directory);

    const result = runCli(["hello"], { home: directory.path });

    expect(result.stdout).toBe("DevFlow MVP1 está funcionando.");
  });

  it("executes init with a temporary HOME and creates .devflow/devflow.db", () => {
    const directory = createTempDirectory();
    directories.push(directory);

    const result = runCli(["init"], { home: directory.path });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(directory.path, ".devflow", "devflow.db"))).toBe(true);
  });

  it("returns exitCode 1 and stderr for inspect of a nonexistent task", () => {
    const directory = createTempDirectory();
    directories.push(directory);

    runCli(["init"], { home: directory.path });

    const result = runCli(["inspect", "--task", "MISSING"], { home: directory.path });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No existe la tarea: MISSING");
  });

  it("does not modify process.env.HOME or process.cwd()", () => {
    const originalHome = process.env.HOME;
    const originalCwd = process.cwd();

    const directory = createTempDirectory();
    directories.push(directory);

    runCli(["hello"], { home: directory.path });

    expect(process.env.HOME).toBe(originalHome);
    expect(process.cwd()).toBe(originalCwd);
  });
});
