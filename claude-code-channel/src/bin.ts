#!/usr/bin/env node
/**
 * World2Agent Channel for Claude Code
 *
 * This is the unified entry point for all World2Agent sensors in Claude Code.
 * It dynamically loads sensors based on user configuration and runs them
 * with a shared MCP connection to Claude Code.
 *
 * Features:
 * - Detects sensors needing configuration (have SETUP.md but no handler skill)
 * - Waits for user confirmation before starting sensors
 * - Exposes start_sensors tool for Claude to call after setup
 * - Exposes reload_sensors tool to add/remove/update sensors mid-session
 *   without restarting Claude Code
 */

import { startSensor, FileSensorStore } from "@world2agent/sdk";
import type { CleanupFn, SensorSpec, SensorStore, W2ASignal } from "@world2agent/sdk";
import { packageToSkillId } from "@world2agent/sdk";
import { loadConfig, type SensorEntry } from "./config.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Helper Functions ───

function hasHandlerSkill(skillId: string): boolean {
  const projectSkillPath = join(process.cwd(), ".claude", "skills", skillId, "SKILL.md");
  const globalSkillPath = join(homedir(), ".claude", "skills", skillId, "SKILL.md");

  const projectExists = existsSync(projectSkillPath);
  const globalExists = existsSync(globalSkillPath);
  const exists = projectExists || globalExists;

  console.error(`[world2agent] hasHandlerSkill(${skillId}): project=${projectExists}, global=${globalExists}`);
  return exists;
}

function findSetupFile(packageName: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    let packagePath: string;

    if (packageName.startsWith(".") || packageName.startsWith("/")) {
      const { resolve } = require("node:path");
      packagePath = dirname(resolve(process.cwd(), packageName));
    } else {
      const mainPath = require.resolve(packageName);
      packagePath = dirname(mainPath);
      if (packagePath.endsWith("/dist") || packagePath.endsWith("\\dist")) {
        packagePath = dirname(packagePath);
      }
    }

    const setupPath = join(packagePath, "SETUP.md");
    const exists = existsSync(setupPath);
    console.error(`[world2agent] findSetupFile(${packageName}): ${setupPath} -> ${exists}`);
    return exists ? setupPath : null;
  } catch (err) {
    console.error(`[world2agent] findSetupFile(${packageName}): error`, err);
    return null;
  }
}

interface SensorSetupInfo {
  skillId: string;
  packageName: string;
  setupPath: string;
}

function findSensorsNeedingSetup(packages: string[]): SensorSetupInfo[] {
  const needsSetup: SensorSetupInfo[] = [];

  for (const pkg of packages) {
    const skillId = packageToSkillId(pkg);
    if (hasHandlerSkill(skillId)) continue;

    const setupPath = findSetupFile(pkg);
    if (setupPath) {
      needsSetup.push({ skillId, packageName: pkg, setupPath });
    }
  }

  return needsSetup;
}

async function importSensorSpec(packageName: string): Promise<SensorSpec | null> {
  let module;
  try {
    if (packageName.startsWith(".") || packageName.startsWith("/")) {
      const { pathToFileURL } = await import("node:url");
      const { resolve } = await import("node:path");
      const absPath = resolve(process.cwd(), packageName);
      module = await import(pathToFileURL(absPath).href);
    } else {
      module = await import(packageName);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isNotFound = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(msg);
    if (isNotFound) {
      console.error(
        `[world2agent]     ERROR: package "${packageName}" is not installed.\n` +
        `       Fix: npm install -g ${packageName}\n` +
        `       Or add it to this plugin: npm install ${packageName} --prefix "$CLAUDE_PLUGIN_ROOT"`,
      );
    } else {
      console.error(`[world2agent]     ERROR: Failed to import ${packageName}: ${msg}`);
    }
    return null;
  }

  const spec: SensorSpec = module.default;
  if (!spec || typeof spec.start !== "function") {
    console.error(`[world2agent]     ERROR: ${packageName} does not export a valid SensorSpec`);
    return null;
  }

  return spec;
}

/** Deterministic JSON serialization so we can detect sensor config changes across reloads. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value as object).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

// ─── Main ───

async function main() {
  console.error("[world2agent] Starting World2Agent channel for Claude Code...");

  const bootConfig = loadConfig();
  const noSensorsConfigured = bootConfig.sensors.length === 0;

  if (noSensorsConfigured) {
    console.error("[world2agent] No sensors configured. Will stay idle and wait for user to add sensors.");
  }

  const bootEnabled = bootConfig.sensors.filter((s) => s.enabled !== false);
  const sensorsNeedingSetup = findSensorsNeedingSetup(bootEnabled.map((s) => s.package));
  const needsSetup = sensorsNeedingSetup.length > 0;

  // Build instructions — kept minimal. Per-sensor handler logic lives in
  // ~/.claude/skills/<skill_id>/SKILL.md and is loaded on demand by Claude
  // Code's native skill router, triggered by the `Use skill: <id>` directive
  // injected into every signal notification (see transport() below).
  const channelName = bootConfig.name ?? "world2agent";
  let instructions = bootConfig.instructions ?? "";

  if (instructions) instructions += "\n\n";
  instructions +=
    "# World2Agent channel protocol\n\n" +
    "You will receive signals via `notifications/claude/channel`. " +
    "Every signal's `content` begins with `Use skill: <skill_id>` — " +
    "load that skill from `.claude/skills/<skill_id>/SKILL.md` (project) " +
    "or `~/.claude/skills/<skill_id>/SKILL.md` (global) and apply it to the rest of the message.\n";

  if (noSensorsConfigured) {
    instructions += "\n# No sensors configured\n\n";
    instructions += "The world2agent plugin is loaded but no sensors are configured. ";
    instructions += "Run `/world2agent:sensor-add <name>` (e.g. `hackernews`, `futu`, `x`) to add your first sensor, ";
    instructions += "then call the `reload_sensors` MCP tool to pick it up without restarting the session.\n";
  }

  if (needsSetup) {
    instructions += "\n# Sensors pending configuration\n\n";
    instructions += "These sensors are installed but missing handler skills:\n\n";
    for (const s of sensorsNeedingSetup) {
      instructions += `- **${s.skillId}**: SETUP.md at \`${s.setupPath}\`\n`;
    }
    instructions += "\nSensors are NOT running yet. Ask the user if they want to configure them now.\n\n";
    instructions += "- If yes: read the SETUP.md, run its interactive Q&A, write the handler skill to `.claude/skills/<skill_id>/SKILL.md` (project-level), then call the `start_sensors` tool.\n";
    instructions += "- If skip: call `start_sensors` directly — signals will still arrive and the channel self-describe protocol above tells you what to do.\n";
  }

  instructions +=
    "\n# Mutating sensors mid-session\n\n" +
    "After `/world2agent:sensor-add`, `/world2agent:sensor-remove`, or editing `~/.world2agent/config.json`, " +
    "call the `reload_sensors` tool. It re-reads the config file and diffs it against what's running: " +
    "new sensors start, removed sensors stop, config-changed sensors restart. No session restart needed.\n";

  // Shared, file-backed state store so dedup sets and sync tokens survive
  // session restarts. Keys are auto-scoped by sensor id inside startSensor().
  // Path is ~/.world2agent/state.json — sits alongside config.json.
  const sharedStore: SensorStore = new FileSensorStore();

  const mcp = new Server(
    { name: channelName, version: "0.1.0-alpha.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: instructions || undefined,
    },
  );

  // TEMP: gate all outgoing notifications for 30s after startup. Claude Code's
  // client needs a grace period to finish its own init before it reliably
  // routes `notifications/claude/channel` to the model; signals that arrive
  // too early get dropped. Remove once the client stabilizes early delivery.
  const NOTIFICATION_GATE_MS = 30_000;
  const notificationGate = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.error(`[world2agent] notification gate opened (${NOTIFICATION_GATE_MS}ms elapsed)`);
      resolve();
    }, NOTIFICATION_GATE_MS),
  );
  let gateOpen = false;
  notificationGate.then(() => {
    gateOpen = true;
  });
  const sendNotification = async (
    params: Parameters<typeof mcp.notification>[0],
  ): Promise<void> => {
    if (!gateOpen) {
      console.error(`[world2agent] notification queued behind 30s gate: ${params.method}`);
      await notificationGate;
    }
    await mcp.notification(params);
  };

  // Transport closure: every emit from every sensor flows through here.
  const transport = async (signal: W2ASignal): Promise<void> => {
    const skillId = packageToSkillId(signal.source.package);

    let body = `[W2A Signal pkg=${signal.source.package}] ${signal.event.type}\n\n${signal.event.summary}`;
    if (signal.attachments && signal.attachments.length > 0) {
      const payloadDesc = signal.attachments
        .map((p) => `[${p.mime_type}] ${p.description}`)
        .join("\n");
      body += `\n\nAttachments:\n${payloadDesc}`;
    }

    const content = `Use skill: ${skillId}\n\n${body}`;

    const meta: Record<string, string> = {
      event_type: signal.event.type,
      signal_id: signal.signal_id,
      package: signal.source.package,
      skill_id: skillId,
    };
    if (signal.source.source_type) {
      meta.source_type = signal.source.source_type;
    }
    if (signal.source.user_identity) {
      meta.user_identity = signal.source.user_identity;
    }

    // TEMP: routed through sendNotification so signals are held until the
    // 30s startup gate opens (see NOTIFICATION_GATE_MS above).
    await sendNotification({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  };

  // Per-sensor lifecycle state. Key: npm package name. Value: active cleanup
  // fn + hash of the config we started it with (so we can detect updates).
  const handles = new Map<string, { cleanup: CleanupFn; configHash: string }>();

  // Start one sensor by package name. Returns null on failure (package not
  // installed, bad export, or spec.start() throws) so the caller can decide
  // how to surface the error.
  const startOne = async (sensor: SensorEntry): Promise<CleanupFn | null> => {
    const spec = await importSensorSpec(sensor.package);
    if (!spec) return null;
    try {
      return await startSensor(spec, {
        config: sensor.config,
        onSignal: transport,
        store: sharedStore,
      });
    } catch (err) {
      console.error(`[world2agent] startSensor(${sensor.package}) failed:`, err);
      return null;
    }
  };

  interface DiffResult {
    started: string[];
    restarted: string[];
    stopped: string[];
    failed: string[];
    skipped: { package: string; reason: string }[];
  }

  // Diff the target sensor set against what's running and converge. Used by
  // both the initial boot and reload_sensors, so the two paths stay in sync.
  const applyConfig = async (
    targetSensors: SensorEntry[],
    opts: { gateOnHandlerSkill: boolean },
  ): Promise<DiffResult> => {
    const result: DiffResult = { started: [], restarted: [], stopped: [], failed: [], skipped: [] };

    const enabled = targetSensors.filter((s) => s.enabled !== false);
    const targetPackages = new Set(enabled.map((s) => s.package));

    // Stop sensors that disappeared from config (or got disabled).
    for (const [pkg, handle] of handles) {
      if (targetPackages.has(pkg)) continue;
      try {
        await handle.cleanup();
      } catch (err) {
        console.error(`[world2agent] cleanup(${pkg}) error:`, err);
      }
      handles.delete(pkg);
      result.stopped.push(pkg);
    }

    // Start or restart each target.
    for (const sensor of enabled) {
      const skillId = packageToSkillId(sensor.package);

      // When gating, skip sensors that have SETUP.md but no handler skill yet —
      // their signals would arrive with `Use skill: X` pointing at a missing
      // skill. The user has to finish /world2agent:sensor-add first.
      if (opts.gateOnHandlerSkill) {
        const setupPath = findSetupFile(sensor.package);
        if (setupPath && !hasHandlerSkill(skillId)) {
          if (!handles.has(sensor.package)) {
            result.skipped.push({
              package: sensor.package,
              reason: "handler skill missing — finish /world2agent:sensor-add",
            });
          }
          continue;
        }
      }

      const newHash = stableStringify(sensor.config ?? {});
      const existing = handles.get(sensor.package);

      if (existing) {
        if (existing.configHash === newHash) continue; // already running with same config
        // Config changed: stop the old instance, then start a fresh one.
        try {
          await existing.cleanup();
        } catch (err) {
          console.error(`[world2agent] cleanup(${sensor.package}) error:`, err);
        }
        handles.delete(sensor.package);

        const cleanup = await startOne(sensor);
        if (cleanup) {
          handles.set(sensor.package, { cleanup, configHash: newHash });
          result.restarted.push(sensor.package);
        } else {
          result.failed.push(sensor.package);
        }
      } else {
        const cleanup = await startOne(sensor);
        if (cleanup) {
          handles.set(sensor.package, { cleanup, configHash: newHash });
          result.started.push(sensor.package);
        } else {
          result.failed.push(sensor.package);
        }
      }
    }

    return result;
  };

  const summarizeDiff = (d: DiffResult): string => {
    const parts: string[] = [];
    if (d.started.length > 0) parts.push(`Started: ${d.started.join(", ")}.`);
    if (d.restarted.length > 0) parts.push(`Restarted (config changed): ${d.restarted.join(", ")}.`);
    if (d.stopped.length > 0) parts.push(`Stopped (removed from config): ${d.stopped.join(", ")}.`);
    if (d.skipped.length > 0) {
      parts.push(
        "Skipped: " +
          d.skipped.map((s) => `${s.package} (${s.reason})`).join(", ") +
          ".",
      );
    }
    if (d.failed.length > 0) parts.push(`Failed to load: ${d.failed.join(", ")}. See stderr for details.`);
    if (parts.length === 0) return "No changes. Sensor set is up to date.";
    return parts.join(" ");
  };

  // Tool handlers ────
  //
  // start_sensors: user confirmed after the pending-setup prompt. Kick off the
  // initial batch, ignoring the handler-skill gate (the user has decided to
  // proceed even if skills aren't written yet).
  //
  // reload_sensors: re-read config and converge. Gates new sensors on handler
  // skills so /world2agent:sensor-add can't half-enroll a sensor.

  let initialStartDone = !needsSetup; // boot branch below starts initial batch directly when no setup needed

  const startSensorsTool = async (): Promise<string> => {
    if (initialStartDone) {
      // Treat subsequent calls as a reload with gating OFF (caller already said "just run it").
      const diff = await applyConfig(loadConfig().sensors, { gateOnHandlerSkill: false });
      return summarizeDiff(diff);
    }
    initialStartDone = true;
    const diff = await applyConfig(bootEnabled, { gateOnHandlerSkill: false });
    return summarizeDiff(diff);
  };

  const reloadSensorsTool = async (): Promise<string> => {
    console.error("[world2agent] reload_sensors: re-reading config...");
    const fresh = loadConfig();
    const diff = await applyConfig(fresh.sensors, { gateOnHandlerSkill: true });
    return summarizeDiff(diff);
  };

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(needsSetup
        ? [{
            name: "start_sensors",
            description:
              "Start the signal sensors. Call this after the user has configured their preferences, or if they choose to skip configuration.",
            inputSchema: {
              type: "object" as const,
              properties: {},
              required: [],
            },
          }]
        : []),
      {
        name: "reload_sensors",
        description:
          "Re-read ~/.world2agent/config.json and converge the running sensor set: start newly-added sensors, stop removed sensors, restart sensors whose config changed. Call this after /world2agent:sensor-add, /world2agent:sensor-remove, or any hand-edit of the config file.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "start_sensors") {
      const result = await startSensorsTool();
      return { content: [{ type: "text" as const, text: result }] };
    }
    if (req.params.name === "reload_sensors") {
      const result = await reloadSensorsTool();
      return { content: [{ type: "text" as const, text: result }] };
    }
    throw new Error(`Unknown tool: ${req.params.name}`);
  });

  // Single top-level signal handler that tears down every running sensor
  // exactly once. Replaces the per-runAll-call SIGINT handlers that the old
  // implementation stacked up on every reload.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[world2agent] Shutting down ${handles.size} sensor(s)...`);
    await Promise.allSettled(Array.from(handles.values()).map((h) => h.cleanup()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(`[world2agent] Connecting to Claude Code...`);
  await mcp.connect(new StdioServerTransport());
  console.error(`[world2agent] Connected.`);

  // Small delay to ensure connection is fully established before sending first notification
  await new Promise((r) => setTimeout(r, 500));

  // TEMP: all boot-time notifications below go through sendNotification so
  // they respect the 30s startup gate. Sensor startup itself is NOT gated —
  // we want sensors collecting and deduping in the background during the wait.
  if (noSensorsConfigured) {
    console.error(`[world2agent] Sending onboarding notification.`);
    await sendNotification({
      method: "notifications/claude/channel",
      params: {
        content:
          "World2Agent plugin installed, but no sensors are configured yet. Run `/world2agent:sensor-add <name>` to add your first one (e.g. hackernews), then call the `reload_sensors` tool to pick it up without a session restart.",
        meta: {
          event_type: "system.world2agent.onboarding",
          reason: "no_sensors",
        },
      },
    });
  } else if (needsSetup) {
    console.error(`[world2agent] Waiting for start_sensors tool call...`);
    const sensorList = sensorsNeedingSetup.map((s) => s.skillId).join(", ");
    console.error(`[world2agent] Sending setup prompt notification for: ${sensorList}`);
    await sendNotification({
      method: "notifications/claude/channel",
      params: {
        content: `World2Agent sensors detected: ${sensorList}. These sensors are not yet configured. Would you like to set them up now?`,
        meta: {
          event_type: "system.sensors.pending_setup",
          sensors: sensorList,
        },
      },
    });
  } else {
    console.error(`[world2agent] Starting ${bootEnabled.length} sensor(s)...`);
    const diff = await applyConfig(bootEnabled, { gateOnHandlerSkill: false });
    console.error(`[world2agent] ${summarizeDiff(diff)}`);
    if (diff.failed.length > 0 && handles.size === 0) {
      // All configured sensors failed to load (likely missing npm packages).
      // Drop the user into the onboarding-ish flow so they can fix it.
      await sendNotification({
        method: "notifications/claude/channel",
        params: {
          content:
            "World2Agent plugin loaded, but all configured sensors failed to start (likely missing npm packages). " +
            "Run `/world2agent:sensor-add <name>` to (re)install, or check package names in ~/.world2agent/config.json, then call `reload_sensors`.",
          meta: {
            event_type: "system.world2agent.onboarding",
            reason: "all_failed",
          },
        },
      });
    }
  }

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[world2agent] Fatal error:", err);
  process.exit(1);
});
