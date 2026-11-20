import type { ReactNode } from "react";
import { cn } from "../lib/utils";
export function Frame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "boat-ui my-3 -ml-2 w-[calc(100%+16px)] sm:ml-0 sm:w-[calc(100%+8px)] max-w-[720px] overflow-hidden rounded-[12px] sm:rounded-[10px] border border-border bg-card text-[13px] leading-5 text-foreground dark:text-[#C1C1C1]",
        className,
      )}
    >
      {children}
    </section>
  );
}
