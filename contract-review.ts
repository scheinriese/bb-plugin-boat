// Reviewer selection and public native-chat metadata. Safe in server and app.
import { z } from "zod";
export const reviewerSchema = z.enum(["codex", "claude", "none"]);
export type Reviewer = z.infer<typeof reviewerSchema>;
export const NATIVE_REVIEW_METADATA = "nativeReviewPolicy";
export const nativeReviewStateSchema = z.object({
  version: z.literal(1), taskId: z.string(), reviewer: reviewerSchema,
  source: z.enum(["machine", "project", "global"]),
  state: z.enum(["waiting", "disabled", "starting", "reviewing", "reviewed", "failed", "outdated"]),
  message: z.string().max(500), turnKey: z.string().nullable(), reviewTaskId: z.string().nullable(),
});
export type NativeReviewState = z.infer<typeof nativeReviewStateSchema>;
