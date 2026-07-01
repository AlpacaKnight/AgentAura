#!/usr/bin/env node

import { clearRuntimeState, codexHooksPath, configPath, disabledPath, initConfig, isDisabled, loadConfig, loadRuntimeState, saveConfig, setDisabled } from './config';
import { discoverDevices } from './discovery';
import { RingLightClient } from './deviceClient';
import { installCodexHooks, printCodexHooks, uninstallCodexHooks } from './installHooks';
import { CODEX_EVENT_TO_AGENT_STATE, CODEX_HOOK_EVENTS, runCodexHook, runIdleFallback } from './hooks';
import { AgentAuraConfig, AgentState, TransportName, isAgentState, isTransportName } from './types';

async function main(): Promise<void> {
    const [command = 'help', ...args] = process.argv.slice(2);

    if (command === 'hook') {
        await runCodexHook(args[0]);
        return;
    }
    if (command === 'idle-fallback') {
        await idleFallbackCommand(args);
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
            await status(args);
            break;
        case 'install-hooks':
            printInstallResult(installCodexHooks());
            break;
        case 'uninstall-hooks':
            console.log(`Removed AgentAura Codex hooks from: ${uninstallCodexHooks()}`);
            break;
        case 'hooks':
            hooksCommand(args);
            break;
        case 'disable':
        case 'off':
            setDisabled(true);
            console.log(`AgentAura Codex disabled: ${disabledPath()}`);
            break;
        case 'enable':
        case 'on':
            setDisabled(false);
            console.log('AgentAura Codex enabled');
            break;
        case 'reset-cache':
            clearRuntimeState();
            console.log('Cleared AgentAura Codex runtime state.');
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
    throw new Error('Usage: agent-aura-codex config get|path|init|set ...');
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
    if (flags.idleFallbackMs !== undefined) { patch.idleFallbackMs = parseNumberFlag(flags.idleFallbackMs, '--idle-fallback-ms'); }
    if (flags.autoDiscover !== undefined) { patch.autoDiscover = parseBoolean(flags.autoDiscover); }
    if (flags.authToken !== undefined) { patch.authToken = flags.authToken; }

    if (flags.discover !== undefined) {
        const devices = await discoverDevices(2500);
        const first = devices[0];
        if (!first?.ip) {
            throw new Error('No AgentAura ring light found via UDP discovery');
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
    const ok = await new RingLightClient(loadConfig()).sendAgentState(state as AgentState);
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
    const ok = await new RingLightClient(loadConfig()).sendCommand(raw);
    if (!ok) {
        throw new Error(`Failed to send command: ${raw}`);
    }
    console.log(`Sent: ${raw}`);
}

async function status(args: string[]): Promise<void> {
    const { flags } = parseArgs(args);
    const config = loadConfig();
    const client = new RingLightClient(config);
    const result: Record<string, unknown> = {
        disabled: isDisabled(),
        disabledPath: disabledPath(),
        configPath: configPath(),
        codexHooksPath: codexHooksPath(),
        config,
        client: client.describe(),
        runtime: loadRuntimeState(),
        hookMapping: CODEX_EVENT_TO_AGENT_STATE,
    };
    if (flags.probe !== undefined) {
        result.device = await client.health();
    }
    printJson(result);
}

async function idleFallbackCommand(args: string[]): Promise<void> {
    const token = (args[0] || '').trim();
    const delayMs = parseNumberFlag(args[1] || '0', 'idle-fallback delay');
    if (!token) {
        throw new Error('idle-fallback token is required');
    }
    await runIdleFallback(token, delayMs);
}

function hooksCommand(args: string[]): void {
    const [subcommand = 'install'] = args;
    if (subcommand === 'install') {
        printInstallResult(installCodexHooks());
        return;
    }
    if (subcommand === 'uninstall') {
        console.log(`Removed AgentAura Codex hooks from: ${uninstallCodexHooks()}`);
        return;
    }
    if (subcommand === 'print') {
        printJson(printCodexHooks());
        return;
    }
    throw new Error('Usage: agent-aura-codex hooks install|uninstall|print');
}

function printInstallResult(filePath: string): void {
    console.log(`Installed Codex hooks: ${filePath}`);
    console.log(`Events: ${CODEX_HOOK_EVENTS.join(', ')}`);
}

function parseArgs(args: string[]): { flags: Record<string, string | undefined>; positional: string[] } {
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

function toCamel(key: string): string {
    return key.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
}

function parseBoolean(value: string | undefined): boolean {
    if (value === undefined) { return true; }
    return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function parseNumberFlag(value: string | undefined, label: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${label} must be a number`);
    }
    return Math.round(parsed);
}

function printJson(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
    console.log(`AgentAura Codex Ring Light

Usage:
  agent-aura-codex configure --transport http --host 192.168.1.100 --port 80
  agent-aura-codex configure --discover
  agent-aura-codex install-hooks
  agent-aura-codex test busy
  agent-aura-codex command "rgb 255,0,0"
  agent-aura-codex discover --save
  agent-aura-codex status --probe

Aliases:
  agent-aura-codex config get
    agent-aura-codex config path
    agent-aura-codex config init
  agent-aura-codex config set --transport udp --host 192.168.1.100 --port 8888
  agent-aura-codex hooks install
  agent-aura-codex hooks uninstall
    agent-aura-codex disable   # no-op future hook sync, leaves hooks installed
    agent-aura-codex enable    # resume hook sync

Codex hook events:
  ${CODEX_HOOK_EVENTS.join(', ')}

Environment overrides:
  AGENTAURA_CODEX_TRANSPORT=http|udp|serial
  AGENTAURA_CODEX_HOST=192.168.1.100
  AGENTAURA_CODEX_PORT=80
  AGENTAURA_CODEX_SERIAL_PORT=/dev/ttyACM0
  AGENTAURA_CODEX_BAUD=115200
  AGENTAURA_CODEX_ENABLED=true|false
  AGENTAURA_CODEX_IDLE_FALLBACK_MS=5000

Set auth token:
  agent-aura-codex config set --auth-token my-secret-token
`);
}

main().catch((error: Error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
});
