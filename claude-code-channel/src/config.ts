import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SensorEntry {
  /** npm package name, e.g. "@world2agent/sensor-hackernews" */
  package: string;
  /** Sensor-specific config (credentials, options, etc.) */
  config?: Record<string, unknown>;
  /** Whether this sensor is enabled (default: true) */
  enabled?: boolean;
}

export interface ChannelConfig {
  /** List of sensors to load and run */
  sensors: SensorEntry[];
  /** Channel name shown in Claude Code (default: "world2agent") */
  name?: string;
  /** Custom instructions for Claude (optional) */
  instructions?: string;
}

const CONFIG_PATHS = [
  // Project-local config
  join(process.cwd(), ".world2agent.json"),
  join(process.cwd(), "world2agent.config.json"),
  // User-level config
  join(homedir(), ".world2agent", "config.json"),
  join(homedir(), ".config", "world2agent", "config.json"),
];

/**
 * Load channel configuration from file or environment.
 *
 * Config search order:
 * 1. W2A_CONFIG env var (path to config file)
 * 2. W2A_SENSORS env var (comma-separated package names, quick setup)
 * 3. .world2agent.json in current directory
 * 4. world2agent.config.json in current directory
 * 5. ~/.world2agent/config.json
 * 6. ~/.config/world2agent/config.json
 */
export function loadConfig(): ChannelConfig {
  // 1. Explicit config file path
  const configPath = process.env.W2A_CONFIG;
  if (configPath) {
    return loadConfigFile(configPath);
  }

  // 2. Quick setup via env var — comma-separated npm package names.
  const sensorsEnv = process.env.W2A_SENSORS;
  if (sensorsEnv) {
    const sensors = sensorsEnv.split(",").map((s) => {
      const pkg = s.trim();
      return { package: pkg, config: configFromEnv(envPrefixFor(pkg)) };
    });
    return { sensors };
  }

  // 3-6. Search config files
  for (const path of CONFIG_PATHS) {
    if (existsSync(path)) {
      console.error(`[world2agent] Loading config from ${path}`);
      return loadConfigFile(path);
    }
  }

  // No config found - show help
  console.error(`
[world2agent] No configuration found.

Quick start with environment variable (comma-separated npm package names):
  W2A_SENSORS=@world2agent/sensor-hackernews claude --dangerously-load-development-channels server:world2agent

Or create a config file at one of these locations:
  ${CONFIG_PATHS.join("\n  ")}

Example config:
{
  "sensors": [
    { "package": "@world2agent/sensor-hackernews", "config": { "top_n": 5 } },
    { "package": "@world2agent/sensor-feishu", "config": { "app_id": "..." } }
  ]
}
`);

  return { sensors: [] };
}

function loadConfigFile(path: string): ChannelConfig {
  try {
    const content = readFileSync(path, "utf-8");
    const config = JSON.parse(content) as ChannelConfig;

    for (const sensor of config.sensors) {
      sensor.config = { ...configFromEnv(envPrefixFor(sensor.package)), ...sensor.config };
    }

    return config;
  } catch (err) {
    console.error(`[world2agent] Failed to load config from ${path}:`, err);
    return { sensors: [] };
  }
}

/**
 * Derive the env-var prefix for a sensor's per-package overrides.
 * Pattern: `W2A_<SLUG>_<KEY>=value`, where `<SLUG>` is the trailing slug of
 * the package name, uppercased with `-`→`_`. An optional `sensor-` prefix is
 * trimmed purely for brevity — not a naming requirement.
 *
 *   "@world2agent/sensor-hackernews" → "W2A_HACKERNEWS_"
 *   "@acme/my-source"                → "W2A_MY_SOURCE_"
 */
function envPrefixFor(pkg: string): string {
  const trailing = pkg.split("/").pop() ?? pkg;
  const slug = trailing.replace(/^sensor-/, "");
  return slug.toUpperCase().replace(/-/g, "_");
}

/**
 * Extract sensor config from environment variables.
 *
 * Pattern: W2A_<SLUG>_<KEY>=value
 * Example: W2A_HACKERNEWS_TOP_N=10 → { top_n: 10 }
 */
function configFromEnv(slug: string): Record<string, unknown> {
  const prefix = `W2A_${slug}_`;
  const config: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || !value) continue;

    const field = key.slice(prefix.length).toLowerCase();

    // Try JSON parse for arrays/objects
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        config[field] = JSON.parse(trimmed);
        continue;
      } catch {
        // fall through to string
      }
    }

    // Try number
    const num = Number(value);
    if (!isNaN(num)) {
      config[field] = num;
      continue;
    }

    config[field] = value;
  }

  return config;
}
