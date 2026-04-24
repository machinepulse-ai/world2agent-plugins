#!/usr/bin/env node
// Bundle src/bin.ts into a single self-contained ESM file.
// - All npm dependencies (mcp-sdk, scp-sdk, zod, etc.) inlined
// - Sensor packages kept external → resolved at runtime from plugin's node_modules
import { build } from "esbuild";

await build({
  entryPoints: ["src/bin.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/bin.bundle.mjs",
  // createRequire shim for any CJS interop inside the bundle
  banner: {
    js: "import { createRequire as __wrapCreateRequire } from 'node:module'; const require = __wrapCreateRequire(import.meta.url);",
  },
  external: ["@world2agent/sensor-*"],
  logLevel: "info",
});

console.log("✓ bundled → dist/bin.bundle.mjs");
