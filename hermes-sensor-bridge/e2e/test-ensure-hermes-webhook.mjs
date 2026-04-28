#!/usr/bin/env node
/**
 * Smoke test for ensureHermesWebhookEnabled — exercises the four states:
 *   1. Empty HERMES_HOME → block written to both config.yaml and .env.
 *   2. Re-run on the same HERMES_HOME → idempotent no-op.
 *   3. Hand-written `platforms.webhook.enabled: true` already → detected, no write.
 *   4. Hand-written *unmanaged* top-level `platforms:` block → throws with guidance.
 *
 * Usage:
 *   node e2e/test-ensure-hermes-webhook.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHermesWebhookEnabled } from "../dist/cli/common.js";
import {
  getBridgePaths,
  normalizeSensorEntry,
  upsertSensorEntry,
  readManifest,
  writeManifest,
  ensureBridgeDirs,
} from "../dist/supervisor/manifest.js";

let failures = 0;

function check(label, condition, detail) {
  const ok = !!condition;
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${label}\n`);
  if (!ok) {
    failures++;
    if (detail) process.stdout.write(`     ${detail}\n`);
  }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "w2a-hermes-home-"));
  // emulate Hermes's standard layout
  mkdirSync(home, { recursive: true });
  return home;
}

function pathsFor(home) {
  return getBridgePaths({ ...process.env, HERMES_HOME: home });
}

async function caseFreshHome() {
  const home = makeHome();
  try {
    const paths = pathsFor(home);
    const result = await ensureHermesWebhookEnabled(paths);
    const yaml = readFileSync(paths.hermesConfigYamlFile, "utf8");
    const env = readFileSync(paths.hermesEnvFile, "utf8");

    check("fresh: alreadyEnabled false", result.alreadyEnabled === false);
    check("fresh: configYamlModified", result.configYamlModified === true);
    check("fresh: envModified", result.envModified === true);
    check("fresh: yaml has platforms.webhook.enabled", /platforms:\s*\n\s*webhook:\s*\n\s*enabled:\s*true/.test(yaml));
    check("fresh: env has WEBHOOK_ENABLED=true", /^WEBHOOK_ENABLED=true$/m.test(env));
    check("fresh: yaml has managed marker", yaml.includes("world2agent-hermes-bridge (managed)"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function caseIdempotent() {
  const home = makeHome();
  try {
    const paths = pathsFor(home);
    await ensureHermesWebhookEnabled(paths);
    const result = await ensureHermesWebhookEnabled(paths);

    check("idempotent: alreadyEnabled true", result.alreadyEnabled === true);
    check("idempotent: detectedVia is config-yaml", result.detectedVia === "config-yaml");
    check("idempotent: configYamlModified false", result.configYamlModified === false);
    check("idempotent: envModified false", result.envModified === false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function caseUserPreEnabled() {
  const home = makeHome();
  try {
    const paths = pathsFor(home);
    writeFileSync(
      paths.hermesConfigYamlFile,
      'platforms:\n  webhook:\n    enabled: true\n    extra:\n      port: 9999\n',
      "utf8",
    );
    const result = await ensureHermesWebhookEnabled(paths);
    const yaml = readFileSync(paths.hermesConfigYamlFile, "utf8");

    check("user-enabled: alreadyEnabled true", result.alreadyEnabled === true);
    check("user-enabled: detectedVia is config-yaml", result.detectedVia === "config-yaml");
    check("user-enabled: yaml unchanged", !yaml.includes("world2agent-hermes-bridge (managed)"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function caseUserUnmanagedPlatformsRefuses() {
  const home = makeHome();
  try {
    const paths = pathsFor(home);
    // user has top-level platforms: with telegram (no webhook), expect refusal
    writeFileSync(
      paths.hermesConfigYamlFile,
      'platforms:\n  telegram:\n    enabled: true\n',
      "utf8",
    );
    let threw = false;
    let message = "";
    try {
      await ensureHermesWebhookEnabled(paths);
    } catch (error) {
      threw = true;
      message = error?.message ?? String(error);
    }
    check("unmanaged: throws", threw);
    check("unmanaged: error mentions platforms", /platforms:/.test(message));
    check("unmanaged: error mentions hermes gateway setup", /hermes gateway setup/.test(message));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function casePartialStateHealed() {
  const home = makeHome();
  try {
    const paths = pathsFor(home);
    // simulate user that hand-enabled webhook in config.yaml but never wrote .env
    writeFileSync(
      paths.hermesConfigYamlFile,
      'platforms:\n  webhook:\n    enabled: true\n    extra:\n      port: 9999\n',
      "utf8",
    );
    const result = await ensureHermesWebhookEnabled(paths);
    const yaml = readFileSync(paths.hermesConfigYamlFile, "utf8");
    const env = readFileSync(paths.hermesEnvFile, "utf8");

    check("partial: alreadyEnabled true (yaml had it)", result.alreadyEnabled === true);
    check("partial: detectedVia config-yaml", result.detectedVia === "config-yaml");
    check("partial: yaml unchanged", !yaml.includes("world2agent-hermes-bridge (managed)"));
    check("partial: env now patched", result.envModified === true);
    check("partial: env has WEBHOOK_ENABLED=true", /^WEBHOOK_ENABLED=true$/m.test(env));
    check("partial: env has marker", env.includes("world2agent-hermes-bridge (managed)"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function caseNestedAgentPlatformsIgnored() {
  const home = makeHome();
  try {
    const paths = pathsFor(home);
    // Mimics the real Hermes config shape where `agent.platforms: {}` is at indent 2.
    // Our top-level scanner must NOT treat that as an unmanaged top-level `platforms:`.
    writeFileSync(
      paths.hermesConfigYamlFile,
      "agent:\n  platforms: {}\n  some_other: value\n",
      "utf8",
    );
    const result = await ensureHermesWebhookEnabled(paths);
    const yaml = readFileSync(paths.hermesConfigYamlFile, "utf8");

    check("nested: alreadyEnabled false", result.alreadyEnabled === false);
    check("nested: configYamlModified true (top-level platforms was missing)", result.configYamlModified === true);
    check("nested: managed block appended", yaml.includes("world2agent-hermes-bridge (managed)"));
    check("nested: original agent.platforms still present", yaml.includes("agent:\n  platforms: {}"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function caseSkillIdRoundTrip() {
  const home = makeHome();
  try {
    const paths = pathsFor(home);
    await ensureBridgeDirs(paths);

    const customSkillId = "my-custom-handler";
    const entry = {
      sensor_id: "hn-custom",
      pkg: "@world2agent/sensor-hackernews",
      skill_id: customSkillId,
      subscription_name: "world2agent-hn-custom",
      webhook_url: "http://127.0.0.1:8644/webhooks/world2agent-hn-custom",
      enabled: true,
      config: { top_n: 3 },
    };

    const normalized = normalizeSensorEntry(entry);
    check("skill_id: normalize preserves custom skill_id", normalized.skill_id === customSkillId);

    const initial = await readManifest(paths);
    const next = upsertSensorEntry(initial, entry);
    await writeManifest(paths, next);

    const reloaded = await readManifest(paths);
    const found = reloaded.sensors.find((s) => s.sensor_id === "hn-custom");
    check("skill_id: reload returns single entry", !!found);
    check("skill_id: parse preserves custom skill_id", found?.skill_id === customSkillId);

    // Default fallback (no skill_id set) still derives from pkg.
    const fallback = normalizeSensorEntry({ ...entry, sensor_id: "hn-default", skill_id: "" });
    check(
      "skill_id: empty falls back to packageToSkillId",
      fallback.skill_id === "world2agent-sensor-hackernews",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

await caseFreshHome();
await caseIdempotent();
await caseUserPreEnabled();
await caseUserUnmanagedPlatformsRefuses();
await casePartialStateHealed();
await caseNestedAgentPlatformsIgnored();
await caseSkillIdRoundTrip();

if (failures > 0) {
  process.stderr.write(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("\nAll checks passed.\n");
