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
