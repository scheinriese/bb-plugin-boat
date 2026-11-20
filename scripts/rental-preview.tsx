// Interactive fake fixture only. No RPC, credentials, provider calls or settings.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { MacRentalQuote, OwnMacNotice } from "../contract-ownmac";
import { OwnMacRentalCard } from "../web/own-mac-cards";
const quotes: MacRentalQuote[] = [
  { id: "fake-instabox", provider: "instabox", label: "Instabox", model: "fake-m2", modelLabel: "Mac M2", cpus: 8, memoryMiB: 8192, checkedAt: "2030-01-01T12:00:00Z", minimumCost: 10.8, hourPrice: 0.45, minimumHours: 24, currency: "USD", expiresAt: "2099-01-01T00:00:00Z" },
  { id: "fake-scaleway", provider: "scaleway", label: "Scaleway", model: "fake-m4", modelLabel: "Mac mini M4", cpus: 10, memoryMiB: 16384, region: "fr-par-1", checkedAt: "2030-01-01T12:00:00Z", minimumCost: 5.28, hourPrice: 0.22, minimumHours: 24, currency: "EUR", expiresAt: "2099-01-01T00:00:00Z" },
];
const initial: OwnMacNotice = {
  taskId: "fake-task", title: "Test the sample native app", alias: "", reason: "unavailable", canWaitForOwnMac: false,
  offers: quotes, offer: quotes[1], recommendedQuoteId: quotes[1].id,
  recommendationReason: "Project preference: Scaleway.",
  unavailable: [{ provider: "fake-unavailable", label: "Other Mac", reason: "No compatible model is currently available." }],
};
const failed: OwnMacNotice = {
  ...initial, offer:quotes[0], answer:"rent", replacementId:"t_fake_allocated",
  linkedTask:{taskId:"t_fake_allocated",status:"failed",turns:0,machineId:"instabox_fake_allocated",error:"Instabox did not report the Mac lease; work cannot safely start.",lease:{provider:"instabox",model:"m2",minimumCost:10.8,hourPrice:.45,currency:"USD",paidUntil:"2030-01-02T12:00:00Z",releaseAt:"2030-01-02T12:00:00Z",endedAt:null}},
};
const allActions:OwnMacNotice = {...initial,canWaitForOwnMac:true};
function Preview() {
  const state=new URL(location.href).searchParams.get("state");
  const [notice, setNotice] = useState(state==="allocated-failed" ? failed : state==="all-actions" ? allActions : initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <main className="boat-ui mx-auto max-w-[800px] space-y-4 p-4">
    <div className="space-y-1"><h1 className="text-base font-medium">Mac rental choice</h1><p className="text-xs leading-5 text-[#8A8A8A]">Interactive sample · fake quotes only · nothing is rented</p></div>
    <OwnMacRentalCard notice={notice} showTaskTitle={false} busy={busy} approving={busy} error={error}
      onOwnWords={() => setError("Sample only: opens the composer to ask about this rental; it does not approve a rental.")}
      onRecover={() => setError("Sample refusal: current provider lease must be verified before this existing task can recover. No new rental was started.")}
      onOpenTask={() => setError("Sample only: opens the existing linked task in the installed plugin.")}
      onOpenMachine={() => setError("Sample only: opens Sandboxes to inspect this allocated machine.")}
      onSelect={quoteId => { setError(""); setNotice({ ...notice, offer: quotes.find(quote => quote.id === quoteId) }); }}
      onRefresh={() => { setError(""); setNotice({...initial,canWaitForOwnMac:notice.canWaitForOwnMac}); }}
      onAnswer={answer => {
        if (answer === "wait" || answer === "queue") { setNotice({ ...notice, answer }); return; }
        setBusy(true);
        setTimeout(() => { setBusy(false); setNotice({ ...notice, answer: "rent", replacementId: "fake-start" }); }, 1200);
      }} />
    <details className="text-xs leading-5 text-[#8A8A8A]"><summary className="cursor-pointer">Preview states</summary><div className="mt-2 flex flex-wrap gap-3">
      <button onClick={() => { setError(""); setNotice(initial); }}>Reset</button>
      <button onClick={() => { setError(""); setNotice(allActions); }}>All four actions</button>
      <button onClick={() => { setError(""); setNotice(failed); }}>Allocated · task failed</button>
      <button onClick={() => { setError(""); setNotice({...failed,linkedTask:{...failed.linkedTask!,lease:{...failed.linkedTask!.lease!,endedAt:"2030-01-01T12:01:00Z"}}}); }}>Ended local row · uncertain billing</button>
      <button onClick={() => { setError(""); setNotice({...failed,linkedTask:undefined}); }}>Linked task unavailable</button>
      <button onClick={() => { setError(""); const offers = quotes.map(q => ({ ...q, expiresAt: "2020-01-01T00:00:00Z" })); setNotice({ ...initial, offers, offer: offers[1] }); }}>Expired</button>
      <button onClick={() => { setError("The selected model is no longer available. Refresh offers to choose again."); setNotice(initial); }}>Error</button>
      <button onClick={() => { setError(""); setNotice({ ...initial, offers: [], offer: undefined }); }}>Unavailable</button>
      <button onClick={() => { setError(""); setNotice({ ...initial, offers: [], offer: undefined, canWaitForOwnMac: true }); }}>No offers · wait for Your Mac</button>
    </div></details>
  </main>;
}
createRoot(document.getElementById("rental-preview")!).render(<Preview />);
