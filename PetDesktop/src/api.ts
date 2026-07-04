import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AgentState,
  AppSettings,
  AppSnapshot,
  DiscoveredHardware,
  SerialPortInfo,
  ManagedPluginStatus,
  PluginOperationResult,
  PluginPackageInspection,
  PluginProvider,
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
    showOnAllWorkspaces: false,
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
    if (command === 'discover_hardware' || command === 'list_serial_ports' || command === 'list_managed_plugins' || command === 'inspect_plugin_packages') return [] as T;
    if (command === 'inspect_managed_plugin') {
      const provider = (args?.provider as PluginProvider) ?? 'claude';
      return { provider, installed: false, hooksInstalled: false, hooksSupported: false } as unknown as T;
    }
    return undefined as T;
  }
  return invoke<T>(command, args);
}

export const api = {
  lanIp: () => call<string>('get_lan_ip'),
  snapshot: () => call<AppSnapshot>('get_snapshot'),
  setAgentState: (state: AgentState) => call<void>('set_manual_state', { state }),
  setLockedAgent: (instanceId?: string) => call<void>('set_locked_agent', { instanceId: instanceId ?? null }),
  setPaused: (paused: boolean) => call<void>('set_paused', { paused }),
  previewPetScale: (petScale: number) => isTauri() ? emitTo('pet', 'pet-scale-preview', petScale) : Promise.resolve(),
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
  inspectPluginPackages: (paths: string[]) => call<PluginPackageInspection[]>('inspect_plugin_packages', { paths }),
  listPlugins: () => call<ManagedPluginStatus[]>('list_managed_plugins'),
  inspectPlugin: (provider: PluginProvider) => call<ManagedPluginStatus>('inspect_managed_plugin', { provider }),
  installPlugin: (path: string) => call<PluginOperationResult>('install_plugin_package', { path }),
  uninstallPlugin: (provider: PluginProvider) => call<PluginOperationResult>('uninstall_managed_plugin', { provider }),
  managePluginHooks: (provider: PluginProvider, install: boolean) => call<PluginOperationResult>('manage_plugin_hooks', { provider, install }),
  loadPluginConfig: (provider: PluginProvider) => call<string>('load_plugin_config', { provider }),
  savePluginConfig: (provider: PluginProvider, config: string) => call<void>('save_plugin_config', { provider, config }),
};

export async function onSnapshot(callback: (snapshot: AppSnapshot) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<AppSnapshot>('snapshot-changed', event => callback(event.payload));
}

export async function onPetScalePreview(callback: (scale: number) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<number>('pet-scale-preview', event => callback(event.payload));
}
