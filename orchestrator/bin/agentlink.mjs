#!/usr/bin/env node
// Runs src/cli.ts through tsx so `agentlink` works as an installed bin.
import { register } from "tsx/esm/api";
register();
await import(new URL("../src/cli.ts", import.meta.url).href);
