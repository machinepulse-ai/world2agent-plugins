import { readFile } from "node:fs/promises";
import { getBridgePaths } from "../../supervisor/manifest.js";
import { getStringFlag } from "../common.js";
export async function runLogsCommand(args) {
    const sensorId = args._[0];
    const lineLimit = Number(getStringFlag(args, "lines") ?? "100");
    const paths = getBridgePaths();
    const raw = await readFile(paths.supervisorLogFile, "utf8");
    const lines = raw
        .trimEnd()
        .split("\n")
        .filter((line) => !sensorId || line.includes(`[w2a/${sensorId}]`));
    const sliced = lines.slice(-Math.max(1, lineLimit));
    process.stdout.write(sliced.join("\n") + (sliced.length > 0 ? "\n" : ""));
}
