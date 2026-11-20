import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Only for an isolated test host. The host sorts contributions by plugin id.
export default function collision(bb: BbPluginApi): void {
  bb.cli.register({
    name: "harbor",
    summary: "Harbor collision fixture",
    rendersHelp: true,
    run: () => ({ exitCode: 0, stdout: "Collision fixture owns bb harbor.\n" }),
  });
}
