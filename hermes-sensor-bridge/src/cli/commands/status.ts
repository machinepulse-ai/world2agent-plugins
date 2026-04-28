import { getBridgePaths } from "../../supervisor/manifest.js";
import {
  getPort,
  isSupervisorRunning,
  printJson,
  readRuntimeState,
  type ParsedArgs,
} from "../common.js";

export async function runStatusCommand(args: ParsedArgs): Promise<void> {
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
