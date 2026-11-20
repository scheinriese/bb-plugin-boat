import { useFillComposer } from "./cards";
import { useState } from "react";
import {
  experimental_useRpcMutation,
  experimental_useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import {
  OwnMacCleanupCard,
  OwnMacFallbackLine,
  OwnMacRefusalCard,
  OwnMacRentalCard,
} from "./own-mac-cards";
import { toast } from "sonner";
import { useCloudAgentsNavigation } from "./hooks";
import { PANEL_PATH } from "./format";
export function LiveOwnMacNotices({
  taskId,
  threadId,
  showTaskTitle = true,
}: {
  taskId?: string;
  threadId?: string;
  showTaskTitle?: boolean;
}) {
  const fill = useFillComposer(threadId ?? "");
  const {openTask,navigate}=useCloudAgentsNavigation();
  const { data } = experimental_useRpcQuery({
    contract: rpcContract,
    method: "ownMacNotices",
    input: taskId ? { taskId } : threadId ? { threadId } : {},
  });
  const test = experimental_useRpcMutation({
    contract: rpcContract,
    method: "ownMacTestConnection",
  });
  const check = experimental_useRpcMutation({
    contract: rpcContract,
    method: "ownMacCheckCleanup",
  });
  const answer = experimental_useRpcMutation({
    contract: rpcContract,
    method: "answerOwnMacRental",
  });
  const recover = experimental_useRpcMutation({contract:rpcContract,method:"recoverAllocatedMac"});
  const refresh = experimental_useRpcMutation({
    contract: rpcContract,
    method: "refreshMacRentalOffers",
  });
  const select = experimental_useRpcMutation({
    contract: rpcContract,
    method: "selectMacRentalOffer",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [approvingTask, setApprovingTask] = useState<string | null>(null);
  const [showOffers, setShowOffers] = useState<Record<string, boolean>>({});
  const fail = (reason: Error) => toast.error(reason.message);
  if (!data?.notices.length) return null;
  return (
    <div className="space-y-3">
      {data?.notices.map((notice) => {
        const busy = test.isPending || check.isPending || answer.isPending || refresh.isPending || select.isPending;
        const run = (action: () => Promise<unknown>, approving = false) => {
          setErrors(current => ({ ...current, [notice.taskId]: "" }));
          if (approving) setApprovingTask(notice.taskId);
          void action().catch((reason: Error) => {
            setErrors(current => ({ ...current, [notice.taskId]: reason.message }));
          }).finally(() => { if (approving) setApprovingTask(null); });
        };
        if (notice.disconnect)
          return (
            <p
              key={notice.taskId}
              role="status"
              className="rounded-lg border border-[#262626] bg-[#181818] px-3.5 py-3 text-[13px] leading-5 text-[#A8A8A8]"
            >
              {notice.disconnect}
            </p>
          );
        if (notice.cleanup)
          return (
            <OwnMacCleanupCard
              key={notice.taskId}
              title={notice.title}
              cleanup={notice.cleanup}
              busy={busy}
              onCheck={() => {
                void check.mutate(null).catch(fail);
              }}
            />
          );
        if (
          notice.refusal &&
          !notice.answer &&
          !notice.offer &&
          !notice.offers &&
          !notice.replacementId &&
          !showOffers[notice.taskId]
        )
          return (
            <OwnMacRefusalCard
              key={notice.taskId}
              notice={notice}
              busy={busy}
              onTest={() => {
                void test.mutate(null).catch(fail);
              }}
              onRent={() =>
                setShowOffers({ ...showOffers, [notice.taskId]: true })
              }
            />
          );
        if (notice.offer || notice.offers || notice.replacementId)
          return (
            <div key={notice.taskId} className="space-y-3">
              {notice.refusal &&
                !notice.answer &&
                !showOffers[notice.taskId] && (
                  <OwnMacRefusalCard
                    notice={notice}
                    busy={busy}
                    onTest={() => {
                      void test.mutate(null).catch(fail);
                    }}
                    onRent={() =>
                      setShowOffers({ ...showOffers, [notice.taskId]: true })
                    }
                  />
                )}
              <OwnMacRentalCard
                notice={notice}
                showTaskTitle={showTaskTitle}
                onOpenTask={notice.replacementId ? () => openTask(notice.replacementId!) : undefined}
                onOpenMachine={() => navigate.toPluginPanel(PANEL_PATH,{subPath:"sandboxes"})}
                recovering={recover.isPending}
                onRecover={notice.replacementId && notice.linkedTask?.machineId ? () => run(() => recover.mutate({taskId:notice.replacementId!,machineId:notice.linkedTask!.machineId!,userApproved:true})) : undefined}
                onOwnWords={
                  fill
                    ? () =>
                        fill(
                          "I have a question about the Mac rental cost before I choose.\n",
                        )
                    : undefined
                }
                busy={busy}
                approving={approvingTask === notice.taskId}
                error={errors[notice.taskId]}
                onRefresh={() => run(() => refresh.mutate({ taskId: notice.taskId }))}
                onSelect={(quoteId) => run(() => select.mutate({ taskId: notice.taskId, quoteId }))}
                onAnswer={(choice) => run(() => answer.mutate({
                  taskId: notice.taskId,
                  answer: choice,
                  quoteId: notice.offer?.id,
                }), choice === "rent")}
              />
            </div>
          );
        return <OwnMacFallbackLine key={notice.taskId} notice={notice} />;
      })}
    </div>
  );
}

/** Visible inside the existing chat context card, without sending a prompt
 * to the worker. Sending would wake a disconnected or completed task. */
export function OwnMacChatNotices({ threadId }: { threadId: string }) {
  const { data } = experimental_useRpcQuery({
    contract: rpcContract,
    method: "ownMacNotices",
    input: { threadId },
  });
  if (!data?.notices.length) return null;
  return <LiveOwnMacNotices threadId={threadId} />;
}
