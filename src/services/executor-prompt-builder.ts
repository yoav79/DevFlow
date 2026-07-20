export interface ExecutorPromptInput {
  readonly project: {
    readonly name: string;
  };
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
  };
  readonly contract: {
    readonly objective: string;
    readonly context: string;
    readonly acceptanceCriteria: readonly string[];
    readonly allowedPaths: readonly string[];
    readonly forbiddenPaths: readonly string[];
    readonly requiredCommands: readonly string[];
    readonly assumptions: readonly string[];
    readonly risks: readonly string[];
  };
  readonly workspace: {
    readonly workspacePath: string;
    readonly branchName: string;
    readonly baseCommit: string;
    readonly executionNumber: number;
  };
}

export type ExecutorPromptBuildErrorCode =
  | "INVALID_PROJECT_NAME"
  | "INVALID_TASK_ID"
  | "INVALID_TASK_TITLE"
  | "INVALID_TASK_DESCRIPTION"
  | "INVALID_CONTRACT_OBJECTIVE"
  | "INVALID_CONTRACT_CONTEXT"
  | "INVALID_ACCEPTANCE_CRITERIA"
  | "INVALID_ALLOWED_PATHS"
  | "INVALID_FORBIDDEN_PATHS"
  | "INVALID_REQUIRED_COMMANDS"
  | "INVALID_ASSUMPTIONS"
  | "INVALID_RISKS"
  | "INVALID_WORKSPACE_PATH"
  | "INVALID_BRANCH_NAME"
  | "INVALID_BASE_COMMIT"
  | "INVALID_EXECUTION_NUMBER";

export class ExecutorPromptBuildError extends Error {
  readonly code: ExecutorPromptBuildErrorCode;
  readonly path: readonly (string | number)[];
  declare readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code: ExecutorPromptBuildErrorCode;
      path: readonly (string | number)[];
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "ExecutorPromptBuildError";
    this.code = options.code;
    this.path = [...options.path];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function isNonEmptyText(value: string): boolean {
  return value.trim().length > 0;
}

function validateTextField(
  value: string,
  path: readonly (string | number)[],
  code: ExecutorPromptBuildErrorCode,
  message: string,
): string {
  if (!isNonEmptyText(value)) {
    throw new ExecutorPromptBuildError(message, { code, path });
  }

  return value;
}

function validateExecutionNumber(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new ExecutorPromptBuildError(
      "El número de ejecución debe ser un entero finito mayor o igual que 1.",
      {
        code: "INVALID_EXECUTION_NUMBER",
        path: ["workspace", "executionNumber"],
      },
    );
  }

  return value;
}

function validateStringArray(
  values: readonly string[],
  path: readonly (string | number)[],
  code: ExecutorPromptBuildErrorCode,
  emptyMessage: string,
  itemMessage: string,
  options?: { minLength?: number },
): readonly string[] {
  if (options?.minLength !== undefined && values.length < options.minLength) {
    throw new ExecutorPromptBuildError(emptyMessage, { code, path });
  }

  return values.map((value, index) => {
    if (!isNonEmptyText(value)) {
      throw new ExecutorPromptBuildError(itemMessage, {
        code,
        path: [...path, index],
      });
    }

    return value;
  });
}

function validatePromptInput(input: ExecutorPromptInput): ExecutorPromptInput {
  const projectName = validateTextField(
    input.project.name,
    ["project", "name"],
    "INVALID_PROJECT_NAME",
    "El nombre del proyecto no puede estar vacío.",
  );

  const taskId = validateTextField(
    input.task.id,
    ["task", "id"],
    "INVALID_TASK_ID",
    "El id de la tarea no puede estar vacío.",
  );

  const taskTitle = validateTextField(
    input.task.title,
    ["task", "title"],
    "INVALID_TASK_TITLE",
    "El título de la tarea no puede estar vacío.",
  );

  const taskDescription = validateTextField(
    input.task.description,
    ["task", "description"],
    "INVALID_TASK_DESCRIPTION",
    "La descripción de la tarea no puede estar vacía.",
  );

  const objective = validateTextField(
    input.contract.objective,
    ["contract", "objective"],
    "INVALID_CONTRACT_OBJECTIVE",
    "El objetivo del contrato no puede estar vacío.",
  );

  const context = validateTextField(
    input.contract.context,
    ["contract", "context"],
    "INVALID_CONTRACT_CONTEXT",
    "El contexto del contrato no puede estar vacío.",
  );

  const acceptanceCriteria = validateStringArray(
    input.contract.acceptanceCriteria,
    ["contract", "acceptanceCriteria"],
    "INVALID_ACCEPTANCE_CRITERIA",
    "acceptanceCriteria debe contener al menos un elemento.",
    "acceptanceCriteria no puede contener elementos vacíos.",
    { minLength: 1 },
  );

  const allowedPaths = validateStringArray(
    input.contract.allowedPaths,
    ["contract", "allowedPaths"],
    "INVALID_ALLOWED_PATHS",
    "allowedPaths es inválido.",
    "allowedPaths no puede contener elementos vacíos.",
  );

  const forbiddenPaths = validateStringArray(
    input.contract.forbiddenPaths,
    ["contract", "forbiddenPaths"],
    "INVALID_FORBIDDEN_PATHS",
    "forbiddenPaths es inválido.",
    "forbiddenPaths no puede contener elementos vacíos.",
  );

  const requiredCommands = validateStringArray(
    input.contract.requiredCommands,
    ["contract", "requiredCommands"],
    "INVALID_REQUIRED_COMMANDS",
    "requiredCommands es inválido.",
    "requiredCommands no puede contener elementos vacíos.",
  );

  const assumptions = validateStringArray(
    input.contract.assumptions,
    ["contract", "assumptions"],
    "INVALID_ASSUMPTIONS",
    "assumptions es inválido.",
    "assumptions no puede contener elementos vacíos.",
  );

  const risks = validateStringArray(
    input.contract.risks,
    ["contract", "risks"],
    "INVALID_RISKS",
    "risks es inválido.",
    "risks no puede contener elementos vacíos.",
  );

  const workspacePath = validateTextField(
    input.workspace.workspacePath,
    ["workspace", "workspacePath"],
    "INVALID_WORKSPACE_PATH",
    "La ruta del workspace no puede estar vacía.",
  );

  const branchName = validateTextField(
    input.workspace.branchName,
    ["workspace", "branchName"],
    "INVALID_BRANCH_NAME",
    "El nombre de la rama no puede estar vacío.",
  );

  const baseCommit = validateTextField(
    input.workspace.baseCommit,
    ["workspace", "baseCommit"],
    "INVALID_BASE_COMMIT",
    "El commit base no puede estar vacío.",
  );

  const executionNumber = validateExecutionNumber(input.workspace.executionNumber);

  return {
    project: {
      name: projectName,
    },
    task: {
      id: taskId,
      title: taskTitle,
      description: taskDescription,
    },
    contract: {
      objective,
      context,
      acceptanceCriteria,
      allowedPaths,
      forbiddenPaths,
      requiredCommands,
      assumptions,
      risks,
    },
    workspace: {
      workspacePath,
      branchName,
      baseCommit,
      executionNumber,
    },
  };
}

function buildExecutionContextJson(input: ExecutorPromptInput): string {
  return JSON.stringify(
    {
      project: {
        name: input.project.name,
      },
      task: {
        id: input.task.id,
        title: input.task.title,
        description: input.task.description,
      },
      workspace: {
        workspacePath: input.workspace.workspacePath,
        branchName: input.workspace.branchName,
        baseCommit: input.workspace.baseCommit,
        executionNumber: input.workspace.executionNumber,
      },
    },
    null,
    2,
  );
}

function buildApprovedContractJson(input: ExecutorPromptInput): string {
  return JSON.stringify(
    {
      objective: input.contract.objective,
      context: input.contract.context,
      acceptanceCriteria: input.contract.acceptanceCriteria,
      allowedPaths: input.contract.allowedPaths,
      forbiddenPaths: input.contract.forbiddenPaths,
      requiredCommands: input.contract.requiredCommands,
      assumptions: input.contract.assumptions,
      risks: input.contract.risks,
    },
    null,
    2,
  );
}

function buildEnvelopeContractSection(): string {
  return [
    '{',
    '  "protocolVersion": 1,',
    '  "role": "executor",',
    '  "status": "COMPLETED | NEEDS_INPUT | BLOCKED | FAILED",',
    '  "summary": "string no vacío",',
    '  "questions": ["string"],',
    '  "risks": ["string"],',
    '  "payload": {',
    '    "filesClaimed": ["string"],',
    '    "commandsClaimed": ["string"]',
    "  }",
    '}',
    'role debe ser exactamente "executor".',
    'filesClaimed y commandsClaimed son afirmaciones del agente.',
    'Si no hubo archivos o comandos, ambos campos deben ser arrays vacíos.',
    'Los cuatro statuses son válidos.',
    'No inventes preguntas ni riesgos.',
    'summary debe describir con precisión el resultado.',
    'JSON puro.',
    'Un solo objeto.',
    'Sin markdown.',
    'Sin fences.',
    'Sin comentarios.',
    'Sin campos extra.',
    'Sin texto adicional.',
  ].join("\n");
}

function buildExecutorPayloadSection(): string {
  return [
    'payload.filesClaimed: string[]',
    'payload.commandsClaimed: string[]',
    'No dupliques valores dentro de filesClaimed.',
    'No dupliques valores dentro de commandsClaimed.',
    'Preserva solo afirmaciones reales del trabajo realizado.',
    'Si no hubo archivos modificados, usa filesClaimed: [].',
    'Si no hubo comandos ejecutados, usa commandsClaimed: [].',
  ].join("\n");
}

function buildStatusRulesSection(): string {
  return [
    '- COMPLETED: la ejecución solicitada terminó.',
    '- NEEDS_INPUT: necesitas información adicional.',
    '- BLOCKED: existe un bloqueo que impide continuar.',
    '- FAILED: la ejecución no pudo completarse.',
    '- No exijas questions no vacías para NEEDS_INPUT.',
    '- No exijas risks no vacíos para BLOCKED.',
    '- No exijas archivos modificados para COMPLETED.',
    '- No exijas comandos ejecutados para COMPLETED.',
  ].join("\n");
}

export function buildExecutorPrompt(input: ExecutorPromptInput): string {
  const validated = validatePromptInput(input);
  const executionContextJson = buildExecutionContextJson(validated);
  const approvedContractJson = buildApprovedContractJson(validated);

  return [
    "IDENTIDAD",
    "Actúas como executor de DevFlow.",
    "",
    "MISIÓN",
    "Implementa únicamente el contrato aprobado y reporta el resultado real de la ejecución.",
    "",
    "RESTRICCIONES OPERATIVAS",
    "- implementar únicamente el contrato aprobado",
    `- trabajar exclusivamente dentro de ${validated.workspace.workspacePath}`,
    "- respetar allowedPaths",
    "- no modificar forbiddenPaths",
    "- no ampliar el alcance",
    "- no cambiar arquitectura salvo necesidad concreta para cumplir el contrato",
    "- no agregar dependencias sin justificación",
    "- no hacer commit",
    "- no hacer push",
    "- no cambiar de branch",
    "- no crear worktrees",
    "- no modificar el worktree principal",
    "- no editar fuera del workspace",
    "- no afirmar que un comando se ejecutó si no se ejecutó",
    "- no afirmar que un archivo se modificó si no se modificó",
    "",
    "CONTEXTO DE EJECUCIÓN",
    executionContextJson,
    "",
    "CONTRATO APROBADO",
    approvedContractJson,
    "",
    "CONTRATO DEL AGENT ENVELOPE",
    buildEnvelopeContractSection(),
    "",
    "PAYLOAD DEL EXECUTOR",
    buildExecutorPayloadSection(),
    "",
    "REGLAS DE STATUS",
    buildStatusRulesSection(),
    "",
    "REGLA FINAL DE RESPUESTA",
    "Responde con un único objeto JSON, sin markdown, sin fences, sin texto antes o después, sin múltiples objetos y sin comentarios JSON.",
  ].join("\n");
}
