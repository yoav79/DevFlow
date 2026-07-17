/// <reference types="node" />

import { getDefaultDatabasePath, initializeSchema, openDatabase } from "../db.js";
import { getProjectById } from "../repositories/project-repository.js";
import { listTasksByProjectId } from "../repositories/task-repository.js";
import { listPendingHumanRequests } from "../repositories/human-request-repository.js";
import { TASK_STATES } from "../types.js";

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
]);

export interface StatusOptions {
  project: string;
}

export function runStatusCommand(options: StatusOptions): void {
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

    const pendingRequests = listPendingHumanRequests(database);
    const projectTaskIds = new Set(tasks.map((t) => t.id));
    const pendingCount = pendingRequests.filter((r) => projectTaskIds.has(r.taskId)).length;

    const total = tasks.length;
    const active = tasks.filter((t) => !TERMINAL_STATES.has(t.state)).length;

    console.log(`Proyecto: ${existingProject.id}`);
    console.log(`Nombre: ${existingProject.name}`);
    console.log(`Tareas totales: ${total}`);
    console.log(`Tareas activas: ${active}`);
    console.log(`Solicitudes pendientes: ${pendingCount}`);

    if (total === 0) {
      console.log(`Estados: Sin tareas`);
      return;
    }

    const counts = new Map<string, number>();

    for (const task of tasks) {
      counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
    }

    console.log(`Estados:`);

    for (const state of TASK_STATES) {
      const count = counts.get(state);

      if (count !== undefined) {
        console.log(`${state}: ${count}`);
      }
    }
  } finally {
    database.close();
  }
}
