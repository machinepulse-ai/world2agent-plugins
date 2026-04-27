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
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
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

  // Persistent log of channel-side events. Lives at ~/.world2agent/channel.log
  // so the boot trace and lifecycle are inspectable without re-instrumenting
  // the bundle. Writes are best-effort — if the directory is unavailable,
  // stderr (which Claude Code captures) carries the same lines.
  const channelLogPath = join(homedir(), ".world2agent", "channel.log");
  const log = (msg: string): void => {
    const line = `[${new Date().toISOString()}] [world2agent] ${msg}`;
    console.error(line);
    try {
      appendFileSync(channelLogPath, line + "\n");
    } catch {
      try {
        mkdirSync(dirname(channelLogPath), { recursive: true });
        appendFileSync(channelLogPath, line + "\n");
      } catch {
        /* give up — stderr is enough */
      }
    }
  };

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

  // Gate outgoing notifications until the client has sent
  // `notifications/initialized` (MCP handshake completion). Notifications
  // emitted before that point queue here and flush as soon as the client
  // signals it is ready to receive them.
  let gateOpen = false;
  let openGate: () => void = () => {};
  const notificationGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  notificationGate.then(() => {
    gateOpen = true;
  });

  // Channel-readiness gate: confirms that the client side delivers
  // `notifications/claude/channel` before any sensor starts polling.
  // Sensor startup writes seen-id state to ~/.world2agent/state.json,
  // which must only accumulate while the client is actively consuming
  // signals — that way every channel-enabled session sees a fresh
  // batch of signals from the moment it opens.
  //
  // Detection is end-to-end: at boot we send one channel notification
  // asking Claude to call the `confirm_channel_received` tool. The ack
  // is the proof that channel notifications are flowing. We allow up
  // to 30 seconds for the ack; absent that, sensors stay offline for
  // this session and the next launch starts clean.
  let channelEnabled: boolean | null = null;
  let resolveChannelReady: (value: boolean) => void = () => {};
  const channelReady = new Promise<boolean>((resolve) => {
    resolveChannelReady = resolve;
  });
  channelReady.then((v) => {
    channelEnabled = v;
  });

  mcp.oninitialized = () => {
    log("Client initialized");
    openGate();
  };
  const sendNotification = async (
    params: Parameters<typeof mcp.notification>[0],
  ): Promise<void> => {
    if (!gateOpen) {
      await notificationGate;
    }
    await mcp.notification(params);
  };

  // Transport closure: every emit from every sensor flows through here.
  // The body is what Claude Code surfaces to the model, so it must carry
  // everything the handler skill needs to act — `meta` is for client-side
  // routing, not guaranteed to reach the model.
  const transport = async (signal: W2ASignal): Promise<void> => {
    const skillId = packageToSkillId(signal.source.package);

    const headerBits = [`pkg=${signal.source.package}`];
    if (signal.source.source_type) headerBits.push(`source=${signal.source.source_type}`);
    if (signal.source.user_identity && signal.source.user_identity !== "unknown") {
      headerBits.push(`user=${signal.source.user_identity}`);
    }
    let body = `[W2A Signal ${headerBits.join(" ")}] ${signal.event.type}\n\n${signal.event.summary}`;

    if (signal.source_event) {
      body += `\n\nSource event data:\n\`\`\`json\n${JSON.stringify(signal.source_event.data, null, 2)}\n\`\`\``;
    }

    if (signal.attachments && signal.attachments.length > 0) {
      body += "\n\nAttachments:";
      for (const a of signal.attachments) {
        body += `\n- [${a.mime_type}] ${a.description}`;
        if (a.type === "inline") {
          const indented = a.data.split("\n").join("\n  ");
          body += `\n  ${indented}`;
        } else {
          body += `\n  uri: ${a.uri}`;
        }
      }
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

      // When gating is on, defer sensors that ship a SETUP.md until their
      // handler skill exists. /world2agent:sensor-add writes that skill, and
      // once it's in place the sensor goes live on the next reload.
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
  // skills so a sensor only goes live once /world2agent:sensor-add has
  // finished writing its skill.

  let initialStartDone = !needsSetup; // boot branch below starts initial batch directly when no setup needed

  const channelDisabledMessage = (): string =>
    "Channel notifications are not flowing in this Claude Code session " +
    "(the boot handshake was never acknowledged), so sensors were NOT " +
    "started. Polling now would write seen-id state to " +
    "~/.world2agent/state.json and pollute the dedup cache — when you next " +
    "launch Claude Code with `--dangerously-load-development-channels " +
    "plugin:world2agent@world2agent-plugins`, the sensor would silently " +
    "swallow the first real batch of signals.\n\n" +
    "What to do: exit this session and relaunch Claude Code with that flag. " +
    "Sensor config in ~/.world2agent/config.json is already saved; no need " +
    "to re-run /world2agent:sensor-add.\n\n" +
    "See ~/.world2agent/channel.log for the boot trace.";

  // Called by Claude when the client receives the boot handshake notification.
  // This is the ONE reliable end-to-end signal that channel notifications are
  // actually being delivered: the only way Claude sees the prompt to call
  // this tool is if the message arrived.
  const confirmChannelReceivedTool = async (): Promise<string> => {
    if (channelEnabled === true) {
      return "Channel handshake already confirmed — no action needed.";
    }
    if (channelEnabled === false) {
      return "Channel was previously marked disabled (handshake timed out). Restart Claude Code to retry.";
    }
    log("Channel handshake ack received — channel notifications are flowing.");
    resolveChannelReady(true);
    return "Channel handshake confirmed. Proceeding with sensor startup.";
  };

  const startSensorsTool = async (): Promise<string> => {
    if (!(await channelReady)) return channelDisabledMessage();
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
    if (!(await channelReady)) return channelDisabledMessage();
    log("reload_sensors: re-reading config...");
    const fresh = loadConfig();
    const diff = await applyConfig(fresh.sensors, { gateOnHandlerSkill: true });
    return summarizeDiff(diff);
  };

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "confirm_channel_received",
        description:
          "Acknowledge that this Claude Code session is receiving World2Agent channel notifications. Call this IMMEDIATELY when you see a channel message asking you to do so — sensors will not start until you do.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
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
    if (req.params.name === "confirm_channel_received") {
      const result = await confirmChannelReceivedTool();
      return { content: [{ type: "text" as const, text: result }] };
    }
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
  // exactly once across the whole channel lifetime.
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

  // Parent (Claude Code) closing stdio is our cue to exit cleanly. This
  // keeps the channel process bound to its parent's lifetime so the next
  // MCP child owns ~/.world2agent/state.json without contention.
  process.stdin.on("end", () => {
    console.error("[world2agent] stdin ended — shutting down");
    void shutdown();
  });
  process.stdin.on("close", () => {
    console.error("[world2agent] stdin closed — shutting down");
    void shutdown();
  });
  process.stdin.on("error", (err) => {
    console.error("[world2agent] stdin error — shutting down:", err);
    void shutdown();
  });

  log(`Connecting to Claude Code...`);
  await mcp.connect(new StdioServerTransport());
  log(`Connected. Sending channel handshake (will queue until client init)...`);

  // End-to-end channel detection: send one channel notification asking
  // Claude to call `confirm_channel_received`. A live channel produces
  // an ack within a few seconds; a 30s deadline backs that up so the
  // session settles into a definite ready/offline state. `sendNotification`
  // already queues until the MCP init handshake completes.
  //
  // The 5-second delay lets Claude Code finish wiring up its channel
  // listener after MCP init. Notifications fired ≥100ms post-init are
  // reliably consumed; five seconds keeps us comfortably inside that
  // window.
  if (channelEnabled === null) {
    const HANDSHAKE_DELAY_MS = 5000;
    setTimeout(() => {
      log(`Firing handshake notification (${HANDSHAKE_DELAY_MS}ms post-connect)...`);
      void sendNotification({
        method: "notifications/claude/channel",
        params: {
          content:
            "World2Agent channel handshake.\n\n" +
            "If you are reading this message, channel notifications are " +
            "flowing in this Claude Code session. Please IMMEDIATELY call the " +
            "`confirm_channel_received` tool with no arguments — World2Agent " +
            "sensors will not start polling until you do.\n\n" +
            "Don't reply to the user about this message; just call the tool. " +
            "After acknowledgment, normal sensor signals will follow as usual.",
          meta: {
            event_type: "system.world2agent.handshake",
            reason: "boot_handshake",
          },
        },
      }).catch((err) => log(`Handshake notify error: ${err}`));
    }, HANDSHAKE_DELAY_MS);

    const HANDSHAKE_TIMEOUT_MS = 30000;
    setTimeout(() => {
      if (channelEnabled === null) {
        log(
          `Channel handshake not acknowledged within ${HANDSHAKE_TIMEOUT_MS}ms — ` +
            "treating as disabled.",
        );
        resolveChannelReady(false);
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  // Block boot-time sensor startup until handshake is acked or times out.
  const clientChannelEnabled = await channelReady;

  if (!clientChannelEnabled) {
    log(
      "Channel disabled (handshake not acknowledged). Skipping sensor " +
        "startup to avoid polluting ~/.world2agent/state.json. Tools " +
        "(start_sensors / reload_sensors) will return a help message if " +
        "called. To enable, relaunch Claude Code with " +
        "`--dangerously-load-development-channels plugin:world2agent@world2agent-plugins`.",
    );
  } else if (noSensorsConfigured) {
    // Boot-time notifications go through sendNotification so they queue on
    // the init gate (see oninitialized above) and deliver as soon as the
    // client is ready.
    log(`Sending onboarding notification.`);
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
    log(`Waiting for start_sensors tool call...`);
    const sensorList = sensorsNeedingSetup.map((s) => s.skillId).join(", ");
    log(`Sending setup prompt notification for: ${sensorList}`);
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
    log(`Starting ${bootEnabled.length} sensor(s)...`);
    const diff = await applyConfig(bootEnabled, { gateOnHandlerSkill: false });
    log(summarizeDiff(diff));
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
    } else if (diff.started.length > 0) {
      // Friendly post-handshake confirmation: tell the user the channel is
      // up and which sensors are being watched. Fires once per boot.
      const running = diff.started.join(", ");
      log(`Sending ready notification.`);
      await sendNotification({
        method: "notifications/claude/channel",
        params: {
          content:
            `World2Agent is now active and listening for signals from ${diff.started.length} sensor(s): ${running}.\n\n` +
            "In one short sentence, tell the user that World2Agent is ready and which source(s) it's watching, " +
            "then return control to whatever the user was doing. Do not list installation steps or repeat this message.",
          meta: {
            event_type: "system.world2agent.ready",
            sensor_count: String(diff.started.length),
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
