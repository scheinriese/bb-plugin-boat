import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  monthlyMacSuggestionSchema,
  type MonthlyMacSuggestion,
  type MonthlyMacPrice,
} from "../contract-monthly-macs.ts";
import { MacLeaseLedger, LEASE_DAY_MS as DAY } from "./mac-leases.ts";
import {
  chipMeets,
  leaseChip,
  monthlyMacRule,
  type WeeklyForecast,
} from "./monthly-macs.ts";
export const MONTHLY_MAC_MIGRATIONS = [
  `CREATE TABLE monthly_mac_forecasts (group_id TEXT NOT NULL, at INTEGER NOT NULL, days REAL NOT NULL, day_rate REAL NOT NULL, PRIMARY KEY(group_id,at))`,
  `CREATE TABLE monthly_mac_suggestions (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, created_at INTEGER NOT NULL, snoozed_until INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL)`,
  `CREATE TABLE monthly_mac_shown (suggestion_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY(suggestion_id,thread_id))`,
  `CREATE TABLE monthly_mac_enrolled (group_id TEXT PRIMARY KEY, price TEXT NOT NULL)`,
];
export class MonthlyMacAdvisor {
  private readonly db: () => Database.Database;
  private readonly ledger: MacLeaseLedger;
  constructor(db: () => Database.Database, ledger: MacLeaseLedger) {
    this.db = db;
    this.ledger = ledger;
  }
  active(): MonthlyMacSuggestion[] {
    return (
      this.db()
        .prepare(
          "SELECT body FROM monthly_mac_suggestions WHERE active=1 ORDER BY created_at DESC",
        )
        .all() as { body: string }[]
    )
      .map((row) => monthlyMacSuggestionSchema.parse(JSON.parse(row.body)))
      .filter((item) => item.answer === null);
  }
  forThread(threadId: string): MonthlyMacSuggestion[] {
    return this.active().filter(
      (item) =>
        this.db()
          .prepare("INSERT OR IGNORE INTO monthly_mac_shown VALUES (?,?)")
          .run(item.id, threadId).changes > 0,
    );
  }
  get(id: string): MonthlyMacSuggestion | null {
    const row = this.db()
      .prepare("SELECT body FROM monthly_mac_suggestions WHERE id=?")
      .get(id) as { body: string } | undefined;
    return row ? monthlyMacSuggestionSchema.parse(JSON.parse(row.body)) : null;
  }
  /** Integration seam for Your Mac: recording enrollment never buys a contract. */
  recordEnrolled(group: string, price: MonthlyMacPrice | null): void {
    if (price)
      this.db()
        .prepare("INSERT OR REPLACE INTO monthly_mac_enrolled VALUES (?,?)")
        .run(group, JSON.stringify(price));
    else
      this.db()
        .prepare("DELETE FROM monthly_mac_enrolled WHERE group_id=?")
        .run(group);
  }
  answer(
    id: string,
    answer: NonNullable<MonthlyMacSuggestion["answer"]>,
    now = Date.now(),
  ): MonthlyMacSuggestion {
    const suggestion = this.get(id);
    if (!suggestion)
      throw new Error("This Mac suggestion is no longer available.");
    if (suggestion.answer) return suggestion;
    if (
      (suggestion.kind === "rent" && answer === "cancel") ||
      (suggestion.kind === "cancel" && answer === "rent")
    )
      throw new Error("Choose an option from this suggestion.");
    suggestion.answer = answer;
    suggestion.answeredAt = new Date(now).toISOString();
    this.db()
      .prepare(
        "UPDATE monthly_mac_suggestions SET active=0,body=?,snoozed_until=? WHERE id=?",
      )
      .run(
        JSON.stringify(suggestion),
        answer === "keep" ? now + 14 * DAY : 0,
        id,
      );
    return suggestion;
  }
  refresh(
    prices: readonly MonthlyMacPrice[],
    now = Date.now(),
  ): MonthlyMacSuggestion[] {
    this.db()
      .prepare("UPDATE monthly_mac_suggestions SET active=0 WHERE active=1")
      .run();
    const leases = this.ledger.list();
    const groups = new Map<string, typeof leases>();
    for (const lease of leases) {
      const group = `${lease.provider}:${lease.currency}`;
      groups.set(group, [...(groups.get(group) ?? []), lease]);
    }
    const suggestions: MonthlyMacSuggestion[] = [];
    for (const [group, all] of groups) {
      const recent = all.filter(
        (l) =>
          Date.parse(l.startedAt) < now &&
          Math.max(
            Date.parse(l.paidUntil),
            l.endedAt ? Date.parse(l.endedAt) : now,
          ) >
            now - 30 * DAY,
      );
      // Retain hardware for an enrolled Mac even when recent day use is zero.
      const required = recent.length ? recent : all.slice(-1);
      if (!required.length || required.some((l) => !leaseChip(l.size)))
        continue;
      const chip = required
        .map((l) => leaseChip(l.size)!)
        .sort((a, b) => (chipMeets(a, b) ? -1 : 1))[0]!;
      const ramGB = Math.max(...required.map((l) => l.memoryMiB / 1024));
      const eligible = prices.filter(
        (p) =>
          p.available &&
          required.every(
            (l) =>
              p.ramGB * 1024 >= l.memoryMiB &&
              chipMeets(p.chip, leaseChip(l.size)!),
          ),
      );
      const enrolledRow = this.db()
        .prepare("SELECT price FROM monthly_mac_enrolled WHERE group_id=?")
        .get(group) as { price: string } | undefined;
      const enrolled = enrolledRow
        ? (JSON.parse(enrolledRow.price) as MonthlyMacPrice)
        : null;
      const candidate =
        enrolled ??
        eligible
          .filter(
            (p) => p.currency === all[0]!.currency && p.billing === "monthly",
          )
          .sort((a, b) => a.monthlyPrice - b.monthlyPrice)[0];
      if (!candidate || candidate.currency !== all[0]!.currency) continue;
      // A single monthly machine cannot replace overlapping physical leases.
      if (
        !enrolled &&
        recent.some((a, i) =>
          recent
            .slice(i + 1)
            .some(
              (b) =>
                Math.max(
                  Date.parse(a.startedAt),
                  Date.parse(b.startedAt),
                  now - 30 * DAY,
                ) <
                Math.min(
                  Math.max(
                    Date.parse(a.paidUntil),
                    a.endedAt ? Date.parse(a.endedAt) : now,
                  ),
                  Math.max(
                    Date.parse(b.paidUntil),
                    b.endedAt ? Date.parse(b.endedAt) : now,
                  ),
                  now,
                ),
            ),
        )
      )
        continue;
      const window = this.ledger.between(
        now - 30 * DAY,
        now,
        now,
        undefined,
        all[0]!.provider,
        candidate.currency,
      );
      const cost = window.costs[candidate.currency] ?? 0;
      const dayRate =
        window.leaseDays > 0
          ? cost / window.leaseDays
          : all[all.length - 1]!.hourPrice * 24;
      if (!(dayRate > 0)) continue;
      // Price/hardware changes reset the pair's weekly evidence, never reuse an
      // old forecast against newly edited terms. No historic forecasts invented.
      const key = createHash("sha256")
        .update(
          JSON.stringify([group, candidate, chip, ramGB, Boolean(enrolled)]),
        )
        .digest("hex");
      const latestRow = this.db()
        .prepare(
          "SELECT at FROM monthly_mac_forecasts WHERE group_id=? ORDER BY at DESC LIMIT 1",
        )
        .get(key) as { at: number } | undefined;
      if (!latestRow || now - latestRow.at >= 7 * DAY) {
        const weeklyDays = [0, 1, 2, 3].map(
          (i) =>
            (this.ledger.between(
              now - (i + 1) * 7 * DAY,
              now - i * 7 * DAY,
              now,
              undefined,
              all[0]!.provider,
              candidate.currency,
            ).leaseDays *
              30) /
            7,
        );
        this.db()
          .prepare("INSERT INTO monthly_mac_forecasts VALUES (?,?,?,?)")
          .run(key, now, Math.min(30, weeklyDays[0]!), dayRate);
      }
      const forecasts = (
        this.db()
          .prepare(
            "SELECT at,days,day_rate AS dayRate FROM monthly_mac_forecasts WHERE group_id=? ORDER BY at DESC LIMIT 2",
          )
          .all(key) as WeeklyForecast[]
      ).reverse();
      const last = this.db()
        .prepare(
          "SELECT id,created_at AS at,snoozed_until AS snooze FROM monthly_mac_suggestions WHERE group_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(group) as { id: string; at: number; snooze: number } | undefined;
      const existing = last ? this.get(last.id) : null;
      const historySince = Math.min(...all.map((l) => Date.parse(l.startedAt)));
      const passes = monthlyMacRule({
        now,
        historySince,
        monthlyPrice: candidate.monthlyPrice,
        forecasts,
        enrolled: Boolean(enrolled),
      });
      if (
        !passes ||
        (!enrolled && window.leaseDays <= candidate.monthlyPrice / dayRate)
      )
        continue;
      const weekly = [0, 1, 2, 3].map((i) =>
        Math.min(
          30,
          (this.ledger.between(
            now - (i + 1) * 7 * DAY,
            now - i * 7 * DAY,
            now,
            undefined,
            all[0]!.provider,
            candidate.currency,
          ).leaseDays *
            30) /
            7,
        ),
      );
      const base = forecasts[forecasts.length - 1]!.days;
      if (
        existing &&
        !existing.answer &&
        JSON.stringify(existing.candidate) === JSON.stringify(candidate) &&
        existing.chip === chip &&
        existing.ramGB === ramGB &&
        existing.kind === (enrolled ? "cancel" : "rent")
      ) {
        const updated = {
          ...existing,
          days: window.leaseDays,
          cost,
          dayRate,
          breakEven: candidate.monthlyPrice / dayRate,
          forecast: {
            low: Math.min(...weekly),
            base,
            high: Math.max(...weekly),
          },
          savings: base * dayRate - candidate.monthlyPrice,
        };
        this.db()
          .prepare(
            "UPDATE monthly_mac_suggestions SET active=1,body=? WHERE id=?",
          )
          .run(JSON.stringify(updated), existing.id);
        suggestions.push(updated);
        continue;
      }
      if (
        !monthlyMacRule({
          now,
          historySince,
          monthlyPrice: candidate.monthlyPrice,
          forecasts,
          lastSuggestedAt: last?.at,
          snoozedUntil: last?.snooze,
          enrolled: Boolean(enrolled),
        })
      )
        continue;
      const suggestion: MonthlyMacSuggestion = {
        id: randomUUID(),
        group,
        kind: enrolled ? "cancel" : "rent",
        createdAt: new Date(now).toISOString(),
        candidate,
        alternatives: eligible.filter((p) => p.id !== candidate.id),
        dayProvider: all[0]!.provider,
        chip,
        ramGB,
        currency: candidate.currency,
        days: window.leaseDays,
        cost,
        dayRate,
        breakEven: candidate.monthlyPrice / dayRate,
        forecast: { low: Math.min(...weekly), base, high: Math.max(...weekly) },
        savings: base * dayRate - candidate.monthlyPrice,
        answer: null,
        answeredAt: null,
      };
      this.db()
        .prepare(
          "INSERT INTO monthly_mac_suggestions (id,group_id,created_at,active,body) VALUES (?,?,?,1,?)",
        )
        .run(suggestion.id, group, now, JSON.stringify(suggestion));
      suggestions.push(suggestion);
    }
    return suggestions;
  }
}
