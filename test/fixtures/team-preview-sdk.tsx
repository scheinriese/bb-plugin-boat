export * from "@get-bb/plugin-sdk/app";
import type { TeamState } from "../../contract-team";
let state: TeamState;
export function setTeamFixture(value: TeamState) {
  state = value;
}
export const experimental_useRpcQuery = ({ method }: { method: string }) => ({
  data: method === "teamState" ? state : undefined,
  isFetching: false,
  refetch: async () => {},
});
export const experimental_useRpcMutation = () => ({
  isPending: false,
  mutate: async () => {
    throw new Error("Static fixture preview");
  },
});
export const useBbNavigate = () => ({
  toThread() {},
  toPluginPanel() {},
  openUrl() {},
});
export const experimental_Icon = ({
  className,
  name,
}: {
  className?: string;
  name?: string;
}) => (
  <span className={className} aria-hidden="true">
    {name === "Lock" ? "♙" : name === "TriangleAlert" ? "△" : ""}
  </span>
);
