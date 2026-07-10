#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { clearRuntimeState, configPath, disabledPath, initConfig, isDisabled, loadConfig, loadRuntimeState, runtimeStatePath, saveConfig, setDisabled, suppressHooks, zcodeConfigPath } from './config';
import { discoverDevices } from './discovery';
import { RingLightClient } from './deviceClient';
import { ZCODE_EVENT_TO_AGENT_STATE, ZCODE_HOOK_EVENTS, runZcodeHook } from './hooks';
import { installZcodeHooks, printZcodeHooks, uninstallZcodeHooks } from './installHooks';
import { AgentAuraConfig, AgentState, TransportName, isAgentState, isTransportName } from './types';

async function main(): Promise<void> {
    const [command = 'help', ...args] = process.argv.slice(2);

    if (command === 'hook') {
        await runZcodeHook(args[0]);
        return;
    }
    if (command === 'heartbeat-loop') {
        await heartbeatLoopCommand(args);
        return;
    }

    switch (command) {
        case 'configure':
            await configure(args);
            break;
        case 'config':
            await configCommand(args);
            break;
        case 'show-config':
            printJson({ path: configPath(), config: loadConfig() });
            break;
        case 'discover':
            await discover(args);
            break;
        case 'test':
        case 'state':
            await testState(args);
            break;
        case 'command':
        case 'cmd':
            await sendCommand(args);
            break;
        case 'status':
        case 'doctor':
            suppressHooks(undefined, 'manual status command');
            await status(args);
            break;
        case 'install-hooks':
            printInstallResult(installZcodeHooks());
            break;
        case 'uninstall-hooks':
            console.log(`Removed AgentAura ZCode hooks from: ${uninstallZcodeHooks()}`);
            break;
        case 'hooks':
            hooksCommand(args);
            break;
        case 'plugin-path':
            printPluginPath();
            break;
        case 'disable':
        case 'off':
            suppressHooks(undefined, 'manual disable command');
            setDisabled(true);
            console.log(`AgentAura ZCode disabled: ${disabledPath()}`);
            break;
        case 'enable':
        case 'on':
            suppressHooks(undefined, 'manual enable command');
            setDisabled(false);
            console.log('AgentAura ZCode enabled');
            break;
        case 'reset-cache':
            clearRuntimeState();
            console.log('Cleared AgentAura ZCode runtime state.');
            break;
        case 'help':
        case '--help':
        case '-h':
            printHelp();
            break;
        default:
            console.error(`Unknown command: ${command}`);
            printHelp();
            process.exitCode = 2;
    }
}

async function configCommand(args: string[]): Promise<void> {
    const [subcommand = 'get', ...rest] = args;
    if (subcommand === 'get') {
        printJson({ path: configPath(), config: loadConfig() });
        return;
    }
    if (subcommand === 'path') {
        console.log(configPath());
        return;
    }
    if (subcommand === 'init') {
        const { flags } = parseArgs(rest);
        const config = initConfig(flags.force !== undefined);
        printJson({ path: configPath(), config });
        return;
    }
    if (subcommand === 'set') {
        await configure(rest);
        return;
    }
    throw new Error('Usage: agent-aura-zcode config get|path|init|set ...');
}

async function configure(args: string[]): Promise<void> {
    const { flags } = parseArgs(args);
    const patch: Partial<AgentAuraConfig> = {};

    if (flags.enabled !== undefined) {
        patch.enabled = parseBoolean(flags.enabled);
    }
    if (flags.transport !== undefined) {
        const value = flags.transport.toLowerCase();
        if (!isTransportName(value)) {
            throw new Error('--transport must be http, udp, or serial');
        }
        patch.transport = value as TransportName;
        if (value === 'http' && flags.port === undefined) { patch.port = 80; }
        if (value === 'udp' && flags.port === undefined) { patch.port = 8888; }
    }
    if (flags.host !== undefined) { patch.host = flags.host; }
    if (flags.port !== undefined) { patch.port = parseNumberFlag(flags.port, '--port'); }
    if (flags.serialPort !== undefined) { patch.serialPort = flags.serialPort; }
    if (flags.baud !== undefined) { patch.baud = parseNumberFlag(flags.baud, '--baud'); }
    if (flags.debounceMs !== undefined) { patch.debounceMs = parseNumberFlag(flags.debounceMs, '--debounce-ms'); }
    if (flags.cooldownMs !== undefined) { patch.cooldownMs = parseNumberFlag(flags.cooldownMs, '--cooldown-ms'); }
    if (flags.timeoutMs !== undefined) { patch.timeoutMs = parseNumberFlag(flags.timeoutMs, '--timeout-ms'); }
    if (flags.autoDiscover !== undefined) { patch.autoDiscover = parseBoolean(flags.autoDiscover); }
    if (flags.authToken !== undefined) { patch.authToken = flags.authToken; }

    if (flags.discover !== undefined) {
        const devices = await discoverDevices(2500);
        const first = devices[0];
        if (!first?.ip) {
            throw new Error('No AgentAura device found via UDP discovery');
        }
        patch.host = first.ip;
        const transport = patch.transport || loadConfig().transport;
        patch.port = transport === 'udp' ? (first.udp || 8888) : (first.http || 80);
    }

    const config = saveConfig(patch);
    printJson({ path: configPath(), config });
}

async function discover(args: string[]): Promise<void> {
    const { flags } = parseArgs(args);
    const timeout = flags.timeout ? parseNumberFlag(flags.timeout, '--timeout') : 2500;
    const devices = await discoverDevices(timeout);

    if (flags.save !== undefined || flags.saveFirst !== undefined) {
        const first = devices[0];
        if (!first?.ip) {
            throw new Error('No device found to save');
        }
        const current = loadConfig();
        const config = saveConfig({
            host: first.ip,
            port: current.transport === 'udp' ? (first.udp || 8888) : (first.http || 80),
        });
        printJson({ devices, saved: config });
        return;
    }

    printJson({ devices });
}

async function testState(args: string[]): Promise<void> {
    const state = (args[0] || '').trim().toLowerCase();
    if (!isAgentState(state)) {
        throw new Error('state must be one of: running, busy, waiting, error, idle, init, offline, upgrade');
    }
    suppressHooks(undefined, `manual state ${state}`);
    const runtime = loadRuntimeState();
    const ok = await new RingLightClient(loadConfig()).sendAgentState(state as AgentState, runtime.lastSessionId ? { sessionId: runtime.lastSessionId } : undefined);
    if (!ok) {
        throw new Error(`Failed to send agent state ${state}. Check config and device reachability.`);
    }
    console.log(`Sent agent ${state}`);
}

async function sendCommand(args: string[]): Promise<void> {
    const raw = args.join(' ').trim();
    if (!raw) {
        throw new Error('command text is required');
    }
    suppressHooks(undefined, 'manual firmware command');
    const runtime = loadRuntimeState();
    const ok = await new RingLightClient(loadConfig()).sendCommand(raw, runtime.lastSessionId ? { sessionId: runtime.lastSessionId } : undefined);
    if (!ok) {
        throw new Error(`Failed to send command: ${raw}`);
    }
    console.log(`Sent: ${raw}`);
}

async function heartbeatLoopCommand(args: string[]): Promise<void> {
    const token = (args[0] || '').trim();
    const intervalMs = parseNumberFlag(args[1] || '0', 'heartbeat-loop interval');
    if (!token) {
        throw new Error('heartbeat-loop token is required');
    }
    await new RingLightClient(loadConfig()).runHeartbeatLoop(token, intervalMs);
}

async function status(args: string[]): Promise<void> {
    const { flags } = parseArgs(args);
    const config = loadConfig();
    const client = new RingLightClient(config);
    const result: Record<string, unknown> = {
        disabled: isDisabled(),
        disabledPath: disabledPath(),
        configPath: configPath(),
        zcodeConfigPath: zcodeConfigPath(),
        runtimeStatePath: runtimeStatePath(),
        pluginDataPath: process.env.ZCODE_PLUGIN_DATA || null,
        config,
        client: client.describe(),
        runtime: loadRuntimeState(),
        hookMapping: ZCODE_EVENT_TO_AGENT_STATE,
    };
    if (flags.probe !== undefined) {
        result.device = await client.health();
    }
    printJson(result);
}

function hooksCommand(args: string[]): void {
    const [subcommand = 'print'] = args;
    if (subcommand === 'install') {
        printInstallResult(installZcodeHooks());
        return;
    }
    if (subcommand === 'uninstall') {
        console.log(`Removed AgentAura ZCode hooks from: ${uninstallZcodeHooks()}`);
        return;
    }
    if (subcommand === 'print') {
        printJson(printZcodeHooks());
        return;
    }
    throw new Error('Usage: agent-aura-zcode hooks install|uninstall|print');
}

function printInstallResult(filePath: string): void {
    console.log(`Installed ZCode hooks: ${filePath}`);
    console.log(`Events: ${ZCODE_HOOK_EVENTS.join(', ')}`);
}

/**
 * 输出当前插件包的根目录路径（npm 全局安装目录）。
 * 用户在 ZCode → Settings → Plugin Management → Discover → '+' 添加该路径作为本地 marketplace。
 */
function printPluginPath(): void {
    const pluginDir = path.resolve(__dirname, '..');
    const manifest = path.join(pluginDir, '.zcode-plugin', 'plugin.json');
    const marketplace = path.join(pluginDir, 'marketplace.json');
    const hooks = path.join(pluginDir, 'hooks', 'hooks.json');
    const entry = path.join(pluginDir, 'out', 'index.js');

    const checks = [
        { label: 'plugin.json', path: manifest },
        { label: 'marketplace.json', path: marketplace },
        { label: 'hooks.json', path: hooks },
        { label: 'out/index.js', path: entry },
    ];
    const missing = checks.filter((c) => !fs.existsSync(c.path));

    printJson({
        pluginPath: pluginDir,
        marketplaceReady: missing.length === 0,
        checks: checks.map((c) => ({ ...c, exists: fs.existsSync(c.path) })),
        missing: missing.map((c) => c.label),
        instructions: missing.length === 0
            ? `在 ZCode → Settings → Plugin Management → Discover → '+' 添加本地目录: ${pluginDir}`
            : '插件文件不完整，请重新 npm install -g 安装',
    });
}

interface ParsedArgs {
    flags: Record<string, string | undefined>;
    positional: string[];
}

function parseArgs(args: string[]): ParsedArgs {
    const flags: Record<string, string | undefined> = {};
    const positional: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        const body = arg.slice(2);
        const eq = body.indexOf('=');
        if (eq >= 0) {
            flags[toCamel(body.slice(0, eq))] = body.slice(eq + 1);
            continue;
        }
        const key = toCamel(body);
        const next = args[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
            flags[key] = next;
            index += 1;
        } else {
            flags[key] = 'true';
        }
    }
    return { flags, positional };
}

function toCamel(value: string): string {
    return value.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function parseNumberFlag(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${label} must be a number`);
    }
    return Math.round(parsed);
}

function parseBoolean(value: string): boolean {
    return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function printJson(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
    console.log(`AgentAura ZCode Ring Light

Usage:
  agent-aura-zcode configure --transport http --host 192.168.1.100 --port 80
  agent-aura-zcode configure --discover
  agent-aura-zcode test busy
  agent-aura-zcode command "rgb 255,0,0"
  agent-aura-zcode discover --save
  agent-aura-zcode status --probe

ZCode plugin:
  zcode plugin marketplace add <local repo>/Agent_Plugin
  zcode plugin install agent-aura-zcode@agentaura

Commands:
  config get|path|init|set
  configure --transport http|udp|serial --host <ip> --port <port>
  discover [--save] [--timeout 2500]
  test running|busy|waiting|error|idle|init|offline|upgrade
  command <firmware text command>
  status [--probe]
  install-hooks
  uninstall-hooks
  hooks print
  plugin-path              print the ZCode plugin marketplace path
  enable|disable
  reset-cache

ZCode hook events:
  ${ZCODE_HOOK_EVENTS.join(', ')}

Environment overrides:
  AGENTAURA_ZCODE_TRANSPORT=http|udp|serial
  AGENTAURA_ZCODE_HOST=192.168.1.100
  AGENTAURA_ZCODE_PORT=80
  AGENTAURA_ZCODE_SERIAL_PORT=/dev/ttyACM0
  AGENTAURA_ZCODE_BAUD=115200
  AGENTAURA_ZCODE_ENABLED=true|false

Set auth token:
  agent-aura-zcode config set --auth-token my-secret-token
`);
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
});
