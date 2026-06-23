/**
 * AgentAura Copilot Ring Light Extension
 *
 * Syncs GitHub Copilot's actual activity states to ESP32 Ring Light hardware
 * by monitoring Copilot's chat transcript log (thinking, running tools,
 * waiting for approval, done). It does NOT monitor the user's own editing
 * or typing — only Copilot's state.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeviceClient } from './deviceClient';
import { TranscriptWatcher } from './transcriptWatcher';
import { StatusBarUI } from './statusBar';
import { DeviceDiscovery } from './discovery';
import { ChatParticipant } from './chatParticipant';
import { ControlPanelProvider } from './controlPanel';

let client: DeviceClient;
let transcriptWatcher: TranscriptWatcher;
let statusBar: StatusBarUI;
let discovery: DeviceDiscovery;
let chatParticipant: ChatParticipant;

// Diagnostic: mirror every output-channel line to a timestamped temp file so
// state transitions can be inspected outside VS Code.
const DEBUG_LOG = path.join(os.tmpdir(), 'agent-aura-debug.log');
function wrapChannelWithFileLog(channel: vscode.OutputChannel): vscode.OutputChannel {
    try {
        fs.writeFileSync(DEBUG_LOG, `=== AgentAura debug log ${new Date().toISOString()} ===\n`);
    } catch { /* ignore */ }
    const origAppendLine = channel.appendLine.bind(channel);
    channel.appendLine = (value: string) => {
        try { fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${value}\n`); } catch { /* ignore */ }
        origAppendLine(value);
    };
    return channel;
}

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = wrapChannelWithFileLog(vscode.window.createOutputChannel('AgentAura'));
    context.subscriptions.push(outputChannel);

    // Initialize components
    client = new DeviceClient(outputChannel);
    statusBar = new StatusBarUI(client);
    discovery = new DeviceDiscovery(outputChannel);
    transcriptWatcher = new TranscriptWatcher(client, outputChannel);
    chatParticipant = new ChatParticipant(client, outputChannel);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('agentAura.connect', () => connectDevice(true)),
        vscode.commands.registerCommand('agentAura.disconnect', () => disconnectDevice()),
        vscode.commands.registerCommand('agentAura.discover', () => discoverDevices()),
        vscode.commands.registerCommand('agentAura.sendCommand', () => sendCommandPrompt()),
        vscode.commands.registerCommand('agentAura.setState', () => setStatePrompt()),
    );

    // Register disposables
    context.subscriptions.push(client, transcriptWatcher, statusBar, chatParticipant);

    // Register sidebar WebView panel
    const controlPanel = new ControlPanelProvider(client, outputChannel, {
        connect: () => connectDevice(false),
        disconnect: disconnectDevice,
        discover: scanDevices,
    });
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ControlPanelProvider.viewType,
            controlPanel
        )
    );

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('agentAura')) {
                client.reloadConfig();
                transcriptWatcher.reloadConfig();
                const enabled = vscode.workspace.getConfiguration('agentAura').get<boolean>('enabled') ?? true;
                if (!enabled) {
                    transcriptWatcher.stop();
                } else if (client.connected) {
                    transcriptWatcher.start();
                }
                statusBar.update();
            }
        })
    );

    // Auto-connect if host is configured
    const config = vscode.workspace.getConfiguration('agentAura');
    const transport = config.get<string>('transport') || 'http';
    const canAutoConnect = config.get<boolean>('enabled') && (
        (transport === 'serial' && config.get<string>('serialPort')) ||
        (transport !== 'serial' && config.get<string>('host'))
    );
    if (canAutoConnect) {
        client.connect().then(() => {
            transcriptWatcher.start();
            client.sendAgentState('init');
        });
    }

    statusBar.update();
    outputChannel.appendLine('[AgentAura] Extension activated');
}

export async function deactivate(): Promise<void> {
    if (client) {
        await client.sendAgentState('offline');
        client.disconnect();
    }
}

// ─── Command Handlers ───────────────────────────────────────────

async function connectDevice(allowPrompt = true): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('agentAura');
    const transport = config.get<string>('transport') || 'http';

    if (transport === 'serial') {
        // Serial mode: check serialPort, not host
        let serialPort = config.get<string>('serialPort');
        if (!serialPort) {
            if (!allowPrompt) {
                vscode.window.showErrorMessage('AgentAura: Serial port is not configured');
                return false;
            }
            serialPort = await vscode.window.showInputBox({
                prompt: 'Enter serial port path',
                placeHolder: '/dev/ttyACM0 or COM3',
            });
            if (!serialPort) { return false; }
            await config.update('serialPort', serialPort, vscode.ConfigurationTarget.Global);
        }
        await client.connect();
        if (!client.connected) { return false; }
        if (config.get<boolean>('enabled') ?? true) {
            transcriptWatcher.start();
        }
        client.sendAgentState('init');
        statusBar.update();
        vscode.window.showInformationMessage(`AgentAura: Connected via serial ${serialPort}`);
        return true;
    } else {
        // HTTP/UDP mode: need host
        let host = config.get<string>('host');
        if (!host) {
            if (!allowPrompt) {
                vscode.window.showErrorMessage('AgentAura: Host is not configured');
                return false;
            }
            host = await vscode.window.showInputBox({
                prompt: 'Enter ESP32 Ring Light IP address or hostname',
                placeHolder: '192.168.1.100 or ringlight.local',
            });
            if (!host) { return false; }
            await config.update('host', host, vscode.ConfigurationTarget.Global);
        }
        await client.connect();
        if (!client.connected) { return false; }
        if (config.get<boolean>('enabled') ?? true) {
            transcriptWatcher.start();
        }
        client.sendAgentState('init');
        statusBar.update();
        vscode.window.showInformationMessage(`AgentAura: Connected to ${host}`);
        return true;
    }
}

async function disconnectDevice(): Promise<void> {
    await client.sendAgentState('offline');
    transcriptWatcher.stop();
    client.disconnect();
    statusBar.update();
    vscode.window.showInformationMessage('AgentAura: Disconnected');
}

async function scanDevices() {
    return discovery.scan();
}

async function discoverDevices() {
    const devices = await scanDevices();
    if (devices.length === 0) {
        vscode.window.showWarningMessage('AgentAura: No devices found on the network');
        return;
    }

    const items = devices.map(d => ({
        label: `${d.device} (${d.ip})`,
        description: `${d.model} - fw ${d.fw}`,
        detail: `Effect: ${d.effect} | MAC: ${d.mac}`,
        ip: d.ip,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Ring Light device to connect',
    });

    if (selected) {
        const config = vscode.workspace.getConfiguration('agentAura');
        await config.update('transport', 'http', vscode.ConfigurationTarget.Global);
        await config.update('host', selected.ip, vscode.ConfigurationTarget.Global);
        client.reloadConfig();
        await client.connect();
        if (!client.connected) { return; }
        if (config.get<boolean>('enabled') ?? true) {
            transcriptWatcher.start();
        }
        client.sendAgentState('init');
        statusBar.update();
        vscode.window.showInformationMessage(`AgentAura: Connected to ${selected.label}`);
    }
}

async function sendCommandPrompt() {
    const cmd = await vscode.window.showInputBox({
        prompt: 'Enter command to send to Ring Light',
        placeHolder: 'e.g. rgb 255,0,0 / effect breath 0,255,100 / brightness 200',
    });
    if (cmd) {
        const ok = await client.sendRawCommand(cmd);
        if (ok) {
            vscode.window.showInformationMessage(`AgentAura: Sent "${cmd}"`);
        } else {
            vscode.window.showErrorMessage(`AgentAura: Failed to send "${cmd}"`);
        }
    }
}

async function setStatePrompt() {
    const states = [
        { label: 'running', description: '🟢 Green breath - normal running' },
        { label: 'busy', description: '🟡 Yellow flow - busy processing' },
        { label: 'waiting', description: '🟡 Yellow blink - waiting for approval' },
        { label: 'error', description: '🔴 Red blink - error' },
        { label: 'idle', description: '🔵 Blue breath - idle' },
        { label: 'init', description: '🌈 Rainbow - initializing' },
        { label: 'offline', description: '⚫ Off - offline/standby' },
        { label: 'upgrade', description: '🟠 Orange meteor - upgrading' },
    ];

    const selected = await vscode.window.showQuickPick(states, {
        placeHolder: 'Select an agent state',
    });

    if (selected) {
        await client.sendAgentState(selected.label as import('./stateMapper').AgentState);
    }
}
