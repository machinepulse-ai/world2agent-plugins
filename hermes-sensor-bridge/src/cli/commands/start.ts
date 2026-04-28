import { spawn } from "node:child_process";
import { getBridgePaths } from "../../supervisor/manifest.js";
import {
  getPort,
  hasFlag,
  isSupervisorRunning,
  printJson,
  resolveSupervisorBin,
  type ParsedArgs,
} from "../common.js";

export async function runStartCommand(args: ParsedArgs): Promise<void> {
  const port = getPort(args);
  const detach = hasFlag(args, "detach");
  const paths = getBridgePaths();
  const existing = await isSupervisorRunning(paths);
  if (existing.running) {
    printJson({
      ok: true,
      already_running: true,
      pid: existing.pid,
    });
    return;
  }

  const child = spawn(process.execPath, [resolveSupervisorBin(), "--port", String(port)], {
    cwd: process.cwd(),
    detached: detach,
    stdio: detach ? "ignore" : "inherit",
  });

  if (detach) {
    child.unref();
    printJson({
      ok: true,
      detached: true,
      pid: child.pid,
      port,
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Supervisor exited with code ${code}`));
    });
  });
}
