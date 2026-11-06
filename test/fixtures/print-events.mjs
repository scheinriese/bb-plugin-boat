#!/usr/bin/env node
// Prints recorded `boat events --json` output (shapes from a live probe).
import { readFileSync } from "node:fs";
process.stdout.write(readFileSync(new URL("./events.jsonl", import.meta.url), "utf8"));
