import { z } from "zod";

export const projectCatalogSchema = z.object({
  repos: z.array(z.object({ repo: z.string(), baseBranch: z.string().nullable(), language: z.string().nullable(), updatedAt: z.string().nullable() })).max(200),
  local: z.array(z.object({ id: z.string(), name: z.string(), repo: z.string(), branch: z.string().nullable() })).max(100),
  scope: z.literal("configured-boat-repos"),
  truncated: z.boolean(),
  error: z.string().nullable(),
});
export type ProjectCatalogDto = z.infer<typeof projectCatalogSchema>;
export const projectSnapshotCheckSchema = z.object({
  taskId: z.string(), title: z.string(), sandboxId: z.string().nullable(),
  stage: z.enum(["checking", "ready", "failed", "saved"]),
  error: z.string().nullable(), createdAt: z.string(),
});
export type ProjectSnapshotCheckDto = z.infer<typeof projectSnapshotCheckSchema>;
export const projectRpcMethods = {
  projectCatalog: { input: z.null(), output: projectCatalogSchema, tags: () => ["boat:projects"] },
  projectSnapshotCheck: { input: z.object({ projectId: z.string().min(1).max(64) }), output: projectSnapshotCheckSchema.nullable(), tags: () => ["boat:tasks", "boat:projects"] },
  startProjectSnapshot: { input: z.object({ projectId: z.string().min(1).max(64) }), output: projectSnapshotCheckSchema },
};
