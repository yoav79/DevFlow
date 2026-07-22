import { z } from "zod";

import { evidenceBundleSchema } from "./evidence-bundle-schema.js";

export const reviewerPromptInputSourceSchema = z
  .object({
    evidenceBundle: z.unknown(),
    reviewNumber: z.number().finite().int().min(1),
  })
  .strict();

export const reviewerPromptInputSchema = z
  .object({
    version: z.literal(1),
    reviewNumber: z.number().finite().int().min(1),
    evidenceBundle: evidenceBundleSchema,
  })
  .strict();

export type ReviewerPromptInputSource = z.infer<typeof reviewerPromptInputSourceSchema>;
export type ReviewerPromptInput = z.infer<typeof reviewerPromptInputSchema>;
