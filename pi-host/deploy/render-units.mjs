#!/usr/bin/env node
/** Render NEW units only. Does not install/start/restart anything or call a model. Run as the App UID. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { noSymlinks, privateDirectory } from '../dist/private-files.js';

const allowed = ['config', 'code-root', 'runtime-root', 'node', 'ntfy-binary', 'user', 'existing-workdir', 'output-dir'];
const args = process.argv.slice(2); const values = {};
const fail = code => { throw new Error(code); };
for (let i = 0; i < args.length; i += 2) {
  const k = args[i]?.replace(/^--/, '');
  if (!allowed.includes(k) || values[k] !== undefined || !args[i]?.startsWith('--') || args[i + 1] === undefined) fail('INVALID_RENDER_ARGUMENTS');
  values[k] = args[i + 1];
}
for (const key of allowed) if (!values[key]) fail('EXPLICIT_RENDER_ARGUMENT_REQUIRED');
for (const key of allowed.filter(k => k !== 'user')) {
  const path = values[key]; if (!isAbsolute(path) || resolve(path) !== path || !/^\/[A-Za-z0-9_./-]+$/.test(path)) fail('SAFE_ABSOLUTE_UNIT_PATH_REQUIRED');
}
if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(values.user) || values.user === 'root') fail('NONROOT_APP_USER_REQUIRED');
for (const key of ['node', 'ntfy-binary', 'code-root']) if (/^\/(?:home|root)\//.test(values[key])) fail('EXECUTABLE_HIDDEN_BY_PROTECT_HOME');
const c = loadConfig(values.config); const root = values['runtime-root']; const code = values['code-root'];
if (!c.identity_reference || c.allow_model_calls || c.listen.host !== '127.0.0.1' || c.listen.port !== 18441) fail('NAMED_DISABLED_LOOPBACK_APP_CONFIG_REQUIRED');
const operator = join(root, 'operator'); const data = join(root, 'runtime'); const push = join(root, 'push');
if (c.data_dir !== data || dirname(values.config) !== operator || dirname(c.initial_prompt_file) !== operator) fail('NEW_PRIVATE_LAYOUT_REQUIRED');
const profile = dirname(c.identity_reference.persona_file);
if (dirname(c.identity_reference.settings_file) !== profile || dirname(c.identity_reference.credentials_file) !== profile) fail('SINGLE_READONLY_PROFILE_DIRECTORY_REQUIRED');
for (const p of [root, code, profile, values['existing-workdir']]) if (p === '/' || p === '/home' || p === '/opt' || p === '/usr') fail('NARROW_UNIT_PATH_REQUIRED');
if (profile === root || profile.startsWith(root + '/') || root.startsWith(profile + '/') || values['existing-workdir'] === code) fail('OVERLAPPING_UNIT_OWNERS');
privateDirectory(root); privateDirectory(operator); privateDirectory(profile);
const out = values['output-dir']; noSymlinks(out); privateDirectory(dirname(out));
if (existsSync(out)) fail('OUTPUT_ALREADY_EXISTS');

const common = `[Unit]\nAfter=network.target\n\n[Service]\nType=simple\nUser=${values.user}\nGroup=${values.user}\nUMask=0077\nRestart=no\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=tmpfs\nPrivateTmp=yes\nPrivateDevices=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nRestrictRealtime=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nCapabilityBoundingSet=\nAmbientCapabilities=\nTasksMax=64\nCPUQuota=50%\nInaccessiblePaths=-${values['existing-workdir']}\n`;
const hidden = ['sessions', 'extensions', 'skills', 'prompts', 'themes', 'AGENTS.md', 'CLAUDE.md', 'mcp.json', 'trust.json'];
const app = common + `WorkingDirectory=${data}/work\nEnvironment=HOME=${data}/work\nBindPaths=${data}\nBindReadOnlyPaths=${operator} ${profile}\nReadOnlyPaths=${operator} ${profile} ${code}\nReadWritePaths=${data}\nInaccessiblePaths=${hidden.map(p => '-' + join(profile, p)).join(' ')}\nMemoryHigh=384M\nMemoryMax=768M\nExecStart=${values.node} ${code}/pi-host/dist/main.js serve --config ${values.config}\n\n[Install]\nWantedBy=multi-user.target\n`;
const ntfy = common + `WorkingDirectory=${push}\nEnvironment=HOME=${push}\nEnvironment=GOMAXPROCS=1\nBindPaths=${push}\nReadWritePaths=${push}\nMemoryHigh=96M\nMemoryMax=128M\nExecStart=${values['ntfy-binary']} serve --config ${push}/server.yml\n\n[Install]\nWantedBy=multi-user.target\n`;
mkdirSync(out, { mode: 0o700 });
writeFileSync(join(out, 'notifier-app-test.service'), app, { mode: 0o600, flag: 'wx' });
writeFileSync(join(out, 'notifier-app-test-ntfy.service'), ntfy, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ rendered_new_units: 2, installed: false, started: false, model_requested: false }));
