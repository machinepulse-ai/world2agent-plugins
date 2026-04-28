import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorld2AgentPlugin } from "../src/plugin.js";

const ORIGINAL_W2A_HOME = process.env.W2A_HOME;
const ORIGINAL_OPENCLAW_HOME = process.env.OPENCLAW_HOME;

describe("contextInjection startup check", () => {
  afterEach(() => {
    process.env.W2A_HOME = ORIGINAL_W2A_HOME;
    process.env.OPENCLAW_HOME = ORIGINAL_OPENCLAW_HOME;
  });

  it("fails register() synchronously when agents.defaults.contextInjection is not continuation-skip", async () => {
    const root = await mkdtemp(join(tmpdir(), "w2a-openclaw-register-"));
    process.env.W2A_HOME = join(root, "w2a");
    process.env.OPENCLAW_HOME = join(root, "openclaw");

    const plugin = createWorld2AgentPlugin();
    expect(() =>
      plugin.register({
        config: {
          agents: {
            defaults: {
              contextInjection: "always",
            },
          },
        },
        pluginConfig: {},
      }),
    ).toThrow(
      "OpenClaw config field `agents.defaults.contextInjection` must be set to \"continuation-skip\"",
    );
  });

  it("register() returns synchronously (not a promise) — OpenClaw drops async registers", async () => {
    const root = await mkdtemp(join(tmpdir(), "w2a-openclaw-sync-"));
    process.env.W2A_HOME = join(root, "w2a");
    process.env.OPENCLAW_HOME = join(root, "openclaw");

    const plugin = createWorld2AgentPlugin();
    const result = plugin.register({
      registrationMode: "cli-metadata",
      pluginConfig: {},
      registerCli: () => {},
    });
    expect(result).toBeUndefined();
  });
});

