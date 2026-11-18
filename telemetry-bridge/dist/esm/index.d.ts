export interface TelemetryBridgePlugin {
  startServer(options: ServerConfig): Promise<void>;
  stopServer(): Promise<void>;
  getServerStatus(): Promise<{ running: boolean; wsUrl: string }>;
  getData(): Promise<any>;
  getWsUrl(): Promise<{ url: string }>;
  requestPermissions(): Promise<Record<string, boolean>>;
  hasUsageStatsPermission(): Promise<{ granted: boolean }>;
  openUsageAccessSettings(): Promise<void>;
}

export interface ServerConfig {
  port: number;
  wsPort: number;
  token: string;
  bindAll: boolean;
  intervalSec: number;
}

export const TelemetryBridge: TelemetryBridgePlugin;
export default TelemetryBridge;
