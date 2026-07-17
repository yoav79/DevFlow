/// <reference types="node" />

import process from "node:process";

import { getDefaultDatabasePath, initializeSchema, openDatabase } from "../db.js";
import { listPendingHumanRequests } from "../repositories/human-request-repository.js";
import { getTaskById } from "../repositories/task-repository.js";

export interface RequestListOptions {
  task: string;
}

function parseOptions(requestId: string, optionsJson: string | null): string {
  if (optionsJson === null) {
    return "Ninguna";
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    throw new Error(`La solicitud ${requestId} contiene opciones inválidas.`);
  }

  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`La solicitud ${requestId} contiene opciones inválidas.`);
  }

  return parsed.join(", ");
}

export function runRequestListCommand(options: RequestListOptions): void {
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

    const requests = listPendingHumanRequests(database).filter((request) => request.taskId === taskId);

    if (requests.length === 0) {
      process.stdout.write(`Solicitudes pendientes para ${taskId}: 0\n`);
      return;
    }

    const lines = [`Solicitudes pendientes para ${taskId}: ${requests.length}`];

    for (const [index, request] of requests.entries()) {
      if (index > 0) {
        lines.push("");
      }

      lines.push(
        `ID: ${request.id}`,
        `Tipo: ${request.type}`,
        `Pregunta: ${request.question}`,
        `Opciones: ${parseOptions(request.id, request.optionsJson)}`,
        `Creada: ${request.createdAt}`,
      );
    }

    process.stdout.write(`${lines.join("\n")}\n`);
  } finally {
    database.close();
  }
}
