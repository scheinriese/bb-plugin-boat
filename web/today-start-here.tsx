import { Children, type ReactNode } from "react";

/** Cost guidance can be the only Start here item; no empty action box. */
export function TodayStartHereActions({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children);
  return rows.length ? (
    <div className="overflow-hidden rounded-xl border sm:rounded-[10px] border-border bg-card divide-y divide-border/60">
      {rows}
    </div>
  ) : null;
}
