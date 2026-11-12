// Fake thread event logs for the steer retry tests (test/fixtures/steer-bad-request.json).
import { readFileSync } from "node:fs";
import type { TurnEventRow } from "../src/steer-retry.ts";

export const INCIDENT: TurnEventRow[] = JSON.parse(readFileSync(new URL("./fixtures/steer-bad-request.json", import.meta.url), "utf8")).rows;
export const STEER = "Keep the old settings route working too.";
export const BAD_REQUEST = '{"detail":"Bad Request"}';

/** The incident's rows, with the given row types left out. */
export function without(...types: string[]): TurnEventRow[] {
  return INCIDENT.filter((row) => !types.includes(row.type) && !(types.includes("steer") && JSON.stringify(row.data).includes("req_steer")));
}

/** The incident with its provider error replaced. */
export function withError(error: { message?: string; detail?: string; category?: string; httpStatusCode?: number | null }, completed = error.message ?? ""): TurnEventRow[] {
  return INCIDENT.map((row) => {
    if (row.type === "provider/error") {
      return { ...row, data: { ...row.data, message: error.message ?? "", detail: error.detail, errorInfo: { category: error.category ?? "unknown", providerCode: "other", httpStatusCode: error.httpStatusCode ?? null } } };
    }
    if (row.type === "turn/completed") return { ...row, data: { ...row.data, error: { message: completed } } };
    return row;
  });
}

/** Rows of a later turn: a request, its acceptance, maybe a steer, and how it ended. */
export function laterTurn(seq: number, options: { status: "failed" | "completed"; steer?: string; error?: string; turnId?: string }): TurnEventRow[] {
  const turnId = options.turnId ?? `turn_${seq}`;
  const scope = { kind: "turn", turnId };
  const rows: TurnEventRow[] = [
    { id: `evt_${seq}`, seq, type: "client/turn/requested", scope: { kind: "thread" }, data: { requestId: `req_${seq}`, target: { kind: "new-turn" }, source: "tell", input: [{ type: "text", text: "Retry" }] } },
    { id: `evt_${seq + 1}`, seq: seq + 1, type: "turn/input/accepted", scope, data: { clientRequestId: `req_${seq}`, scope } },
    { id: `evt_${seq + 2}`, seq: seq + 2, type: "turn/started", scope, data: {} },
  ];
  if (options.steer) {
    rows.push(
      { id: `evt_${seq + 3}`, seq: seq + 3, type: "client/turn/requested", scope: { kind: "thread" }, data: { requestId: `req_${seq + 3}`, target: { kind: "steer", expectedTurnId: turnId }, source: "tell", input: [{ type: "text", text: options.steer }] } },
      { id: `evt_${seq + 4}`, seq: seq + 4, type: "turn/input/accepted", scope, data: { clientRequestId: `req_${seq + 3}`, scope } },
    );
  }
  if (options.status === "failed") {
    rows.push({ id: `evt_${seq + 5}`, seq: seq + 5, type: "provider/error", scope, data: { message: options.error ?? BAD_REQUEST, detail: options.error ?? BAD_REQUEST, willRetry: false, errorInfo: { category: "unknown", providerCode: "other", httpStatusCode: null } } });
  }
  rows.push({ id: `evt_${seq + 6}`, seq: seq + 6, type: "turn/completed", scope, data: { status: options.status, ...(options.status === "failed" ? { error: { message: options.error ?? BAD_REQUEST } } : {}) } });
  return rows;
}
