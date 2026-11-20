import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { ClaudeRoutingStatus } from "../../web/claude-design";
import { TaskDesignControl } from "../../web/design-task-control";
import type { TaskDto } from "../../contract";

export function renderTaskControl(task: TaskDto): string {
  return renderToStaticMarkup(<TaskDesignControl task={task}/>);
}

export function renderRoutingControl(props: ComponentProps<typeof ClaudeRoutingStatus>): string {
  return renderToStaticMarkup(<ClaudeRoutingStatus {...props}/>);
}
