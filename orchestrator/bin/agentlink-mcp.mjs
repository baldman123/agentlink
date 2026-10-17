#!/usr/bin/env node
// Runs the MCP stdio server (src/mcp.ts) through tsx.
import { register } from "tsx/esm/api";
register();
await import(new URL("../src/mcp.ts", import.meta.url).href);
