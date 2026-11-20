// Public SDK defaults remain available; this preview overrides only the host UI
// functions used by the paid-start form. No RPC or provider calls are supplied.
export * from "@get-bb/plugin-sdk/app";
const formHost = {
  shortcuts: new Map(), actionShortcuts: new Map(),
  registerChoiceHandler: () => () => {}, registerActionHandler: () => () => {},
};
export const experimental_useQuestionFormHost = () => formHost;
export function experimental_ProviderIcon({className}: {className?:string}) {
  return <svg viewBox="0 0 16 16" className={className} aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>;
}
export const experimental_useProviders = () => ({ providers: [{id:"claude-code"},{id:"codex"}] });
