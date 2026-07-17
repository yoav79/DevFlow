import { getDefaultDatabasePath, initializeSchema, openDatabase } from "../db.js";

export function runInitCommand(): void {
  const databasePath = getDefaultDatabasePath();
  const database = openDatabase(databasePath);
  let initializationError: unknown;

  try {
    initializeSchema(database);
    console.log(`DevFlow inicializado en: ${databasePath}`);
  } catch (error) {
    initializationError = error;
    throw error;
  } finally {
    try {
      database.close();
    } catch (closeError) {
      if (initializationError === undefined) {
        throw closeError;
      }
    }
  }
}
