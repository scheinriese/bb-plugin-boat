import assert from "node:assert/strict";
import { test } from "node:test";
import { LISTED_FALLBACK_MS, REVEAL_WINDOW_MS, cancelQueuedStartReveal, claimQueuedStartReveal, onQueuedStartReveal, queuedRowClickId, revealQueuedStart } from "../web/start-queue-reveal.ts";

const ID = "qs_0f8e2c1a-5b7d-4c3e-9a1f-2d6b8e4c0a11";
const OTHER = "qs_7c1d9e2b-3a4f-4b6c-8d0e-5f1a2b3c4d5e";

// The few DOM calls queuedRowClickId makes, on a small element tree.
class Node {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly parent: Node | null;
  constructor(tag: string, attrs: Record<string, string>, parent: Node | null) {
    this.tag = tag;
    this.attrs = attrs;
    this.parent = parent;
  }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  private up(): Node[] { const nodes: Node[] = []; for (let node: Node | null = this; node; node = node.parent) nodes.push(node); return nodes; }
  closest(selector: string): Node | null {
    const row = (node: Node) => "data-queued-start-id" in node.attrs;
    if (selector === "[data-queued-start-id]") return this.up().find(row) ?? null;
    if (selector === "[data-queued-start-id] a[href]") return this.up().find((node) => node.tag === "a" && "href" in node.attrs && node.up().slice(1).some(row)) ?? null;
    throw new Error(`unexpected selector ${selector}`);
  }
}
/** A sidebar row as the companion sidebar renders it: a link to the chat, then a menu button. */
function row(state: string, id = ID, href: string | null = "/threads/thr_orchestrator") {
  const wrapper = new Node("div", { "data-queued-start-id": id, "data-queued-start-state": state }, null);
  const link = new Node("a", href === null ? {} : { href }, wrapper);
  return { title: new Node("span", {}, new Node("span", {}, link)), menu: new Node("button", {}, wrapper) };
}
const click = (target: unknown, keys: Partial<Record<"button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey", unknown>> = {}) =>
  queuedRowClickId({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...keys, target } as never);

test("a plain click on a waiting or starting queued row's link opens that request", () => {
  assert.equal(click(row("waiting").title), ID);
  assert.equal(click(row("dispatching").title), ID);
});

test("menus, modified clicks, started rows and rows without a chat link don't", () => {
  assert.equal(click(row("waiting").menu), null);
  for (const keys of [{ button: 1 }, { button: 2 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) assert.equal(click(row("waiting").title, keys), null);
  // A started request's row opens its task, not the requesting chat.
  assert.equal(click(row("started").title), null);
  assert.equal(click(row("waiting", ID, null).title), null);
  assert.equal(click(row("waiting", "not-a-request").title), null);
  assert.equal(click(new Node("a", { href: "/threads/thr_other" }, null)), null);
  assert.equal(click(null), null);
  assert.equal(click({ nodeType: 3 }), null);
});

const OLDER = "qs_1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

test("the card whose own marker is the request takes the reveal at once, and only once", () => {
  cancelQueuedStartReveal();
  const now = 1_000_000;
  revealQueuedStart(ID, now);
  assert.equal(claimQueuedStartReveal(OTHER, [OTHER], now + 10), null, "another request's card doesn't take it");
  assert.equal(claimQueuedStartReveal(ID, [ID], now + 20), ID);
  assert.equal(claimQueuedStartReveal(ID, [ID], now + 30), null, "only once");
});

test("with several cards listing the request, its own card wins over an older group card", () => {
  cancelQueuedStartReveal();
  const now = 2_000_000;
  revealQueuedStart(ID, now);
  // An older group card (its own marker is another request) lists this one too and mounts first.
  assert.equal(claimQueuedStartReveal(OLDER, [OLDER, ID], now), null, "a listing card waits for the owner");
  assert.equal(claimQueuedStartReveal(OLDER, [OLDER, ID], now + LISTED_FALLBACK_MS - 1), null);
  assert.equal(claimQueuedStartReveal(ID, [ID, OTHER], now + 100), ID, "the owner takes it inside the wait");
  assert.equal(claimQueuedStartReveal(OLDER, [OLDER, ID], now + LISTED_FALLBACK_MS + 1), null, "nothing left for the older card");
});

test("without a card of its own, the request falls back to a card listing it", () => {
  cancelQueuedStartReveal();
  const now = 3_000_000;
  revealQueuedStart(OTHER, now);
  assert.equal(claimQueuedStartReveal(ID, [ID, OTHER], now + 5), null);
  assert.equal(claimQueuedStartReveal(ID, [ID, OTHER], now + 5 + LISTED_FALLBACK_MS), OTHER, "the group card listing it takes it");
});

test("a reveal expires, so a later visit to the chat doesn't jump", () => {
  cancelQueuedStartReveal();
  revealQueuedStart(ID, 0);
  assert.equal(claimQueuedStartReveal(ID, [ID], REVEAL_WINDOW_MS + 1), null);
  assert.equal(claimQueuedStartReveal(ID, [ID], 1), null, "an expired reveal is gone");
  revealQueuedStart("thr_not_a_request", 0);
  assert.equal(claimQueuedStartReveal("thr_not_a_request", ["thr_not_a_request"], 1), null);
});

test("scrolling after the click cancels a reveal for a card that renders later", () => {
  revealQueuedStart(ID, 0);
  cancelQueuedStartReveal();
  assert.equal(claimQueuedStartReveal(ID, [ID], 10), null);
});

test("mounted cards hear a new reveal and the fallback; a newer request replaces an older one", async () => {
  cancelQueuedStartReveal();
  const owner: (string | null)[] = [];
  const stopOwner = onQueuedStartReveal(() => owner.push(claimQueuedStartReveal(ID, [ID])));
  revealQueuedStart(OTHER);
  revealQueuedStart(ID);
  assert.deepEqual(owner, [null, ID]);
  stopOwner();
  // A listing card retries by itself once the owner's head start has passed.
  const listing: (string | null)[] = [];
  const stopListing = onQueuedStartReveal(() => listing.push(claimQueuedStartReveal(OLDER, [OLDER, OTHER])));
  revealQueuedStart(OTHER);
  assert.deepEqual(listing, [null]);
  await new Promise((resolve) => setTimeout(resolve, LISTED_FALLBACK_MS + 50));
  // Other tests' fallback timers may also notify; only one card claims, once.
  assert.deepEqual(listing.filter(Boolean), [OTHER]);
  assert.equal(listing[0], null, "not before the owner's head start");
  stopListing();
  cancelQueuedStartReveal();
});

test("the fallback timer opens the reveal even if the clock reads a moment early", async () => {
  cancelQueuedStartReveal();
  const early = Date.now() + 60_000; // a clock that never reaches fallbackAt on its own
  const claimed: (string | null)[] = [];
  const stop = onQueuedStartReveal(() => claimed.push(claimQueuedStartReveal(OLDER, [OLDER, ID], early + 1)));
  revealQueuedStart(ID, early);
  assert.deepEqual(claimed, [null]);
  await new Promise((resolve) => setTimeout(resolve, LISTED_FALLBACK_MS + 50));
  assert.ok((claimed as (string | null)[]).includes(ID), "the listing card took it when the timer fired");
  stop();
  cancelQueuedStartReveal();
});
