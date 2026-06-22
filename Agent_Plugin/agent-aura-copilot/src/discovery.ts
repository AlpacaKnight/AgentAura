/**
 * DeviceDiscovery - UDP broadcast-based device discovery.
 *
 * Sends "discover" to UDP port 8888 as a broadcast, listens for
 * JSON responses from ESP32 Ring Light devices on the local network.
 */

import * as vscode from 'vscode';
import * as dgram from 'dgram';

export interface DiscoveredDevice {
    device: string;
    model: string;
    fw: string;
    ip: string;
    mac: string;
    udp: number;
    http: number;
    effect: string;
}

const DISCOVERY_TIMEOUT_MS = 3000;
const DISCOVERY_PORT = 8888;

export class DeviceDiscovery {
    private _outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this._outputChannel = outputChannel;
    }

    /**
     * Broadcast discovery and collect responding devices.
     * Returns after DISCOVERY_TIMEOUT_MS or when manually cancelled.
     */
    async scan(): Promise<DiscoveredDevice[]> {
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'AgentAura: Scanning for Ring Light devices...',
                cancellable: true,
            },
            (progress, token) => {
                return new Promise<DiscoveredDevice[]>((resolve) => {
                    const devices: DiscoveredDevice[] = [];
                    const seen = new Set<string>();

                    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

                    const cleanup = () => {
                        try { socket.close(); } catch { /* ignore */ }
                    };

                    const timer = setTimeout(() => {
                        cleanup();
                        resolve(devices);
                    }, DISCOVERY_TIMEOUT_MS);

                    token.onCancellationRequested(() => {
                        clearTimeout(timer);
                        cleanup();
                        resolve(devices);
                    });

                    socket.on('error', (err) => {
                        this._outputChannel.appendLine(`[AgentAura] Discovery error: ${err.message}`);
                        clearTimeout(timer);
                        cleanup();
                        resolve(devices);
                    });

                    socket.on('message', (msg, rinfo) => {
                        try {
                            const data = JSON.parse(msg.toString()) as DiscoveredDevice;
                            const key = data.mac || rinfo.address;
                            if (!seen.has(key)) {
                                seen.add(key);
                                // Use the actual source IP if device doesn't report it
                                if (!data.ip) {
                                    data.ip = rinfo.address;
                                }
                                devices.push(data);
                                this._outputChannel.appendLine(
                                    `[AgentAura] Found: ${data.device} at ${data.ip}`
                                );
                                progress.report({
                                    message: `Found ${devices.length} device(s)...`,
                                });
                            }
                        } catch {
                            // Ignore non-JSON responses
                        }
                    });

                    socket.bind(() => {
                        socket.setBroadcast(true);
                        const message = Buffer.from('discover\n');

                        // Send to broadcast address
                        socket.send(message, DISCOVERY_PORT, '255.255.255.255', (err) => {
                            if (err) {
                                this._outputChannel.appendLine(
                                    `[AgentAura] Discovery send failed: ${err.message}`
                                );
                            }
                        });

                        this._outputChannel.appendLine('[AgentAura] Discovery broadcast sent');
                    });
                });
            }
        );
    }
}
