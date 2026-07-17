import { existsSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createTempGitRepository } from "./temp-git-repository.js";

describe("createTempGitRepository", () => {
  const repositories: Array<{ cleanup(): void }> = [];

  afterEach(() => {
    while (repositories.length > 0) {
      repositories.pop()?.cleanup();
    }
  });

  it("creates a valid Git repository", () => {
    const repository = createTempGitRepository();

    repositories.push(repository);

    expect(repository.runGit(["rev-parse", "--is-inside-work-tree"])).toBe("true");
  });

  it("uses the main branch", () => {
    const repository = createTempGitRepository();

    repositories.push(repository);

    expect(repository.runGit(["branch", "--show-current"]).trim()).toBe("main");
  });

  it("has exactly one initial commit", () => {
    const repository = createTempGitRepository();

    repositories.push(repository);

    expect(repository.runGit(["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("keeps the working tree clean", () => {
    const repository = createTempGitRepository();

    repositories.push(repository);

    expect(repository.runGit(["status", "--short"])).toBe("");
  });

  it("cleans up the repository and is idempotent", () => {
    const repository = createTempGitRepository();

    expect(existsSync(repository.path)).toBe(true);
    repository.cleanup();
    expect(existsSync(repository.path)).toBe(false);

    expect(() => repository.cleanup()).not.toThrow();
  });
});
