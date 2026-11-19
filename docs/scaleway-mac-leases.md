# Scaleway Mac task leases

Scaleway is a second Mac day-lease provider. Add **Scaleway secret key** in
bb's secret settings, set **Scaleway project ID**, and select **Scaleway**
in the project's Runs on. The default zone is `fr-par-3`; `fr-par-1` is also
supported. CLI: `bb boat config runs-on <project> scaleway`.
No API secret belongs in a command, task prompt, backup or log.

Only a dispatched task rents a Mac. The adapter does not offer a new-machine
environment picker, buy a monthly commitment, change a plan, or rent ahead.
Tasks on Scaleway use bb chats, with the existing trusted-project rules,
bb Connect, and the owner's agent authentication in bb. Instabox's
headless runner stays available. If a headless task reaches the Scaleway
routing step, it reports that task chats are required and tries Instabox.

## API and billing sources

Verified against official documentation and the unauthenticated Product
Catalog on 2026-11-19:

- [Apple silicon API and schema](https://www.scaleway.com/en/developers/api/apple-silicon):
  `GET /apple-silicon/v1alpha1/zones/{zone}/server-types` supplies hardware,
  stock and default OS; `POST .../servers` creates a server with the explicit
  `os_id`, `commitment_type: none`, VPC disabled and a Boat recovery tag.
  `GET .../servers/{id}` polls `status: ready` and `delivered`; the list API
  is paginated. `DELETE .../servers/{id}` releases it. Failed bootstrap uses
  `PATCH .../servers/{id}` with `deletion_scheduled: true`.
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
`<plugin data>/scaleway-keys/<random-id>`, mode 0600, in a 0700 directory.
Recovery metadata contains only the public-key resource ID, server ID,
zone and project ID. No Scaleway API secret is persisted there.

Register the public key using `POST /iam/v1alpha1/ssh-keys`. Scaleway SSH
keys are project-scoped, although Boat generates and uses one pair per
machine. See [SSH access](https://www.scaleway.com/en/docs/apple-silicon/how-to/connect-to-mac-mini-ssh/).
SSH uses the API-reported address and username, batch authentication and
only that identity. Host keys use OpenSSH accept-new into a per-machine
known-hosts file; a later mismatch is refused. No passwords are logged or
used. Server passwords/VNC URLs are discarded at the API boundary.

Wait for delivery and successful SSH, then install Node 22 (checking its
published SHA256), Claude Code, Codex and GitHub CLI into the user home.
bb's existing shared machine registration installs/enrolls bb through a
stdin-capable SSH executor. Enrollment input is never put on a command line
or in shell history. Existing task workspace and checkout logic is reused.
Fresh machines still require GitHub authentication for private repositories;
Boat does not silently copy the host's GitHub token to a new provider.

Delete the IAM public-key resource and local private/public/known-hosts files
when releasing the server. A successful list also checks recorded machines
before cleaning keys for external or scheduled deletions; changing project
or zone cannot discard an existing machine's key. An ambiguous create
preserves recovery files and stops routing, requiring console reconciliation.

## Routing and verification

Held leases on either provider precede new rentals. New rentals use the
project's preferred Mac provider, then the other provider when the first
is unconfigured, has no capacity, or rejects creation. History records each
attempt and the chosen fallback. An unknown create outcome or an allocated
machine whose setup failed stops fallback to avoid paying for two Macs.
The shared ledger, placement lock, hand-back and keep-sandbox policy apply.

Automated tests use fake HTTP and SSH, never real rentals. A live account
must verify quota names/localities, OS delivery, SSH propagation, package
installation, bb enrollment, GitHub/agent authentication, Xcode execution,
minimum enforcement, scheduled deletion, key removal and invoice rounding.
