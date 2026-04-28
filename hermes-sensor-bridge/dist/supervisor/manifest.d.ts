export interface SensorEntry {
    sensor_id: string;
    pkg: string;
    skill_id: string;
    subscription_name?: string;
    webhook_url: string;
    enabled: boolean;
    config: Record<string, unknown>;
}
export interface SensorManifest {
    version: 1;
    sensors: SensorEntry[];
}
export interface BridgePaths {
    baseDir: string;
    manifestFile: string;
    hmacSecretFile: string;
    controlTokenFile: string;
    supervisorPidFile: string;
    supervisorLogFile: string;
    stateDir: string;
    hermesHome: string;
    hermesSkillsDir: string;
    gatewayPidFile: string;
    webhookSubscriptionsFile: string;
    hermesEnvFile: string;
    hermesConfigYamlFile: string;
}
export declare function getBridgePaths(env?: NodeJS.ProcessEnv): BridgePaths;
export declare function ensureBridgeDirs(paths: BridgePaths): Promise<void>;
export declare function readManifest(paths: BridgePaths): Promise<SensorManifest>;
export declare function writeManifest(paths: BridgePaths, manifest: SensorManifest): Promise<void>;
export declare function upsertSensorEntry(manifest: SensorManifest, entry: SensorEntry): SensorManifest;
export declare function removeSensorEntry(manifest: SensorManifest, sensorId: string): {
    manifest: SensorManifest;
    removed: SensorEntry | null;
};
export declare function normalizeSensorEntry(entry: SensorEntry): SensorEntry;
export declare function defaultSensorId(pkg: string): string;
export declare function stableStringify(value: unknown): string;
export declare function hashConfig(config: unknown): string;
export declare function loadOrCreateHmacSecret(paths: BridgePaths, override?: string): Promise<string>;
export declare function loadOrCreateControlToken(paths: BridgePaths): Promise<string>;
export declare function readTrimmedText(path: string): Promise<string | null>;
export declare function writeTextAtomic(path: string, content: string): Promise<void>;
export declare function writePidFile(paths: BridgePaths, pid: number): Promise<void>;
export declare function readPidFile(paths: BridgePaths): Promise<number | null>;
export declare function removePidFile(paths: BridgePaths): Promise<void>;
export declare function isProcessAlive(pid: number): Promise<boolean>;
export declare function pathExists(path: string): Promise<boolean>;
