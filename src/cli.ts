#!/usr/bin/env node

import { Command } from "commander";

import { runInitCommand } from "./commands/init.js";
import { runProjectAddCommand } from "./commands/project-add.js";
import { runProjectListCommand } from "./commands/project-list.js";
import { runTaskCreateCommand } from "./commands/task-create.js";
import { runTaskListCommand } from "./commands/task-list.js";
import { runStatusCommand } from "./commands/status.js";
import { runInspectCommand } from "./commands/inspect.js";
import { runSupervisorStartCommand } from "./commands/supervisor-start.js";
import { runSupervisorApplyCommand } from "./commands/supervisor-apply.js";
import { runContractDecideCommand } from "./commands/contract-decide.js";
import { runRequestListCommand } from "./commands/request-list.js";
import { runRequestDecideCommand } from "./commands/request-decide.js";

const program = new Command();

program
  .name("devflow")
  .description("Orquestador local de desarrollo multiagente")
  .version("0.1.0");

program
  .command("hello")
  .description("Verifica que DevFlow está funcionando")
  .action(() => {
    console.log("DevFlow MVP1 está funcionando.");
  });

program
  .command("init")
  .description("Inicializa el almacenamiento local de DevFlow")
  .action(() => {
    runInitCommand();
  });

const projectCommand = program.command("project").description("Gestiona proyectos registrados");

projectCommand
  .command("add")
  .description("Registra un repositorio Git externo")
  .argument("<repository-path>")
  .requiredOption("--id <id>", "Identificador del proyecto")
  .requiredOption("--name <name>", "Nombre del proyecto")
  .option("--branch <branch>", "Rama por defecto")
  .action((repositoryPath, options) => {
    runProjectAddCommand(repositoryPath, options as { id: string; name: string; branch?: string });
  });

projectCommand
  .command("list")
  .description("Lista los proyectos registrados")
  .action(() => {
    runProjectListCommand();
  });

const taskCommand = program.command("task").description("Gestiona tareas de DevFlow");

taskCommand
  .command("create")
  .description("Crea una tarea para un proyecto registrado")
  .requiredOption("--project <project-id>", "Identificador del proyecto")
  .requiredOption("--id <task-id>", "Identificador de la tarea")
  .requiredOption("--title <title>", "Título de la tarea")
  .requiredOption("--description <description>", "Descripción de la tarea")
  .action((options) => {
    runTaskCreateCommand(options as { project: string; id: string; title: string; description: string });
  });

taskCommand
  .command("list")
  .description("Lista las tareas de un proyecto")
  .requiredOption("--project <project-id>", "Identificador del proyecto")
  .action((options) => {
    runTaskListCommand(options as { project: string });
  });

const supervisorCommand = program.command("supervisor").description("Controla la fase del supervisor");

supervisorCommand
  .command("start")
  .description("Inicia explícitamente la generación de contrato de una tarea")
  .requiredOption("--task <task-id>", "Identificador de la tarea")
  .action((options) => {
    runSupervisorStartCommand(options as { task: string });
  });

supervisorCommand
  .command("apply")
  .description("Aplica manualmente un resultado del supervisor a una tarea")
  .requiredOption("--task <task-id>", "Identificador de la tarea")
  .requiredOption("--result <json-file>", "Archivo JSON con el resultado del supervisor")
  .action((options) => {
    runSupervisorApplyCommand(options as { task: string; result: string });
  });

const contractCommand = program.command("contract").description("Resuelve decisiones contractuales");

contractCommand
  .command("decide")
  .description("Resuelve manualmente una aprobación contractual")
  .requiredOption("--request <request-id>", "Identificador de la solicitud")
  .requiredOption("--decision <decision>", "Decisión contractual")
  .option("--comment <text>", "Comentario humano")
  .action((options) => {
    runContractDecideCommand(options as { request: string; decision: string; comment?: string });
  });

const requestCommand = program.command("request").description("Gestiona solicitudes humanas");

requestCommand
  .command("list")
  .description("Lista las solicitudes humanas pendientes de una tarea")
  .requiredOption("--task <task-id>", "Identificador de la tarea")
  .action((options) => {
    runRequestListCommand(options as { task: string });
  });

requestCommand
  .command("decide")
  .description("Resuelve manualmente una decisión funcional")
  .requiredOption("--request <request-id>", "Identificador de la solicitud")
  .requiredOption("--decision <decision>", "Decisión funcional")
  .option("--comment <text>", "Comentario humano")
  .action((options) => {
    runRequestDecideCommand(options as { request: string; decision: string; comment?: string });
  });

program
  .command("status")
  .description("Muestra el estado operativo de un proyecto")
  .requiredOption("--project <project-id>", "Identificador del proyecto")
  .action((options) => {
    runStatusCommand(options as { project: string });
  });

program
  .command("inspect")
  .description("Muestra el detalle operativo de una tarea")
  .requiredOption("--task <task-id>", "Identificador de la tarea")
  .action((options) => {
    runInspectCommand(options as { task: string });
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

void main();
