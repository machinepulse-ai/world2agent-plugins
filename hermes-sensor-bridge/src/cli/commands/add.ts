import { packageToSkillId } from "@world2agent/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultSensorId,
  ensureBridgeDirs,
  getBridgePaths,
  loadOrCreateHmacSecret,
  readManifest,
  upsertSensorEntry,
  writeManifest,
} from "../../supervisor/manifest.js";
import {
  ensureHermesWebhookEnabled,
  ensurePackageInstalled,
  getPort,
  getStringFlag,
  hasFlag,
  maybeReloadSupervisor,
  printJson,
  runCommand,
  type InstalledPackageInfo,
  type ParsedArgs,
} from "../common.js";

export async function runAddCommand(args: ParsedArgs): Promise<void> {
  const pkg = args._[0];
  if (!pkg) {
    throw new Error("Usage: world2agent-hermes add <pkg> --config-file <path>");
  }

  const paths = getBridgePaths();
  await ensureBridgeDirs(paths);

  const installed = await ensurePackageInstalled(pkg);
  const config = await loadConfig(getStringFlag(args, "config-file"), installed);
  const skillId = getStringFlag(args, "skill-id") ?? packageToSkillId(pkg);
  const sensorId = getStringFlag(args, "sensor-id") ?? defaultSensorId(pkg);
  const port = getPort(args);
  const noHermesSubscribe = hasFlag(args, "no-hermes-subscribe");
  const webhookUrlFlag = getStringFlag(args, "webhook-url");
  const hmacSecret = await loadOrCreateHmacSecret(
    paths,
    getStringFlag(args, "hmac-secret"),
  );

  const hermesWebhook = noHermesSubscribe
    ? null
    : await ensureHermesWebhookEnabled(paths, { secret: hmacSecret });

  const { webhookUrl, subscriptionName, subscribeResult } =
    noHermesSubscribe
      ? {
          webhookUrl: requireString(
            webhookUrlFlag,
            "--webhook-url is required with --no-hermes-subscribe",
          ),
          subscriptionName: undefined,
          subscribeResult: null,
        }
      : await subscribeWithHermes(sensorId, skillId, hmacSecret);

  await writeGenericSkill(paths.hermesSkillsDir, skillId, pkg, installed);

  const manifest = await readManifest(paths);
  const nextManifest = upsertSensorEntry(manifest, {
    sensor_id: sensorId,
    pkg,
    skill_id: skillId,
    subscription_name: subscriptionName,
    webhook_url: webhookUrl,
    enabled: true,
    config,
  });
  await writeManifest(paths, nextManifest);

  const reload = await maybeReloadSupervisor(port, paths);
  printJson({
    ok: true,
    sensor_id: sensorId,
    skill_id: skillId,
    webhook_url: webhookUrl,
    hmac_secret_source: getStringFlag(args, "hmac-secret") ? "override" : "stored",
    subscription_name: subscriptionName ?? null,
    subscribe: subscribeResult,
    hermes_webhook: hermesWebhook,
    reload,
  });
}

async function loadConfig(
  configFile: string | undefined,
  installed: InstalledPackageInfo,
): Promise<Record<string, unknown>> {
  if (!configFile) {
    const setupPath = String(
      (installed.packageJson.w2a as Record<string, unknown> | undefined)?.setup ?? "SETUP.md",
    );
    throw new Error(
      `Interactive setup is not implemented; use --config-file <path>. Sensor guidance: ${join(
        installed.packageRoot,
        setupPath,
      )}`,
    );
  }

  const raw = JSON.parse(await readFile(configFile, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Config file must contain a JSON object: ${configFile}`);
  }
  return raw as Record<string, unknown>;
}

async function subscribeWithHermes(
  sensorId: string,
  skillId: string,
  hmacSecret: string,
): Promise<{
  webhookUrl: string;
  subscriptionName: string;
  subscribeResult: unknown;
}> {
  const subscriptionName = `world2agent-${sensorId}`;
  const { stdout } = await runCommand("hermes", [
    "webhook",
    "subscribe",
    subscriptionName,
    "--description",
    `World2Agent: ${skillId}`,
    "--skills",
    skillId,
    "--prompt",
    "{prompt}",
    "--secret",
    hmacSecret,
  ]);

  const parsed = parseSubscribeOutput(stdout);
  return {
    webhookUrl: parsed.url,
    subscriptionName: parsed.name ?? subscriptionName,
    subscribeResult: parsed.raw,
  };
}

function parseSubscribeOutput(stdout: string): {
  url: string;
  name: string | undefined;
  raw: unknown;
} {
  const trimmed = stdout.trim();

  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const url = firstString(json, ["url", "webhook_url", "deliver_url"]);
    if (url) {
      const name = firstString(json, ["name", "subscription_name", "id"]);
      return { url, name, raw: json };
    }
  } catch {
    // fall through
  }

  const url = trimmed.match(/https?:\/\/\S+/)?.[0];
  if (!url) {
    throw new Error(`Could not parse webhook URL from hermes subscribe output: ${trimmed}`);
  }
  // We do not synthesize a default name — the caller already has the name it
  // passed to `hermes webhook subscribe` and is the source of truth for it.
  return { url, name: undefined, raw: trimmed };
}

async function writeGenericSkill(
  hermesSkillsDir: string,
  skillId: string,
  pkg: string,
  installed: InstalledPackageInfo,
): Promise<void> {
  const sourceType = String(
    (installed.packageJson.w2a as Record<string, unknown> | undefined)?.source_type ?? pkg,
  );
  const signals = (
    (installed.packageJson.w2a as Record<string, unknown> | undefined)?.signals as
      | string[]
      | undefined
  )?.join(", ");

  const skillDir = join(hermesSkillsDir, skillId);
  await mkdir(skillDir, { recursive: true });
  const skillMd = [
    "---",
    `name: ${skillId}`,
    `description: Handle World2Agent signals from ${pkg}.`,
    "user-invocable: false",
    "---",
    "",
    `# ${skillId}`,
    "",
    `Handle W2A signals from \`${pkg}\` (source type: \`${sourceType}\`).`,
    "",
    "## Inputs",
    "- The prompt body contains markdown context plus a fenced JSON copy of the full `signal` object.",
    signals ? `- Common signal types: ${signals}` : "- Inspect `signal.event.type` for the exact event kind.",
    "",
    "## Behavior",
    "- Parse the JSON when you need structured fields.",
    "- If the signal is irrelevant or obviously low-value, skip silently.",
    "- If it is actionable, reply briefly with the key fact, why it matters, and any obvious next step.",
    "",
    "## Notes",
    "- This skill was generated from the bridge CLI because the sensor package does not ship a machine-runnable setup script yet.",
    "- Replace it with a richer sensor-specific handler if you need more nuanced behavior.",
    "",
  ].join("\n");
  await writeFile(join(skillDir, "SKILL.md"), skillMd, "utf8");
}

function firstString(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }
  return undefined;
}

function requireString(value: string | undefined, errorMessage: string): string {
  if (!value) throw new Error(errorMessage);
  return value;
}
