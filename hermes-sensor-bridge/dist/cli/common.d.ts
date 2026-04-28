import { type BridgePaths } from "../supervisor/manifest.js";
export interface ParsedArgs {
    _: string[];
    flags: Map<string, string | boolean>;
}
export interface InstalledPackageInfo {
    packageJsonPath: string;
    packageRoot: string;
    packageJson: Record<string, unknown>;
}
export declare function parseArgs(argv: string[]): ParsedArgs;
export declare function getStringFlag(args: ParsedArgs, name: string): string | undefined;
export declare function hasFlag(args: ParsedArgs, name: string): boolean;
export declare function getPort(args: ParsedArgs): number;
export declare function printJson(value: unknown): void;
export declare function bridgePackageRoot(): string;
export declare function resolveSupervisorBin(): string;
export declare function resolveInstalledPackage(pkg: string): Promise<InstalledPackageInfo | null>;
export declare function ensurePackageInstalled(pkg: string): Promise<InstalledPackageInfo>;
export declare function callControl(pathname: string, options?: {
    method?: string;
    port?: number;
    paths?: BridgePaths;
}): Promise<Response>;
export declare function readRuntimeState(port: number, paths: BridgePaths): Promise<{
    health: unknown;
    list: unknown;
} | null>;
export declare function maybeReloadSupervisor(port: number, paths: BridgePaths): Promise<unknown | null>;
export declare function isSupervisorRunning(paths: BridgePaths): Promise<{
    pid: number | null;
    running: boolean;
}>;
export declare function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean>;
export declare function runCommand(command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    stdout: string;
    stderr: string;
}>;
export declare function removePath(path: string): Promise<void>;
export interface EnsureHermesWebhookResult {
    /** Webhook platform was already enabled before this call. */
    alreadyEnabled: boolean;
    /** Where enablement was detected (or null when we just enabled it). */
    detectedVia: "config-yaml" | "managed-block" | null;
    configYamlModified: boolean;
    envModified: boolean;
    configYamlFile: string;
    hermesEnvFile: string;
    webhookPort: number;
    /** True if a Hermes gateway is running and needs a restart for new config. */
    gatewayRestartRequired: boolean;
    /** True when this call wrote the WEBHOOK_SECRET / extra.secret. */
    secretWritten: boolean;
}
/**
 * Make sure Hermes's webhook platform is enabled and a top-level
 * `platforms.webhook.*` config exists.
 *
 * Hermes's CLI (e.g. `hermes webhook subscribe`) reads `~/.hermes/config.yaml`
 * to decide whether the webhook platform is configured; the gateway runtime
 * additionally honours `WEBHOOK_*` env vars. We write both, fenced by marker
 * comments so the change is idempotent and easy to revert by hand.
 */
export declare function ensureHermesWebhookEnabled(paths?: BridgePaths, opts?: {
    port?: number;
    secret?: string;
}): Promise<EnsureHermesWebhookResult>;
