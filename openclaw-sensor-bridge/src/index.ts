export type {
  BridgePaths,
  BridgeSensorEntry,
  NotifyTarget,
  OpenClawBridgeSensorConfig,
  SharedConfig,
  SharedSensorEntry,
} from "./supervisor/manifest.js";
export {
  getBridgePaths,
  hashConfig,
  listBridgeSensors,
  readConfig,
  removeConfigSensor,
  resolveAgentId,
  resolveSessionKey,
  upsertConfigSensor,
  writeConfig,
} from "./supervisor/manifest.js";
export type { OpenClawConnection } from "./supervisor/openclaw-config.js";
export { resolveOpenClawConnection } from "./supervisor/openclaw-config.js";
export {
  SensorSupervisor,
  renderPrompt,
  type ApplyResult,
  type ChildHandle,
  type HandleSnapshot,
} from "./supervisor/spawn.js";

