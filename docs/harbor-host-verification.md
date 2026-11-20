# Harbor CLI verification

Checked on 2026-11-20 using the published **bb-app 0.50.1** package, whose
runtime bundles SDK 0.6.157. npm reported bb-app 0.50.1 and Plugin SDK 0.6.164
as the latest releases. The repository keeps its SDK 0.6.104 pin.

## Isolation

The task's enrolled bb reaches a live server. None of its plugin installs,
registrations or settings were changed. No `bb plugin install`, `reload`,
`remove` or `dev` command was run. Verification used a separate published bb
server on loopback with fresh disposable data and client directories. After
its first initialization, it was stopped and fixture rows for the two path
plugins were inserted into its own database before restarting it. Both
plugins loaded as **running** through the real plugin loader. No cloud task
was started and no plugin settings were changed.

This tests the actual host's discovery, CLI proxy, HTTP boundary and plugin
runtime. It does not claim to test the Git install pipeline or paid sandbox
provisioning. CI builds each plugin with production dependencies on bb 0.48.1,
0.49.0 and 0.50.1; both plugins also built locally on all three versions.
The same isolated real-host checks also passed on **bb 0.48.1** with both
plugins built by that host, covering the oldest supported version.

## Route 1: native aliases unavailable

The latest public SDK's `PluginCliRegistration` and `PluginCliSpec` still have
no top-level aliases. The host normalizes a single name and the strict `bb`
manifest schema declares no alias field. Relevant upstream sources:
[registration contract](https://github.com/get-bb/bb/blob/fab82665a3299fae8910f55d7519a3b034a03b9a/packages/plugin-sdk/src/backend-contract.ts),
[normalizer](https://github.com/get-bb/bb/blob/fab82665a3299fae8910f55d7519a3b034a03b9a/packages/plugin-sdk/src/internal/host-policy.ts),
[manifest](https://github.com/get-bb/bb/blob/fab82665a3299fae8910f55d7519a3b034a03b9a/packages/domain/src/plugin-manifest.ts).

A disposable probe plugin registered `alias-probe` with an extra
`aliases: ["native-harbor-probe"]` field, then caught the error from a second
top-level registration. On the real 0.50.1 host:

```text
$ bb alias-probe --help
{"duplicateError":"cli command is already registered"}
[exit 0]

$ bb native-harbor-probe --help
error: unknown command 'native-harbor-probe'
[exit 1]
```

The probe's alias did not appear in discovery. The probe was only a disposable
fixture; it is not shipped with either plugin.

## Route 2: companion plugin works

The real host reported these CLI contributions (selected fields):

```json
[
  { "pluginId": "boat", "name": "boat", "rendersHelp": true },
  { "pluginId": "harbor", "name": "harbor", "rendersHelp": true }
]
```

`node scripts/check-harbor-host.mjs` asserted byte-for-byte equality of stdout,
stderr and exit status for top-level help, nested help, a read-only listing
and a JSON parser error. Selected transcript follows; long help and error
usage lines are omitted here.

```text
$ bb --version
0.50.1
[exit 0]

$ bb harbor --help
bb boat — Harbormaster: coding agents across cloud sandbox providers, orchestrated from bb
[remaining help omitted; exit 0]

$ bb boat --help
bb boat — Harbormaster: coding agents across cloud sandbox providers, orchestrated from bb
[remaining help omitted; exit 0]

$ bb harbor task start --help
bb boat task start — Start a coding agent on a task in a boat sandbox
[remaining help omitted; exit 0]

$ bb boat task start --help
bb boat task start — Start a coding agent on a task in a boat sandbox
[remaining help omitted; exit 0]

$ bb harbor project list --json
{
  "projects": [],
  "local": []
}
[exit 0]

$ bb boat project list --json
{
  "projects": [],
  "local": []
}
[exit 0]

$ bb harbor task start --unknown-option --json
[JSON error code: unknown_option; message: unknown option '--unknown-option']
[same readable error on stderr; exit 1]

$ bb boat task start --unknown-option --json
[JSON error code: unknown_option; message: unknown option '--unknown-option']
[same readable error on stderr; exit 1]

PASS: both names return identical help, read-only results and parser errors.
```

Help intentionally keeps `bb boat`, as all output comes from the existing
handler. No user text or command results are rewritten. Unit tests using the
fake boat CLI additionally prove shared project state, XLarge approval
refusals, exact argv/context forwarding, cancellation, whitespace keepalives,
missing-plugin errors and no retries after a failed command.

The same script on the isolated bb 0.48.1 host finished with:

```text
$ bb --version
0.48.1
[exit 0]

PASS: both names return identical help, read-only results and parser errors.
```
