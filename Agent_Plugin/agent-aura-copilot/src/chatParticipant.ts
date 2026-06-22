/**
 * ChatParticipant - @ring chat participant for Copilot Chat.
 *
 * Allows users to control the Ring Light directly from Copilot Chat:
 *   @ring red          → Set color to red
 *   @ring rainbow      → Set rainbow effect
 *   @ring state busy   → Set agent state
 *   @ring off          → Turn off
 *   @ring status       → Query device status
 *
 * Also signals Copilot activity states to the watcher when chat
 * interactions happen, enabling automatic state sync.
 */

import * as vscode from 'vscode';
import { DeviceClient } from './deviceClient';

export class ChatParticipant implements vscode.Disposable {
    private _client: DeviceClient;
    private _outputChannel: vscode.OutputChannel;
    private _participant: vscode.ChatParticipant | null = null;

    constructor(client: DeviceClient, outputChannel: vscode.OutputChannel) {
        this._client = client;
        this._outputChannel = outputChannel;
        this._register();
    }

    private _register() {
        try {
            this._participant = vscode.chat.createChatParticipant(
                'agent-aura.ring',
                this._handleRequest.bind(this)
            );
            this._participant.iconPath = new vscode.ThemeIcon('lightbulb');
        } catch (err: any) {
            this._outputChannel.appendLine(
                `[AgentAura] Chat participant registration failed: ${err.message}`
            );
        }
    }

    private async _handleRequest(
        request: vscode.ChatRequest,
        _context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        const prompt = request.prompt.trim().toLowerCase();

        // Signal that chat interaction is happening
        this._client.sendAgentState('busy');

        if (token.isCancellationRequested) {
            return { metadata: { command: 'cancelled' } };
        }

        try {
            const result = await this._processCommand(prompt, stream);
            // After processing, go back to running
            this._client.sendAgentState('running');
            return result;
        } catch (err: any) {
            stream.markdown(`❌ Error: ${err.message}`);
            this._client.sendAgentState('error');
            return { metadata: { command: 'error' } };
        }
    }

    private async _processCommand(
        prompt: string,
        stream: vscode.ChatResponseStream
    ): Promise<vscode.ChatResult> {
        // Parse the command
        const parts = prompt.split(/\s+/);
        const cmd = parts[0];

        switch (cmd) {
            case 'status':
            case 'state': {
                if (parts.length > 1 && cmd === 'state') {
                    // Set state: @ring state busy
                    const state = parts[1];
                    await this._client.sendAgentState(state as any);
                    stream.markdown(`✅ State set to **${state}**`);
                } else {
                    // Query state
                    const deviceState = await this._client.getDeviceState();
                    if (deviceState) {
                        stream.markdown(this._formatStatus(deviceState));
                    } else {
                        stream.markdown('⚠️ Cannot reach device. Check connection settings.');
                    }
                }
                return { metadata: { command: 'status' } };
            }

            case 'on': {
                await this._client.sendRawCommand('power on');
                stream.markdown('💡 Ring Light turned **ON**');
                return { metadata: { command: 'power' } };
            }

            case 'off': {
                await this._client.sendRawCommand('power off');
                stream.markdown('⚫ Ring Light turned **OFF**');
                return { metadata: { command: 'power' } };
            }

            case 'red':
                await this._client.sendRawCommand('rgb 255,0,0');
                stream.markdown('🔴 Color set to **red**');
                return { metadata: { command: 'color' } };

            case 'green':
                await this._client.sendRawCommand('rgb 0,255,0');
                stream.markdown('🟢 Color set to **green**');
                return { metadata: { command: 'color' } };

            case 'blue':
                await this._client.sendRawCommand('rgb 0,0,255');
                stream.markdown('🔵 Color set to **blue**');
                return { metadata: { command: 'color' } };

            case 'white':
                await this._client.sendRawCommand('rgb 255,255,255');
                stream.markdown('⚪ Color set to **white**');
                return { metadata: { command: 'color' } };

            case 'rgb': {
                const colorArgs = parts.slice(1).join(',');
                await this._client.sendRawCommand(`rgb ${colorArgs}`);
                stream.markdown(`🎨 Color set to **rgb(${colorArgs})**`);
                return { metadata: { command: 'color' } };
            }

            case 'effect': {
                const effectArgs = parts.slice(1).join(' ');
                await this._client.sendRawCommand(`effect ${effectArgs}`);
                stream.markdown(`✨ Effect set to **${effectArgs || 'default'}**`);
                return { metadata: { command: 'effect' } };
            }

            case 'rainbow':
                await this._client.sendRawCommand('effect rainbow');
                stream.markdown('🌈 Effect set to **rainbow**');
                return { metadata: { command: 'effect' } };

            case 'breath':
            case 'breathing': {
                const breathArgs = parts.slice(1).join(' ');
                await this._client.sendRawCommand(`effect breath ${breathArgs}`);
                stream.markdown(`💨 Effect set to **breath** ${breathArgs}`);
                return { metadata: { command: 'effect' } };
            }

            case 'brightness':
            case 'brt': {
                const val = parts[1] || '128';
                await this._client.sendRawCommand(`brightness ${val}`);
                stream.markdown(`🔆 Brightness set to **${val}**`);
                return { metadata: { command: 'brightness' } };
            }

            case 'speed':
            case 'spd': {
                const val = parts[1] || '128';
                await this._client.sendRawCommand(`speed ${val}`);
                stream.markdown(`⚡ Speed set to **${val}**`);
                return { metadata: { command: 'speed' } };
            }

            case 'discover':
            case 'scan': {
                await vscode.commands.executeCommand('agentAura.discover');
                stream.markdown('🔍 Scanning for devices...');
                return { metadata: { command: 'discover' } };
            }

            case 'help': {
                stream.markdown(this._helpText());
                return { metadata: { command: 'help' } };
            }

            default: {
                // Try to send as raw command
                await this._client.sendRawCommand(prompt);
                stream.markdown(`📡 Sent: \`${prompt}\``);
                return { metadata: { command: 'raw' } };
            }
        }
    }

    private _formatStatus(state: any): string {
        return [
            `## 💡 ${state.device} v${state.firmware}`,
            '',
            `| Property | Value |`,
            `|---|---|`,
            `| Uptime | ${Math.floor(state.uptime / 60)}min |`,
            `| WiFi | ${state.wifi?.connected ? `✅ ${state.wifi.ssid} (${state.wifi.rssi}dBm)` : '❌ Disconnected'} |`,
            `| IP | ${state.wifi?.ip || 'N/A'} |`,
            `| Power | ${state.led?.power ? 'ON' : 'OFF'} |`,
            `| Brightness | ${state.led?.brightness}/255 |`,
            `| Speed | ${state.led?.speed}/255 |`,
            `| Effect | ${state.current?.effect || 'none'} |`,
            `| Color | rgb(${state.current?.color?.r},${state.current?.color?.g},${state.current?.color?.b}) |`,
        ].join('\n');
    }

    private _helpText(): string {
        return [
            '## 🎛️ Ring Light Commands',
            '',
            '| Command | Description |',
            '|---|---|',
            '| `@ring status` | Query device status |',
            '| `@ring state <name>` | Set agent state (running/busy/idle/error/...) |',
            '| `@ring on` / `@ring off` | Power on/off |',
            '| `@ring red/green/blue/white` | Quick color presets |',
            '| `@ring rgb R,G,B` | Set custom color |',
            '| `@ring effect <name> [args]` | Set effect |',
            '| `@ring rainbow` | Rainbow effect |',
            '| `@ring breath [R,G,B]` | Breathing effect |',
            '| `@ring brightness <0-255>` | Set brightness |',
            '| `@ring speed <0-255>` | Set effect speed |',
            '| `@ring discover` | Scan for devices |',
            '',
            '**Agent States:** running, busy, waiting, error, idle, init, offline, upgrade',
            '',
            '**Effects:** solid, breath, flow, rainbow, gradient, blink, fire, sparkle, cycle, meteor, bounce, wave, pulse, fade, random',
        ].join('\n');
    }

    dispose() {
        this._participant?.dispose();
    }
}
