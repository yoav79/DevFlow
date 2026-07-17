/// <reference types="node" />

import { openDatabase, initializeSchema } from "../db.js";
import { createTask, getTaskById } from "../repositories/task-repository.js";
import { getProjectById } from "../repositories/project-repository.js";
import type { Task } from "../types.js";

export interface TaskCreateOptions {
  project: string;
  id: string;
  title: string;
  description: string;
}

export function runTaskCreateCommand(options: TaskCreateOptions): void {
  const project = options.project.trim();
  const id = options.id.trim();
  const title = options.title.trim();
  const description = options.description.trim();

  if (project.length === 0) {
    throw new Error("El id del proyecto no puede estar vacío.");
  }

  if (id.length === 0) {
    throw new Error("El id de la tarea no puede estar vacío.");
  }

  if (title.length === 0) {
    throw new Error("El título de la tarea no puede estar vacío.");
  }

  if (description.length === 0) {
    throw new Error("La descripción de la tarea no puede estar vacía.");
  }

  const database = openDatabase();

  try {
    initializeSchema(database);

    const existingProject = getProjectById(database, project);

    if (existingProject === null) {
      throw new Error(`No existe el proyecto: ${project}`);
    }

    const existingTask = getTaskById(database, id);

    if (existingTask !== null) {
      throw new Error(`Ya existe una tarea con id ${id}.`);
    }

    const now = new Date().toISOString();

    const task: Task = {
      id,
      projectId: project,
      title,
      description,
      state: "CREATED",
      attempt: 0,
      maxAttempts: 2,
      contractJson: null,
      currentRevisionJson: null,
      createdAt: now,
      updatedAt: now,
    };

    createTask(database, task);

    console.log(`Tarea creada: ${id}`);
    console.log(`Proyecto: ${project}`);
    console.log(`Estado: CREATED`);
  } finally {
    database.close();
  }
}
