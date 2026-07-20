'use strict';

import * as dgram from 'node:dgram';
import * as os from 'node:os';

export const DISCOVERY_PORT = 8888;

export function discoveryBroadcastAddresses(): string[] {
  const addresses = new Set<string>(['255.255.255.255']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4 || ip.some(Number.isNaN) || mask.some(Number.isNaN)) continue;
      addresses.add(ip.map((octet, index) => ((octet & mask[index]) | (~mask[index] & 255)) >>> 0).join('.'));
    }
  }
  return [...addresses];
}

export interface DiscoveredDevice {
  mac?: string;
  ip: string;
  http?: number;
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
        const key = (parsed.mac as string) || (parsed.ip as string) || remoteInfo.address;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        devices.push({ ...parsed, ip: (parsed.ip as string) || remoteInfo.address } as DiscoveredDevice);
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
      for (const address of discoveryBroadcastAddresses()) {
        socket.send(payload, DISCOVERY_PORT, address, (error?: Error | null) => {
          if (error) debugLog(`discovery send to ${address} failed: ${error.message}`);
        });
      }
    });
  });
}

export async function discoverFirst(timeoutMs = 1500): Promise<DiscoveredDevice | null> {
  const devices = await discoverDevices(timeoutMs);
  return devices[0] || null;
}

function debugLog(message: string): void {
  const value = process.env.AGENTAURA_CLAUDE_DEBUG || process.env.AGENTAURA_DEBUG || '';
  if (['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())) {
    process.stderr.write(`[agent-aura-claude] ${message}\n`);
  }
}
