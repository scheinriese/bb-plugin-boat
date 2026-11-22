import { renderToStaticMarkup } from "react-dom/server";
import { SandboxTable } from "../../web/sandboxes-table";
import type { SandboxDto, TaskDto } from "../../contract";
import { setSandboxFailureFixture } from "./sandbox-failure-sdk";

export function renderSandboxFailure(sandbox: SandboxDto, task: TaskDto): string {
  setSandboxFailureFixture(sandbox, task);
  return renderToStaticMarkup(<SandboxTable/>);
}
