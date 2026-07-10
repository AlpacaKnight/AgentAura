import * as dgram from 'node:dgram';

export const DISCOVERY_PORT = 8888;

export interface DiscoveredDevice {
    mac?: string;
    ip: string;
    http?: number;
    udp?: number;
    [key: string]: unknown;
}

export function discoverDevices(timeoutMs = 2500): Promise<DiscoveredDevice[]> {
    return new Promise((resolve) => {
        const devices: DiscoveredDevice[] = [];
        const seen = new Set<string>();
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        let settled = false;

        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                socket.close();
            } catch {
                // Ignore close errors.
            }
            resolve(devices);
        };

        const timer = setTimeout(finish, timeoutMs);
        timer.unref?.();

        socket.on('error', (error: Error) => {
            debugLog(`discovery socket error: ${error.message}`);
            clearTimeout(timer);
            finish();
        });

        socket.on('message', (message: Buffer, remoteInfo: dgram.RemoteInfo) => {
            try {
                const parsed = JSON.parse(message.toString('utf8')) as Record<string, unknown>;
                // PetDesktop 也响应发现广播，但环形灯插件只关心固件设备。
                if (parsed.device === 'PetDesktop') {
                    return;
                }
                const key = (parsed.mac as string) || (parsed.ip as string) || remoteInfo.address;
                if (seen.has(key)) {
                    return;
                }
                seen.add(key);
                devices.push({
                    ...parsed,
                    ip: (parsed.ip as string) || remoteInfo.address,
                    http: typeof parsed.http === 'number' ? parsed.http : undefined,
                    udp: typeof parsed.udp === 'number' ? parsed.udp : undefined,
                } as DiscoveredDevice);
            } catch {
                // Ignore unrelated UDP replies.
            }
        });

        socket.bind(0, () => {
            try {
                socket.setBroadcast(true);
            } catch {
                // Some network stacks refuse broadcast toggles; send still may work.
            }
            const payload = Buffer.from('discover\n', 'utf8');
            socket.send(payload, DISCOVERY_PORT, '255.255.255.255', (error?: Error | null) => {
                if (error) {
                    debugLog(`discovery send error: ${error.message}`);
                    clearTimeout(timer);
                    finish();
                }
            });
        });
    });
}

export async function discoverFirst(timeoutMs = 1500): Promise<DiscoveredDevice | null> {
    const devices = await discoverDevices(timeoutMs);
    return devices[0] || null;
}

function debugLog(message: string): void {
    const value = process.env.AGENTAURA_ZCODE_DEBUG || process.env.AGENTAURA_DEBUG || '';
    if (['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())) {
        process.stderr.write(`[agent-aura-zcode] ${message}\n`);
    }
}
