// Rendering-only native host. These fixtures never call providers or change settings.
export * from "@get-bb/plugin-sdk/app";
import type { TaskDetailDto } from "../../contract";
import type { OwnMacNotice } from "../../contract-ownmac";
let task: TaskDetailDto;
let notice: OwnMacNotice | null;
export function setPendingTaskFixture(next: TaskDetailDto, nextNotice: OwnMacNotice | null) { task = next; notice = nextNotice; }
export const experimental_useRpcQuery = ({method}: {method: string}) => ({
  data: method === "task" ? {task} : method === "ownMacNotices" ? {notices:notice ? [notice] : []} : method === "overview" ? {taskChats:false,connect:{state:"connected"}} : undefined,
  refetch: async () => {}, isFetching: false,
});
export const experimental_useRpcKeyedQuery = ({method}: {method: string}) => ({data: method === "threadRoles" ? {fake: {kind:"task", task}} : {}});
export const experimental_useRpcMutation = () => ({isPending:false,mutate:async()=>({})});
export const experimental_useFixedTabTarget = () => null;
export const useBbNavigate = () => ({toThread() {},toPluginPanel() {},openUrl() {}});
export const useSdk = () => ({threads:{open() {}}});
export const Markdown = ({content}: {content:string}) => <p>{content}</p>;
export const useComposers = () => [];
export const experimental_useProviders = () => ({providers:[]});
export const experimental_useSidebarThreads = () => ({threads:[],projects:[],status:"ready"});
export const experimental_Icon = ({className}: {className?:string}) => <span className={className} aria-hidden="true" />;
export const useRealtimeConnectionState = () => ({state:"connected"});
