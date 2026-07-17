/// <reference types="node" />

import { getDefaultDatabasePath, initializeSchema, openDatabase } from "../db.js";
import { listTasksByProjectId } from "../repositories/task-repository.js";
import { getProjectById } from "../repositories/project-repository.js";

export interface TaskListOptions {
  project: string;
}

export function runTaskListCommand(options: TaskListOptions): void {
  const project = options.project.trim();

  if (project.length === 0) {
    throw new Error("El id del proyecto no puede estar vacío.");
  }

  const database = openDatabase(getDefaultDatabasePath());

  try {
    initializeSchema(database);

    const existingProject = getProjectById(database, project);

    if (existingProject === null) {
      throw new Error(`No existe el proyecto: ${project}`);
    }

    const tasks = listTasksByProjectId(database, project);

    if (tasks.length === 0) {
      console.log(`No hay tareas para el proyecto: ${project}`);
      return;
    }

    const lines = tasks.flatMap((task, index) => {
      const entry = [
        `ID: ${task.id}`,
        `Título: ${task.title}`,
        `Estado: ${task.state}`,
        `Intento: ${task.attempt}/${task.maxAttempts}`,
        `Creada: ${task.createdAt}`,
      ];

      if (index < tasks.length - 1) {
        entry.push("");
      }

      return entry;
    });

    console.log(lines.join("\n"));
  } finally {
    database.close();
  }
}
