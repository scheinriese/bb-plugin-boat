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
function Preview() {
  const [notice, setNotice] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <main className="boat-ui mx-auto max-w-[800px] space-y-4 p-4">
    <div className="space-y-1"><h1 className="text-base font-medium">Mac rental choice</h1><p className="text-xs leading-5 text-[#8A8A8A]">Interactive sample · fake quotes only · nothing is rented</p></div>
    <OwnMacRentalCard notice={notice} showTaskTitle={false} busy={busy} approving={busy} error={error}
      onSelect={quoteId => { setError(""); setNotice({ ...notice, offer: quotes.find(quote => quote.id === quoteId) }); }}
      onRefresh={() => { setError(""); setNotice(initial); }}
      onAnswer={answer => {
        if (answer === "wait" || answer === "queue") { setNotice({ ...notice, answer }); return; }
        setBusy(true);
        setTimeout(() => { setBusy(false); setNotice({ ...notice, answer: "rent", replacementId: "fake-start" }); }, 1200);
      }} />
    <details className="text-xs leading-5 text-[#8A8A8A]"><summary className="cursor-pointer">Preview states</summary><div className="mt-2 flex flex-wrap gap-3">
      <button onClick={() => { setError(""); setNotice(initial); }}>Reset</button>
      <button onClick={() => { setError(""); const offers = quotes.map(q => ({ ...q, expiresAt: "2020-01-01T00:00:00Z" })); setNotice({ ...initial, offers, offer: offers[1] }); }}>Expired</button>
      <button onClick={() => { setError("The selected model is no longer available. Refresh offers to choose again."); setNotice(initial); }}>Error</button>
      <button onClick={() => { setError(""); setNotice({ ...initial, offers: [], offer: undefined }); }}>Unavailable</button>
    </div></details>
  </main>;
}
createRoot(document.getElementById("rental-preview")!).render(<Preview />);
