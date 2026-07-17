import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../helpers/cli-runner.js";
import { createTempDirectory, type TempDirectory } from "../helpers/temp-directory.js";
import { createTempGitRepository, type TempGitRepository } from "../helpers/temp-git-repository.js";

describe("DevFlow Phase 3 integration flow", () => {
  it("completes the project and task management flow", () => {
    let homeDirectory: TempDirectory | null = null;
    let gitRepository: TempGitRepository | null = null;

    try {
      homeDirectory = createTempDirectory();
      gitRepository = createTempGitRepository();

      const home = homeDirectory.path;

      const initResult = runCli(["init"], { home });
      expect(initResult.exitCode).toBe(0);
      expect(initResult.stdout).toContain("DevFlow inicializado en:");

      const addResult = runCli(["project", "add", gitRepository.path, "--id", "alpha", "--name", "Alpha"], { home });
      expect(addResult.exitCode).toBe(0);
      expect(addResult.stdout).toContain("Proyecto registrado: alpha");
      expect(addResult.stdout).toContain("Rama por defecto: main");

      const listResult = runCli(["project", "list"], { home });
      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain("ID: alpha");
      expect(listResult.stdout).toContain("Nombre: Alpha");
      expect(listResult.stdout).toContain(gitRepository.path);

      const createResult = runCli(["task", "create", "--project", "alpha", "--id", "TASK-001", "--title", "Primera tarea", "--description", "Validar el flujo integral"], { home });
      expect(createResult.exitCode).toBe(0);
      expect(createResult.stdout).toBe("Tarea creada: TASK-001\nProyecto: alpha\nEstado: CREATED");

      const taskListResult = runCli(["task", "list", "--project", "alpha"], { home });
      expect(taskListResult.exitCode).toBe(0);
      expect(taskListResult.stdout).toContain("ID: TASK-001");
      expect(taskListResult.stdout).toContain("Título: Primera tarea");
      expect(taskListResult.stdout).toContain("Estado: CREATED");
      expect(taskListResult.stdout).toContain("Intento: 0/2");

      const statusResult = runCli(["status", "--project", "alpha"], { home });
      expect(statusResult.exitCode).toBe(0);
      expect(statusResult.stdout).toContain("Proyecto: alpha");
      expect(statusResult.stdout).toContain("Tareas totales: 1");
      expect(statusResult.stdout).toContain("Tareas activas: 1");
      expect(statusResult.stdout).toContain("Solicitudes pendientes: 0");
      expect(statusResult.stdout).toContain("CREATED: 1");

      const inspectResult = runCli(["inspect", "--task", "TASK-001"], { home });
      expect(inspectResult.exitCode).toBe(0);
      expect(inspectResult.stdout).toContain("Tarea: TASK-001");
      expect(inspectResult.stdout).toContain("Proyecto: alpha");
      expect(inspectResult.stdout).toContain("Estado: CREATED");
      expect(inspectResult.stdout).toContain("Contrato: No");
      expect(inspectResult.stdout).toContain("Revisión actual: No");
      expect(inspectResult.stdout).toContain("Solicitudes pendientes: 0");

      expect(existsSync(join(home, ".devflow", "devflow.db"))).toBe(true);

      const gitStatus = runCli(["--version"], { home, cwd: gitRepository.path });
      expect(gitStatus.exitCode).toBe(0);

      const duplicateResult = runCli(["task", "create", "--project", "alpha", "--id", "TASK-001", "--title", "Duplicada", "--description", "No debe crear"], { home });
      expect(duplicateResult.exitCode).toBe(1);
      expect(duplicateResult.stdout).toBe("");
      expect(duplicateResult.stderr).toContain("Ya existe una tarea con id TASK-001.");
    } finally {
      gitRepository?.cleanup();
      homeDirectory?.cleanup();
    }
  });
});
