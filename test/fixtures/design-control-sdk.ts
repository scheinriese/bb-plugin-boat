// Rendering-only native app host: no network or provider operations.
export * from "@get-bb/plugin-sdk/app";
export const experimental_useRpcMutation = () => ({ isPending: false, mutate: async () => ({ ok: true }) });
