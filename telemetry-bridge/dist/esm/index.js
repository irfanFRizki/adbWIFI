import { registerPlugin, WebPlugin } from '@capacitor/core';

class TelemetryBridgeWeb extends WebPlugin {
  async startServer(_options) {
    console.warn('TelemetryBridge: startServer not available on web');
  }
  async stopServer() {
    console.warn('TelemetryBridge: stopServer not available on web');
  }
  async getServerStatus() {
    return { running: false, wsUrl: '' };
  }
  async getData() {
    return null;
  }
  async getWsUrl() {
    return { url: '' };
  }
  async requestPermissions() {
    return { location: false, usageStats: false, notifications: false };
  }
  async hasUsageStatsPermission() {
    return { granted: false };
  }
  async openUsageAccessSettings() {
    console.warn('TelemetryBridge: openUsageAccessSettings not available on web');
  }
}

const TelemetryBridge = registerPlugin('TelemetryBridge', {
  web: () => new TelemetryBridgeWeb(),
});

export { TelemetryBridge };
export default TelemetryBridge;