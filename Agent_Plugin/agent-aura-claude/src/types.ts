'use strict';

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

export type AgentState = (typeof AGENT_STATES)[number];

export const TRANSPORTS = ['http', 'udp', 'serial'] as const;

export type Transport = (typeof TRANSPORTS)[number];

export function isAgentState(value: unknown): value is AgentState {
  return (AGENT_STATES as readonly string[]).includes(value as string);
}

export function isTransportName(value: unknown): value is Transport {
  return (TRANSPORTS as readonly string[]).includes(value as string);
}
