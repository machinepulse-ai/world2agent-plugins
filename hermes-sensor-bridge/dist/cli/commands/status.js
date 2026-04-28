import { getBridgePaths } from "../../supervisor/manifest.js";
import { getPort, isSupervisorRunning, printJson, readRuntimeState, } from "../common.js";
export async function runStatusCommand(args) {
    const paths = getBridgePaths();
    const port = getPort(args);
    const processState = await isSupervisorRunning(paths);
    const runtime = await readRuntimeState(port, paths);
    printJson({
        ok: true,
        process: processState,
        runtime,
    });
}
