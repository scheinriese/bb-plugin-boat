// Rendering-only host: no provider calls, navigation or mutations.
export * from "@get-bb/plugin-sdk/app";
import type { SandboxDto, TaskDto } from "../../contract";
let sandbox: SandboxDto;
let task: TaskDto;
export function setSandboxFailureFixture(nextSandbox: SandboxDto, nextTask: TaskDto) {
  sandbox = nextSandbox;
  task = nextTask;
}
export const experimental_useRpcQuery = ({method}: {method: string}) => ({
  data: ({
    sandboxes: {sandboxes:[sandbox],error:null}, tasks: {tasks:[task]}, task: {task:null},
    projects: {projects:[]}, settings: {settings:[]}, sandboxProviders: {providers:[]},
    macUsage: {held:[],byProvider:[]}, snapshots: {snapshots:[],error:null},
    fidelityUsage: {plan:null,sandboxes:[]},
  } as Record<string, unknown>)[method],
  isLoading:false, isFetching:false, refetch:async()=>{},
});
export const experimental_useRpcKeyedQuery = () => ({data:{}});
export const experimental_useRpcMutation = () => ({isPending:false,mutate:async()=>{throw new Error("Rendering fixture cannot mutate");}});
export const useBbNavigate = () => ({toThread(){},toPluginPanel(){},openUrl(){}});
export const experimental_useSidebarThreads = () => ({threads:[],projects:[],status:"ready"});
export const experimental_useProviders = () => ({providers:[]});
export const experimental_Icon = ({className}: {className?:string}) => <span className={className} aria-hidden="true"/>;
export const experimental_ProviderIcon = experimental_Icon;
