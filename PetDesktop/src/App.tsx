import { useCallback, useEffect, useMemo, useState } from 'react';
import { confirm, open } from '@tauri-apps/plugin-dialog';
import {
  Bot,
  Box,
  CircleAlert,
  Cpu,
  Gauge,
  HardDrive,
  HeartPulse,
  LoaderCircle,
  Lock,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Trash2,
  Unlock,
  Usb,
  Wifi,
} from 'lucide-react';
import { api, onSnapshot } from './api';
import {
  AGENT_STATES,
  STATE_LABELS,
  type AgentState,
  type AppSettings,
  type AppSnapshot,
  type DiscoveredHardware,
  type SerialPortInfo,
} from './types';

type Tab = 'overview' | 'agents' | 'pets' | 'hardware' | 'settings' | 'logs';

const tabItems: Array<{ id: Tab; label: string; icon: typeof Gauge }> = [
  { id: 'overview', label: '概览', icon: Gauge },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'pets', label: '宠物', icon: HeartPulse },
  { id: 'hardware', label: '硬件', icon: Cpu },
  { id: 'settings', label: '设置', icon: Settings },
  { id: 'logs', label: '日志', icon: HardDrive },
];

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api.snapshot());
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    let stop: (() => void) | undefined;
    void onSnapshot(setSnapshot).then(unlisten => { stop = unlisten; });
    return () => stop?.();
  }, [refresh]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (!snapshot) {
    return <div className="loading"><LoaderCircle className="spin" />正在启动 PetDesktop…</div>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div><strong>AgentAura</strong><span>PetDesktop</span></div>
        </div>
        <nav>
          {tabItems.map(item => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
                <Icon size={18} />{item.label}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <span className={`status-dot ${snapshot.hardware.connected ? 'online' : ''}`} />
          <span>{snapshot.hardware.connected ? '硬件已连接' : '桌宠独立运行'}</span>
          <small>v{snapshot.version}</small>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">CURRENT STATE</p>
            <h1>{STATE_LABELS[snapshot.effectiveState]}</h1>
          </div>
          <div className="top-actions">
            <span className={`state-pill state-${snapshot.effectiveState}`}>{snapshot.effectiveState}</span>
            <button className="icon-button" disabled={busy} onClick={() => run(() => api.setPaused(!snapshot.paused))} title={snapshot.paused ? '恢复同步' : '暂停同步'}>
              {snapshot.paused ? <Play size={18} /> : <Pause size={18} />}
            </button>
            <button className="icon-button" disabled={busy} onClick={refresh} title="刷新"><RefreshCw size={18} /></button>
          </div>
        </header>

        {error && <div className="error-banner"><CircleAlert size={17} />{error}</div>}

        {tab === 'overview' && <Overview snapshot={snapshot} run={run} />}
        {tab === 'agents' && <Agents snapshot={snapshot} run={run} />}
        {tab === 'pets' && <Pets snapshot={snapshot} run={run} />}
        {tab === 'hardware' && <Hardware snapshot={snapshot} run={run} />}
        {tab === 'settings' && <SettingsPanel snapshot={snapshot} run={run} />}
        {tab === 'logs' && <Logs snapshot={snapshot} />}
      </main>
    </div>
  );
}

type Run = (action: () => Promise<unknown>) => Promise<void>;

function Overview({ snapshot, run }: { snapshot: AppSnapshot; run: Run }) {
  const current = snapshot.agents.find(agent => agent.instanceId === snapshot.effectiveAgentId);
  return (
    <section className="page-grid">
      <article className="hero-card">
        <div className={`aura-orb state-${snapshot.effectiveState}`}><span>✦</span></div>
        <div>
          <p className="eyebrow">ACTIVE SOURCE</p>
          <h2>{current?.displayName ?? 'PetDesktop'}</h2>
          <p>{current ? `${current.clientId} · ${current.instanceId}` : '等待 Agent 连接，本地手动状态生效中。'}</p>
        </div>
      </article>
      <article className="metric-card"><Bot /><span>在线 Agents</span><strong>{snapshot.agents.filter(a => a.connected).length}</strong></article>
      <article className="metric-card"><Box /><span>已安装宠物</span><strong>{snapshot.pets.length}</strong></article>
      <article className="metric-card"><Radio /><span>控制服务</span><strong>47831</strong></article>

      <article className="panel span-2">
        <div className="panel-title"><div><p className="eyebrow">MANUAL CONTROL</p><h2>状态测试</h2></div></div>
        <div className="state-buttons">
          {AGENT_STATES.map(state => (
            <button key={state} className={`state-button state-${state}`} onClick={() => run(() => api.setAgentState(state))}>
              <span />{STATE_LABELS[state]}<small>{state}</small>
            </button>
          ))}
        </div>
      </article>

      <article className="panel">
        <div className="panel-title"><div><p className="eyebrow">BRIDGE</p><h2>硬件同步</h2></div></div>
        <dl className="summary-list">
          <div><dt>传输</dt><dd>{snapshot.settings.hardware.transport}</dd></div>
          <div><dt>连接</dt><dd>{snapshot.hardware.connected ? '正常' : '未连接'}</dd></div>
          <div><dt>最近成功</dt><dd>{snapshot.hardware.lastSuccessAt ?? '—'}</dd></div>
        </dl>
        {snapshot.hardware.lastError && <p className="inline-error">{snapshot.hardware.lastError}</p>}
      </article>
    </section>
  );
}

function Agents({ snapshot, run }: { snapshot: AppSnapshot; run: Run }) {
  return (
    <section className="panel full-panel">
      <div className="panel-title">
        <div><p className="eyebrow">CONNECTED CLIENTS</p><h2>Agent 实例</h2></div>
        <span className="muted">心跳超过 30 秒自动离线</span>
      </div>
      {snapshot.agents.length === 0 ? <Empty text="尚无 Agent 连接。升级后的插件会在启动时自动注册。" /> : (
        <div className="agent-list">
          {snapshot.agents.map(agent => {
            const locked = snapshot.lockedAgentId === agent.instanceId;
            const effective = snapshot.effectiveAgentId === agent.instanceId;
            return (
              <div className={`agent-row ${effective ? 'effective' : ''}`} key={agent.instanceId}>
                <div className="agent-icon"><Bot size={20} /></div>
                <div className="agent-main">
                  <strong>{agent.displayName}</strong>
                  <span>{agent.clientId} · {agent.instanceId}</span>
                </div>
                <span className={`status-dot ${agent.connected ? 'online' : ''}`} />
                <span className={`state-pill state-${agent.state}`}>{STATE_LABELS[agent.state]}</span>
                <time>{agent.lastSeenAt}</time>
                <button className="icon-button" title={locked ? '解除锁定' : '锁定此来源'} onClick={() => run(() => api.setLockedAgent(locked ? undefined : agent.instanceId))}>
                  {locked ? <Lock size={17} /> : <Unlock size={17} />}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Pets({ snapshot, run }: { snapshot: AppSnapshot; run: Run }) {
  const installSource = (source: string) => run(async () => {
    try {
      await api.installPet(source);
    } catch (cause) {
      if (!String(cause).includes('already installed')) throw cause;
      const replace = await confirm('同 ID 的宠物已经安装，是否覆盖？', { title: '覆盖宠物', kind: 'warning' });
      if (replace) await api.installPet(source, true);
    }
  });
  const install = async () => {
    const selected = await open({ multiple: false, directory: false, filters: [{ name: 'Codex Pet', extensions: ['zip'] }] });
    if (selected) await installSource(selected);
  };
  const installFolder = async () => {
    const selected = await open({ multiple: false, directory: true });
    if (selected) await installSource(selected);
  };
  return (
    <section className="panel full-panel">
      <div className="panel-title">
        <div><p className="eyebrow">PET LIBRARY</p><h2>宠物管理</h2></div>
        <div className="button-group">
          <button className="secondary" onClick={installFolder}><Plus size={16} />安装目录</button>
          <button className="primary" onClick={install}><Plus size={16} />安装 ZIP</button>
        </div>
      </div>
      <div className="pet-grid">
        {snapshot.pets.map(pet => (
          <article className={`pet-card ${snapshot.settings.selectedPetId === pet.id ? 'selected' : ''}`} key={pet.id}>
            <div className="pet-preview">{pet.builtIn ? '✦' : '🐾'}</div>
            <div><strong>{pet.displayName}</strong><p>{pet.description}</p><small>{pet.columns}×{pet.rows} · {pet.frameWidth}×{pet.frameHeight}</small></div>
            <div className="pet-actions">
              <button className="secondary" disabled={snapshot.settings.selectedPetId === pet.id} onClick={() => run(() => api.selectPet(pet.id))}>使用</button>
              {!pet.builtIn && <button className="danger-icon" title="删除" onClick={() => run(() => api.deletePet(pet.id))}><Trash2 size={16} /></button>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Hardware({ snapshot, run }: { snapshot: AppSnapshot; run: Run }) {
  const [form, setForm] = useState<AppSettings>(snapshot.settings);
  const [devices, setDevices] = useState<DiscoveredHardware[]>([]);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  useEffect(() => setForm(snapshot.settings), [snapshot.settings]);
  const patchHardware = (patch: Partial<AppSettings['hardware']>) => setForm(value => ({ ...value, hardware: { ...value.hardware, ...patch } }));
  const scan = async () => {
    const [found, serial] = await Promise.all([api.discoverHardware(), api.serialPorts()]);
    setDevices(found);
    setPorts(serial);
  };
  return (
    <section className="split-layout">
      <article className="panel">
        <div className="panel-title"><div><p className="eyebrow">ACTIVE DEVICE</p><h2>硬件连接</h2></div><span className={`status-dot ${snapshot.hardware.connected ? 'online' : ''}`} /></div>
        <div className="segmented">
          {(['disabled', 'http', 'udp', 'serial'] as const).map(transport => <button className={form.hardware.transport === transport ? 'active' : ''} key={transport} onClick={() => patchHardware({ transport })}>{transport}</button>)}
        </div>
        {form.hardware.transport === 'http' || form.hardware.transport === 'udp' ? <>
          <label>主机地址<input value={form.hardware.host} placeholder="192.168.1.100" onChange={event => patchHardware({ host: event.target.value })} /></label>
          <label>端口<input type="number" value={form.hardware.port} onChange={event => patchHardware({ port: Number(event.target.value) })} /></label>
        </> : null}
        {form.hardware.transport === 'serial' && <>
          <label>串口<select value={form.hardware.serialPort} onChange={event => patchHardware({ serialPort: event.target.value })}><option value="">选择串口</option>{ports.map(port => <option key={port.name} value={port.name}>{port.name} · {port.portType}</option>)}</select></label>
          <label>波特率<input type="number" value={form.hardware.baud} onChange={event => patchHardware({ baud: Number(event.target.value) })} /></label>
        </>}
        <div className="form-actions"><button className="secondary" onClick={() => void scan()}><RefreshCw size={16} />扫描</button><button className="primary" onClick={() => run(() => api.saveSettings(form))}>保存连接</button><button className="secondary" onClick={() => run(() => api.testHardware())}>测试</button></div>
        {snapshot.hardware.lastError && <p className="inline-error">{snapshot.hardware.lastError}</p>}
      </article>
      <article className="panel">
        <div className="panel-title"><div><p className="eyebrow">DISCOVERY</p><h2>发现结果</h2></div></div>
        {devices.length === 0 && ports.length === 0 ? <Empty text="点击扫描查找局域网设备和本机串口。" /> : <div className="device-list">
          {devices.map(device => <button key={`${device.ip}-${device.mac}`} onClick={() => patchHardware({ transport: 'http', host: device.ip, port: device.http ?? 80 })}><Wifi /><span><strong>{device.device ?? device.model ?? 'AgentAura'}</strong><small>{device.ip}:{device.http ?? 80}</small></span></button>)}
          {ports.map(port => <button key={port.name} onClick={() => patchHardware({ transport: 'serial', serialPort: port.name, baud: 115200 })}><Usb /><span><strong>{port.name}</strong><small>{port.portType}</small></span></button>)}
        </div>}
      </article>
    </section>
  );
}

function SettingsPanel({ snapshot, run }: { snapshot: AppSnapshot; run: Run }) {
  const [form, setForm] = useState(snapshot.settings);
  useEffect(() => setForm(snapshot.settings), [snapshot.settings]);
  const patch = (value: Partial<AppSettings>) => setForm(current => ({ ...current, ...value }));
  const previewScale = (petScale: number) => {
    patch({ petScale });
    void api.previewPetScale(petScale);
  };
  const generateToken = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    patch({ lanToken: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') });
  };
  return (
    <section className="split-layout">
      <article className="panel settings-form">
        <div className="panel-title"><div><p className="eyebrow">PET BEHAVIOR</p><h2>桌宠行为</h2></div></div>
        <Toggle label="显示宠物" checked={form.petVisible} set={petVisible => patch({ petVisible })} />
        <Toggle label="始终置顶" checked={form.alwaysOnTop} set={alwaysOnTop => patch({ alwaysOnTop })} />
        <Toggle label="随机闲逛" checked={form.roamEnabled} set={roamEnabled => patch({ roamEnabled })} />
        <Toggle label="点击穿透" checked={form.clickThrough} set={clickThrough => patch({ clickThrough })} />
        <label>宠物缩放 <output>{Math.round(form.petScale * 100)}%</output><input type="range" min="0.5" max="2" step="0.05" value={form.petScale} onInput={event => previewScale(Number(event.currentTarget.value))} /></label>
        <label>闲逛间隔（秒）<input type="number" min="10" max="600" value={form.roamIntervalSeconds} onChange={event => patch({ roamIntervalSeconds: Number(event.target.value) })} /></label>
        <label>闲逛速度<input type="number" min="20" max="300" value={form.roamSpeed} onChange={event => patch({ roamSpeed: Number(event.target.value) })} /></label>
      </article>
      <article className="panel settings-form">
        <div className="panel-title"><div><p className="eyebrow">SERVICE</p><h2>服务与启动</h2></div></div>
        <Toggle label="开机启动" checked={form.launchAtStartup} set={launchAtStartup => patch({ launchAtStartup })} />
        <Toggle label="允许局域网访问" checked={form.lanEnabled} set={lanEnabled => patch({ lanEnabled })} />
        <label>HTTP 地址<input readOnly value={form.lanEnabled ? '0.0.0.0:47831' : '127.0.0.1:47831'} /></label>
        {form.lanEnabled && <label>访问令牌（可选）<div className="input-action-row"><input value={form.lanToken} onChange={event => patch({ lanToken: event.target.value })} /><button type="button" className="secondary" onClick={generateToken}><RefreshCw size={15} />生成令牌</button></div></label>}
        <p className="hint">访问令牌留空时允许直接连接；设置后，远程客户端必须发送 Authorization: Bearer &lt;token&gt;。</p>
        <div className="form-actions"><button className="primary" onClick={() => run(() => api.saveSettings(form))}>保存全部设置</button></div>
      </article>
    </section>
  );
}

function Logs({ snapshot }: { snapshot: AppSnapshot }) {
  return <section className="panel full-panel"><div className="panel-title"><div><p className="eyebrow">RUNTIME EVENTS</p><h2>运行日志</h2></div><span className="muted">最多保留 500 条</span></div><div className="log-view">{snapshot.logs.length ? snapshot.logs.map((entry, index) => <div className={`log-row ${entry.level}`} key={`${entry.at}-${index}`}><time>{entry.at}</time><span>{entry.level.toUpperCase()}</span><strong>{entry.source}</strong><p>{entry.message}</p></div>) : <Empty text="暂无运行日志。" />}</div></section>;
}

function Toggle({ label, checked, set }: { label: string; checked: boolean; set: (value: boolean) => void }) {
  return <label className="toggle-row"><span>{label}</span><button type="button" className={`toggle ${checked ? 'on' : ''}`} onClick={() => set(!checked)}><i /></button></label>;
}

function Empty({ text }: { text: string }) {
  return <div className="empty"><Radio size={28} /><p>{text}</p></div>;
}
