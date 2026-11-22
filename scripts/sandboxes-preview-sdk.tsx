// Rendering-only host, deliberately disconnected from bb and provider APIs.
export * from "@get-bb/plugin-sdk/app";
import type { AnchorHTMLAttributes } from "react";
import { fixture, type Scene } from "./sandboxes-preview-data";
const requested = new URLSearchParams(location.search).get("scene") as Scene | null;
const values = fixture(requested ?? "returned");
export const experimental_useRpcQuery = ({method, enabled = true}: {method: string; enabled?: boolean}) => enabled ? values[method] ?? {data: undefined, isLoading: false, isFetching: false, refetch: async () => {}} : {data: undefined, isLoading: false};
export const experimental_useRpcKeyedQuery = () => ({data: {}});
export const experimental_useRpcMutation = () => ({isPending: false, mutate: async () => {throw new Error("Synthetic preview: provider actions are disabled");}});
const showNavigation = () => window.dispatchEvent(new CustomEvent("fixture-navigation"));
export const useBbNavigate = () => ({toThread: showNavigation, toPluginPanel: showNavigation, openUrl: showNavigation});
export const experimental_useSidebarThreads = () => ({threads: [], projects: [], status: "ready"});
export const experimental_useProviders = () => ({providers: [{id: "codex"}, {id: "claude-code"}]});
export const experimental_Icon = ({className}: {className?: string}) => <svg viewBox="0 0 16 16" className={className} aria-hidden><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor"/></svg>;
export const experimental_ProviderIcon = experimental_Icon;
export const UrlLink = ({children, ...props}: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} onClick={event => {event.preventDefault(); showNavigation();}}>{children}</a>;
