// "Boat sandbox" as a bb machine: bb threads (for example a cloud
// orchestrator) can run inside a boat.dev sandbox. bb installs its daemon
// there through `boat ssh`; the daemon connects back over bb Connect
// (src/providers/machine.ts does the rest).
//
// bb's setup stays on `boat ssh`, with no fallback to boat's exec API: the
// setup sends bb's enrollment secret on stdin, `boat exec` takes no stdin,
// and boat keeps every exec command line in the sandbox's history (`boat
// history`). While boat.dev is still restoring the disk, the setup would
// also block on files not restored yet over exec; what helps is waiting
// (src/wake-retry.ts) and keeping SSH logins from hanging (src/login-scripts.ts).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoatService, BoatSettings } from "../../service.ts";
import type { ConnectCheck } from "../../connect.ts";
import { registerSandboxMachine, type MachineDeps } from "../machine.ts";
import type { BoatApi } from "./api.ts";
import type { BoatCli } from "./cli.ts";
import { createBoatProvider } from "./provider.ts";
import { machineProblem, type Setup, type SetupSettings } from "./setup.ts";

export function registerBoatMachine(
  bb: BbPluginApi,
  deps: {
    boat: BoatApi;
    cli: BoatCli;
    service: BoatService;
    settings: () => Promise<BoatSettings>;
    /** The setup checks (signed in, a plan, an agent login); absent: only the CLI is checked. */
    setup?: Setup;
    setupSettings?: () => Promise<SetupSettings>;
    connect?: ConnectCheck;
  } & Pick<MachineDeps, "wakes" | "quietLogins" | "prepareHost" | "now" | "stopWait" | "trimTimeoutMs">,
): void {
  const { cli } = deps;
  registerSandboxMachine(bb, createBoatProvider(deps.boat, { cli }), {
    service: deps.service,
    settings: deps.settings,
    ...(deps.wakes ? { wakes: deps.wakes } : {}),
    ...(deps.quietLogins ? { quietLogins: deps.quietLogins } : {}),
    ...(deps.prepareHost ? { prepareHost: deps.prepareHost } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.stopWait ? { stopWait: deps.stopWait } : {}),
    ...(deps.trimTimeoutMs === undefined ? {} : { trimTimeoutMs: deps.trimTimeoutMs }),
    async availability() {
      try {
        await cli.binary();
      } catch {
        return { status: "setup-required" as const, message: "Install the boat CLI on the machine that runs bb: run `curl -fsSL https://boat.dev/install | sh` in a terminal." };
      }
      if (deps.setup === undefined || deps.setupSettings === undefined) return { status: "available" as const };
      try {
        // The newest reading without waiting (a stale one refreshes in the
        // background); boat is read here only before the very first one.
        const setup = deps.setup;
        const [facts, settings, connect] = await Promise.all([
          setup.peek()?.facts ?? setup.reading(),
          deps.setupSettings(),
          deps.connect ? deps.connect().catch(() => null) : Promise.resolve(null),
        ]);
        const problem = machineProblem(facts, settings, connect);
        return problem === null ? { status: "available" as const } : { status: "setup-required" as const, message: problem };
      } catch {
        // Couldn't check: let the creation itself say what's wrong.
        return { status: "available" as const };
      }
    },
  });
}
