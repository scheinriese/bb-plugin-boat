# Recover an allocated Mac after a failed start

A failed app task does not establish that its physical Mac lease ended. Do
not approve another rental, retry an uncertain creation, or delete the machine
to clear the failure. Keep the original approval and linked task for diagnosis.

## What the fake reproductions establish

On the base revision, four independent fake lifecycle cases fail: a provider
`get` normalizes a numeric-string lease ID and microsecond timestamps without
recording its lease; an older stopped list row can end a newer allocation;
equal lease IDs on different machines overwrite the machine binding; and a
subsequent authoritative `get` cannot repair a list-inferred local end. A fifth
fake case shows failed admission attempting generic sandbox deletion when the
physical allocation exists but its local active lease is missing.

These are reproduced code defects. They do not establish the historical cause
of an individual incident. Later `get` output does not establish the original
create response envelope, the order of earlier list observations, or the
provenance of an old local end. A retained minimum in monthly accounting with
no held row is consistent with an ended local row; it does not prove physical
handback or that billing stopped.

## Supported operations after review

Use the failed **linked task ID**, not the source approval request ID. Replace
these fake IDs with the task's existing task and machine IDs:

```sh
bb boat task show t_example --json
bb boat sandbox info m_example --json
bb boat task rental-options t_request --json
```

These operations inspect the existing task, machine and consumed approval.
Machine info can reconcile local lease records or record a billing discrepancy;
it never starts or resumes a physical lease. Do not use `--refresh` to replace
the consumed approval or use generic retry/follow-up for an uncertain creation.

After independent review and installation by the operator, the supported start
operation is:

```sh
bb boat task recover-mac t_example m_example --user-approved --json
```

The public plugin RPC is `recoverAllocatedMac` with input
`{"taskId":"t_example","machineId":"m_example","userApproved":true}`.
Its result contains the same `taskId` and `machineId`. The rental card's
explicit recovery action uses this operation. There is no separate agent tool;
agents can use the CLI only when the user authorized this same-machine start.

Recovery validates the consumed original quote, project/work intent, failed
zero-turn state, current provider and agent availability, account access,
credentials, subscription room, machine work state, fixed model/terms, remaining
prepaid time and provider release plan. Stopped, expired, ambiguous, occupied or
partially started tasks are refused. A full machine quota does not require a new
machine slot because recovery reuses the allocation.

Success keeps the task ID and approval, reserves the existing lease, and runs
normal repository preparation, machine enrollment and agent dispatch for that
task. Those setup steps can install tooling and deliver required credentials.
It never calls create, resume, extend or cancel-release, and never accepts a new
minimum. The provider's scheduled hand-back remains in force, so work must fit
the remaining paid time. No recovery refusal deletes the machine, cleans up its
credentials, changes settings, or clears its release schedule. Read-only provider
observations can update local accounting evidence even when startup is refused.

## Reconciliation and billing

Instabox list snapshots cannot authorize lease termination. A current machine
read records the provider's physical identity and fixed terms, with the machine
included in the identity so another machine cannot steal the row. Reads that
started before a local lease transition cannot revive it afterward. A current
read can repair a matching list-inferred end without recording another minimum;
confirmed local termination remains terminal.

Older ledger rows did not record whether an end came from a list or an explicit
release. Their provenance is unknown on upgrade. Recovery refuses an ambiguous
legacy end, except when the recorded end predates the physical lease's start.
When current provider data contradicts a terminal local row, a persistent public
notice shows the discrepancy, minimum, paid-until time and observed release
schedule. That notice does not claim billing ended. Credentials, attachments,
work history and the existing minimum remain in place.

## Scope of verification

All implementation checks use fake providers and temporary local test storage
in Linux. Standalone browser fixtures exercise the rental card at narrow and
wide widths. There is no live rental, provider, account, settings, credential,
owner-Mac, plugin installation or deployment validation. The branch remains a
draft for independent review before any installed-host recovery.
