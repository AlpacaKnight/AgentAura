export const AGENT_STATES = [
  'init',
  'running',
  'busy',
  'waiting',
  'idle',
  'error',
  'offline',
  'upgrade',
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export type AgentInstance = {
  instanceId: string;
  clientId: string;
  displayName: string;
  version?: string;
  state: AgentState;
  sessionId?: string;
  connected: boolean;
  lastSeenMs: number;
  lastSeenAt: string;
};

export type AnimationSpec = {
  row: number;
  frames: number;
  durationsMs: number[];
};

export type InstalledPet = {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath?: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  builtIn: boolean;
  animations: Record<string, AnimationSpec>;
};

export type HardwareTransport = 'disabled' | 'http' | 'udp' | 'serial';

export type HardwareConfig = {
  transport: HardwareTransport;
  host: string;
  port: number;
  serialPort: string;
  baud: number;
  autoDiscover: boolean;
};

export type HardwareStatus = {
  connected: boolean;
  syncing: boolean;
  lastSuccessAt?: string;
  lastError?: string;
  device?: Record<string, unknown>;
};

export type AppSettings = {
  selectedPetId: string;
  petScale: number;
  alwaysOnTop: boolean;
  roamEnabled: boolean;
  roamIntervalSeconds: number;
  roamSpeed: number;
  clickThrough: boolean;
  petVisible: boolean;
  launchAtStartup: boolean;
  lanEnabled: boolean;
  lanToken: string;
  hardware: HardwareConfig;
};

export type AppSnapshot = {
  version: string;
  effectiveState: AgentState;
  effectiveAgentId?: string;
  lockedAgentId?: string;
  paused: boolean;
  agents: AgentInstance[];
  pets: InstalledPet[];
  selectedPet?: InstalledPet;
  settings: AppSettings;
  hardware: HardwareStatus;
  logs: LogEntry[];
};

export type LogEntry = {
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
};

export type DiscoveredHardware = {
  device?: string;
  model?: string;
  fw?: string;
  ip: string;
  http?: number;
  udp?: number;
  mac?: string;
};

export type SerialPortInfo = {
  name: string;
  portType: string;
};

export const STATE_LABELS: Record<AgentState, string> = {
  init: '初始化',
  running: '运行中',
  busy: '忙碌',
  waiting: '等待输入',
  idle: '空闲',
  error: '错误',
  offline: '离线',
  upgrade: '升级中',
};
