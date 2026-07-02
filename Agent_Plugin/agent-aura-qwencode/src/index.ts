#!/usr/bin/env node

import { clearRuntimeState, configPath, disabledPath, initConfig, isDisabled, loadConfig, loadRuntimeState, qwenSettingsPath, saveConfig, setDisabled } from './config';
import { discoverDevices } from './discovery';
import { RingLightClient } from './deviceClient';
import { QWEN_EVENT_TO_AGENT_STATE, QWEN_HOOK_EVENTS, runQwenHook } from './hooks';
import { installQwenHooks, printQwenHooks, uninstallQwenHooks } from './installHooks';
import { AgentAuraConfig, AgentState, TransportName, isAgentState, isTransportName } from './types';

async function main(): Promise<void> {
    const [command = 'help', ...args] = process.argv.slice(2);

    if (command === 'hook') {
        await runQwenHook(args[0]);
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
            await status(args);
            break;
        case 'install-hooks':
            printInstallResult(installQwenHooks());
            break;
        case 'uninstall-hooks':
            console.log(`Removed AgentAura Qwen Code hooks from: ${uninstallQwenHooks()}`);
            break;
        case 'hooks':
            hooksCommand(args);
            break;
        case 'disable':
        case 'off':
            setDisabled(true);
            console.log(`AgentAura Qwen Code disabled: ${disabledPath()}`);
            break;
        case 'enable':
        case 'on':
            setDisabled(false);
            console.log('AgentAura Qwen Code enabled');
            break;
        case 'reset-cache':
            clearRuntimeState();
            console.log('Cleared AgentAura Qwen Code runtime state.');
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
    throw new Error('Usage: agent-aura-qwencode config get|path|init|set ...');
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
        qwenSettingsPath: qwenSettingsPath(),
        config,
        client: client.describe(),
        runtime: loadRuntimeState(),
        hookMapping: QWEN_EVENT_TO_AGENT_STATE,
    };
    if (flags.probe !== undefined) {
        result.device = await client.health();
    }
    printJson(result);
}

function hooksCommand(args: string[]): void {
    const [subcommand = 'print'] = args;
    if (subcommand === 'install') {
        printInstallResult(installQwenHooks());
        return;
    }
    if (subcommand === 'uninstall') {
        console.log(`Removed AgentAura Qwen Code hooks from: ${uninstallQwenHooks()}`);
        return;
    }
    if (subcommand === 'print') {
        printJson(printQwenHooks());
        return;
    }
    throw new Error('Usage: agent-aura-qwencode hooks install|uninstall|print');
}

function printInstallResult(filePath: string): void {
    console.log(`Installed Qwen Code hooks: ${filePath}`);
    console.log(`Events: ${QWEN_HOOK_EVENTS.join(', ')}`);
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
    console.log(`AgentAura Qwen Code\n\nCommands:\n  configure [--transport http|udp|serial] [--host HOST] [--port PORT] [--serial-port PATH] [--baud N] [--discover]\n  config get|path|init|set\n  discover [--timeout MS] [--save]\n  status [--probe]\n  test <state>\n  command <text>\n  install-hooks\n  uninstall-hooks\n  hooks print\n  enable|disable\n  reset-cache`);
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
});
