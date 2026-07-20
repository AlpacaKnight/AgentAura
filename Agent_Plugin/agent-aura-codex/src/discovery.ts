import * as dgram from 'dgram';
import * as os from 'os';
import { DiscoveredDevice } from './types';

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
            for (const address of discoveryBroadcastAddresses()) {
                socket.send(payload, DISCOVERY_PORT, address, () => {});
            }
        });
    });
}

export async function discoverFirst(timeoutMs = 1500): Promise<DiscoveredDevice | null> {
    const devices = await discoverDevices(timeoutMs);
    return devices[0] || null;
}
