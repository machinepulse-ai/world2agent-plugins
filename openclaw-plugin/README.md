# @world2agent/openclaw-plugin

Native OpenClaw plugin for running World2Agent sensors and dispatching their signals into embedded OpenClaw agent turns.

The default path is in-process: enabled sensors are imported directly inside the plugin process and each signal is sent to `api.runtime.agent.runEmbeddedAgent(...)`. `isolated: true` is opt-in and reuses the Hermes bridge runner/supervisor patterns for subprocess execution plus plugin-local HTTP ingest.

## Install

1. Set the required OpenClaw agent config first:

   ```yaml
   agents:
     defaults:
       contextInjection: continuation-skip
   ```

2. Install dependencies and build this package:

   ```bash
   cd world2agent-plugins/openclaw-plugin
   pnpm install
   pnpm build
   ```

3. Add the plugin package to your OpenClaw plugin search/install path and enable `@world2agent/openclaw-plugin`.

4. Use the registered CLI:

   ```bash
   openclaw world2agent sensor list
   openclaw world2agent sensor add @world2agent/sensor-hackernews --config-file ./hackernews.json
   ```

## Scope

- Reads and writes the W2A sensor manifest at `~/.world2agent/sensors.json` by default.
- Runs sensors in-process unless a sensor entry sets `isolated: true`.
- Reuses the Hermes runner/supervisor patterns instead of inventing a second isolation protocol.
- Uses a stable per-sensor embedded-agent session id: `w2a:<sensor_id>`.
- Requires plugin config `ingestUrl` only when `isolated: true` sensors are used.

## ContextInjection Prerequisite

This plugin refuses to start unless `agents.defaults.contextInjection` is exactly `"continuation-skip"`.

That check also runs before `openclaw world2agent sensor add`. There is no warning mode, no fallback mode, and no override flag. The design requires a hard failure because OpenClaw's default `"always"` setting would re-inject bootstrap on every sensor signal and silently turn high-frequency sensors into a token sink.

## Relation To `hermes-sensor-bridge`

`hermes-sensor-bridge` solved the same World2Agent runtime problem for Hermes with webhook subscriptions plus supervised subprocesses. This package keeps the same manifest shape and reuses the runner/supervisor mechanics for `isolated: true`, but the primary OpenClaw path is simpler: native plugin registration plus `runEmbeddedAgent(...)`.

## Known M0 Spike

`api.runtime.agent.runEmbeddedAgent(...)` from a third-party external plugin remains a live-install verification point. This package guards it defensively and throws a clear error if the runtime helper is absent, but a real OpenClaw install still has to confirm the end-to-end external-plugin path.
