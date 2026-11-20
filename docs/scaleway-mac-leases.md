# Scaleway Mac task leases

Scaleway is a second Mac day-lease provider. Add **Scaleway secret key** in
bb's secret settings, set **Scaleway project ID**, and select **Scaleway**
in the project's Runs on. The default zone is `fr-par-3`; `fr-par-1` is also
supported. CLI: `bb boat config runs-on <project> scaleway`.
No API secret belongs in a command, task prompt, backup or log.

Only a dispatched task rents a Mac. The adapter does not offer a new-machine
environment picker, buy a monthly commitment, change a plan, or rent ahead.
Tasks on Scaleway use bb chats, with the existing trusted-project rules and
bb Connect. Fresh rentals require **GitHub token for rented machines** in bb secret settings for repository tasks and an available Account Pooler route for the chosen agent. GitHub access/expiry and the agent route are checked before allocation. The token travels only through private SSH stdin; agent logins stay on the owner server, with core routing model traffic through the enrolled daemon’s authenticated proxy. See [credential setup and cleanup](settings.md).

Existing held Macs retain SSH checks for the selected agent and GitHub login, with provisioned credentials refreshed before expiry. Immediate and scheduled release first log out and verify credential-file removal, including after failed bootstrap. Cleanup failure keeps the tracked lease for retry. Instabox's
headless runner stays available. If a headless task reaches the Scaleway
routing step, it reports that task chats are required and tries Instabox.

## API and billing sources

Verified against official documentation and the unauthenticated Product
Catalog on 2026-11-19:

- [Apple silicon API and schema](https://www.scaleway.com/en/developers/api/apple-silicon):
  `GET /apple-silicon/v1alpha1/zones/{zone}/server-types` supplies hardware,
  stock and default OS; `POST .../servers` creates a server with the explicit
  `os_id`, `commitment_type: duration_24h`, VPC disabled and a recovery token in
  its name (`bb-boat-<token>`). Create/update requests have no tags field.
  `GET .../servers/{id}` polls `status: ready` and `delivered`; the list API
  is paginated. `DELETE .../servers/{id}` releases it. Failed bootstrap uses
  `PATCH .../servers/{id}` with `schedule_deletion: true` (`deletion_scheduled` is response-only).
- [Public Product Catalog](https://www.scaleway.com/en/developers/api/product-catalog/public-catalog):
  `GET /product-catalog/v2alpha1/public-catalog/products?product_types=apple_silicon&zone={zone}`
  supplies live server-type prices. Only matching-zone, EUR, hourly retail
  prices for available products are accepted. Monthly, retired and network
  products are excluded. No currency conversion source exists here; EUR stays EUR.
- [Pricing](https://www.scaleway.com/en/pricing/apple-silicon/) and
  [billing FAQ](https://www.scaleway.com/en/docs/billing/faq/):
  macOS has a 24-hour minimum. Billing runs from creation to deletion,
  including when powered off. The [Bare Metal conditions](https://www-uploads.scaleway.com/Specific_Conditions_Bare_Metal_v07042026_c09b37fbab.pdf)
  state that each begun hour is charged. Use the minimum plus subsequent
  hourly charges, not another 24-hour purchase. Tax is excluded from retail prices.
- [IAM API](https://www.scaleway.com/en/developers/api/iam) and
  [organization quotas](https://www.scaleway.com/en/docs/organizations-and-projects/organization/organization-quotas/):
  `GET /account/v3/projects/{id}` resolves the organization;
  `GET /iam/v1alpha1/quota?organization_id={id}` supplies model/locality
  limits. Count that organization's Apple silicon servers in the selected
  zone, including its other projects, against those limits. Missing quota
  or unknown stock fails closed. Neither boat.dev nor Instabox consumes a slot.

The catalog currently returns the M1-M hourly offer in `fr-par-3`; hardware,
stock, available OS and prices are discovered at runtime. Other Paris
models depend on zone, stock, quota and account permissions. macOS default
images include Xcode and Command Line Tools; see the
[FAQ](https://www.scaleway.com/en/docs/apple-silicon/faq/) and
[OS API](https://www.scaleway.com/en/developers/api/apple-silicon#path-os-list-all-operating-systems-os).
No Asahi Linux image or beta OS is selected.

## SSH and bb bootstrap

Generate an Ed25519 pair with local `ssh-keygen`. Keep each private key in
`<dirname(plugin database)>/scaleway-keys/<random-id>`, mode 0600, in a 0700 directory.
Recovery metadata contains only the public-key resource ID, server ID,
zone, project ID and whether bootstrap completed. The directory comes from
`dirname(bb.storage.database().name)`, not the server data-root hint. No Scaleway
API secret is persisted there.

Register the public key using `POST /iam/v1alpha1/ssh-keys`. Scaleway SSH
keys are project-scoped, although Boat generates and uses one pair per
machine. See [SSH access](https://www.scaleway.com/en/docs/apple-silicon/how-to/connect-to-mac-mini-ssh/).
SSH uses the API-reported address and username, its login environment for the
actual home directory, batch authentication and
only that identity. Host keys use OpenSSH accept-new into a per-machine
known-hosts file; a later mismatch is refused. No passwords are logged or
used. Server passwords/VNC URLs are discarded at the API boundary.

Wait for delivery and successful SSH, then install Node 22 (checking its
published SHA256), Claude Code, Codex and GitHub CLI into the user home.
bb's existing shared machine registration installs/enrolls bb through a
stdin-capable SSH executor. Enrollment input is never put on a command line
or in shell history. Existing task workspace and checkout logic is reused.
Fresh task rentals fail closed while credential provisioning is unavailable.
Boat does not copy the host's GitHub or agent tokens to a new provider.

Delete the IAM public-key resource and local private/public/known-hosts files
when releasing the server. Automatic management requires a local key or lease
record. A name token matches only its local recovery record; the recorded server
ID keeps ownership after a rename. Other `bb-boat-*` servers are reported as
orphans in provider status, `bb boat providers` and `bb boat status` (including
JSON output). Boat never adopts, schedules or deletes them automatically; inspect
them in the Scaleway console.
Successful complete lists cover every recorded project/zone before treating an
allocation as absent. Changing project or zone does not discard an existing key.

An ambiguous create preserves recovery files and stops fallback. A clean list
recovers its matching name and binds the server ID; if no matching server exists,
it automatically deletes the unused IAM key and local recovery files. A failed
or incomplete list clears nothing. The operator can run
`bb boat providers recover scaleway` to invoke the same reconciliation. Recovered
allocations awaiting setup cannot authorize another rental. Failed bootstrap
requests `schedule_deletion`; a failed safety schedule is surfaced explicitly
with a tracked lease and manual-release instruction, never swallowed. Allocation,
listing, orphan reporting and recovery share a provider-local lock until the
create outcome and server ID are recorded. A list during `POST /servers` cannot
delete the pending IAM or private key. Readiness/bootstrap runs outside this lock.

## Routing and verification

Held leases on either provider precede new rentals. New rentals use the
project's preferred Mac provider, then the other provider when the first
is unconfigured, has no capacity, or rejects creation. History records each
attempt and the chosen fallback. An unknown create outcome or an allocated
machine whose setup failed stops fallback to avoid paying for two Macs.
Allocation and task/lease reservation run under the shared placement lock.
Readiness and SSH/bootstrap use the separate `waitReady` phase outside it, while
the task's reservation/claim protects the machine. Other placements and hand-back
therefore continue. Instabox timeouts and malformed create responses are unknown
allocation outcomes and never authorize a second rental; only explicit refusals
allow fallback. Each candidate runs its own agent/runner preflight before model
lookup or creation, so an unactivated Instabox account reports its setup problem.
Providers that classify their own create outcomes retain ordinary pre-allocation
errors for safe fallback; the service wraps unknown errors only for other providers.
The shared ledger, hand-back and keep-sandbox policy apply. The CLI preserves a
project's system when changing to a mixed provider such as Instabox; it forces Mac
for a Mac-only provider, or Linux for a provider that cannot host Macs.
Scaleway records `minimumCost`, immutable `paidUntil`, `hourPrice` and
`billingIncrementSeconds: 3600`. The ledger charges the minimum plus begun
hours after it, splitting billable time and costs across UTC months. The
default increment preserves Instabox's elapsed-time accounting.

The shared monitor keeps idle Macs inside their minimum, schedules release
at its end with the provider's PATCH hook, and cancels that schedule before
attaching more work. Empty Macs past the minimum are released promptly.
Open work is protected; `keep_sandbox` persists an exemption and cancels any
pending automatic release. These policies are the merged PR #24 logic,
with no separate Scaleway hand-back loop.

Automated tests use fake HTTP and SSH, never real rentals. A live account
must verify `duration_24h` acceptance, quota names/localities, OS delivery, SSH propagation, package
installation, bb enrollment, GitHub/agent authentication, Xcode execution,
minimum enforcement, scheduled deletion, key removal and invoice rounding.

Request shapes were checked against the official generated
[Apple silicon SDK](https://github.com/scaleway/scaleway-sdk-go/blob/master/api/applesilicon/v1alpha1/applesilicon_sdk.go).
The test API rejects unsupported create/update fields and always returns untagged
servers, including ambiguous create and failed scheduling scenarios.
