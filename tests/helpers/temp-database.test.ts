import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeSchema } from "../../src/db.js";
import { createTempDatabase } from "./temp-database.js";

describe("createTempDatabase", () => {
  const createdDatabases: Array<{ cleanup(): void }> = [];

  afterEach(() => {
    while (createdDatabases.length > 0) {
      createdDatabases.pop()?.cleanup();
    }
  });

  it("creates a SQLite file inside a temporary directory", () => {
    const tempDatabase = createTempDatabase();

    createdDatabases.push(tempDatabase);

    expect(tempDatabase.databasePath).toContain(join(tempDatabase.directory.path, "devflow.db"));
  });

  it("returns an absolute path", () => {
    const tempDatabase = createTempDatabase();

    createdDatabases.push(tempDatabase);

    expect(tempDatabase.databasePath.startsWith("/")).toBe(true);
  });

  it("creates the database file", () => {
    const tempDatabase = createTempDatabase();

    createdDatabases.push(tempDatabase);

    expect(existsSync(tempDatabase.databasePath)).toBe(true);
  });

  it("enables foreign keys", () => {
    const tempDatabase = createTempDatabase();

    createdDatabases.push(tempDatabase);

    const row = tempDatabase.database.prepare("PRAGMA foreign_keys;").get() as { foreign_keys?: number };

    expect(row.foreign_keys).toBe(1);
  });

  it("creates the expected tables", () => {
    const tempDatabase = createTempDatabase();

    createdDatabases.push(tempDatabase);

    const rows = tempDatabase.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual(["human_requests", "projects", "task_reviews", "task_workspaces", "tasks"]);
  });

  it("initializes the schema and can run it again", () => {
    const tempDatabase = createTempDatabase();

    createdDatabases.push(tempDatabase);

    expect(() => initializeSchema(tempDatabase.database)).not.toThrow();
  });

  it("closes the connection", () => {
    const tempDatabase = createTempDatabase();

    createdDatabases.push(tempDatabase);
    tempDatabase.close();

    expect(() => tempDatabase.database.prepare("SELECT 1").get()).toThrow();
  });

  it("allows close to be called twice", () => {
    const tempDatabase = createTempDatabase();

    createdDatabases.push(tempDatabase);
    tempDatabase.close();

    expect(() => tempDatabase.close()).not.toThrow();
  });

  it("does not delete the file on close", () => {
    const tempDatabase = createTempDatabase();

    createdDatabases.push(tempDatabase);
    expect(existsSync(tempDatabase.databasePath)).toBe(true);

    tempDatabase.close();

    expect(existsSync(tempDatabase.databasePath)).toBe(true);
  });

  it("cleanup closes and removes the directory", () => {
    const tempDatabase = createTempDatabase();

    tempDatabase.cleanup();

    expect(existsSync(tempDatabase.directory.path)).toBe(false);
  });

  it("cleanup works after close", () => {
    const tempDatabase = createTempDatabase();

    tempDatabase.close();
    expect(() => tempDatabase.cleanup()).not.toThrow();
    expect(existsSync(tempDatabase.directory.path)).toBe(false);
  });

  it("cleanup can be called twice", () => {
    const tempDatabase = createTempDatabase();

    tempDatabase.cleanup();

    expect(() => tempDatabase.cleanup()).not.toThrow();
  });

  it("creates independent databases", () => {
    const first = createTempDatabase();
    const second = createTempDatabase();

    createdDatabases.push(first, second);

    expect(first.databasePath).not.toBe(second.databasePath);

    first.database.prepare("INSERT INTO projects (id, name, repositoryPath, defaultBranch, createdAt) VALUES (?, ?, ?, ?, ?)").run(
      "alpha",
      "Alpha",
      "/tmp/alpha",
      "main",
      "2026-01-01T00:00:00.000Z",
    );

    const secondProject = second.database.prepare("SELECT * FROM projects WHERE id = ?").get("alpha");

    expect(secondProject).toBeUndefined();
  });

  it("keeps separate contents between two databases", () => {
    const first = createTempDatabase();
    const second = createTempDatabase();

    createdDatabases.push(first, second);

    first.database.prepare("INSERT INTO projects (id, name, repositoryPath, defaultBranch, createdAt) VALUES (?, ?, ?, ?, ?)").run(
      "alpha",
      "Alpha",
      "/tmp/alpha",
      "main",
      "2026-01-01T00:00:00.000Z",
    );

    const firstProject = first.database.prepare("SELECT * FROM projects WHERE id = ?").get("alpha");
    const secondProject = second.database.prepare("SELECT * FROM projects WHERE id = ?").get("alpha");

    expect(firstProject).toBeDefined();
    expect(secondProject).toBeUndefined();
  });
});
