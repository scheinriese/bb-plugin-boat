import { renderToStaticMarkup } from "react-dom/server";
import { TaskDetail } from "../../web/task-detail";
import { TaskTab } from "../../web/task-tab";
import { setPendingTaskFixture } from "./pending-task-sdk";
import type { TaskDetailDto } from "../../contract";
import type { OwnMacNotice } from "../../contract-ownmac";
export function renderPendingTask(task: TaskDetailDto, notice: OwnMacNotice | null, panel = false): string {
  setPendingTaskFixture(task, notice);
  return renderToStaticMarkup(panel ? <TaskTab threadId="fake" environment={null} /> : <TaskDetail id={task.id} />);
}
import { pendingTaskSample, pendingRentalSample } from "./pending-task-data";
export function renderPendingTaskScene(): string {
  return renderPendingTask(pendingTaskSample, pendingRentalSample);
}
export function renderCancelledTaskScene(): string {
  const cancelled: TaskDetailDto = {
    ...pendingTaskSample,
    status: "cancelled",
    phase: "cancelled",
    macRentalPending: false,
    publicStatus: {status:"stopped",label:"Stopped",tone:"neutral",reason:null,needsYou:false,moving:false},
  };
  return renderPendingTask(cancelled, null);
}
