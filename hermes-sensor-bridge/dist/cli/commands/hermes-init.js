import { getBridgePaths } from "../../supervisor/manifest.js";
import { ensureHermesWebhookEnabled, printJson, } from "../common.js";
export async function runHermesInitCommand(args) {
    const portRaw = args.flags.get("hermes-port");
    const port = typeof portRaw === "string" ? Number(portRaw) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
        throw new Error(`Invalid --hermes-port value: ${portRaw}`);
    }
    const paths = getBridgePaths();
    const result = await ensureHermesWebhookEnabled(paths, { port });
    const nextSteps = [];
    if (result.alreadyEnabled && !result.configYamlModified && !result.envModified) {
        nextSteps.push("Hermes webhook platform was already enabled — no changes were made.");
    }
    else {
        if (result.configYamlModified) {
            nextSteps.push(`Wrote a managed 'platforms.webhook' block to ${result.configYamlFile}.`);
        }
        if (result.envModified) {
            nextSteps.push(`Wrote managed WEBHOOK_* env vars to ${result.hermesEnvFile}.`);
        }
        nextSteps.push(result.gatewayRestartRequired
            ? "Restart the Hermes gateway so the new config is picked up."
            : "Start the Hermes gateway: 'hermes gateway run'.");
    }
    printJson({ ok: true, ...result, next_steps: nextSteps });
}
