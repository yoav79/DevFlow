export interface SupervisorPromptHumanRequest {
  readonly id: string;
  readonly type: string;
  readonly question: string;
  readonly optionsJson: string;
}

export interface SupervisorPromptInput {
  readonly project: {
    readonly name: string;
    readonly repositoryPath: string;
  };
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly state: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly contractJson: string | null;
    readonly currentRevisionJson: string | null;
  };
  readonly pendingHumanRequests: readonly SupervisorPromptHumanRequest[];
}

export type SupervisorPromptBuildErrorCode =
  | "INVALID_PROJECT_NAME"
  | "INVALID_REPOSITORY_PATH"
  | "INVALID_TASK_ID"
  | "INVALID_TASK_TITLE"
  | "INVALID_TASK_DESCRIPTION"
  | "INVALID_ATTEMPT_RANGE"
  | "INVALID_HUMAN_REQUEST";

export class SupervisorPromptBuildError extends Error {
  readonly code: SupervisorPromptBuildErrorCode;
  readonly path: readonly (string | number)[];
  declare readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code: SupervisorPromptBuildErrorCode;
      path: readonly (string | number)[];
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "SupervisorPromptBuildError";
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
  code: SupervisorPromptBuildErrorCode,
  message: string,
): string {
  if (!isNonEmptyText(value)) {
    throw new SupervisorPromptBuildError(message, { code, path });
  }

  return value;
}

function validateIntegerField(
  value: number,
  path: readonly (string | number)[],
  message: string,
): number {
  if (!Number.isInteger(value)) {
    throw new SupervisorPromptBuildError(message, {
      code: "INVALID_ATTEMPT_RANGE",
      path,
    });
  }

  return value;
}

function validatePromptInput(input: SupervisorPromptInput): SupervisorPromptInput {
  const projectName = validateTextField(
    input.project.name,
    ["project", "name"],
    "INVALID_PROJECT_NAME",
    "El nombre del proyecto no puede estar vacío.",
  );

  const repositoryPath = validateTextField(
    input.project.repositoryPath,
    ["project", "repositoryPath"],
    "INVALID_REPOSITORY_PATH",
    "La ruta del repositorio no puede estar vacía.",
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

  const attempt = validateIntegerField(
    input.task.attempt,
    ["task", "attempt"],
    "El intento debe ser un entero no negativo.",
  );

  const maxAttempts = validateIntegerField(
    input.task.maxAttempts,
    ["task", "maxAttempts"],
    "El máximo de intentos debe ser un entero mayor que cero.",
  );

  if (attempt < 0 || maxAttempts < 1 || attempt > maxAttempts) {
    throw new SupervisorPromptBuildError(
      "La relación entre intento y máximo de intentos no es válida.",
      {
        code: "INVALID_ATTEMPT_RANGE",
        path: ["task", attempt < 0 || attempt > maxAttempts ? "attempt" : "maxAttempts"],
      },
    );
  }

  const pendingHumanRequests = input.pendingHumanRequests.map((request, index) => {
    const id = validateTextField(
      request.id,
      ["pendingHumanRequests", index, "id"],
      "INVALID_HUMAN_REQUEST",
      "La solicitud humana no puede tener un id vacío.",
    );

    const type = validateTextField(
      request.type,
      ["pendingHumanRequests", index, "type"],
      "INVALID_HUMAN_REQUEST",
      "La solicitud humana no puede tener un tipo vacío.",
    );

    const question = validateTextField(
      request.question,
      ["pendingHumanRequests", index, "question"],
      "INVALID_HUMAN_REQUEST",
      "La solicitud humana no puede tener una pregunta vacía.",
    );

    const optionsJson = validateTextField(
      request.optionsJson,
      ["pendingHumanRequests", index, "optionsJson"],
      "INVALID_HUMAN_REQUEST",
      "Las opciones de la solicitud humana no pueden estar vacías.",
    );

    return {
      id,
      type,
      question,
      optionsJson,
    };
  });

  return {
    project: {
      name: projectName,
      repositoryPath,
    },
    task: {
      id: taskId,
      title: taskTitle,
      description: taskDescription,
      state: input.task.state,
      attempt,
      maxAttempts,
      contractJson: input.task.contractJson,
      currentRevisionJson: input.task.currentRevisionJson,
    },
    pendingHumanRequests,
  };
}

function buildContextJson(input: SupervisorPromptInput): string {
  const context = {
    project: {
      name: input.project.name,
      repositoryPath: input.project.repositoryPath,
    },
    task: {
      id: input.task.id,
      title: input.task.title,
      description: input.task.description,
      state: input.task.state,
      attempt: input.task.attempt,
      maxAttempts: input.task.maxAttempts,
      contractJson: input.task.contractJson,
      currentRevisionJson: input.task.currentRevisionJson,
    },
    pendingHumanRequests: input.pendingHumanRequests.map((request) => ({
      id: request.id,
      type: request.type,
      question: request.question,
      optionsJson: request.optionsJson,
    })),
  };

  return JSON.stringify(context, null, 2);
}

function buildEnvelopeContractSection(): string {
  return [
    "protocolVersion: 1",
    'role: "supervisor"',
    'status: "COMPLETED"',
    "summary: string no vacío",
    "questions: string[]",
    "risks: string[]",
    "payload: uno de los tres payloads válidos",
    "JSON puro",
    "un solo objeto",
    "sin markdown",
    "sin comentarios",
    "sin campos extra",
    "sin texto adicional",
  ].join("\n");
}

function buildExecutableTaskSection(): string {
  return [
    'classification: "EXECUTABLE_TASK"',
    "reasoning",
    "objective",
    "context",
    "acceptanceCriteria",
    "allowedPaths",
    "forbiddenPaths",
    "requiredCommands",
    "assumptions",
    "risks",
    'openQuestions: []',
    "acceptanceCriteria debe tener al menos un elemento",
  ].join("\n");
}

function buildDecompositionSection(): string {
  return [
    'classification: "NEEDS_DECOMPOSITION"',
    "reasoning",
    "decompositionReason",
    "suggestedTasks con title y objective",
    "openQuestions",
    "debe proponer al menos dos tareas para satisfacer la validación semántica actual",
  ].join("\n");
}

function buildDiscoverySection(): string {
  return [
    'classification: "NEEDS_DISCOVERY"',
    "reasoning",
    "missingInformation",
    "recommendedDiscoveryActions",
    "openQuestions",
    "missingInformation y recommendedDiscoveryActions deben tener al menos un elemento",
  ].join("\n");
}

export function buildSupervisorPrompt(input: SupervisorPromptInput): string {
  const validated = validatePromptInput(input);
  const contextJson = buildContextJson(validated);

  return [
    "IDENTIDAD",
    "Actúas como supervisor de DevFlow.",
    "",
    "MISIÓN",
    "Analiza únicamente la tarea entregada y produce un resultado supervisor válido.",
    "",
    "RESTRICCIONES DURAS",
    "- no modificar archivos",
    "- no crear archivos",
    "- no eliminar archivos",
    "- no escribir en disco",
    "- no ejecutar cambios en el proyecto",
    "- no implementar la tarea",
    "- no inventar requisitos",
    "- no añadir dependencias",
    "- no responder con markdown",
    "- no responder con texto antes o después del JSON",
    "",
    "CONTEXTO JSON",
    contextJson,
    "",
    "CONTRATO DEL ENVELOPE",
    buildEnvelopeContractSection(),
    "",
    "PAYLOAD EXECUTABLE_TASK",
    buildExecutableTaskSection(),
    "",
    "PAYLOAD NEEDS_DECOMPOSITION",
    buildDecompositionSection(),
    "",
    "PAYLOAD NEEDS_DISCOVERY",
    buildDiscoverySection(),
    "",
    "REGLAS DE CLASIFICACIÓN",
    "- EXECUTABLE_TASK cuando puede generarse un contrato concreto y verificable.",
    "- NEEDS_DECOMPOSITION cuando la tarea es demasiado amplia y debe dividirse.",
    "- NEEDS_DISCOVERY cuando falta información necesaria.",
    "- Las tres classifications deben usar status COMPLETED.",
    "- No usar NEEDS_INPUT, BLOCKED ni FAILED.",
    "- classification pertenece al payload, no al status.",
    "- envelope.questions y envelope.risks son metadata editorial.",
    "- payload.openQuestions y payload.risks siguen siendo campos del dominio supervisor.",
    "- No exigir identidad entre ambos.",
    "- No omitir los campos obligatorios del payload.",
    "",
    "REGLA FINAL DE RESPUESTA",
    "Responde únicamente con el objeto JSON, sin fences y sin explicación.",
  ].join("\n");
}
