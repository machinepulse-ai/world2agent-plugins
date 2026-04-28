interface GatewayWatchOptions {
    gatewayPidFile: string;
    log: (line: string) => void;
    onGatewayExit: () => Promise<void> | void;
}
export declare function startGatewayWatch(options: GatewayWatchOptions): Promise<() => void>;
export {};
