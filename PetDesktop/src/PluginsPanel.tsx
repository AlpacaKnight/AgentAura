import { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm, open } from '@tauri-apps/plugin-dialog';
import { ChevronDown, ChevronUp, Download, FileArchive, LoaderCircle, RefreshCw, Save, Wrench } from 'lucide-react';
import { api, isTauri } from './api';
import type { ManagedPluginStatus, PluginPackageInspection, PluginProvider } from './types';

type PluginConfig = {
  enabled: boolean;
  transport: 'http' | 'udp' | 'serial';
  host: string;
  port: number;
  serialPort: string;
  baud: number;
  debounceMs: number;
  cooldownMs: number;
  timeoutMs: number;
  idleFallbackMs?: number;
  autoDiscover: boolean;
  authToken?: string;
};

const names: Record<PluginProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'VS Code Copilot',
  'kimi-code': 'Kimi Code',
  qwencode: 'Qwen Code',
  qwenpaw: 'QwenPaw',
};

const sourceLabel = (item: ManagedPluginStatus) => {
  const parts: string[] = [];
  if (item.managedInstalled) parts.push(`托管${item.managedVersion ? ` ${item.managedVersion}` : ''}`.trim());
  if (item.globalInstalled) parts.push(`全局${item.globalVersion ? ` ${item.globalVersion}` : ''}`.trim());
  if (item.externalInstalled) parts.push(`宿主${item.externalVersion ? ` ${item.externalVersion}` : ''}`.trim());
  return parts.join(' / ');
};

const statusLabel = (item: ManagedPluginStatus) => {
  if (!item.installed) return '未检测到';
  if (item.preferredSource === 'managed') return '已安装（托管优先）';
  if (item.preferredSource === 'global') return '已检测到全局安装';
  if (item.preferredSource === 'external') return '已安装（宿主扩展）';
  return '已安装';
};

const defaults = (provider: PluginProvider): PluginConfig => ({
  enabled: true,
  transport: 'http',
  host: '127.0.0.1',
  port: 47831,
  serialPort: '',
  baud: 115200,
  debounceMs: 500,
  cooldownMs: 3000,
  timeoutMs: 650,
  ...(provider === 'codex' ? { idleFallbackMs: 5000 } : {}),
  autoDiscover: false,
  ...(['codex', 'kimi-code', 'qwencode'].includes(provider) ? { authToken: '' } : {}),
});

export function PluginsPanel() {
  const [statuses, setStatuses] = useState<ManagedPluginStatus[]>([]);
  const [packages, setPackages] = useState<PluginPackageInspection[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<PluginProvider>();
  const [config, setConfig] = useState<PluginConfig>();
  const [advanced, setAdvanced] = useState(false);
  const [advancedText, setAdvancedText] = useState('');

  const refresh = useCallback(async () => setStatuses(await api.listPlugins()), []);
  const inspect = useCallback(async (paths: string[]) => {
    if (paths.length) setPackages(await api.inspectPluginPackages(paths));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!isTauri()) return;
    let stop: undefined | (() => void);
    void getCurrentWindow().onDragDropEvent(event => {
      if (event.payload.type === 'drop') void inspect(event.payload.paths);
    }).then(unlisten => { stop = unlisten; });
    return () => stop?.();
  }, [inspect]);

  const choose = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: '插件包', extensions: ['tgz', 'zip', 'vsix'] }],
    });
    if (selected) await inspect(Array.isArray(selected) ? selected : [selected]);
  };

  const run = async (action: () => Promise<{ message: string; output: string; success: boolean }>) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await action();
      setMessage([result.message, result.output].filter(Boolean).join('\n'));
      await refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const install = async (item: PluginPackageInspection) => {
    if (!item.valid || !item.provider) return;
    const accepted = await confirm('将调用对应平台的 CLI 安装此插件包，是否继续？', {
      title: '确认安装',
      kind: 'warning',
    });
    if (accepted) await run(() => api.installPlugin(item.path));
  };

  const edit = async (provider: PluginProvider) => {
    const raw = await api.loadPluginConfig(provider);
    let loaded: Partial<PluginConfig> = {};
    try { loaded = JSON.parse(raw) as Partial<PluginConfig>; } catch { /* 后端保存时仍会严格校验 */ }
    const next = { ...defaults(provider), ...loaded };
    setEditing(provider);
    setConfig(next);
    setAdvancedText(JSON.stringify(next, null, 2));
    setAdvanced(false);
  };

  const update = <K extends keyof PluginConfig>(key: K, value: PluginConfig[K]) => {
    setConfig(current => {
      if (!current) return current;
      const next = { ...current, [key]: value };
      setAdvancedText(JSON.stringify(next, null, 2));
      return next;
    });
  };

  const preset = (kind: 'local' | 'lan' | 'serial') => {
    if (!editing) return;
    const base = defaults(editing);
    const next: PluginConfig = kind === 'local'
      ? base
      : kind === 'lan'
        ? { ...base, host: '192.168.1.100', port: 80, autoDiscover: true }
        : { ...base, transport: 'serial', host: '', port: 80, serialPort: 'COM3' };
    setConfig(next);
    setAdvancedText(JSON.stringify(next, null, 2));
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setMessage('');
    try {
      await api.savePluginConfig(editing, advancedText);
      const parsed = JSON.parse(advancedText) as PluginConfig;
      setConfig(parsed);
      setAdvancedText(JSON.stringify(parsed, null, 2));
      setMessage('配置已校验并保存；已有文件已备份为 .json.bak。');
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  return <section className="plugins-page">
    <div className="section-heading">
      <div><p className="eyebrow">PLUGIN MANAGER</p><h2>插件管理</h2></div>
      <button onClick={() => void refresh()}><RefreshCw size={16}/>刷新状态</button>
    </div>

    <button className="plugin-dropzone" onClick={() => void choose()}>
      <FileArchive size={30}/>
      <strong>选择插件包，或拖拽到这里</strong>
      <span>支持 .tgz、.zip、.vsix；SHA-256 仅用于核对文件完整性，不限制插件版本</span>
    </button>

    {packages.map(item => <article className="plugin-package" key={item.path}>
      <div>
        <strong>{item.fileName}</strong>
        <span>{item.provider ? names[item.provider] : '未识别'} · {item.version ?? '未知版本'} · {item.format}</span>
        {item.sha256 && <small className="package-hash" title={item.sha256}>SHA-256：{item.sha256.slice(0, 16)}…（仅供核对）</small>}
        {item.error && <small className="danger">{item.error}</small>}
      </div>
      <button disabled={busy || !item.valid} onClick={() => void install(item)}><Download size={16}/>安装</button>
    </article>)}

    <div className="plugin-grid">{statuses.map(item => <article className="plugin-card" key={item.provider}>
      <div>
        <strong>{names[item.provider]}</strong>
        <span className={item.installed ? 'ok' : ''}>{statusLabel(item)} {item.version ?? ''}</span>
        {item.installed && <span>{sourceLabel(item)}</span>}
      </div>
      <div className="plugin-actions">
        {item.hooksSupported && <button disabled={busy} onClick={() => void run(async () => {
          const installing = !item.hooksInstalled;
          const result = await api.managePluginHooks(item.provider, installing);
          if (result.success && installing && item.provider === 'qwencode') {
            return { ...result, message: `${result.message}\n请完全退出并重新启动 Qwen Code，当前会话不会重新加载新 Hooks。` };
          }
          return result;
        })}>
          <Wrench size={15}/>{item.hooksInstalled ? '卸载 Hooks' : '安装 Hooks'}
        </button>}
        {item.configPath && <button onClick={() => void edit(item.provider)}>配置连接</button>}
        {item.installed && <button disabled={busy} onClick={() => void confirm('确认卸载该插件？', {
          title: '确认卸载', kind: 'warning',
        }).then(ok => { if (ok) return run(() => api.uninstallPlugin(item.provider)); })}>卸载</button>}
      </div>
    </article>)}</div>

    {editing && config && <article className="config-editor">
      <div className="config-heading">
        <div><h3>{names[editing]} 连接配置</h3><code>{statuses.find(value => value.provider === editing)?.configPath}</code></div>
        <label className="config-enabled"><input type="checkbox" checked={config.enabled} onChange={event => update('enabled', event.target.checked)}/>启用同步</label>
      </div>

      <div className="config-help">
        <strong>选择常用场景</strong>
        <span>本机桌宠使用 127.0.0.1:47831；局域网设备通常使用设备 IP 和 80 端口。</span>
        <div><button onClick={() => preset('local')}>本机 PetDesktop</button><button onClick={() => preset('lan')}>局域网设备</button><button onClick={() => preset('serial')}>USB 串口</button></div>
      </div>

      <div className="config-form">
        <label>连接方式<select value={config.transport} onChange={event => update('transport', event.target.value as PluginConfig['transport'])}>
          <option value="http">HTTP（推荐）</option><option value="udp">UDP</option><option value="serial">USB 串口</option>
        </select><small>HTTP 可连接 PetDesktop 或硬件；UDP 直接发送到硬件。</small></label>

        {config.transport !== 'serial' ? <>
          <label>主机地址<input value={config.host} onChange={event => update('host', event.target.value)} placeholder="127.0.0.1 或 192.168.1.100"/><small>本机桌宠填 127.0.0.1，硬件填设备局域网 IP。</small></label>
          <label>端口<input type="number" min={1} max={65535} value={config.port} onChange={event => update('port', Number(event.target.value))}/><small>PetDesktop 为 47831；硬件 HTTP 通常为 80，UDP 通常为 8888。</small></label>
          <label className="checkbox-field"><input type="checkbox" checked={config.autoDiscover} onChange={event => update('autoDiscover', event.target.checked)}/>自动发现局域网设备<small>连接本机 PetDesktop 时建议关闭。</small></label>
        </> : <>
          <label>串口<input value={config.serialPort} onChange={event => update('serialPort', event.target.value)} placeholder="COM3 或 /dev/ttyACM0"/><small>Windows 示例 COM3，macOS/Linux 示例 /dev/ttyACM0。</small></label>
          <label>波特率<input type="number" value={config.baud} onChange={event => update('baud', Number(event.target.value))}/><small>默认 115200。</small></label>
        </>}

        {'authToken' in config && <label>认证令牌<input type="password" value={config.authToken ?? ''} onChange={event => update('authToken', event.target.value)} placeholder="没有设置时留空"/><small>必须与 PetDesktop 或硬件端配置的令牌一致。</small></label>}
      </div>

      <button className="advanced-toggle" onClick={() => setAdvanced(value => !value)}>
        {advanced ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}高级 JSON 配置
      </button>
      {advanced && <><p className="config-warning">高级模式会直接保存下方 JSON，适合调整 debounceMs、cooldownMs、timeoutMs 等参数。</p>
        <textarea value={advancedText} onChange={event => setAdvancedText(event.target.value)} spellCheck={false}/></>}

      <div className="config-footer"><button onClick={() => setEditing(undefined)}>关闭</button><button className="primary" disabled={busy} onClick={() => void save()}><Save size={15}/>保存配置</button></div>
    </article>}

    {busy && <p><LoaderCircle className="spin" size={16}/> 正在执行…</p>}
    {message && <pre className="plugin-output">{message}</pre>}
  </section>;
}
