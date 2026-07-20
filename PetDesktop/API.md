# PetDesktop 接口文档（纯接口版）

## 目录

- [1. 范围与端点](#1-范围与端点)
- [2. 通用约定](#2-通用约定)
- [3. 文本命令协议](#3-文本命令协议)
- [4. HTTP API](#4-http-api)
- [5. UDP API](#5-udp-api)
- [6. 统一状态 JSON](#6-统一状态-json)
- [7. 鉴权与访问控制](#7-鉴权与访问控制)
- [8. 错误语义](#8-错误语义)
- [9. 与 ESP32 固件接口对照](#9-与-esp32-固件接口对照)

---

## 1. 范围与端点

本文仅描述 PetDesktop 对外可调用接口：

- HTTP 服务：`47831`
- UDP 服务：`8888`

默认监听行为：

- HTTP：`127.0.0.1:47831`（启用 LAN 后监听 `0.0.0.0:47831`）
- UDP：`0.0.0.0:8888`

---

## 2. 通用约定

### 2.1 状态枚举

- `init`
- `running`
- `busy`
- `waiting`
- `idle`
- `error`
- `offline`
- `upgrade`

### 2.2 文本响应约定

- 成功：`OK ...`
- 失败：`ERR ...`

---

## 3. 文本命令协议

格式：

```text
<command> [args...]
```

### 3.1 本地处理命令

- `state`
- `agent <state>`

### 3.2 透传命令白名单

- `rgb ...`
- `effect ...`
- `brightness ...`
- `brt ...`
- `speed ...`
- `spd ...`
- `power ...`
- `reset`

说明：白名单命令会转发到当前硬件传输配置（HTTP/UDP/Serial/BLE）。

### 3.3 不支持命令

- `factory`
- `wifi SSID,PASSWORD`
- `help`

---

## 4. HTTP API

### 4.1 `GET /health`

响应示例：

```json
{
  "ok": true,
  "device": "PetDesktop",
  "model": "AgentAura-PetDesktop",
  "version": "0.1.0",
  "state": "idle"
}
```

### 4.2 `GET /api/state`

返回统一状态 JSON，结构见第 6 节。

### 4.3 `POST /api/agent?state=<state>`

行为：上报/更新状态。

成功响应示例：

```text
OK agent busy
```

### 4.4 `POST /api/cmd`

请求头：`Content-Type: text/plain`

请求体：文本命令（见第 3 节）。

行为：

- `state`：返回状态 JSON。
- `agent <state>`：更新状态。
- 白名单命令：转发到硬件桥。
- 非白名单命令：`400`。

### 4.5 `POST /api/v1/agents/register`

请求体：

```json
{
  "instanceId": "codex-main",
  "clientId": "codex",
  "displayName": "Codex",
  "version": "1.2.3",
  "state": "running",
  "sessionId": "session-001"
}
```

响应体：

```json
{
  "ok": true,
  "instanceId": "codex-main",
  "heartbeatIntervalMs": 10000
}
```

### 4.6 `POST /api/v1/agents/{instanceId}/heartbeat`

响应体：

```json
{
  "ok": true
}
```

### 4.7 `POST /api/v1/agents/{instanceId}/state`

请求体：

```json
{
  "state": "waiting",
  "sessionId": "session-001"
}
```

响应体：

```json
{
  "ok": true,
  "state": "waiting"
}
```

### 4.8 `GET /api/v1/agents`

响应体字段：

- `ok: boolean`
- `agents: AgentInstance[]`
- `effectiveState: AgentState`
- `effectiveAgentId?: string`
- `lockedAgentId?: string`

### 4.9 `PUT /api/v1/agents/selection`

请求体：

```json
{
  "instanceId": "codex-main"
}
```

允许 `instanceId = null` 清除锁定。

响应体：

```json
{
  "ok": true
}
```

### 4.10 `DELETE /api/v1/agents/{instanceId}`

响应体：

```json
{
  "ok": true
}
```

### 4.11 `POST /api/v1/agents/{instanceId}/message`

发送桌宠文字气泡消息摘要。向后兼容：旧插件不发送消息时继续正常工作，仅展示状态模板。

请求体：

```json
{
  "kind": "activity",
  "text": "正在运行 cargo test",
  "priority": 20,
  "ttlMs": 5000
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `kind` | `string` | 是 | 消息分类：`state` / `activity` / `success` / `warning` / `error` |
| `text` | `string` | 是 | 消息文本，最大 500 个 Unicode 字符（超出自动截断） |
| `priority` | `number` | 否 | 优先级，数字越大越优先。未提供时按 `kind` 默认：error=80, warning=60, success/state=40, activity=20 |
| `ttlMs` | `number` | 否 | 显示时长（毫秒），限制在 1500–30000 之间。未提供时使用气泡设置中的显示时长 |

处理规则：

- 必须复用现有 Agent 身份、来源限制和认证逻辑。
- 未注册 Agent 返回 `404`。
- LAN 模式继续遵守现有 Token 验证。
- 同内容在 1.5 秒内去重。
- 高优先级消息可以替换低优先级消息。
- 每个 Agent 保留最多 20 条内存消息。
- 消息来源从请求头 `x-agentaura-name` / `x-agentaura-client` 提取。

响应体：

```json
{
  "ok": true
}
```

---

## 5. UDP API

监听：`0.0.0.0:8888`

### 5.1 发现命令

- `discover`
- `ping`
- `who`

响应示例：

```json
{
  "id": "petdesktop-local",
  "mac": "petdesktop-local",
  "device": "PetDesktop",
  "model": "AgentAura-PetDesktop",
  "fw": "0.1.0",
  "ip": "192.168.1.20",
  "udp": 8888,
  "http": 47831,
  "effect": "idle",
  "caps": ["legacy-http", "legacy-udp", "agent-v1", "local-desktop"]
}
```

### 5.2 通用命令

- `state`
- `agent <state>`
- 白名单透传命令（见第 3.2 节）

### 5.3 远程调用鉴权格式

当请求源不是 loopback 且已配置 token 时：

```text
auth <token> <command>
```

认证失败示例：

```text
ERR unauthorized
```

---

## 6. 统一状态 JSON

响应字段：

- `device: string`
- `model: string`
- `firmware: string`
- `uptime: number`
- `wifi.connected: boolean`
- `wifi.ip: string`
- `wifi.mode: string`
- `led.power: boolean`
- `led.brightness: number`
- `led.speed: number`
- `current.effect: string`
- `current.agentState: AgentState`
- `current.agentId?: string`
- `connections.http: boolean`
- `connections.udp: boolean`
- `connections.serial: boolean`
- `connections.hardware: boolean`
- `pet: object | null`
- `agents: number`

示例：

```json
{
  "device": "PetDesktop",
  "model": "AgentAura-PetDesktop",
  "firmware": "0.1.0",
  "uptime": 0,
  "wifi": {
    "connected": false,
    "ip": "127.0.0.1",
    "mode": "loopback"
  },
  "led": {
    "power": true,
    "brightness": 255,
    "speed": 80
  },
  "current": {
    "effect": "idle",
    "agentState": "idle",
    "agentId": "codex-main"
  },
  "connections": {
    "http": true,
    "udp": true,
    "serial": false,
    "hardware": false
  },
  "pet": {
    "id": "builtin-aura",
    "displayName": "Aura"
  },
  "agents": 1
}
```

---

## 7. 鉴权与访问控制

### 7.1 HTTP

- loopback 请求：允许。
- 非 loopback 请求：仅 `lanEnabled=true` 时允许。
- 配置 `lanToken` 后：必须携带 `Authorization: Bearer <token>`。

浏览器请求的 `Origin` 仅允许：

- `tauri://localhost`
- `http://tauri.localhost`
- `https://tauri.localhost`
- `http://localhost:1420`

### 7.2 UDP

- 发现命令可匿名调用。
- 非 loopback 且 `lanEnabled=false`：拒绝。
- 非 loopback 且已配置 token：必须使用 `auth <token> <command>`。

---

## 8. 错误语义

### 8.1 HTTP

- `400 Bad Request`：参数错误、状态非法、命令不支持、请求体非 UTF-8。
- `401 Unauthorized`：token 缺失或无效。
- `403 Forbidden`：LAN 关闭但远程访问，或 Origin 不受信任。
- `404 Not Found`：实例不存在。
- `413 Payload Too Large`：`/api/cmd` 超过 8 KiB。
- `503 Service Unavailable`：硬件桥不可用。

错误体格式：

```json
{
  "ok": false,
  "error": "message"
}
```

### 8.2 UDP

- 认证失败：`ERR unauthorized`
- 不支持命令：`ERR unsupported command`
- 透传失败：`ERR ...`

---

## 9. 与 ESP32 固件接口对照

### 9.1 共同支持

- `state`
- `agent <state>`
- `POST /api/cmd` 文本命令入口
- UDP 发现：`discover/ping/who`
- 灯控命令：`rgb/effect/brightness/speed/power/reset`

### 9.2 PetDesktop 额外接口

- `POST /api/v1/agents/register`
- `POST /api/v1/agents/{instanceId}/heartbeat`
- `POST /api/v1/agents/{instanceId}/state`
- `POST /api/v1/agents/{instanceId}/message`
- `GET /api/v1/agents`
- `PUT /api/v1/agents/selection`
- `DELETE /api/v1/agents/{instanceId}`

### 9.3 固件接口（PetDesktop 不提供）

- `factory`
- `wifi SSID,PASSWORD`
- `help`
- MQTT/WLED 通道
