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
export function LiveOwnMacNotices({
  taskId,
  threadId,
}: {
  taskId?: string;
  threadId?: string;
}) {
  const fill = useFillComposer(threadId ?? "");
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
  const [showOffers, setShowOffers] = useState<Record<string, boolean>>({});
  const fail = (reason: Error) => toast.error(reason.message);
  if (!data?.notices.length) return null;
  return (
    <div className="space-y-3">
      {data?.notices.map((notice) => {
        const busy = test.isPending || check.isPending || answer.isPending;
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
        if (notice.offer)
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
                onOwnWords={
                  fill
                    ? () =>
                        fill(
                          "I have a question about the Mac rental cost before I choose.\n",
                        )
                    : undefined
                }
                busy={busy}
                onAnswer={(choice) => {
                  void answer
                    .mutate({
                      taskId: notice.taskId,
                      answer: choice,
                      quoteId: notice.offer!.id,
                    })
                    .catch(fail);
                }}
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
