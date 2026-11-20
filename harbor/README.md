# Harbormaster CLI companion

Adds `bb harbor` by forwarding to the main Harbormaster plugin's `bb boat`
handler on the same bb server. Requires the main plugin to be installed and
enabled. There are no settings, runtime dependencies or separate task data.

```sh
bb plugin install https://github.com/scheinriese/bb-plugin-boat
bb plugin install git:https://github.com/scheinriese/bb-plugin-boat --subdirectory harbor
bb harbor --help
bb harbor project list --json
```

Keep both plugins updated. `bb boat` keeps working with the main plugin alone;
Its help and usage errors use `bb harbor`; JSON and command data pass through
unchanged. `bb harbormaster` is not registered. You can remove this companion
without removing the main plugin or its task data.

If another plugin owns the short name, use `bb plugin run harbor …`, for
example `bb plugin run harbor --help`. This always targets the companion by id.

From a local checkout, `npm run build` builds both plugins. After both are
installed, `node scripts/check-harbor-host.mjs` at the repository root checks
help, a read-only command and parser errors through both command names.
On an isolated host with `test/fixtures/harbor-collision` also present, add
`--collision` to verify that the fixture owns the short name while the
explicit form still reaches the companion.
