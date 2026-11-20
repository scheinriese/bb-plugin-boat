import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { credentialApprovalSentence, credentialChatApproval, type CredentialApprovalRequest } from "../src/credential-approval.ts";

const now = Date.parse("2030-01-02T12:00:00Z");
const request: CredentialApprovalRequest = { kind: "credential", action: "delete-without-cleanup", leaseId: "example-lease", machineId: "example-mac", since: now - 60_000, threadIds: ["test_owner"], sentence: credentialApprovalSentence("delete-without-cleanup", "example-mac", "example-lease") };
function event(data: Record<string, unknown> = {}, createdAt = now) {
  return { type: "client/turn/requested", createdAt, data: { initiator: "user", senderThreadId: null, input: [{ type: "text", text: request.sentence }], ...data } };
}

test("credential chat approval requires the exact recent owner sentence and core provenance", async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });t.after(()=>harness.lifecycle.dispose());
  let rows: unknown[] = [];
  harness.sdk.stub("threads.events.list", async () => rows);
  for (const invalid of [
    [], [event({ initiator: "agent" })], [event({ initiator: "system" })],
    [event({ senderThreadId: "test_worker" })], [event({ originPluginId: "boat" })],
    [event({ retryOfRequestId: "example-old-request" })], [event({ senderThreadId: undefined })],
    [event({ input: [{ type: "text", text: `[bb message] ${request.sentence}` }] })],
    [event({ input: [{ type: "text", text: request.sentence, visibility: "agent-only" }] })],
    [event({ input: [{ type: "text", text: request.sentence.replace("example-mac", "example-other") }] })],
    [event({ input: [{ type: "text", text: credentialApprovalSentence("dismiss-token-reminder", "example-mac", "example-lease") }] })],
    [event({}, now - 31 * 60_000)], [event({}, request.since - 1)], [event({}, now + 1)], [event({}, Number.NaN)],
    [event({ input: [{ type: "text", text: "Stop, do not delete it" }] }), event()],
  ]) {
    rows = invalid;
    assert.equal((await credentialChatApproval(bb, "test_owner", request, now)).ok, false, JSON.stringify(invalid));
  }
  rows = [event()];
  assert.equal((await credentialChatApproval(bb, "test_worker", request, now)).ok, false);
  assert.equal((await credentialChatApproval(bb, null, request, now)).ok, false);
  assert.equal((await credentialChatApproval(bb, "test_owner", request, now)).ok, true);
  // Messages sent by other agents do not erase a real owner's decision.
  rows = [event({ initiator: "agent" }), event()];
  assert.equal((await credentialChatApproval(bb, "test_owner", request, now)).ok, true);
  harness.sdk.stub("threads.events.list", async () => { throw new Error("test history unavailable"); });
  assert.equal((await credentialChatApproval(bb, "test_owner", request, now)).ok, false);
});
