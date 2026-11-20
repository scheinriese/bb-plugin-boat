import type { SandboxProviderDto } from "../contract-providers";
export const INSTABOX_SECRETS_URL = "https://instabox.sh/dashboard";
const link = "text-[#7AA7FF] hover:underline";
export function SecretDetails() {
  return (
    <dl className="grid grid-cols-1 gap-x-2 gap-y-1.5 rounded-lg border border-[#262626] bg-[#151515] px-3 py-2.5 text-xs leading-4 max-sm:text-sm max-sm:leading-5 sm:grid-cols-[56px_1fr]">
      <dt className="text-xs leading-4 text-[#6E6E6E]">Where</dt>
      <dd>Instabox › Secrets › New secret</dd>
      <dt className="text-xs leading-4 text-[#6E6E6E]">Name</dt>
      <dd className="font-mono text-[11px] max-sm:text-[13px]">GH_TOKEN</dd>
      <dt className="text-xs leading-4 text-[#6E6E6E]">Hosts</dt>
      <dd className="break-words font-mono text-[11px] max-sm:text-[13px]">github.com, api.github.com</dd>
      <dt className="text-xs leading-4 text-[#6E6E6E]">Value</dt>
      <dd className="text-[#8A8A8A]">
        A GitHub token with repo access. Paste it in Instabox only, never in
        chat.
      </dd>
    </dl>
  );
}
export function ProviderSetup({
  provider,
  onCheck,
  onEnable,
  onKey,
  busy = false,
}: {
  provider: SandboxProviderDto;
  onCheck?: () => void;
  onEnable?: () => void;
  onKey?: () => void;
  busy?: boolean;
}) {
  const steps = provider.steps ?? [],
    nextRequired = steps.findIndex((s) => s.possible && s.required !== false && !s.done),
    next = nextRequired >= 0 ? nextRequired : steps.findIndex((s) => s.possible && !s.done),
    waiting = (provider.waitingTasks ?? 0) > 0;
  return (
    <ol
      className="mt-3 space-y-1 text-[13px] leading-[18px]"
      aria-label={`${provider.label} setup steps`}
    >
      {steps.map((s, i) => {
        const active = i === next,
          needs = active && waiting;
        return (
          <li
            key={s.id}
            className={
              active
                ? `-ml-[13px] space-y-2.5 rounded-lg border px-3 py-2.5 ${needs ? "border-[#3D3420] bg-[#211D17]" : "border-[#2A3A55] bg-[#1A2230]"}`
                : s.possible
                  ? "flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1"
                  : "flex min-h-8 items-center gap-2.5 rounded-md border border-dashed border-[#2A2A2A] px-2 text-[#6E6E6E]"
            }
          >
            <div
              className={`flex items-center gap-2.5 ${active ? "" : "w-[220px]"}`}
            >
              <span
                aria-hidden
                className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] ${s.done ? "border-[#5BD08A] bg-[#1B2A21] text-[#5BD08A]" : active ? (needs ? "border-[#F0B135] text-[#F0B135]" : "border-[#7AA7FF] text-[#7AA7FF]") : "border-[#444444] text-[#6E6E6E]"}`}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span
                className={
                  s.done || active ? "text-[#EDEDED]" : "text-[#8A8A8A]"
                }
              >
                {s.label}
              </span>
              {active && (
                <span
                  className={`rounded px-1.5 text-[11px] ${needs ? "text-[#F0B135]" : "bg-[#1E2A3D] text-[#7AA7FF]"}`}
                >
                  {needs
                    ? `${provider.waitingTasks} task${provider.waitingTasks === 1 ? "" : "s"} waiting`
                    : s.required === false ? "Optional" : "Next"}
                </span>
              )}
            </div>
            {active ? (
              <div className="space-y-2.5 pl-[26px]">
                <p className="text-xs leading-[17px] text-[#A8A8A8]">
                  {s.id === "github"
                    ? "Agents push branches from Instabox, so it needs its own GitHub token. Add it in Instabox; Harbormaster only checks that it exists."
                    : s.detail}
                  {s.docsUrl && <a className="ml-1 text-[#7AA7FF] hover:underline" href={s.docsUrl} target="_blank" rel="noreferrer">Credential risks ↗</a>}
                </p>
                {s.id === "github" && (
                  <>
                    <p className="text-xs text-[#A8A8A8]">
                      Name <code className="text-[#EDEDED]">GH_TOKEN</code>
                      <br />
                      Hosts <code>github.com, api.github.com</code>
                    </p>
                    <a
                      href={INSTABOX_SECRETS_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-block rounded-md bg-[#E6E6E6] px-2.5 py-1 text-xs font-medium text-[#141414]"
                    >
                      Open Instabox Secrets ↗
                    </a>
                  </>
                )}
                {s.id === "cli" && (
                  <code className="block text-xs">npm install -g instabox</code>
                )}
                {s.id === "key" && (
                  <button type="button" className={link} onClick={onKey}>
                    Add or replace key in bb secrets
                  </button>
                )}
                {s.id === "enabled" && provider.id === "instabox" && (
                  <button
                    type="button"
                    disabled={busy}
                    role="switch"
                    aria-checked={provider.enabled}
                    className="rounded-md bg-[#E6E6E6] px-2.5 py-1 text-xs text-[#141414] disabled:opacity-60"
                    onClick={onEnable}
                  >
                    Turn on Instabox
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={onCheck}
                  className="ml-2 rounded-md border border-[#333333] px-2.5 py-1 text-xs text-[#D0D0D0] disabled:opacity-60"
                >
                  {busy ? "Checking…" : "Check again"}
                </button>
              </div>
            ) : (
              <span className="text-xs text-[#6E6E6E]">
                {s.detail}
                {s.docsUrl && <a className="ml-1 text-[#7AA7FF] hover:underline" href={s.docsUrl} target="_blank" rel="noreferrer">Credential risks ↗</a>}
                {s.id === "key" && s.done && (
                  <button className={`ml-1 ${link}`} onClick={onKey}>
                    Change
                  </button>
                )}
                {s.id === "enabled" && !s.done && (
                  <span
                    role="switch"
                    aria-checked="false"
                    aria-disabled="true"
                    className="ml-3 inline-block h-4 w-7 rounded-full bg-[#2A2A2A] align-middle opacity-60"
                  >
                    <span className="m-0.5 block size-3 rounded-full bg-[#6E6E6E]" />
                  </span>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
