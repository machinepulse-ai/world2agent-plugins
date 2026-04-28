import { getBridgePaths, readManifest } from "../../supervisor/manifest.js";
import {
  getPort,
  printJson,
  readRuntimeState,
  type ParsedArgs,
} from "../common.js";

export async function runListCommand(args: ParsedArgs): Promise<void> {
  const paths = getBridgePaths();
  const port = getPort(args);
  const manifest = await readManifest(paths);
  const runtime = await readRuntimeState(port, paths);

  const handles = new Map<string, any>();
  const runtimeHandles = ((runtime?.list as { handles?: any[] } | undefined)?.handles ?? []);
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
