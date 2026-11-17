import assert from "node:assert/strict";
import { test } from "node:test";
import { REVEAL_WINDOW_MS, claimQueuedStartReveal, onQueuedStartReveal, queuedRowClickId, resetQueuedStartReveal, revealQueuedStart } from "../web/start-queue-reveal.ts";

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

test("the card showing the request takes the reveal once, also when it renders later", () => {
  resetQueuedStartReveal();
  const now = 1_000_000;
  revealQueuedStart(ID, now);
  assert.equal(claimQueuedStartReveal([OTHER], now + 10), null, "another request's card doesn't take it");
  assert.equal(claimQueuedStartReveal([OTHER, ID], now + 2_000), ID, "a group card listing the request does");
  assert.equal(claimQueuedStartReveal([ID], now + 2_100), null, "only once");
});

test("a reveal expires, so a later visit to the chat doesn't jump", () => {
  resetQueuedStartReveal();
  revealQueuedStart(ID, 0);
  assert.equal(claimQueuedStartReveal([ID], REVEAL_WINDOW_MS + 1), null);
  assert.equal(claimQueuedStartReveal([ID], 1), null, "an expired reveal is gone");
  revealQueuedStart("thr_not_a_request", 0);
  assert.equal(claimQueuedStartReveal(["thr_not_a_request"], 1), null);
});

test("mounted cards hear a new reveal; a newer request replaces an older one", () => {
  resetQueuedStartReveal();
  const claimed: (string | null)[] = [];
  const stop = onQueuedStartReveal(() => claimed.push(claimQueuedStartReveal([ID], 5)));
  revealQueuedStart(OTHER, 0);
  revealQueuedStart(ID, 0);
  assert.deepEqual(claimed, [null, ID]);
  stop();
  revealQueuedStart(ID, 0);
  assert.deepEqual(claimed, [null, ID]);
  resetQueuedStartReveal();
});
