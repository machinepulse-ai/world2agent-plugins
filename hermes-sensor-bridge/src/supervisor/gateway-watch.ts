import { pathExists, readTrimmedText } from "./manifest.js";

interface GatewayWatchOptions {
  gatewayPidFile: string;
  log: (line: string) => void;
  onGatewayExit: () => Promise<void> | void;
}

export async function startGatewayWatch(
  options: GatewayWatchOptions,
): Promise<() => void> {
  if (!(await pathExists(options.gatewayPidFile))) {
    return () => {};
  }

  let stopping = false;
  const timer = setInterval(() => {
    void checkGatewayPid(options).catch((error) => {
      options.log(
        `[w2a/gateway-watch] error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, 10_000);
  timer.unref();

  return () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
  };
}

async function checkGatewayPid(options: GatewayWatchOptions): Promise<void> {
  const raw = await readTrimmedText(options.gatewayPidFile);
  if (!raw) return;

  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return;

  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return;
    }
    options.log(`[w2a/gateway-watch] gateway pid ${pid} is gone; shutting down`);
    await options.onGatewayExit();
  }
}
