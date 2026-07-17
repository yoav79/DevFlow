/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { Project } from "../types.js";

function mapRowToProject(row: Record<string, unknown>): Project {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    repositoryPath: String(row["repositoryPath"]),
    defaultBranch: String(row["defaultBranch"]),
    createdAt: String(row["createdAt"]),
  };
}

export function createProject(database: DatabaseSync, project: Project): Project {
  database
    .prepare(
      "INSERT INTO projects (id, name, repositoryPath, defaultBranch, createdAt) VALUES (?, ?, ?, ?, ?)",
    )
    .run(project.id, project.name, project.repositoryPath, project.defaultBranch, project.createdAt);

  return project;
}

export function getProjectById(database: DatabaseSync, projectId: string): Project | null {
  const row = database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
    | Record<string, unknown>
    | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRowToProject(row);
}

export function listProjects(database: DatabaseSync): Project[] {
  const rows = database
    .prepare("SELECT * FROM projects ORDER BY createdAt ASC, id ASC")
    .all() as Record<string, unknown>[];

  return rows.map(mapRowToProject);
}
