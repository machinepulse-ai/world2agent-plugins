export interface SensorEntry {
    /** npm package name, e.g. "@world2agent/sensor-hackernews" */
    package: string;
    /** Sensor-specific config (credentials, options, etc.) */
    config?: Record<string, unknown>;
    /** Whether this sensor is enabled (default: true) */
    enabled?: boolean;
}
export interface ChannelConfig {
    /** List of sensors to load and run */
    sensors: SensorEntry[];
    /** Channel name shown in Claude Code (default: "world2agent") */
    name?: string;
    /** Custom instructions for Claude (optional) */
    instructions?: string;
}
/**
 * Load channel configuration from file or environment.
 *
 * Config search order:
 * 1. W2A_CONFIG env var (path to config file)
 * 2. W2A_SENSORS env var (comma-separated package names, quick setup)
 * 3. .world2agent.json in current directory
 * 4. world2agent.config.json in current directory
 * 5. ~/.world2agent/config.json
 * 6. ~/.config/world2agent/config.json
 */
export declare function loadConfig(): ChannelConfig;
