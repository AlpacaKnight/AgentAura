/**
 * DeviceDiscovery - UDP broadcast-based device discovery.
 *
 * Sends "discover" to UDP port 8888 as a broadcast, listens for
 * JSON responses from ESP32 Ring Light devices on the local network.
 */

import * as vscode from 'vscode';
import * as dgram from 'dgram';
import * as os from 'os';

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

export function discoveryBroadcastAddresses(): string[] {
    const addresses = new Set<string>(['255.255.255.255']);
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (entry.family !== 'IPv4' || entry.internal) { continue; }
            const ip = entry.address.split('.').map(Number);
            const mask = entry.netmask.split('.').map(Number);
            if (ip.length !== 4 || mask.length !== 4 || ip.some(Number.isNaN) || mask.some(Number.isNaN)) { continue; }
            addresses.add(ip.map((octet, index) => ((octet & mask[index]) | (~mask[index] & 255)) >>> 0).join('.'));
        }
    }
    return [...addresses];
}

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

                        for (const address of discoveryBroadcastAddresses()) {
                            socket.send(message, DISCOVERY_PORT, address, (err) => {
                                if (err) {
                                    this._outputChannel.appendLine(
                                        `[AgentAura] Discovery send to ${address} failed: ${err.message}`
                                    );
                                }
                            });
                        }

                        this._outputChannel.appendLine(
                            `[AgentAura] Discovery broadcast sent to ${discoveryBroadcastAddresses().join(', ')}`
                        );
                    });
                });
            }
        );
    }
}
