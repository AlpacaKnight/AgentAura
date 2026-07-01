export const AGENT_STATES = [
    'running',
    'busy',
    'waiting',
    'error',
    'idle',
    'init',
    'offline',
    'upgrade',
] as const;

export type AgentState = typeof AGENT_STATES[number];

export const TRANSPORTS = ['http', 'udp', 'serial'] as const;

export type TransportName = typeof TRANSPORTS[number];

export interface AgentAuraConfig {
    enabled: boolean;
    transport: TransportName;
    host: string;
    port: number;
    serialPort: string;
    baud: number;
    debounceMs: number;
    cooldownMs: number;
    timeoutMs: number;
    idleFallbackMs: number;
    autoDiscover: boolean;
    authToken: string;
}

export interface RuntimeState {
    lastState?: AgentState;
    lastSentAt?: number;
    unreachableUntil?: number;
    lastError?: string;
    idleFallbackToken?: string;
    idleFallbackDueAt?: number;
}

export interface DiscoveredDevice {
    device?: string;
    model?: string;
    fw?: string;
    ip?: string;
    mac?: string;
    udp?: number;
    http?: number;
    effect?: string;
}

export interface DeviceState {
    device?: string;
    firmware?: string;
    uptime?: number;
    wifi?: { connected?: boolean; ssid?: string; rssi?: number; ip?: string; mode?: string };
    led?: { num_leds?: number; brightness?: number; speed?: number; power?: boolean };
    current?: { effect?: string; color?: { r?: number; g?: number; b?: number }; color2?: { r?: number; g?: number; b?: number } };
    connections?: { usb?: boolean; http?: boolean; udp?: boolean; mqtt?: boolean; ble?: boolean };
    reachable?: boolean;
    raw?: string;
}

export function isAgentState(value: string): value is AgentState {
    return (AGENT_STATES as readonly string[]).includes(value);
}

export function isTransportName(value: string): value is TransportName {
    return (TRANSPORTS as readonly string[]).includes(value);
}
