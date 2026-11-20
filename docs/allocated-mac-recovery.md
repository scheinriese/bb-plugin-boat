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
recovery action uses the basic operation. It never opts into legacy adoption.
There is no separate agent tool;
agents can use the CLI only when the user authorized this same-machine start.

## Explicit adoption of a legacy deletion after failed admission

The basic command still refuses an ambiguous legacy end. A reviewed, explicit
adoption can admit one narrow case: the original `lease_unknown` task never
started, its existing lease has a legacy `deleted` timestamp after the failure
and no more than 10 seconds later, and the provider still confirms the exact
same physical lease before its original minimum ends. This recognizes current
provider evidence without asserting what caused the historical admission failure
or the local deletion record.

Gather evidence through supported reads. The `macUsage` RPC with `null` input
returns `legacyEnded`, up to 100 recent raw legacy deletion rows; this is history,
not a list of eligible recoveries. Match its `machineId` to the existing machine.
`sandbox info` supplies the physical `mac.leaseId`, `startedAt`, `chargeUntil`,
model, terms and `scheduledReleaseAt`. `task show` supplies the failed linked
task's `finishedAt` and failure cause. The consumed original rental notice links
the source request to that task and retains its original approved quote.

Copy the strings exactly, including microseconds. `failedAt` means the task's
`finishedAt`; the recorded `lease_unknown` event must follow it within one second.
The provider's current release schedule must equal the original `paidUntil`.
The original row must have `releaseAt: null` and no explicit keep. Any recorded
stop/delete intent or source/task cancellation prevents adoption, including a
failed provider deletion. The operator must additionally confirm that no owner
release was requested; missing historical intent records alone do not prove this.

Example with **fake IDs and times**; replace every value with the inspected
evidence. `--user-approved` authorizes recovery of this task on this Mac and
`noReleaseRequested` records the intent check. Neither approves another rental:

```sh
bb boat task recover-mac t_example m_example --user-approved --json \
  --adopt-legacy-lease '{"ledgerId":"instabox:73","leaseId":"73","sourceTaskId":"t_request","startedAt":"2030-01-01T12:00:27.670853Z","paidUntil":"2030-01-02T12:00:27.670853Z","endedAt":"2030-01-01T12:00:32.793Z","failedAt":"2030-01-01T12:00:31.299Z","noReleaseRequested":true}'
```

The equivalent public RPC is `recoverAllocatedMac`:

```json
{
  "taskId": "t_example",
  "machineId": "m_example",
  "userApproved": true,
  "adoptLegacyLease": {
    "ledgerId": "instabox:73",
    "leaseId": "73",
    "sourceTaskId": "t_request",
    "startedAt": "2030-01-01T12:00:27.670853Z",
    "paidUntil": "2030-01-02T12:00:27.670853Z",
    "endedAt": "2030-01-01T12:00:32.793Z",
    "failedAt": "2030-01-01T12:00:31.299Z",
    "noReleaseRequested": true
  }
}
```

The service validates this proof against the original linked approval, task,
machine, raw ledger row and repeated fresh provider reads. It also rechecks
credentials, account/subscription room, trust, project intent, physical work,
resources, cancellation and remaining prepaid time. Confirmed terminations,
different/replaced/expired leases, changed terms, conflicting work, release or
keep intent, missing approval, stale observations and incomplete proof refuse.

Success atomically records an adoption overlay and transitions the **same task**
to starting. The original ended row, including its deletion timestamp, reason,
provenance and release field, remains intact. The overlay uses the original lease
ID for held capacity, reservations and billing, so the minimum is counted once.
It records the operator proof, observed physical identity/terms/release schedule
and adoption time. `macUsage.adoptions` exposes that audit and the public notice
explains the reconciliation. Later provider termination ends the overlay;
it does not erase the historical record or allow stale reads to adopt it again.

These are local accounting/application writes. No create, start, resume, renew,
reimage, extend, schedule cancellation or settings write is performed. The
provider release plan remains in force. Repository/tooling preparation and bb
enrollment then proceed as for basic recovery; a later setup failure preserves
the adoption audit, physical machine, credentials and release plan.

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
release. Their provenance is unknown on upgrade. Ordinary reads and basic
recovery refuse an ambiguous legacy end, except when its timestamp predates the
physical lease's start. The explicit evidence-bound adoption above is separate
and preserves the original end rather than automatically rewriting it.
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
