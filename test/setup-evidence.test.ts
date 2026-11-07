import assert from "node:assert/strict";
import {test} from "node:test";
import {setupEvidence,setupDuration} from "../web/setup-evidence.ts";

test("setup receipts require actual marked observations and preserve partial progress",()=>{
  assert.deepEqual(setupEvidence(["Node22 works and GitHub should work"]),{os:null,node:null,git:null,github:null});
  assert.deepEqual(setupEvidence(["=== SETUP CHECK ===\nOS: Ubuntu 24.04\nNODE: v22.11.0\n=== END SETUP CHECK ===","=== SETUP CHECK ===\nGIT: 2.47.0\nGITHUB: failed\n=== END SETUP CHECK ==="]),{os:"Ubuntu 24.04",node:"22.11.0",git:"2.47.0",github:"failed"});
  assert.equal(setupEvidence(["=== SETUP CHECK ===\nNODE: v22.11.0\nGIT: probably installed\nGITHUB: expected\n=== END SETUP CHECK ==="]).github,null);
  assert.equal(setupEvidence(["=== SETUP CHECK ===\nGITHUB: failed\n=== END SETUP CHECK ===","=== SETUP CHECK ===\nGITHUB: ok\n=== END SETUP CHECK ==="]).github,"ok");
});

test("setup duration uses completion time after a run ends",()=>{
  assert.equal(setupDuration("2026-11-07T19:00:00Z","2026-11-07T19:01:12Z",Date.parse("2026-11-07T20:00:00Z")),"1 min 12 s");
  assert.equal(setupDuration("invalid",null,Date.now()),null);
});
