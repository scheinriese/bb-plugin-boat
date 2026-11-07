import { type PluginAppBuilder, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { MERGE_RENDERER_ID, mergeFormSchema } from "../contract-merge";
import { ShipFormView } from "./ship-interaction";
import { Button } from "../components/ui/button";
export function registerMergeInteraction(app: PluginAppBuilder): void {
  app.slots.pendingInteraction({ id: MERGE_RENDERER_ID, component: MergeInteraction });
}
export function MergeInteraction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = mergeFormSchema.safeParse(interaction.payload);
  if (!parsed.success) return <section className="boat-ui boat-ship-form"><p role="alert">This merge confirmation is unavailable. Request merging again.</p><Button onClick={() => void cancel()}>Cancel confirmation</Button></section>;
  const { requestId, taskId, title, facts } = parsed.data;
  return <ShipFormView key={interaction.id} merge={{ number: facts.number, head: facts.head }} form={{ requestId, taskId, title, baseBranch: facts.baseBranch,
    keepOpen: true, commits: facts.commits, repositories: 1, additions: facts.additions, deletions: facts.deletions,
    changedSinceApproval: null, changesUrl: `${facts.url}/files`,
    checks: [
      ...(facts.reviewDecision === "APPROVED" ? [{ text: "Review approved", tone: "ready" as const }] : []),
      ...facts.checks.map((check) => ({ text: check.name, tone: ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.state) ? "ready" as const : "caution" as const })),
      { text: `Merges cleanly on ${facts.baseBranch}`, tone: "ready" },
    ],
  }} cancel={cancel} submit={(value) => {
    const choice = value as { requestId: string; choice: string; note: string };
    return submit({ requestId: choice.requestId, choice: choice.choice === "ship" ? "merge" : "not-yet", note: choice.note });
  }} />;
}
