import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getBridgePaths,
  readManifest,
  removeSensorEntry,
  writeManifest,
} from "../../supervisor/manifest.js";
import {
  getPort,
  maybeReloadSupervisor,
  printJson,
  bridgePackageRoot,
  removePath,
  runCommand,
  type ParsedArgs,
} from "../common.js";

export async function runRemoveCommand(args: ParsedArgs): Promise<void> {
  const sensorId = args._[0];
  if (!sensorId) {
    throw new Error("Usage: world2agent-hermes remove <sensor_id> [--purge]");
  }

  const paths = getBridgePaths();
  const manifest = await readManifest(paths);
  const { manifest: nextManifest, removed } = removeSensorEntry(manifest, sensorId);
  if (!removed) {
    throw new Error(`Sensor not found: ${sensorId}`);
  }

  if (removed.subscription_name) {
    try {
      await runCommand("hermes", ["webhook", "unsubscribe", removed.subscription_name]);
    } catch (error) {
      await removeSubscriptionFromFile(paths.webhookSubscriptionsFile, removed.subscription_name);
      if (!(await subscriptionStillPresent(paths.webhookSubscriptionsFile, removed.subscription_name))) {
        // fallback succeeded
      } else {
        throw error;
      }
    }
  }

  await writeManifest(paths, nextManifest);

  const purge = args.flags.get("purge") === true;
  if (purge) {
    await removePath(join(paths.hermesSkillsDir, removed.skill_id));

    const stillUsesPackage = nextManifest.sensors.some((entry) => entry.pkg === removed.pkg);
    if (!stillUsesPackage) {
      try {
        await runCommand("npm", ["uninstall", "--no-save", removed.pkg], {
          cwd: bridgePackageRoot(),
        });
      } catch {
        // best effort
      }
    }
  }

  const reload = await maybeReloadSupervisor(getPort(args), paths);
  printJson({
    ok: true,
    removed,
    purge,
    reload,
  });
}

async function removeSubscriptionFromFile(
  file: string,
  name: string,
): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    const next = stripSubscription(raw, name);
    if (next === raw) return;
    await import("../../supervisor/manifest.js").then(({ writeTextAtomic }) =>
      writeTextAtomic(file, JSON.stringify(next, null, 2) + "\n"),
    );
  } catch {
    // best effort
  }
}

async function subscriptionStillPresent(
  file: string,
  name: string,
): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    return containsSubscription(raw, name);
  } catch {
    return false;
  }
}

function stripSubscription(value: unknown, name: string): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => !matchesSubscription(item, name));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const obj = { ...(value as Record<string, unknown>) };
  if (Array.isArray(obj.subscriptions)) {
    obj.subscriptions = obj.subscriptions.filter((item) => !matchesSubscription(item, name));
  }
  if (name in obj) {
    delete obj[name];
  }
  return obj;
}

function containsSubscription(value: unknown, name: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => matchesSubscription(item, name));
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.subscriptions)) {
    return obj.subscriptions.some((item) => matchesSubscription(item, name));
  }
  return name in obj;
}

function matchesSubscription(value: unknown, name: string): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    ((value as Record<string, unknown>).name === name ||
      (value as Record<string, unknown>).subscription_name === name)
  );
}
