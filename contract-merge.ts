// Shared merge confirmation and bounded GitHub facts. No runtime SDK imports.
import type { defineRpcContract as DefineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
const defineRpcContract = ((contract: unknown) => contract) as typeof DefineRpcContract;
export const MERGE_RENDERER_ID = "merge-pull-request";
export const pullRequestFactsSchema = z.object({
  repo: z.string(), number: z.number().int().positive(), url: z.string().url(), title: z.string(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/), base: z.string().regex(/^[a-f0-9]{40,64}$/),
  headBranch: z.string(), baseBranch: z.string(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), draft: z.boolean(),
  mergeable: z.string(), mergeState: z.string(), reviewDecision: z.string(),
  checks: z.array(z.object({ name: z.string(), state: z.string(), url: z.string().nullable() })).max(100),
  checksTruncated: z.boolean(), mergeMethod: z.enum(["merge", "squash", "rebase"]).nullable(),
});
export type PullRequestFacts = z.infer<typeof pullRequestFactsSchema>;
export const mergeChoiceSchema = z.object({ requestId: z.string(), choice: z.enum(["merge", "not-yet"]), note: z.string().trim().max(4_000).default("") }).strict();
export const mergeFormSchema = z.object({ requestId: z.string(), taskId: z.string(), title: z.string(), facts: pullRequestFactsSchema });
export type MergeForm = z.infer<typeof mergeFormSchema>;
export const mergeRpcContract = defineRpcContract({
  requestMerge: { input: z.object({ id: z.string().min(1), from: z.enum(["chat", "page"]).optional() }),
    output: z.object({ pending: z.literal(true), requestId: z.string(), threadId: z.string(), duplicate: z.boolean() }) },
  pullRequestFacts: { input: z.object({ id: z.string().min(1) }), output: pullRequestFactsSchema.nullable() },
});
