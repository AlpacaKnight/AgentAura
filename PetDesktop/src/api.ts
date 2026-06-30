import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AgentState,
  AppSettings,
  AppSnapshot,
  DiscoveredHardware,
  SerialPortInfo,
} from './types';

const browserFallback: AppSnapshot = {
  version: '0.1.0-browser-preview',
  effectiveState: 'idle',
  paused: false,
  agents: [],
  pets: [],
  settings: {
    selectedPetId: 'builtin-aura',
    petScale: 1,
    alwaysOnTop: true,
    roamEnabled: false,
    roamIntervalSeconds: 30,
    roamSpeed: 80,
    clickThrough: false,
    petVisible: true,
    launchAtStartup: false,
    lanEnabled: false,
    lanToken: '',
    hardware: {
      transport: 'disabled',
      host: '',
      port: 80,
      serialPort: '',
      baud: 115200,
      autoDiscover: true,
    },
  },
  hardware: { connected: false, syncing: false },
  logs: [],
};

export const isTauri = () => '__TAURI_INTERNALS__' in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    if (command === 'get_snapshot') return browserFallback as T;
    if (command === 'read_selected_pet_asset') return '' as T;
    if (command === 'discover_hardware' || command === 'list_serial_ports') return [] as T;
    return undefined as T;
  }
  return invoke<T>(command, args);
}

export const api = {
  snapshot: () => call<AppSnapshot>('get_snapshot'),
  setAgentState: (state: AgentState) => call<void>('set_manual_state', { state }),
  setLockedAgent: (instanceId?: string) => call<void>('set_locked_agent', { instanceId: instanceId ?? null }),
  setPaused: (paused: boolean) => call<void>('set_paused', { paused }),
  saveSettings: (settings: AppSettings) => call<AppSnapshot>('save_settings', { settings }),
  installPet: (source: string, replace = false) => call<AppSnapshot>('install_pet', { source, replace }),
  deletePet: (petId: string) => call<AppSnapshot>('delete_pet', { petId }),
  selectPet: (petId: string) => call<AppSnapshot>('select_pet', { petId }),
  selectedPetAsset: () => call<string>('read_selected_pet_asset'),
  discoverHardware: () => call<DiscoveredHardware[]>('discover_hardware'),
  serialPorts: () => call<SerialPortInfo[]>('list_serial_ports'),
  testHardware: () => call<void>('test_hardware'),
  showManagement: () => call<void>('show_management'),
  showPet: (visible: boolean) => call<void>('show_pet', { visible }),
};

export async function onSnapshot(callback: (snapshot: AppSnapshot) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<AppSnapshot>('snapshot-changed', event => callback(event.payload));
}
