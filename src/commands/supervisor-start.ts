/// <reference types="node" />

import process from "node:process";

import { getDefaultDatabasePath, initializeSchema, openDatabase } from "../db.js";
import { getTaskById, updateTaskState } from "../repositories/task-repository.js";

export interface SupervisorStartOptions {
  task: string;
}

export function runSupervisorStartCommand(options: SupervisorStartOptions): void {
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

    const previousState = task.state;

    if (task.state === "CREATED") {
      const updated = updateTaskState(database, taskId, "GENERATING_CONTRACT", new Date().toISOString());

      if (updated === null || updated.state !== "GENERATING_CONTRACT") {
        throw new Error(`No se pudo iniciar el supervisor para la tarea: ${taskId}`);
      }
    } else if (task.state !== "GENERATING_CONTRACT") {
      throw new Error(
        `La tarea ${taskId} no puede iniciar el supervisor desde el estado ${task.state}.`,
      );
    }

    const currentTask = getTaskById(database, taskId);

    if (currentTask === null || currentTask.state !== "GENERATING_CONTRACT") {
      throw new Error(`No se pudo iniciar el supervisor para la tarea: ${taskId}`);
    }

    process.stdout.write(
      `Supervisor iniciado: ${taskId}\nEstado anterior: ${previousState}\nEstado actual: GENERATING_CONTRACT\n`,
    );
  } finally {
    database.close();
  }
}
