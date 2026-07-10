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
  showOnAllWorkspaces: boolean;
  launchAtStartup: boolean;
  lanEnabled: boolean;
  lanToken: string;
  hardware: HardwareConfig;
  petBubble: PetBubbleSettings;
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
  petMessages: PetMessage[];
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

/** 没有事件摘要时，按状态显示的本地化气泡模板。 */
export const STATE_TEMPLATES: Record<AgentState, string> = {
  init: '正在初始化…',
  running: '正在处理任务…',
  busy: '正在使用工具…',
  waiting: '等待你的确认',
  error: '操作出现错误',
  idle: '任务已完成',
  offline: 'Agent 已离线',
  upgrade: '正在更新…',
};

export type PetMessageKind = 'state' | 'activity' | 'success' | 'warning' | 'error';

export type PetMessage = {
  id: string;
  agentInstanceId?: string;
  kind: PetMessageKind;
  text: string;
  source: string;
  priority: number;
  createdAt: string;
  ttlMs: number;
};

export type PetBubbleMode = 'state' | 'events' | 'both';

export type PetBubbleSettings = {
  enabled: boolean;
  mode: PetBubbleMode;
  durationSeconds: number;
  maxCharacters: number;
  fontScale: number;
  showSource: boolean;
};

export type PluginProvider = 'claude' | 'codex' | 'copilot' | 'kimi-code' | 'qwencode' | 'qwenpaw' | 'zcode';
export type PluginPackageInspection = {
  path: string; fileName: string; sha256: string; format: string; provider?: PluginProvider;
  version?: string; valid: boolean; error?: string; warnings: string[];
};
export type ManagedPluginStatus = {
  provider: PluginProvider; installed: boolean; version?: string; hooksInstalled: boolean;
  hooksSupported: boolean; configPath?: string;
  managedInstalled: boolean; globalInstalled: boolean; externalInstalled: boolean;
  preferredSource?: 'managed' | 'global' | 'external';
  managedVersion?: string; globalVersion?: string; externalVersion?: string;
};
export type PluginOperationResult = {
  provider: PluginProvider; success: boolean; message: string; output: string;
};
