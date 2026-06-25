'use strict';

const AGENT_STATES = [
  'running',
  'busy',
  'waiting',
  'error',
  'idle',
  'init',
  'offline',
  'upgrade',
];

const TRANSPORTS = ['http', 'udp', 'serial'];

function isAgentState(value) {
  return AGENT_STATES.includes(value);
}

function isTransportName(value) {
  return TRANSPORTS.includes(value);
}

module.exports = {
  AGENT_STATES,
  TRANSPORTS,
  isAgentState,
  isTransportName,
};
