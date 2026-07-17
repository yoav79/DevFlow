export const TASK_STATES = [
  "CREATED",
  "GENERATING_CONTRACT",
  "CONTRACT_APPROVAL_REQUIRED",
  "PREPARING_WORKSPACE",
  "EXECUTING",
  "VERIFYING",
  "REVIEWING",
  "REVISION_REQUIRED",
  "HUMAN_REQUIRED",
  "FINAL_APPROVAL_REQUIRED",
  "GENERATING_NEXT_TASK",
  "NEXT_TASK_APPROVAL_REQUIRED",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export type AgentName = "supervisor" | "executor" | "reviewer" | "next-task";

export interface Project {
  id: string;
  name: string;
  repositoryPath: string;
  defaultBranch: string;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  state: TaskState;
  attempt: number;
  maxAttempts: number;
  contractJson: string | null;
  currentRevisionJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export type HumanRequestType =
  | "CONTRACT_APPROVAL"
  | "FUNCTIONAL_DECISION"
  | "SCOPE_EXPANSION"
  | "DEPENDENCY_APPROVAL"
  | "FINAL_APPROVAL"
  | "NEXT_TASK_APPROVAL";

export type HumanRequestStatus = "PENDING" | "RESOLVED" | "REJECTED";

export interface HumanRequest {
  id: string;
  taskId: string;
  type: HumanRequestType;
  question: string;
  optionsJson: string;
  resolutionJson: string | null;
  status: HumanRequestStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export const SUPERVISOR_CLASSIFICATIONS = [
  "EXECUTABLE_TASK",
  "NEEDS_DECOMPOSITION",
  "NEEDS_DISCOVERY",
] as const;

export type SupervisorClassification = (typeof SUPERVISOR_CLASSIFICATIONS)[number];

export interface SupervisorResultBase {
  classification: SupervisorClassification;
  summary: string;
  reasoning: string;
}

/**
 * Resultado ejecutable: la tarea puede avanzar directamente al executor.
 *
 * - allowedPaths: rutas relativas al repositorio que el executor puede modificar.
 *   Un array vacío significa que no se autoriza modificar ninguna ruta.
 * - forbiddenPaths: complementa allowedPaths pero nunca lo amplía.
 *   Si una ruta está en forbiddenPaths, el executor no debe tocarla aunque
 *   esté en allowedPaths.
 * - openQuestions: debe ser exactamente [] cuando la clasificación es EXECUTABLE_TASK.
 *   Si hay preguntas abiertas, el supervisor debe clasificar como NEEDS_DISCOVERY.
 * - reasoning: explica por qué se clasificó como ejecutable.
 *   No debe usarse como instrucción del executor.
 */
export interface ExecutableTaskContract extends SupervisorResultBase {
  classification: "EXECUTABLE_TASK";
  objective: string;
  context: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  requiredCommands: string[];
  assumptions: string[];
  risks: string[];
  openQuestions: [];
}

/**
 * Resultado que requiere descomposición: la tarea es demasiado grande
 * y debe dividirse en subtareas.
 *
 * - NEEDS_DECOMPOSITION no es un contrato ejecutable.
 * - openQuestions contiene preguntas que impiden dividir la tarea.
 */
export interface DecompositionRequiredResult extends SupervisorResultBase {
  classification: "NEEDS_DECOMPOSITION";
  decompositionReason: string;
  suggestedTasks: Array<{
    title: string;
    objective: string;
  }>;
  openQuestions: string[];
}

/**
 * Resultado que requiere descubrimiento: faltan información o decisiones
 * antes de poder clasificar la tarea.
 *
 * - NEEDS_DISCOVERY no es un contrato ejecutable.
 * - openQuestions contiene preguntas que deben resolverse.
 */
export interface DiscoveryRequiredResult extends SupervisorResultBase {
  classification: "NEEDS_DISCOVERY";
  missingInformation: string[];
  recommendedDiscoveryActions: string[];
  openQuestions: string[];
}

export type SupervisorResult =
  | ExecutableTaskContract
  | DecompositionRequiredResult
  | DiscoveryRequiredResult;

/**
 * Alias temporal para el contrato ejecutable.
 * El nombre de dominio se conserva para consumo futuro del executor.
 */
export type TaskContract = ExecutableTaskContract;
