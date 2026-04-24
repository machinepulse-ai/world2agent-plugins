# Contributing

Thanks for helping improve the World2Agent Claude Code marketplace. This document covers repository conventions. Protocol-level changes (signal schema, authoring guidelines) belong in the [`world2agent`](https://github.com/machinepulse-ai/world2agent) repository; SDK changes belong in the `@world2agent/sdk` package.

## Repository layout

- `.claude-plugin/marketplace.json` — the marketplace catalog Claude Code reads.
- `claude-code-channel/` — the `world2agent` plugin (MCP channel adapter + slash commands + handler skills).

Each plugin in this repo is distributed two ways: bundled inside the marketplace (via `/plugin install`) and as a standalone npm package.

## Dev setup

```bash
cd claude-code-channel
npm install
npm run build
```

`npm run build` runs `tsc` (type-check + emit `dist/*.js`) then `node build.mjs` (esbuild → `dist/bin.bundle.mjs`, which is what Claude Code actually executes via `.mcp.json`).

To try the plugin locally against a Claude Code session, point a local marketplace at the working tree:

```
/plugin marketplace add /absolute/path/to/world2agent-plugins
/plugin install world2agent@world2agent-plugins
```

## Version bumping

Every user-visible release requires **both** version fields to match:

- `claude-code-channel/package.json` → `"version"`
- `claude-code-channel/.claude-plugin/plugin.json` → `"version"`

Claude Code reads `plugin.json` to decide whether to refresh the plugin; npm reads `package.json`. If they drift, `/plugin update` and `npm install` disagree about what version the user is on. CI fails the PR when the two don't match.

Follow semver:

- **major** — breaking change to `config.json`, the MCP tool surface, or the slash-command contract.
- **minor** — new sensor-facing feature, new slash command, new configuration knob.
- **patch** — bugfixes, doc-only changes, internal refactors.

## Shipping the build output

`claude-code-channel/dist/` **is** checked in, intentionally. Claude Code installs plugins by cloning this repo and runs the committed bundle directly, so `dist/bin.bundle.mjs` has to be present on `main`. When your PR touches `src/`, `build.mjs`, `tsconfig.json`, or `.mcp.json`, run `npm run build` and commit the regenerated `dist/` in the same PR. CI re-runs the build and rejects PRs whose committed `dist/` is stale.

Do **not** commit `*.tsbuildinfo` — it's a TypeScript incremental-build cache and is gitignored.

## Adding a new plugin to the marketplace

1. Create a new directory at the repo root (sibling of `claude-code-channel/`).
2. Inside it, add at minimum: `.claude-plugin/plugin.json`, a `package.json` with `"license": "Apache-2.0"`, and a `README.md`.
3. Append an entry to `plugins[]` in `.claude-plugin/marketplace.json`.
4. Open a PR describing what the plugin does and why it belongs in this marketplace.

## Authoring sensors

Sensors are separate npm packages, **not** part of this repo. See `@world2agent/sdk` and the sensor-authoring skill in the protocol repository.

## Code style

- TypeScript strict mode (enforced by `tsconfig.json`).
- ESM only — no CJS in new code.
- Keep the MCP server boot path simple. New logic should come with a test or a short comment explaining the why.

## Licensing

By contributing, you agree that your contributions will be licensed under the Apache License 2.0 (see [`LICENSE`](./LICENSE)). Do not submit code that you do not have the right to license this way.
