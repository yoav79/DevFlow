/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { getDefaultDatabasePath, initializeSchema, openDatabase } from "../db.js";
import { parseSupervisorResult } from "../services/supervisor-result-parser.js";
import { validateSupervisorResultSemantics } from "../services/supervisor-result-semantic-validator.js";
import { applySupervisorResult } from "../services/supervisor-result-application-service.js";

export interface SupervisorApplyOptions {
  task: string;
  result: string;
}

export function runSupervisorApplyCommand(options: SupervisorApplyOptions): void {
  const taskId = options.task.trim();
  const resultPath = options.result.trim();

  if (taskId.length === 0) {
    throw new Error("El id de la tarea no puede estar vacío.");
  }

  if (resultPath.length === 0) {
    throw new Error("La ruta del resultado no puede estar vacía.");
  }

  const absolutePath = resolve(process.cwd(), resultPath);

  let rawJson: string;

  try {
    rawJson = readFileSync(absolutePath, "utf8");
  } catch {
    throw new Error(`No se pudo leer el resultado del supervisor: ${absolutePath}`);
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawJson);
  } catch {
    throw new Error(`El archivo de resultado no contiene JSON válido: ${absolutePath}`);
  }

  const parsedResult = parseSupervisorResult(parsedJson);
  const validatedResult = validateSupervisorResultSemantics(parsedResult);

  const database = openDatabase(getDefaultDatabasePath());

  try {
    initializeSchema(database);

    const outcome = applySupervisorResult(database, taskId, validatedResult);

    switch (outcome.classification) {
      case "EXECUTABLE_TASK":
        process.stdout.write(
          `Resultado del supervisor aplicado: ${taskId}\n` +
            `Clasificación: ${outcome.classification}\n` +
            `Estado actual: ${outcome.currentState}\n` +
            `Solicitud humana: ${outcome.humanRequest.id}\n` +
            `Tipo de solicitud: ${outcome.humanRequest.type}\n` +
            `Contrato persistido: Sí\n`,
        );
        break;
      case "NEEDS_DECOMPOSITION":
        process.stdout.write(
          `Resultado del supervisor aplicado: ${taskId}\n` +
            `Clasificación: ${outcome.classification}\n` +
            `Estado actual: ${outcome.currentState}\n` +
            `Solicitud humana: ${outcome.humanRequest.id}\n` +
            `Tipo de solicitud: ${outcome.humanRequest.type}\n` +
            `Contrato persistido: No\n` +
            `Acción requerida: Descomposición humana\n`,
        );
        break;
      case "NEEDS_DISCOVERY":
        process.stdout.write(
          `Resultado del supervisor aplicado: ${taskId}\n` +
            `Clasificación: ${outcome.classification}\n` +
            `Estado actual: ${outcome.currentState}\n` +
            `Solicitud humana: ${outcome.humanRequest.id}\n` +
            `Tipo de solicitud: ${outcome.humanRequest.type}\n` +
            `Contrato persistido: No\n` +
            `Acción requerida: Descubrimiento humano\n`,
        );
        break;
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Clasificación desconocida: ${String(exhaustive)}`);
      }
    }
  } finally {
    database.close();
  }
}
