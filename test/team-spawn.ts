import type { BbPluginApi } from "@get-bb/plugin-sdk";
type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
/** The SDK fake does not enforce this real bb request constraint. */
export function strictTeamSpawn<T>(run: (args: SpawnArgs) => T) {
  return async (args: SpawnArgs) => {
    if (args.input !== undefined ? args.input.length < 1 : !args.prompt?.trim())
      throw new Error("HTTP 400: input must contain at least one entry");
    return run(args);
  };
}
