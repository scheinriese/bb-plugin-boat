import { z } from "zod";

export const monthlyMacPriceSchema = z.object({
  id: z.string().min(1).max(80),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(80),
  chip: z.string().regex(/^M[1-9][0-9]*(?: Pro| Max| Ultra)?$/),
  ramGB: z.number().int().positive(),
  monthlyPrice: z.number().positive(),
  currency: z.enum(["USD", "EUR"]),
  signupUrl: z.url().startsWith("https://"),
  sourceUrl: z.url().startsWith("https://"),
  asOf: z.iso.date(),
  available: z.boolean(),
  billing: z.enum(["monthly", "hourly-estimate"]),
});
export const monthlyMacPricesSchema = z
  .array(monthlyMacPriceSchema)
  .max(50)
  .refine(
    (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
    "Use unique price IDs.",
  );
export type MonthlyMacPrice = z.infer<typeof monthlyMacPriceSchema>;
export const monthlyMacSuggestionSchema = z.object({
  id: z.string(),
  group: z.string(),
  kind: z.enum(["rent", "cancel"]),
  createdAt: z.string(),
  candidate: monthlyMacPriceSchema,
  alternatives: z.array(monthlyMacPriceSchema),
  dayProvider: z.string(),
  chip: z.string(),
  ramGB: z.number(),
  currency: z.string(),
  days: z.number(),
  cost: z.number(),
  dayRate: z.number(),
  breakEven: z.number(),
  forecast: z.object({ low: z.number(), base: z.number(), high: z.number() }),
  savings: z.number(),
  answer: z.enum(["rent", "keep", "own", "cancel"]).nullable(),
  answeredAt: z.string().nullable(),
});
export type MonthlyMacSuggestion = z.infer<typeof monthlyMacSuggestionSchema>;
export const MONTHLY_MACS_TAG = "boat:monthly-macs";
export const monthlyMacRpcMethods = {
  monthlyMacSuggestions: {
    input: z.null(),
    output: z.object({ suggestions: z.array(monthlyMacSuggestionSchema) }),
    tags: () => [MONTHLY_MACS_TAG, "boat:settings", "boat:sandboxes"],
  },
  monthlyMacSuggestion: {
    input: z.object({ id: z.string() }),
    output: z.object({ suggestion: monthlyMacSuggestionSchema.nullable() }),
    tags: () => [MONTHLY_MACS_TAG],
  },
  answerMonthlyMacSuggestion: {
    input: z.object({
      id: z.string(),
      answer: z.enum(["rent", "keep", "own", "cancel"]),
    }),
    output: z.object({ suggestion: monthlyMacSuggestionSchema }),
  },
};
