import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AVAILABILITY_SCRIPT,
  parseReading,
  refusal,
  availability,
} from "../src/providers/ownmac/probe.ts";

function probe(power: string, sudo = false, vm = false) {
  const bin = mkdtempSync(join(tmpdir(), "fake-ownmac-probe-"));
  const stub = `#!/bin/bash
case "${"$"}{0##*/}" in
(ioreg) printf '"IOPlatformUUID" = "fake-machine"\\n' ;;
(id) case "$1" in (-un) echo fake-agents ;; (-u) echo 502 ;; (-Gn) echo staff ;; (*) exit 1 ;; esac ;;
(sysctl) case "$2" in (kern.hv_vmm_present) echo "$FAKE_VM" ;; (hw.memsize) echo 17179869184 ;; (hw.ncpu) echo 8 ;; (vm.loadavg) echo '{ 0.5 0.5 0.5 }' ;; (*) exit 1 ;; esac ;;
(pmset) echo "Now drawing from '$FAKE_POWER'" ;;
(stat) echo fake-agents ;;
(pgrep) exit 1 ;;
(vm_stat) printf 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\\nPages free: 3000000.\\n' ;;
(sudo) test "$*" = '-n true' || exit 2; exit "$FAKE_SUDO_EXIT" ;;
esac
`;
  try {
    for (const command of [
      "ioreg",
      "id",
      "sysctl",
      "pmset",
      "stat",
      "pgrep",
      "vm_stat",
      "sudo",
    ])
      writeFileSync(join(bin, command), stub, { mode: 0o700 });
    return parseReading(
      execFileSync("/bin/bash", ["-c", AVAILABILITY_SCRIPT], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          FAKE_POWER: power,
          FAKE_SUDO_EXIT: sudo ? "0" : "1",
          FAKE_VM: vm ? "1" : "0",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}
for (const [power, expected] of [
  ["AC Power", "Available"],
  ["Battery Power", "On battery"],
  ["UPS Power", "On battery"],
])
  test(`read-only probe handles ${power}`, () => {
    assert.equal(
      availability(
        probe(power!),
        { hardware: null, user: "fake-owner", uid: 501 },
        0,
        1,
      ),
      expected,
    );
  });
test("unknown pmset output fails closed", () => {
  assert.throws(() => probe("fake unknown"));
});
test("passwordless sudo counts as admin, with the VM exception", () => {
  const physical = probe("AC Power", true),
    vm = probe("AC Power", true, true),
    local = { hardware: null, user: "fake-owner", uid: 501 };
  assert.equal(physical.admin, true);
  assert.match(refusal(physical, local)!, /admin user/);
  assert.equal(refusal(vm, local), null);
});
test("probe does not count CLI processes as running tasks", () => {
  assert.doesNotMatch(AVAILABILITY_SCRIPT, /running=|pgrep .* -f/);
});
