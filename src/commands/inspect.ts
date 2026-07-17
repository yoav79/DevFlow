/// <reference types="node" />

import { getDefaultDatabasePath, initializeSchema, openDatabase } from "../db.js";
import { getTaskById } from "../repositories/task-repository.js";
import { getProjectById } from "../repositories/project-repository.js";
import { listPendingHumanRequests } from "../repositories/human-request-repository.js";

export interface InspectOptions {
  task: string;
}

export function runInspectCommand(options: InspectOptions): void {
  const taskId = options.task.trim();

  if (taskId.length === 0) {
    throw new Error("El id de la tarea no puede estar vacío.");
  }

  const database = openDatabase(getDefaultDatabasePath());

  try {
    initializeSchema(database);

    const task = getTaskById(database, taskId);

    if (task === null) {
      throw new Error(`No existe la tarea: ${taskId}`);
    }

    const project = getProjectById(database, task.projectId);

    if (project === null) {
      throw new Error(`La tarea ${taskId} referencia un proyecto inexistente: ${task.projectId}`);
    }

    const pendingRequests = listPendingHumanRequests(database);
    const pendingCount = pendingRequests.filter((r) => r.taskId === taskId).length;

    const contract = task.contractJson !== null ? "Sí" : "No";
    const revision = task.currentRevisionJson !== null ? "Sí" : "No";

    console.log(`Tarea: ${task.id}`);
    console.log(`Proyecto: ${task.projectId}`);
    console.log(`Nombre del proyecto: ${project.name}`);
    console.log(`Título: ${task.title}`);
    console.log(`Descripción: ${task.description}`);
    console.log(`Estado: ${task.state}`);
    console.log(`Intento: ${task.attempt}/${task.maxAttempts}`);
    console.log(`Contrato: ${contract}`);
    console.log(`Revisión actual: ${revision}`);
    console.log(`Solicitudes pendientes: ${pendingCount}`);
    console.log(`Creada: ${task.createdAt}`);
    console.log(`Actualizada: ${task.updatedAt}`);
  } finally {
    database.close();
  }
}
