import { fileRegistry, type RegistryProvider } from './auth.js';
import { DeviceStore } from './device-store.js';
import { DeviceAuthority } from './device-authority.js';

export interface DeviceAuthConfig { path: string; store_id: string }
export function openDeviceRegistry(authFile: string, config?: DeviceAuthConfig): { registry: RegistryProvider; deviceAuthority?: DeviceAuthority; close(): void } {
  if (!config) return { registry: fileRegistry(authFile), close() {} };
  const store = new DeviceStore(config.path, config.store_id);
  try {
    const deviceAuthority = new DeviceAuthority(store, fileRegistry(authFile, true));
    deviceAuthority.registry(); // Selected feature must be valid now; missing files never initialize or fall back.
    return { registry: deviceAuthority.registry, deviceAuthority, close: () => store.close() };
  } catch (error) { store.close(); throw error; }
}
