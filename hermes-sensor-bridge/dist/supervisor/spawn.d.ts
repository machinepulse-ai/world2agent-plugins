import { type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BridgePaths, SensorEntry } from "./manifest.js";
export interface ChildHandle {
    sensorId: string;
    pkg: string;
    skillId: string;
    configHash: string;
    webhookUrl: string;
    process: ChildProcessWithoutNullStreams;
    startedAt: number;
    restartCount: number;
    lastExitCode: number | null;
    stopping: boolean;
}
export interface ApplyResult {
    started: string[];
    restarted: string[];
    stopped: string[];
    failed: Array<{
        sensor_id: string;
        error: string;
    }>;
}
export interface HandleSnapshot {
    sensor_id: string;
    pkg: string;
    skill_id: string;
    webhook_url: string;
    config_hash: string;
    pid: number | undefined;
    started_at: number;
    restart_count: number;
    last_exit_code: number | null;
}
interface SensorSupervisorOptions {
    paths: BridgePaths;
    hmacSecret: string;
    log: (line: string) => void;
}
export declare class SensorSupervisor {
    private readonly paths;
    private readonly hmacSecret;
    private readonly log;
    private readonly handles;
    private readonly desiredEntries;
    private readonly restartTimers;
    private readonly runnerBin;
    constructor(options: SensorSupervisorOptions);
    snapshot(): HandleSnapshot[];
    spawn(entry: SensorEntry, restartCount?: number): Promise<ChildHandle>;
    terminate(handle: ChildHandle, graceMs?: number): Promise<void>;
    applyConfig(entries: SensorEntry[]): Promise<ApplyResult>;
    terminateAll(graceMs?: number): Promise<void>;
    private matchesEntry;
    private attachChildStreams;
    /**
     * Render a signal into a Hermes-shaped POST and ship it to the route
     * recorded for this sensor. Retries on 5xx / network errors, fails fast
     * on 4xx (including 401 from a HMAC mismatch — those are configuration
     * problems, not transient).
     */
    private deliverSignal;
    private handleExit;
    private clearRestartTimer;
}
interface HttpPostOptions {
    timeoutMs: number;
    maxAttempts: number;
    baseDelayMs: number;
}
/**
 * POST a body with retry on transient failures (network errors and 5xx).
 * 4xx is treated as permanent and propagated immediately.
 */
export declare function httpPost(url: string, body: string, headers: Record<string, string>, opts: HttpPostOptions): Promise<void>;
/**
 * Render a W2A signal into a Markdown prompt body that the Hermes-side
 * skill can read directly. The full signal is appended as a fenced JSON
 * block so the skill can parse structured fields when it needs to.
 */
export declare function renderPrompt(signal: Record<string, unknown>): string;
export {};
