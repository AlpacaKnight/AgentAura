import * as dgram from 'dgram';
import { DiscoveredDevice } from './types';

const DISCOVERY_PORT = 8888;

export function discoverDevices(timeoutMs = 2500): Promise<DiscoveredDevice[]> {
    return new Promise((resolve) => {
        const devices: DiscoveredDevice[] = [];
        const seen = new Set<string>();
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        let settled = false;

        const finish = () => {
            if (settled) { return; }
            settled = true;
            try { socket.close(); } catch { /* ignore */ }
            resolve(devices);
        };

        const timer = setTimeout(finish, timeoutMs);
        timer.unref?.();

        socket.on('error', () => {
            clearTimeout(timer);
            finish();
        });

        socket.on('message', (message, remoteInfo) => {
            try {
                const parsed = JSON.parse(message.toString('utf8')) as DiscoveredDevice;
                const key = parsed.mac || parsed.ip || remoteInfo.address;
                if (seen.has(key)) { return; }
                seen.add(key);
                devices.push({ ...parsed, ip: parsed.ip || remoteInfo.address });
            } catch {
                // Ignore unrelated UDP replies.
            }
        });

        socket.bind(0, () => {
            try { socket.setBroadcast(true); } catch { /* ignore */ }
            const payload = Buffer.from('discover\n', 'utf8');
            socket.send(payload, DISCOVERY_PORT, '255.255.255.255', (error) => {
                if (error) {
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