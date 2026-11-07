# Pull request merge confirmation

The `requestMerge` RPC opens the confirmation in the task chat and returns immediately. Only its explicit matching Merge choice authorizes the operation; notes, cancellation and older requests never authorize a merge.

Before showing the form, Boat reads the PR from GitHub with the bb server's existing `gh` login. Reads are bounded and uncached: additions/deletions, commit count, HEAD/base, reviews, enabled merge methods, and up to 100 checks. Unknown, pending, failed or truncated checks, draft PRs and blocking branch rules prevent merging. Repository and PR URL must agree with the task.

Approval applies to the exact task generation and GitHub snapshot. Boat takes the existing sandbox lifecycle claim, rechecks both, then invokes `gh pr merge --match-head-commit <approved HEAD>` with an enabled merge method. It never bypasses rules or deletes the branch. A PR queued by GitHub remains queued until a read confirms it actually merged. A confirmed merge records `merged`, marks an unchanged idle task done, and keeps its sandbox. Concurrent new work remains open.

The UI uses bb's native pending-interaction frame. The SDK controls its header, requester attribution and scroll limits. Keyboard hints use the current bb bindings.

Shipping uses the existing guarded service path. Before requesting approval it reads diff counts and checks rebase feasibility in a disposable clone with hooks disabled. It does not fetch, checkout or rebase the task checkout. Test counts are shown only when supplied by verified execution evidence; agent prose does not constitute independently run tests.
