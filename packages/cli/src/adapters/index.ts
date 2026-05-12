// Types and interfaces
export type {
  InstallationType,
  InstallationAdapter,
  InstallationConfig,
  InstallationPaths,
  GatewayConfig,
  ValidationResult,
  AdapterOptions,
} from "./types";

// Constants and schemas
export {
  DEFAULT_GATEWAY_CONFIG,
  PORTS,
  gatewayConfigSchema,
  installationPathsSchema,
  installationConfigSchema,
} from "./types";

// Configuration utilities
export {
  getHiveDir,
  getDefaultPaths,
  loadEnvFile,
  mergeEnv,
  validateGatewayConfig,
  validateInstallationConfig,
  findFreePort,
  isPortAvailable,
  waitForPort,
  waitForHttpPort,
  expandPath,
  getDistDir,
  isDevMode,
  isChildProcess,
  getPlatformInfo,
} from "./config";

// Adapters
export { BunGlobalAdapter } from "./bun-global";
export { BinaryAdapter } from "./binary";

// Factory and detection
export {
  detectAdapter,
  detectAllAdapters,
  getInstallationType,
  isInstallationTypeAvailable,
  getAdapterByType,
  INSTALLATION_TYPE_NAMES,
  INSTALLATION_TYPE_DESCRIPTIONS,
} from "./factory";
