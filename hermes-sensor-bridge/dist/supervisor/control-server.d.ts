import type { SensorSupervisor } from "./spawn.js";
import type { BridgePaths } from "./manifest.js";
interface ControlServerOptions {
    paths: BridgePaths;
    supervisor: SensorSupervisor;
    token: string;
    port: number;
    startedAt: number;
    log: (line: string) => void;
}
export interface RunningControlServer {
    close(): Promise<void>;
}
export declare function startControlServer(options: ControlServerOptions): Promise<RunningControlServer>;
export {};
