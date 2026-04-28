import { getBridgePaths, readManifest } from "../../supervisor/manifest.js";
import { getPort, printJson, readRuntimeState, } from "../common.js";
export async function runListCommand(args) {
    const paths = getBridgePaths();
    const port = getPort(args);
    const manifest = await readManifest(paths);
    const runtime = await readRuntimeState(port, paths);
    const handles = new Map();
    const runtimeHandles = (runtime?.list?.handles ?? []);
    for (const handle of runtimeHandles) {
        handles.set(handle.sensor_id, handle);
    }
    printJson({
        ok: true,
        sensors: manifest.sensors.map((entry) => ({
            ...entry,
            runtime: handles.get(entry.sensor_id) ?? null,
        })),
    });
}
