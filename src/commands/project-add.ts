import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { getDefaultDatabasePath, initializeSchema, openDatabase } from "../db.js";
import { createProject, getProjectById, listProjects } from "../repositories/project-repository.js";
import type { Project } from "../types.js";

export interface ProjectAddOptions {
  id: string;
  name: string;
  branch?: string;
}

type GitResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
};

function runGitInRepository(repositoryPath: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function ensureGitRepository(repositoryPath: string): void {
  const result = runGitInRepository(repositoryPath, ["rev-parse", "--is-inside-work-tree"]);

  if (result.error !== undefined) {
    throw new Error(`No se pudo ejecutar Git: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`La ruta no es un repositorio Git: ${repositoryPath}`);
  }

  if (result.stdout.trim() !== "true") {
    throw new Error(`La ruta no es un repositorio Git: ${repositoryPath}`);
  }
}

function getCurrentBranch(repositoryPath: string): string {
  const result = runGitInRepository(repositoryPath, ["branch", "--show-current"]);

  if (result.error !== undefined) {
    throw new Error(`No se pudo ejecutar Git: ${result.error.message}`);
  }

  if (result.status !== 0 || result.stdout.trim().length === 0) {
    throw new Error(
      `No se pudo determinar la rama actual para ${repositoryPath}; usa --branch.`,
    );
  }

  return result.stdout.trim();
}

export function runProjectAddCommand(repositoryPath: string, options: ProjectAddOptions): void {
  const resolvedRepositoryPath = resolve(repositoryPath);

  if (!existsSync(resolvedRepositoryPath)) {
    throw new Error(`La ruta no existe: ${resolvedRepositoryPath}`);
  }

  if (!statSync(resolvedRepositoryPath).isDirectory()) {
    throw new Error(`La ruta no es un directorio: ${resolvedRepositoryPath}`);
  }

  ensureGitRepository(resolvedRepositoryPath);

  const id = options.id.trim();
  if (id.length === 0) {
    throw new Error("El id del proyecto no puede estar vacío.");
  }

  const name = options.name.trim();
  if (name.length === 0) {
    throw new Error("El nombre del proyecto no puede estar vacío.");
  }

  const defaultBranch = options.branch === undefined ? getCurrentBranch(resolvedRepositoryPath) : options.branch.trim();
  if (defaultBranch.length === 0) {
    throw new Error("La rama por defecto no puede estar vacía.");
  }

  const database = openDatabase(getDefaultDatabasePath());

  try {
    initializeSchema(database);

    if (getProjectById(database, id) !== null) {
      throw new Error(`Ya existe un proyecto con id ${id}.`);
    }

    const projects = listProjects(database);
    if (projects.some((project) => project.repositoryPath === resolvedRepositoryPath)) {
      throw new Error(`La ruta ya está registrada: ${resolvedRepositoryPath}`);
    }

    const project: Project = {
      id,
      name,
      repositoryPath: resolvedRepositoryPath,
      defaultBranch,
      createdAt: new Date().toISOString(),
    };

    createProject(database, project);

    console.log(`Proyecto registrado: ${project.id}`);
    console.log(`Ruta: ${project.repositoryPath}`);
    console.log(`Rama por defecto: ${project.defaultBranch}`);
  } finally {
    database.close();
  }
}
