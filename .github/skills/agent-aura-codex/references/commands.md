# AgentAura Codex 命令速查

## 安装与打包

```bash
cd /home/xuyd2/Git/open/AgentAura/Agent_Plugin/agent-aura-codex
npm install
npm run compile
chmod +x scripts/pack.sh
./scripts/pack.sh
npm install -g ./dist/agent-aura-codex-0.1.0.tgz
```

## 配置连接

```bash
agent-aura-codex config init
agent-aura-codex config path
agent-aura-codex config get
agent-aura-codex configure --discover
agent-aura-codex configure --transport http --host 192.168.1.100 --port 80
agent-aura-codex configure --transport udp --host 192.168.1.100 --port 8888
agent-aura-codex configure --transport serial --serial-port /dev/ttyACM0 --baud 115200
```

## Hooks 与测试

```bash
agent-aura-codex install-hooks
agent-aura-codex status
agent-aura-codex status --probe
agent-aura-codex test running
agent-aura-codex test busy
agent-aura-codex test waiting
agent-aura-codex test idle
```

## 开关与移除

```bash
agent-aura-codex off
agent-aura-codex on
agent-aura-codex config set --enabled false
agent-aura-codex config set --enabled true
agent-aura-codex uninstall-hooks
agent-aura-codex hooks uninstall
npm uninstall -g agent-aura-codex
rm -f ~/.codex/agent-aura-codex.json ~/.codex/agent-aura-codex-state.json ~/.codex/agent-aura-codex.disabled
```

## 串口辅助命令

```bash
ls -1 /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || true
node -e "const {SerialPort}=require('serialport'); SerialPort.list().then(ports=>console.log(JSON.stringify(ports,null,2)))"
sudo usermod -aG dialout "$USER"
```
