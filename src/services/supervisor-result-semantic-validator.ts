import type {
  SupervisorResult,
  ExecutableTaskContract,
  DecompositionRequiredResult,
  DiscoveryRequiredResult,
} from "../types.js";

export type SupervisorSemanticIssueCode =
  | "DUPLICATE_VALUE"
  | "UNSAFE_PATH"
  | "CONFLICTING_PATH"
  | "INVALID_PATH"
  | "INSUFFICIENT_DISCOVERY"
  | "INSUFFICIENT_DECOMPOSITION";

export interface SupervisorSemanticIssue {
  code: SupervisorSemanticIssueCode;
  path: Array<string | number>;
  message: string;
}

export class SupervisorResultSemanticError extends Error {
  readonly issues: SupervisorSemanticIssue[];

  constructor(issues: SupervisorSemanticIssue[]) {
    const count = issues.length;
    super(`Resultado del supervisor semánticamente inválido: ${count} error(es).`);
    this.name = "SupervisorResultSemanticError";
    this.issues = issues.map((issue) => ({
      code: issue.code,
      path: [...issue.path],
      message: issue.message,
    }));
  }
}

function findDuplicateValues(
  field: string,
  values: string[],
): SupervisorSemanticIssue[] {
  const issues: SupervisorSemanticIssue[] = [];
  for (let i = 1; i < values.length; i++) {
    const current = values[i];
    for (let j = 0; j < i; j++) {
      if (current === values[j]) {
        issues.push({
          code: "DUPLICATE_VALUE",
          path: [field, i],
          message: `Valor duplicado en ${field}: ${current}`,
        });
        break;
      }
    }
  }
  return issues;
}

const ABSOLUTE_UNIX = /^\//;
const ABSOLUTE_WINDOWS = /^[a-zA-Z]:[/\\]/;
const UNC_PREFIX = /^\\\\/;
const HAS_DOT_DOT = /(^|\/)\.\.(\/|$)/;
const EXACT_DOT = /^\.$/;
const DOUBLE_SLASH = /\/\//;
const HAS_BACKSLASH = /\\/;
const ENDS_WITH_SLASH = /\/$/;

function validatePath(
  field: string,
  value: string,
): SupervisorSemanticIssue[] {
  const issues: SupervisorSemanticIssue[] = [];
  const index = (field === "allowedPaths" ? -1 : -1); // caller provides index in path

  if (ABSOLUTE_UNIX.test(value)) {
    issues.push({
      code: "UNSAFE_PATH",
      path: [field],
      message: `Ruta insegura en ${field}: ${value}`,
    });
  } else if (ABSOLUTE_WINDOWS.test(value)) {
    issues.push({
      code: "UNSAFE_PATH",
      path: [field],
      message: `Ruta insegura en ${field}: ${value}`,
    });
  } else if (UNC_PREFIX.test(value)) {
    issues.push({
      code: "UNSAFE_PATH",
      path: [field],
      message: `Ruta insegura en ${field}: ${value}`,
    });
  } else if (HAS_DOT_DOT.test(value)) {
    issues.push({
      code: "UNSAFE_PATH",
      path: [field],
      message: `Ruta insegura en ${field}: ${value}`,
    });
  } else if (EXACT_DOT.test(value)) {
    issues.push({
      code: "INVALID_PATH",
      path: [field],
      message: `Ruta inválida en ${field}: ${value}`,
    });
  } else if (DOUBLE_SLASH.test(value)) {
    issues.push({
      code: "INVALID_PATH",
      path: [field],
      message: `Ruta inválida en ${field}: ${value}`,
    });
  } else if (HAS_BACKSLASH.test(value)) {
    issues.push({
      code: "INVALID_PATH",
      path: [field],
      message: `Ruta inválida en ${field}: ${value}`,
    });
  } else if (ENDS_WITH_SLASH.test(value)) {
    issues.push({
      code: "INVALID_PATH",
      path: [field],
      message: `Ruta inválida en ${field}: ${value}`,
    });
  }

  return issues;
}

function validatePathsArray(
  field: string,
  values: string[],
): SupervisorSemanticIssue[] {
  const issues: SupervisorSemanticIssue[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    const pathIssues = validatePath(field, value);
    for (const issue of pathIssues) {
      issue.path = [field, i];
      issues.push(issue);
    }
  }
  return issues;
}

function validateExecutableTask(
  result: ExecutableTaskContract,
): SupervisorSemanticIssue[] {
  const issues: SupervisorSemanticIssue[] = [];

  issues.push(...findDuplicateValues("acceptanceCriteria", result.acceptanceCriteria));
  issues.push(...findDuplicateValues("allowedPaths", result.allowedPaths));
  issues.push(...findDuplicateValues("forbiddenPaths", result.forbiddenPaths));
  issues.push(...findDuplicateValues("requiredCommands", result.requiredCommands));
  issues.push(...findDuplicateValues("assumptions", result.assumptions));
  issues.push(...findDuplicateValues("risks", result.risks));

  issues.push(...validatePathsArray("allowedPaths", result.allowedPaths));
  issues.push(...validatePathsArray("forbiddenPaths", result.forbiddenPaths));

  for (let i = 0; i < result.forbiddenPaths.length; i++) {
    const forbidden = result.forbiddenPaths[i]!;
    if (result.allowedPaths.includes(forbidden)) {
      issues.push({
        code: "CONFLICTING_PATH",
        path: ["forbiddenPaths", i],
        message: `La ruta está permitida y prohibida al mismo tiempo: ${forbidden}`,
      });
    }
  }

  return issues;
}

function validateDecomposition(
  result: DecompositionRequiredResult,
): SupervisorSemanticIssue[] {
  const issues: SupervisorSemanticIssue[] = [];

  issues.push(...findDuplicateValues("openQuestions", result.openQuestions));

  const titles = result.suggestedTasks.map((t) => t.title);
  for (let i = 1; i < titles.length; i++) {
    const current = titles[i];
    for (let j = 0; j < i; j++) {
      if (current === titles[j]) {
        issues.push({
          code: "DUPLICATE_VALUE",
          path: ["suggestedTasks", i, "title"],
          message: `Título de tarea sugerida duplicado: ${current}`,
        });
        break;
      }
    }
  }

  if (result.suggestedTasks.length < 2) {
    issues.push({
      code: "INSUFFICIENT_DECOMPOSITION",
      path: ["suggestedTasks"],
      message: "La descomposición debe proponer al menos 2 tareas.",
    });
  }

  return issues;
}

function validateDiscovery(
  result: DiscoveryRequiredResult,
): SupervisorSemanticIssue[] {
  const issues: SupervisorSemanticIssue[] = [];

  issues.push(...findDuplicateValues("missingInformation", result.missingInformation));
  issues.push(...findDuplicateValues("recommendedDiscoveryActions", result.recommendedDiscoveryActions));
  issues.push(...findDuplicateValues("openQuestions", result.openQuestions));

  if (result.openQuestions.length === 0 && result.recommendedDiscoveryActions.length === 0) {
    issues.push({
      code: "INSUFFICIENT_DISCOVERY",
      path: ["recommendedDiscoveryActions"],
      message: "El descubrimiento debe incluir preguntas abiertas o acciones recomendadas.",
    });
  }

  return issues;
}

export function validateSupervisorResultSemantics(
  result: SupervisorResult,
): SupervisorResult {
  let issues: SupervisorSemanticIssue[];

  switch (result.classification) {
    case "EXECUTABLE_TASK":
      issues = validateExecutableTask(result);
      break;
    case "NEEDS_DECOMPOSITION":
      issues = validateDecomposition(result);
      break;
    case "NEEDS_DISCOVERY":
      issues = validateDiscovery(result);
      break;
  }

  if (issues.length > 0) {
    throw new SupervisorResultSemanticError(issues);
  }

  return result;
}
