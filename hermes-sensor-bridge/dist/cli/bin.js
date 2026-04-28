#!/usr/bin/env node
import { parseArgs } from "./common.js";
import { runAddCommand } from "./commands/add.js";
import { runHermesInitCommand } from "./commands/hermes-init.js";
import { runListCommand } from "./commands/list.js";
import { runLogsCommand } from "./commands/logs.js";
import { runRemoveCommand } from "./commands/remove.js";
import { runStartCommand } from "./commands/start.js";
import { runStatusCommand } from "./commands/status.js";
import { runStopCommand } from "./commands/stop.js";
async function main() {
    const [command, ...rest] = process.argv.slice(2);
    const args = parseArgs(rest);
    switch (command) {
        case "start":
            await runStartCommand(args);
            return;
        case "stop":
            await runStopCommand();
            return;
        case "status":
            await runStatusCommand(args);
            return;
        case "list":
            await runListCommand(args);
            return;
        case "add":
            await runAddCommand(args);
            return;
        case "remove":
            await runRemoveCommand(args);
            return;
        case "logs":
            await runLogsCommand(args);
            return;
        case "hermes-init":
            await runHermesInitCommand(args);
            return;
        default:
            throw new Error("Usage: world2agent-hermes <start|stop|status|list|add|remove|logs|hermes-init> [...]");
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
