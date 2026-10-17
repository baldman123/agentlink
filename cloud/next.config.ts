import path from "node:path";
import type { NextConfig } from "next";

// cloud/ imports ../contracts and ../ui/src (with .ts extensions), so the build root is the repo root:
// that keeps one React (hoisted to <repo>/node_modules by the npm workspace) for cloud and ui/src alike.
const repoRoot = path.resolve(import.meta.dirname, "..");

const config: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  experimental: { externalDir: true },
  poweredByHeader: false,
};

export default config;
