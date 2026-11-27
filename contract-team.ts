import { z } from "zod";
import { pullRequestFactsSchema } from "./contract-merge.ts";
import type { defineRpcContract as DefineRpcContract } from "@get-bb/plugin-sdk";
const defineRpcContract = ((contract: unknown) =>
  contract) as typeof DefineRpcContract;

const text = (max: number) => z.string().trim().min(1).max(max);
export const scopeSchema = z.object({
  actionClass: text(60),
  targets: z.array(text(300)).min(1).max(20),
  members: z.array(text(100)).min(1).max(1),
  expiresAt: z.string().datetime(),
  uses: z.number().int().min(1).max(10).default(1),
});
export const optionSchema = z.object({
  id: text(60),
  label: text(100),
  effect: text(4000),
  tier: z.enum(["contained", "confirm"]),
  recommended: z.boolean().default(false),
  action: z
    .enum(["answer", "deny", "defer", "continue", "cancel", "extend-budget"])
    .default("answer"),
});
export const askInputSchema = z.object({
  memberId: text(100),
  assignmentId: text(100).nullable().default(null),
  threadId: text(200).nullable().default(null),
  verb: z.enum(["Do", "Decide", "Approve", "Review"]),
  title: text(80),
  unblocks: text(120),
  context: z.string().max(12000).default(""),
  due: z.string().datetime().nullable().default(null),
  options: z.array(optionSchema).min(1).max(8),
  secondary: text(60),
  scope: scopeSchema.nullable().default(null),
  confirmLabel: text(120).default("Apply this action"),
  legacyDecisionId: z.string().nullable().default(null),
  taskId: z.string().nullable().default(null),
});
export const memberSchema = z.object({
  id: z.string(),
  name: text(40),
  role: text(80),
  kind: z.enum(["lead", "specialist", "project-lead"]),
  homeThreadId: z.string().nullable(),
  previousHomeThreadIds: z.array(z.string()),
  projectId: z.string(),
  orchestratorProjectId: z.string().nullable(),
  standingInstructions: z.string(),
  placement: z.enum(["sandbox", "mac", "either"]),
  status: z.enum(["active", "paused", "archived"]),
  avatar: z.object({ initials: z.string(), color: z.string() }),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Member = z.infer<typeof memberSchema>;
export const resultSchema = z.object({
  status: z.enum(["done", "partial", "blocked"]),
  summary: text(3000),
  delivered: text(3000),
  evidence: text(3000),
  files: z.array(z.string()).max(30).default([]),
  openQuestions: z.string().max(3000).default("none"),
});
export const assignmentInputSchema = z.object({
  assignee: text(100),
  mode: z.enum(["work", "consult", "notify"]),
  title: text(120),
  brief: text(12000),
  doneWhen: z.string().max(500).default(""),
  parentId: z.string().nullable().default(null),
  dedupeKey: z.string().max(300).nullable().default(null),
  wallHours: z.number().min(1).max(72).default(12),
});
export type AssignmentInput = z.infer<typeof assignmentInputSchema>;
export const assignmentSchema = assignmentInputSchema.extend({
  id: z.string(),
  rootId: z.string(),
  depth: z.number(),
  requester: z.string(),
  origin: z.object({
    kind: z.enum(["user", "member"]),
    id: z.string(),
    source: z.string(),
  }),
  watchers: z.array(z.string()),
  status: z.enum([
    "queued",
    "delivered",
    "running",
    "waiting",
    "needs-user",
    "paused",
    "closed",
  ]),
  outcome: z
    .enum(["done", "partial", "blocked", "cancelled", "expired"])
    .nullable(),
  result: resultSchema.nullable(),
  lastProgress: z.string().nullable(),
  taskIds: z.array(z.string()).default([]),
  decisionIds: z.array(z.string()).default([]),
  threadId: z.string().nullable(),
  continues: z.number(),
  turns: z.number(),
  maxTurns: z.number(),
  treeTurnLimit: z.number().default(120),
  waitUntil: z.string().nullable().default(null),
  deadline: z.string(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Assignment = z.infer<typeof assignmentSchema>;
export const answerSchema = z.object({
  option: z.string(),
  text: z.string(),
  at: z.string(),
  surface: z.string(),
  provenance: z.enum(["unverified tap", "typed reply"]),
});
export const askSchema = askInputSchema.extend({
  id: z.string(),
  tier: z.enum(["contained", "confirm"]),
  state: z.enum([
    "open",
    "confirming",
    "verifying",
    "answered",
    "expired",
    "withdrawn",
    "superseded",
  ]),
  answer: answerSchema.nullable(),
  after: z.object({
    ranAt: z.string().nullable(),
    revocable: z.boolean(),
    heldUntil: z.string().nullable(),
    undoUntil: z.string().nullable(),
  }),
  deferredUntil: z.string().nullable(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ask = z.infer<typeof askSchema>;
export const grantSchema = scopeSchema.extend({
  id: z.string(),
  askId: z.string(),
  status: z.enum(["active", "used", "revoked", "expired"]),
  usesLeft: z.number(),
  notBefore: z.string(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Grant = z.infer<typeof grantSchema>;
export const incidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  assignmentId: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export const receiptSchema = z.object({
  id: z.string(),
  assignmentId: z.string(),
  threadId: z.string(),
  nonce: z.string(),
  kind: z.enum(["assignment", "result", "continue", "answer"]),
  text: z.string(),
  state: z.enum(["pending", "sending", "uncertain", "accepted", "failed"]),
  delivery: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Receipt = z.infer<typeof receiptSchema>;
export const teamStateSchema = z.object({
  enabled: z.boolean(),
  now: z.string(),
  rules: z.string(),
  members: z.array(memberSchema),
  assignments: z.array(assignmentSchema),
  asks: z.array(askSchema),
  incidents: z.array(incidentSchema),
  receipts: z.array(receiptSchema),
  grants: z.array(grantSchema),
  legacyDecisionIds: z.array(z.string()),
  workbench: z.boolean(),
});
export type TeamState = z.infer<typeof teamStateSchema>;
export const teamMemberDtoSchema = z.object({
  memberId: z.string(),
  threadId: z.string().min(1),
  name: z.string(),
  kind: memberSchema.shape.kind,
  avatar: memberSchema.shape.avatar,
  status: memberSchema.shape.status,
  preview: z.object({
    kind: z.enum(["needs-you", "activity", "counts", "last-message"]),
    text: z.string(),
    tone: z.enum(["neutral", "attention", "danger", "success"]),
  }),
  unread: z.object({
    messages: z.number().int().nonnegative(),
    cards: z.number().int().nonnegative(),
  }),
  order: z.number().int(),
  backgroundThreadIds: z.array(z.string()),
});
export const teamSidebarSchema = z.object({
  enabled: z.literal(true),
  yourMove: z.object({
    count: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    confirm: z.number().int().nonnegative(),
  }),
  projects: z.array(
    z.object({
      bbProjectId: z.string(),
      icon: z.string(),
      leadThreadId: z.string(),
    }),
  ),
  lead: teamMemberDtoSchema.nullable(),
  members: z.array(teamMemberDtoSchema),
  hideFromSections: z.array(z.string()),
  revision: z.string(),
  truncated: z.boolean(),
});
export type TeamSidebar = z.infer<typeof teamSidebarSchema>;
const answerInput = z.object({
  askId: text(100),
  revision: z.number().int(),
  option: text(60),
  text: z.string().max(4000).default(""),
  surface: z
    .enum(["today", "tray", "strip", "board", "confirm-view", "tool", "cli"])
    .default("today"),
});
export const teamRpcContract = defineRpcContract({
  teamState: {
    input: z.null(),
    output: teamStateSchema,
    tags: () => ["boat:team"],
  },
  teamSave: {
    input: z.object({
      enabled: z.boolean(),
      name: text(40).optional(),
      homeThreadId: text(200).optional(),
      standingInstructions: z.string().max(20000).optional(),
      rules: z.string().max(4000).optional(),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  answerAsk: {
    input: answerInput,
    output: z.object({ ask: askSchema, message: z.string() }),
  },
  openAskConfirm: {
    input: z.object({ askId: text(100), revision: z.number().int() }),
    output: z.object({
      ask: askSchema,
      confirmToken: z.string(),
      expiresAt: z.string(),
      facts: pullRequestFactsSchema.nullable().optional(),
    }),
  },
  confirmAsk: {
    input: z.object({
      askId: text(100),
      revision: z.number().int(),
      confirmToken: text(200),
    }),
    output: askSchema,
  },
  cancelAskConfirm: {
    input: z.object({ askId: text(100), revision: z.number().int() }),
    output: askSchema,
  },
  resumeTeamMember: {
    input: z.object({ memberId: text(100) }),
    output: z.object({ ok: z.literal(true) }),
  },
  revokeAsk: {
    input: z.object({ askId: text(100) }),
    output: z.object({ ok: z.literal(true) }),
  },
});
export type AnswerInput = z.infer<typeof answerInput>;
