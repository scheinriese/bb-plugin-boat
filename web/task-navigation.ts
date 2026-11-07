import { useCallback } from "react";
import { experimental_useAppPanel, type JsonValue } from "@get-bb/plugin-sdk/app";

export const TASK_SECTIONS = ["Overview", "Reviews", "Transcript", "Sandbox"] as const;
export type TaskSection = typeof TASK_SECTIONS[number];
export const TASK_TARGET = { validate(value: JsonValue): value is { threadId: string; section: TaskSection } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.threadId === "string" && TASK_SECTIONS.includes(value.section as TaskSection);
} };
export const TASK_TAB = { id: "task", context: { kind: "thread" as const }, availability: "fixed" as const, experimental_target: TASK_TARGET };
/** Opens the current thread's native Task tab with a validated session-only target. */
export function useOpenTaskSection() {
  const panel = experimental_useAppPanel();
  return useCallback((threadId: string, section: TaskSection) => panel.openTab({ tab: TASK_TAB, target: { threadId, section } }), [panel]);
}

