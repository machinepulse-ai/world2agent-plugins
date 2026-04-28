import { getBridgePaths, readPidFile, } from "../../supervisor/manifest.js";
import { printJson, waitForProcessExit } from "../common.js";
export async function runStopCommand() {
    const paths = getBridgePaths();
    const pid = await readPidFile(paths);
    if (!pid) {
        printJson({ ok: true, stopped: false, reason: "not running" });
        return;
    }
    try {
        process.kill(pid, "SIGTERM");
    }
    catch (error) {
        printJson({
            ok: true,
            stopped: false,
            pid,
            reason: error instanceof Error ? error.message : String(error),
        });
        return;
    }
    const exited = await waitForProcessExit(pid, 5_000);
    if (!exited) {
        try {
            process.kill(pid, "SIGKILL");
        }
        catch {
            // no-op
        }
    }
    printJson({
        ok: true,
        stopped: true,
        pid,
        forced: !exited,
    });
}
