// -*- coding: utf-8 -*-
// AgentAura plugin frontend — connection configuration page.
//
// React + antd are injected by the QwenPaw console host at runtime; vite
// `external`s them so nothing here is bundled. The type-only import below
// gives `React.useState<T>()` real generic signatures (erased at build).
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;
const getApiUrl = host.getApiUrl;
const getApiToken = host.getApiToken;

const {
  Button,
  Card,
  Space,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Table,
  Typography,
  Tag,
  message,
  Divider,
  Alert,
} = antd;
const { Title, Text: AntText, Paragraph } = Typography;

// ------------------------------------------------------------------ helpers

/** Mirror of console/src/api/authHeaders.ts — inject agent scope. */
function getSelectedAgentId(): string | null {
  try {
    const raw =
      window.sessionStorage?.getItem("qwenpaw-agent-storage") ??
      window.localStorage?.getItem("qwenpaw-agent-storage");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const selected = parsed?.state?.selectedAgent;
    return typeof selected === "string" && selected ? selected : null;
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const t = getApiToken?.();
  if (t) headers.Authorization = `Bearer ${t}`;
  const agentId = getSelectedAgentId();
  if (agentId) headers["X-Agent-Id"] = agentId;
  return headers;
}

async function apiGet(path: string): Promise<any> {
  const res = await fetch(getApiUrl(path), { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function apiPost(path: string, body: object): Promise<any> {
  const res = await fetch(getApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(typeof data?.detail === "string" ? data.detail : text);
  }
  return data;
}

// ------------------------------------------------------------------ types

type Transport = "http" | "udp" | "serial";

interface ClientStatus {
  configured: boolean;
  transport: Transport;
  host?: string;
  port?: number;
  serial_port?: string;
  baud?: number;
  auth_token?: string;
  reachable: boolean;
  device_state?: any;
}

interface DiscoveredDevice {
  device?: string;
  model?: string;
  fw?: string;
  ip: string;
  mac?: string;
  udp?: number;
  http?: number;
  effect?: string;
}

interface SerialPortInfo {
  device: string;
  description: string;
  manufacturer?: string;
  vid?: string | null;
  pid?: string | null;
}

// Default ports per transport — kept in sync with plugin.json meta.
const DEFAULT_PORT: Record<Transport, number> = {
  http: 80,
  udp: 8888,
  serial: 115200,
};

const TRANSPORT_LABEL: Record<Transport, string> = {
  http: "HTTP (WiFi REST)",
  udp: "UDP (WiFi 数据报)",
  serial: "USB 串口 (CDC)",
};

const AGENT_STATES = [
  "running",
  "busy",
  "waiting",
  "error",
  "idle",
  "init",
  "offline",
  "upgrade",
] as const;

// ------------------------------------------------------------------ page

function RingLightConfigPage() {
  const [form] = Form.useForm();
  const [status, setStatus] = React.useState<ClientStatus | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [devices, setDevices] = React.useState<DiscoveredDevice[]>([]);
  const [discovering, setDiscovering] = React.useState(false);
  const [serialPorts, setSerialPorts] = React.useState<SerialPortInfo[]>([]);
  const [portsLoading, setPortsLoading] = React.useState(false);
  const [transport, setTransport] = React.useState<Transport>("http");
  const [testing, setTesting] = React.useState<string | null>(null);

  // --- refresh status from backend
  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const st = await apiGet("/agentaura/status");
      const client: ClientStatus = st.client ?? {};
      setStatus(client);
      // Sync the form with the backend's current config so the UI always
      // reflects what the device is actually using.
      const t: Transport = (client.transport as Transport) || "http";
      setTransport(t);
      form.setFieldsValue({
        transport: t,
        host: client.host || "",
        port: client.port ?? DEFAULT_PORT[t],
        serial_port: client.serial_port || "",
        baud: client.baud ?? 115200,
        auth_token: client.auth_token || "",
        auto_discover: true,
        debounce_ms: 500,
      });
    } catch (e: any) {
      message.error(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [form]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // --- discover devices via UDP broadcast
  const discover = async () => {
    setDiscovering(true);
    try {
      const r = await apiGet("/agentaura/devices");
      setDevices(r.devices || []);
      if ((r.devices || []).length === 0) {
        message.info("未发现设备，请确认设备已通电并连接到同一局域网");
      } else {
        message.success(`发现 ${(r.devices || []).length} 个设备`);
      }
    } catch (e: any) {
      message.error(e?.message || String(e));
    } finally {
      setDiscovering(false);
    }
  };

  // --- enumerate serial ports
  const listSerialPorts = async () => {
    setPortsLoading(true);
    try {
      const r = await apiGet("/agentaura/serial-ports");
      setSerialPorts(r.ports || []);
      if ((r.ports || []).length === 0) {
        message.info(
          "未发现串口，请确认设备已通过 USB 连接并被系统识别",
        );
      }
    } catch (e: any) {
      message.error(e?.message || String(e));
    } finally {
      setPortsLoading(false);
    }
  };

  React.useEffect(() => {
    if (transport === "serial" && serialPorts.length === 0) {
      void listSerialPorts();
    }
  }, [transport]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- save config
  const saveConfig = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      await apiPost("/agentaura/connection-config", {
        transport: values.transport,
        host: values.host || "",
        port: values.port ?? null,
        serial_port: values.serial_port || "",
        baud: values.baud ?? null,
        debounce_ms: values.debounce_ms ?? 500,
        auth_token: values.auth_token || "",
        auto_discover: !!values.auto_discover,
      });
      message.success("配置已保存");
      await refresh();
    } catch (e: any) {
      if (e?.errorFields) return; // form validation error — already shown
      message.error(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  // --- quick-fill from a discovered device
  const useDevice = (d: DiscoveredDevice) => {
    form.setFieldsValue({
      transport: "http" as Transport,
      host: d.ip,
      port: d.http ?? 80,
    });
    setTransport("http");
    message.success(`已填入 ${d.ip}，点击「保存配置」生效`);
  };

  // --- test an agent state
  const testAgent = async (state: string) => {
    setTesting(state);
    try {
      await apiPost("/agentaura/agent", { state });
      message.success(`已发送 agent ${state}`);
    } catch (e: any) {
      message.error(e?.message || String(e));
    } finally {
      setTesting(null);
    }
  };

  const reachable = status?.reachable === true;
  const configured = status?.configured === true;

  // Port field default changes with transport — update on transport change.
  const onTransportChange = (t: Transport) => {
    setTransport(t);
    const cur = form.getFieldValue("port");
    // Only auto-adjust port when the user hasn't overridden it to a
    // non-default value for the previous transport.
    if (
      cur === DEFAULT_PORT["http"] ||
      cur === DEFAULT_PORT["udp"] ||
      cur === undefined
    ) {
      form.setFieldValue("port", DEFAULT_PORT[t]);
    }
  };

  // --- discovered devices table columns
  const deviceColumns = [
    { title: "设备", dataIndex: "device", key: "device" },
    { title: "IP", dataIndex: "ip", key: "ip" },
    { title: "MAC", dataIndex: "mac", key: "mac" },
    { title: "HTTP", dataIndex: "http", key: "http" },
    { title: "固件", dataIndex: "fw", key: "fw" },
    {
      title: "操作",
      key: "action",
      render: (_: unknown, row: DiscoveredDevice) =>
        React.createElement(
          Button,
          {
            type: "link",
            size: "small",
            onClick: () => useDevice(row),
          },
          "填入配置",
        ),
    },
  ];

  return React.createElement(
    Card,
    { style: { maxWidth: 880, margin: "24px auto" } },
    React.createElement(
      Space,
      { direction: "vertical", size: "large", style: { width: "100%" } },
      [
        // ----- header
        React.createElement(
          "div",
          { key: "header" },
          React.createElement(
            Title,
            { level: 3, style: { marginBottom: 4 } },
            "💡 AgentAura",
          ),
          React.createElement(
            Paragraph,
            { type: "secondary", style: { marginBottom: 0 } },
            "将 QwenPaw 智能体生命周期事件实时同步到 ESP32 环形灯。配置连接方式、发现设备、测试灯效。",
          ),
        ),

        // ----- connection status
        React.createElement(
          Card,
          {
            key: "status",
            size: "small",
            title: "连接状态",
            extra: React.createElement(
              Button,
              { size: "small", onClick: () => void refresh(), loading },
              "刷新",
            ),
          },
          React.createElement(
            Space,
            { wrap: true },
            React.createElement(
              Tag,
              { color: configured ? "blue" : "default" },
              configured ? `已配置 (${TRANSPORT_LABEL[status?.transport || "http"]})` : "未配置",
            ),
            React.createElement(
              Tag,
              { color: reachable ? "green" : "red" },
              reachable ? "● 设备在线" : "● 设备离线",
            ),
            status?.host &&
              React.createElement(AntText, { type: "secondary" }, `Host: ${status.host}`),
            status?.serial_port &&
              React.createElement(
                AntText,
                { type: "secondary" },
                `串口: ${status.serial_port}`,
              ),
            status?.device_state?.current?.effect &&
              React.createElement(
                AntText,
                { type: "secondary" },
                `灯效: ${status.device_state.current.effect}`,
              ),
          ),
        ),

        // ----- connection config form
        React.createElement(
          Card,
          { key: "config", size: "small", title: "连接配置" },
          React.createElement(
            Form,
            {
              form,
              layout: "vertical",
              initialValues: {
                transport: "http",
                port: 80,
                baud: 115200,
                auto_discover: true,
                debounce_ms: 500,
              },
            },
            React.createElement(
              Form.Item,
              {
                name: "transport",
                label: "连接方式",
                tooltip: "HTTP/UDP 需要设备连接 WiFi；串口需要 USB 连线",
              },
              React.createElement(
                Select,
                {
                  onChange: onTransportChange,
                  options: (Object.keys(TRANSPORT_LABEL) as Transport[]).map(
                    (t) => ({ value: t, label: TRANSPORT_LABEL[t] }),
                  ),
                },
              ),
            ),

            // Network fields (http / udp)
            (transport === "http" || transport === "udp") &&
              React.createElement(
                "div",
                { key: "net" },
                React.createElement(
                  Form.Item,
                  {
                    name: "host",
                    label: "设备 IP / 主机名",
                    rules: [{ required: true, message: "请输入设备 IP 或主机名" }],
                  },
                  React.createElement(Input, {
                    placeholder: "192.168.1.100 或 ringlight.local",
                  }),
                ),
                React.createElement(
                  Form.Item,
                  { name: "port", label: `端口 (默认 ${DEFAULT_PORT[transport]})` },
                  React.createElement(InputNumber, {
                    min: 1,
                    max: 65535,
                    style: { width: "100%" },
                    placeholder: String(DEFAULT_PORT[transport]),
                  }),
                ),
              ),

            // Serial fields
            transport === "serial" &&
              React.createElement(
                "div",
                { key: "serial" },
                React.createElement(
                  Alert,
                  {
                    type: "info",
                    showIcon: true,
                    style: { marginBottom: 16 },
                    message: "USB 串口模式",
                    description:
                      "pyserial 会在安装插件时自动安装。设备通过 USB 连接到本机，无需 WiFi。",
                  },
                ),
                React.createElement(
                  Form.Item,
                  {
                    name: "serial_port",
                    label: "串口",
                    rules: [{ required: true, message: "请选择或输入串口" }],
                  },
                  React.createElement(Select, {
                    showSearch: true,
                    placeholder: "选择串口或手动输入",
                    loading: portsLoading,
                    onDropdownVisibleChange: (open: boolean) => {
                      if (open) void listSerialPorts();
                    },
                    options: serialPorts.map((p) => ({
                      value: p.device,
                      label: `${p.device} — ${p.description}`,
                    })),
                    notFoundContent:
                      serialPorts.length === 0
                        ? "未发现串口设备"
                        : undefined,
                  }),
                ),
                React.createElement(
                  Form.Item,
                  { name: "baud", label: "波特率 (固件默认 115200)" },
                  React.createElement(InputNumber, {
                    min: 1200,
                    max: 4000000,
                    style: { width: "100%" },
                  }),
                ),
              ),

            React.createElement(
              Form.Item,
              {
                name: "auto_discover",
                label: "启动时自动发现设备",
                valuePropName: "checked",
                tooltip: "通过 UDP 广播自动查找局域网内的设备（仅 http/udp 模式）",
              },
              React.createElement(Switch, { disabled: transport === "serial" }),
            ),

            React.createElement(
              Form.Item,
              {
                name: "debounce_ms",
                label: "状态去抖 (ms)",
                tooltip: "相同状态在该时间窗口内不重复发送，避免灯效重启闪烁",
              },
              React.createElement(InputNumber, {
                min: 0,
                max: 60000,
                style: { width: "100%" },
              }),
            ),

            React.createElement(
              Form.Item,
              {
                name: "auth_token",
                label: "Auth Token",
                tooltip:
                  "HTTP 请求的 Bearer Token。设备无认证时留空。",
              },
              React.createElement(Input.Password, {
                placeholder: "留空表示不使用认证",
                visibilityToggle: true,
              }),
            ),

            React.createElement(
              Space,
              null,
              React.createElement(
                Button,
                {
                  type: "primary",
                  onClick: () => void saveConfig(),
                  loading: saving,
                },
                "保存配置",
              ),
              React.createElement(
                Button,
                { onClick: () => void refresh() },
                "重置为当前",
              ),
            ),
          ),
        ),

        // ----- device discovery
        (transport === "http" || transport === "udp") &&
          React.createElement(
            Card,
            {
              key: "discovery",
              size: "small",
              title: "设备发现 (UDP 广播)",
              extra: React.createElement(
                Button,
                {
                  size: "small",
                  onClick: () => void discover(),
                  loading: discovering,
                },
                "扫描设备",
              ),
            },
            devices.length === 0
              ? React.createElement(
                  AntText,
                  { type: "secondary" },
                  "点击「扫描设备」搜索局域网内的 ESP32环形灯 设备",
                )
              : React.createElement(Table, {
                  rowKey: "ip",
                  size: "small",
                  dataSource: devices,
                  columns: deviceColumns,
                  pagination: false,
                }),
          ),

        // ----- test controls
        React.createElement(
          Card,
          { key: "test", size: "small", title: "灯效测试" },
          React.createElement(
            Space,
            { wrap: true },
            ...AGENT_STATES.map((s) =>
              React.createElement(
                Button,
                {
                  key: s,
                  size: "small",
                  loading: testing === s,
                  onClick: () => void testAgent(s),
                  disabled: !configured,
                },
                `agent ${s}`,
              ),
            ),
          ),
          React.createElement(Divider, { style: { margin: "12px 0" } }),
          React.createElement(
            AntText,
            { type: "secondary", style: { fontSize: 12 } },
            "点击按钮发送 agent 状态指令，验证灯效是否正常。设备离线时按钮无效。",
          ),
        ),
      ],
    ),
  );
}

// ------------------------------------------------------------------ register

class AgentAuraPlugin {
  readonly id = "agentaura";

  setup(): void {
    window.QwenPaw.registerRoutes?.(this.id, [
      {
        path: "/plugin/agentaura/config",
        component: RingLightConfigPage,
        label: "AgentAura",
        icon: "💡",
        priority: 42,
      },
    ]);
  }
}

new AgentAuraPlugin().setup();
