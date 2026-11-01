import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { pushConfig, type PushConfig } from './notifications.js';
import type { DeviceAuthConfig } from './device-config.js';

export interface ServerConfig {
  host: string;
  port: number;
  databasePath: string;
  authFile: string;
  push?: PushConfig;
  deviceAuth?: DeviceAuthConfig;
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const host = env.HOST ?? '127.0.0.1';
  if (isIP(host) === 0) {
    throw new Error('HOST must be an explicit IPv4 or IPv6 address');
  }

  const portText = env.PORT ?? '3000';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const databasePath = env.DATABASE_PATH ?? './data/app.sqlite';
  if (databasePath.trim() === '' || databasePath === ':memory:') {
    throw new Error('DATABASE_PATH must name a persistent SQLite file');
  }

  const authFile = env.AUTH_FILE ?? './data/credentials.json';
  if (authFile.trim() === '') throw new Error('AUTH_FILE must name a private credentials file');
  if (env.PUSH_ALLOW_LOCAL_HTTP !== undefined && !['0', '1'].includes(env.PUSH_ALLOW_LOCAL_HTTP)) throw new Error('PUSH_ALLOW_LOCAL_HTTP must be 0 or 1');
  if (env.PUSH_ORIGIN === undefined && (env.PUSH_TOKEN !== undefined || env.PUSH_ALLOW_LOCAL_HTTP !== undefined)) throw new Error('Push options require PUSH_ORIGIN');
  const push = env.PUSH_ORIGIN === undefined ? undefined : pushConfig(env.PUSH_ORIGIN, env.PUSH_TOKEN, env.PUSH_ALLOW_LOCAL_HTTP === '1');
  const devicePath = env.DEVICE_AUTH_PATH; const storeId = env.DEVICE_AUTH_STORE_ID;
  if ((devicePath === undefined) !== (storeId === undefined) || devicePath !== undefined && (!devicePath.trim() || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(storeId ?? ''))) throw new Error('Device auth requires an explicit original path and matching store ID');
  const deviceAuth = devicePath === undefined ? undefined : { path: resolve(cwd, devicePath), store_id: storeId! };
  return { host, port, databasePath: resolve(cwd, databasePath), authFile: resolve(cwd, authFile), ...(push === undefined ? {} : { push }), ...(deviceAuth === undefined ? {} : { deviceAuth }) };
}
