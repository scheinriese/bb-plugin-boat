# Sandboxes usage evidence

The Sandboxes view separates current guest power, account usage for a billing
period, and saved snapshots. A lease held in the local ledger is not evidence
that its guest is running. Snapshots never contribute to machine counts.

The inventory projection reads each enabled provider once through its existing
list API. Each successful read carries its receipt time. A failed read has an
unavailable status, a null timestamp, and a null count; its raw error is not
returned by this projection. Responses are limited to 200 machines per provider
and 200 lease records. Provider reads have a 15-second deadline; optional chat
metadata has a separate two-second deadline and cannot discard machine results.
A truncated list cannot establish an exact count.

## Guest power

`ready`, `idle`, and `running` count as on. `stopped`, `archived`, `deleted`, and
the normalized deleted state `cancelled` count as off. All other states remain
unknown, including starting, stopping, and errors. These presentation rules are
independent of the existing capacity and lifecycle rules.

The [boat lifecycle documentation](https://docs.boat.dev/concepts), checked on
2026-11-22, identifies ready/idle/running as the Running group. Its `running`
state means an integrated agent prompt is active; `idle` can still execute
commands. Starting includes provisioning/provisioned/cloning, and billing can
begin at provisioned before the guest becomes ready. The installed CLI's
`boat list --help` (1.0.105) describes its default filter as up/running. An “on”
count therefore describes running guests, not the number of active tasks or
the amount of compute billed this period. No literal API state named `on`
was verified.

## Lease history

The public projection contains only provider, machine and task references,
model, recorded lease terms, and end evidence. It omits credential notices,
operator evidence, local ledger IDs, and raw provider bodies. Held records are
shown before history so old history cannot displace them at the response limit.

A recorded hand-back or deletion with confirmed end evidence can be shown as
a return record. An inferred or legacy end remains unverified. A stopped guest
alone cannot establish a return; a held record alone cannot establish guest
power. Even a confirmed return record does not confirm the provider's final
billing amount or final billing end time. Lease cost remains a local estimate,
not a provider-attributed invoice line.

## Billing presentation and limits

Instabox usage is an account total in USD, including Macs. It is independent
of inventory: cumulative usage remains visible when no guests are running.
Successful observations carry their original timestamp. Failed refreshes can
retain that observation only within the same in-process credential, CLI and
endpoint scope; changing that scope clears the retained value. The private
scope fingerprint is never returned, logged or persisted.

The Mac summary is a local calculation from recorded leases for the stated
UTC calendar month. `calculatedAt` is its calculation time, not a provider
billing observation. Provider billing periods, account binding and invoice
line attribution are not proven by this ledger. The UI therefore marks the
breakdown unreconciled and never subtracts it from the account total, even
when currency and dates happen to match. Currency totals remain separate.
Minimum lease commitments are not described as payment confirmation.

The approved layout is retained with these narrow copy qualifications. It
does not show an exact unmatched amount or claim a confirmed final bill.
Provider guest creation time cannot establish continuous uptime, so no
invented time-on duration is displayed. Own-Mac task environments are not
counted as separate physical Macs. Snapshot readiness does not establish a
successful restore; restore testing remains explicitly unverified.

The isolated `scripts/sandboxes-preview-server.mjs` renders the real component
against synthetic, local RPC fixtures. Build first, then run it with
`node scripts/sandboxes-preview-server.mjs --host 0.0.0.0 --port 4182`.
It never contacts a provider or bb and its controls cannot allocate resources.
