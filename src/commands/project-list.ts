import { getDefaultDatabasePath, initializeSchema, openDatabase } from "../db.js";
import { listProjects } from "../repositories/project-repository.js";

export function runProjectListCommand(): void {
  const database = openDatabase(getDefaultDatabasePath());

  try {
    initializeSchema(database);

    const projects = listProjects(database);

    if (projects.length === 0) {
      console.log("No hay proyectos registrados.");
      return;
    }

    const lines = projects.flatMap((project, index) => {
      const entry = [
        `ID: ${project.id}`,
        `Nombre: ${project.name}`,
        `Ruta: ${project.repositoryPath}`,
        `Rama: ${project.defaultBranch}`,
        `Creado: ${project.createdAt}`,
      ];

      if (index < projects.length - 1) {
        entry.push("");
      }

      return entry;
    });

    console.log(lines.join("\n"));
  } finally {
    database.close();
  }
}
