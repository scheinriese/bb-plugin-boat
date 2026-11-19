// "Instabox sandbox" as a bb machine: task chats and any bb chat can run in
// an Instabox machine. bb installs its daemon there over Instabox's exec API
// (./provider.ts restExecutor, `noHistory`), after Instabox's own short step
// (systemd linger, the Secrets proxy's CA); src/providers/machine.ts does the
// rest. Its availability is Instabox's setup checks (./setup.ts).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoatService, BoatSettings } from "../../service.ts";
import type { ConnectCheck } from "../../connect.ts";
import { registerSandboxMachine, type MachineDeps } from "../machine.ts";
import type { SandboxProvider } from "../types.ts";
import type { InstaboxSetup } from "./setup.ts";

export function registerInstaboxMachine(
  bb: BbPluginApi,
  deps: {
    provider: SandboxProvider;
    service: BoatService;
    settings: () => Promise<BoatSettings>;
    setup: Pick<InstaboxSetup, "status" | "peek">;
    connect?: ConnectCheck;
  } & Pick<MachineDeps, "now" | "stopWait">,
): void {
  registerSandboxMachine(bb, deps.provider, {
    service: deps.service,
    settings: deps.settings,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.stopWait ? { stopWait: deps.stopWait } : {}),
    async availability() {
      try {
        const status = await (deps.setup.peek() ?? deps.setup.status());
        const failing = status.checks.find((check) => check.required && check.state === "missing");
        if (!status.turnedOn) return { status: "setup-required" as const, message: "Instabox is off in Boat's settings. Turn it on with `bb boat config set instaboxEnabled true`." };
        if (failing) return { status: "setup-required" as const, message: `${failing.label}: ${failing.detail}. ${failing.fix?.text ?? ""}`.trim() };
        const connect = deps.connect ? await deps.connect().catch(() => null) : null;
        if (connect?.state === "off") return { status: "setup-required" as const, message: `A chat in an Instabox machine reaches this bb through bb Connect, which is off. ${connect.fix ?? "Run `bb connect on`."}` };
        return { status: "available" as const };
      } catch {
        // Couldn't check: let the creation itself say what's wrong.
        return { status: "available" as const };
      }
    },
  });
}
