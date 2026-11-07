// Root registers this alongside the existing RPC helpers.
import { mergeRpcContract } from "../contract-merge.ts";
import { getPullRequest, mergePullRequest } from "./github.ts";
import { createMergeInteractions, mergeGeneration } from "./merge-interaction.ts";
import { TaskError } from "./service.ts";
import { refuse } from "./rpc.ts";
import type { Runtime } from "./runtime.ts";

export function registerMergeRpc(runtime: Runtime): void {
  const { bb, service } = runtime;
  const interactions = createMergeInteractions({
    getTask: (id) => service.mustGet(id),
    latestReview: (id) => service.store.latestEvent(id, "review")?.text ?? null,
    facts: (task, signal) => getPullRequest(task.repo!, task.prUrl!, signal),
    requestInput: (request, options) => bb.ui.requestInput(request, options),
    async merge(id, facts, signal, guard) {
      let generation = "";
      let confirmedMerged = false;
      await service.withMergeClaim(id, async (task) => {
        await guard(task);
        generation = mergeGeneration(task);
        await mergePullRequest(facts, signal);
        service.store.addEvent(id, "merge-submitted", `GitHub accepted the merge request for PR #${facts.number}; approved HEAD ${facts.head}`);
        // gh can enqueue a PR under repository rules. Only actual MERGED is shipped.
        const after = await getPullRequest(facts.repo, facts.url, signal).catch(() => {
          throw new TaskError("GitHub accepted the merge request, but its final status couldn't be verified. Check the pull request on GitHub before trying again.", "merge_unverified");
        });
        if (after.state !== "MERGED") {
          service.store.addEvent(id, "merge-queued", `PR #${facts.number} was submitted to GitHub; merge is not yet confirmed`);
          return;
        }
        confirmedMerged = true;
        service.store.addEvent(id, "merged", `Merged PR #${facts.number} into ${facts.baseBranch}; approved HEAD ${facts.head}`);
      });
      // No close under the claim; new work during the GitHub call stays open.
      const current = service.mustGet(id);
      if (confirmedMerged && mergeGeneration(current) === generation) {
        // Synchronous conditional transition: no await can close newly started work.
        service.store.transition(id, ["idle"], { status: "done", finishedAt: new Date().toISOString(), readyAt: null }, { promptId: current.promptId });
      }
      runtime.changed();
    },
    record: (id, kind, text) => { service.store.addEvent(id, kind, text); },
    changed: () => runtime.changed(),
    report: (threadId, text) => runtime.tellOrchestrator(threadId, text),
  });
  bb.onDispose(() => interactions.dispose());
  bb.rpc.register(mergeRpcContract, {
    requestMerge: (input) => refuse(async () => interactions.request(input)),
    pullRequestFacts: (input) => refuse(async () => {
      const task = service.mustGet(input.id);
      return task.repo && task.prUrl ? getPullRequest(task.repo, task.prUrl) : null;
    }),
  });
}
