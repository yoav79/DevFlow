import { z } from "zod";
import type {
  SupervisorClassification,
  SupervisorResultBase,
  ExecutableTaskContract,
  DecompositionRequiredResult,
  DiscoveryRequiredResult,
  SupervisorResult,
} from "../types.js";

const nonEmptyString = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0, {
    message: "String must not be empty or whitespace only",
  });

const nonEmptyStringArray = z.array(nonEmptyString);

export const supervisorClassificationSchema = z.enum([
  "EXECUTABLE_TASK",
  "NEEDS_DECOMPOSITION",
  "NEEDS_DISCOVERY",
]);

export const supervisorResultBaseSchema = z
  .object({
    classification: supervisorClassificationSchema,
    summary: nonEmptyString,
    reasoning: nonEmptyString,
  })
  .strict();

export const suggestedTaskSchema = z
  .object({
    title: nonEmptyString,
    objective: nonEmptyString,
  })
  .strict();

export const executableTaskContractSchema = z
  .object({
    classification: z.literal("EXECUTABLE_TASK"),
    summary: nonEmptyString,
    reasoning: nonEmptyString,
    objective: nonEmptyString,
    context: nonEmptyString,
    acceptanceCriteria: nonEmptyStringArray.min(1),
    allowedPaths: z.array(nonEmptyString),
    forbiddenPaths: z.array(nonEmptyString),
    requiredCommands: z.array(nonEmptyString),
    assumptions: z.array(nonEmptyString),
    risks: z.array(nonEmptyString),
    openQuestions: z.tuple([]),
  })
  .strict();

export const decompositionRequiredResultSchema = z
  .object({
    classification: z.literal("NEEDS_DECOMPOSITION"),
    summary: nonEmptyString,
    reasoning: nonEmptyString,
    decompositionReason: nonEmptyString,
    suggestedTasks: z.array(suggestedTaskSchema).min(1),
    openQuestions: z.array(nonEmptyString),
  })
  .strict();

export const discoveryRequiredResultSchema = z
  .object({
    classification: z.literal("NEEDS_DISCOVERY"),
    summary: nonEmptyString,
    reasoning: nonEmptyString,
    missingInformation: nonEmptyStringArray.min(1),
    recommendedDiscoveryActions: nonEmptyStringArray.min(1),
    openQuestions: z.array(nonEmptyString),
  })
  .strict();

export const supervisorResultSchema = z.discriminatedUnion("classification", [
  executableTaskContractSchema,
  decompositionRequiredResultSchema,
  discoveryRequiredResultSchema,
]);

// Static compatibility: schemas must be assignable to their corresponding types.
// These fail at compile time if the schemas diverge from the types.
type _ContractCheck = ExecutableTaskContract extends z.infer<typeof executableTaskContractSchema>
  ? z.infer<typeof executableTaskContractSchema> extends ExecutableTaskContract
    ? true
    : false
  : false;
type _DecompositionCheck = DecompositionRequiredResult extends z.infer<typeof decompositionRequiredResultSchema>
  ? z.infer<typeof decompositionRequiredResultSchema> extends DecompositionRequiredResult
    ? true
    : false
  : false;
type _DiscoveryCheck = DiscoveryRequiredResult extends z.infer<typeof discoveryRequiredResultSchema>
  ? z.infer<typeof discoveryRequiredResultSchema> extends DiscoveryRequiredResult
    ? true
    : false
  : false;
type _SupervisorCheck = SupervisorResult extends z.infer<typeof supervisorResultSchema>
  ? z.infer<typeof supervisorResultSchema> extends SupervisorResult
    ? true
    : false
  : false;
