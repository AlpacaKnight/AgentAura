#!/usr/bin/env python3
"""
ESP32 Ring Light — BLE + MQTT 接口测试
读取同目录 config.json 的 ble_/mqtt_ 配置项。

依赖:
  pip install bleak paho-mqtt

用法:
  1. 编辑 test/config.json 填写 BLE 设备名 / MQTT broker 地址
  2. python test/test_ble_mqtt.py
"""
import json
import os
import sys
import time

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

class C:
    G="\033[92m"; R="\033[91m"; Y="\033[93m"; B="\033[94m"; BOLD="\033[1m"; END="\033[0m"

passed=0; failed=0
def ok(m):
    global passed; passed+=1; print(f"  {C.G}[OK]{C.END} {m}")
def fail(m,d=""):
    global failed; failed+=1; print(f"  {C.R}[FAIL]{C.END} {m}"+(f" {C.R}({d}){C.END}" if d else ""))
def section(t): print(f"\n{C.BOLD}{C.B}=== {t} ==={C.END}")
def wait(t,l=""):
    if l: print(f"  ... {l} {t}s")
    time.sleep(t)

def load_config():
    if not os.path.exists(CONFIG_PATH):
        print(f"{C.R}错误: 配置文件不存在: {CONFIG_PATH}{C.END}"); sys.exit(1)
    try:
        with open(CONFIG_PATH,"r",encoding="utf-8-sig") as f: return json.load(f)
    except json.JSONDecodeError as e:
        print(f"{C.R}错误: config.json 格式无效: {e}{C.END}"); sys.exit(1)

# ============================================================
#  BLE 测试 (需要 bleak)
# ============================================================
def test_ble(cfg):
    section("BLE 接口测试")

    device_name = cfg.get("ble_device_name","ESP32-Ring").strip()
    svc_uuid    = cfg.get("ble_service_uuid","")
    char_color  = cfg.get("ble_char_color_uuid","")
    char_state  = cfg.get("ble_char_state_uuid","")

    if not device_name or not char_color:
        print(f"  {C.Y}BLE 配置不完整, 跳过{C.END}"); return

    try:
        import asyncio
        from bleak import BleakClient, BleakScanner
    except ImportError:
        print(f"  {C.Y}需要 bleak: pip install bleak{C.END}")
        print(f"  {C.Y}跳过 BLE 测试{C.END}"); return

    async def run():
        # 1. 扫描设备
        print(f"\n[1] 扫描 BLE 设备 (名称含 '{device_name}')...")
        devices = await BleakScanner.discover(timeout=8.0)
        target = None
        for d in devices:
            if device_name in (d.name or ""):
                target = d; break
        if not target:
            # 也尝试完整名称匹配 (带 MAC 后缀)
            for d in devices:
                if d.name and d.name.startswith(device_name):
                    target = d; break
        if target:
            ok(f"发现设备: {target.name} ({target.address})")
        else:
            fail("未找到 BLE 设备", f"扫描到 {len(devices)} 个设备, 无匹配 '{device_name}'")
            print(f"  扫描到的设备:")
            for d in devices:
                print(f"    {d.name or '(无名)'} - {d.address}")
            return

        # 2. 连接并测试
        print(f"\n[2] 连接 {target.name}...")
        async with BleakClient(target.address, timeout=10.0) as client:
            ok(f"已连接, MTU={client.mtu_size}")

            # 3. 读取状态
            print(f"\n[3] 读取 STATE 特征值...")
            try:
                data = await client.read_gatt_char(char_state)
                text = data.decode("utf-8", errors="replace")
                j = json.loads(text)
                ok(f"状态读取成功: device={j.get('device')}, effect={j['current']['effect']}")
            except Exception as e:
                fail("状态读取失败", str(e)[:60])

            # 4. 写入颜色指令
            tests = [
                ("rgb 255,0,0",       "BLE 设红色"),
                ("effect rainbow",    "BLE 切彩虹"),
                ("effect breath 0,255,0", "BLE 绿呼吸"),
                ("brightness 64",     "BLE 调亮度"),
                ("agent error",       "BLE 错误状态"),
                ("power off",         "BLE 关灯"),
                ("power on",          "BLE 开灯"),
            ]
            for i, (cmd, desc) in enumerate(tests):
                print(f"\n[{4+i}] {desc}: '{cmd}'")
                try:
                    await client.write_gatt_char(char_color, cmd.encode("utf-8"), response=True)
                    ok(f"写入成功")
                except Exception as e:
                    fail(f"写入失败", str(e)[:60])
                wait(1.2, f"观察 {desc}")

            # 5. 再次读取状态验证
            print(f"\n[{4+len(tests)}] 读取最终状态...")
            try:
                data = await client.read_gatt_char(char_state)
                j = json.loads(data.decode("utf-8", errors="replace"))
                ok(f"最终: effect={j['current']['effect']}, power={j['led']['power']}")
            except Exception as e:
                fail("最终状态读取失败", str(e)[:60])

    try:
        asyncio.run(run())
    except Exception as e:
        fail(f"BLE 测试异常: {e}")

# ============================================================
#  MQTT 测试 (需要 paho-mqtt)
# ============================================================
def test_mqtt(cfg):
    section("MQTT 接口测试")

    host = cfg.get("mqtt_host","").strip()
    port = cfg.get("mqtt_port",1883)
    user = cfg.get("mqtt_user","").strip()
    pw   = cfg.get("mqtt_pass","").strip()
    topic = cfg.get("mqtt_topic","ring").strip()

    if not host:
        print(f"  {C.Y}未配置 mqtt_host, 跳过 MQTT 测试{C.END}"); return

    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        print(f"  {C.Y}需要 paho-mqtt: pip install paho-mqtt{C.END}")
        print(f"  {C.Y}跳过 MQTT 测试{C.END}"); return

    connected = False
    status_msg = [None]

    def on_connect(c, userdata, flags, rc, props=None):
        nonlocal connected
        connected = (rc == 0)
        if rc == 0:
            ok(f"MQTT 连接成功 ({host}:{port})")
        else:
            fail(f"MQTT 连接失败", f"rc={rc}")

    def on_message(c, userdata, msg):
        status_msg[0] = msg.payload.decode("utf-8", errors="replace")

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.on_message = on_message
    if user:
        client.username_pw_set(user, pw)

    print(f"\n[1] 连接 MQTT Broker {host}:{port}...")
    try:
        client.connect(host, port, 30)
    except Exception as e:
        fail(f"连接失败", str(e)[:60]); return

    client.loop_start()
    wait(2, "等待连接")

    if not connected:
        fail("MQTT 未连接, 终止测试")
        client.loop_stop(); return

    # 2. 订阅 status
    print(f"\n[2] 订阅 {topic}/status...")
    client.subscribe(f"{topic}/status")
    ok("订阅成功")

    # 3. 测试各主题
    def publish(subtopic, payload):
        client.publish(f"{topic}/{subtopic}", payload)
        wait(0.5)

    print(f"\n[3] 发布 {topic}/cmd: 'rgb 255,0,0'")
    publish("cmd", "rgb 255,0,0")
    ok("发布 cmd 成功") if connected else fail("发布失败")
    wait(1, "观察红灯")

    print(f'\n[4] 发布 {topic}/color/set: JSON')
    publish("color/set", json.dumps({"r":0,"g":255,"b":0}))
    ok("发布 color/set 成功")
    wait(1, "观察绿灯")

    print(f'\n[5] 发布 {topic}/effect/set: JSON')
    publish("effect/set", json.dumps({"effect":"breath","r":0,"g":100,"b":255}))
    ok("发布 effect/set 成功")
    wait(2, "观察蓝呼吸")

    print(f'\n[6] 发布 {topic}/brightness/set: "100"')
    publish("brightness/set", "100")
    ok("发布 brightness/set 成功")

    print(f'\n[7] 发布 {topic}/speed/set: "200"')
    publish("speed/set", "200")
    ok("发布 speed/set 成功")
    wait(1, "观察加速")

    print(f'\n[8] 发布 {topic}/cmd: "agent error"')
    publish("cmd", "agent error")
    ok("发布 agent error 成功")
    wait(2, "观察红色闪烁")

    # 9. 等待 status 上报
    print(f"\n[9] 等待 {topic}/status 上报...")
    wait(3, "等待状态上报")
    if status_msg[0]:
        try:
            j = json.loads(status_msg[0])
            ok(f"收到状态: effect={j['current']['effect']}, power={j['led']['power']}")
        except:
            ok(f"收到状态: {status_msg[0][:60]}")
    else:
        print(f"  {C.Y}(未收到 status 上报, 可能固件未配置 MQTT 或未触发状态变更){C.END}")

    client.loop_stop()
    client.disconnect()

# ============================================================
#  主程序
# ============================================================
def main():
    cfg = load_config()
    host = cfg.get("host","").strip()
    ble_name = cfg.get("ble_device_name","").strip()
    mqtt_host = cfg.get("mqtt_host","").strip()

    print(f"{C.BOLD}{'='*50}{C.END}")
    print(f"{C.BOLD}  ESP32 Ring Light BLE + MQTT 测试{C.END}")
    print(f"{C.BOLD}{'='*50}{C.END}")
    print(f"  BLE:   {ble_name or '未配置'}")
    print(f"  MQTT:  {mqtt_host or '未配置'}:{cfg.get('mqtt_port',1883)}")
    print(f"{'='*50}")

    if not ble_name and not mqtt_host:
        print(f"\n{C.R}错误: BLE 和 MQTT 均未配置{C.END}")
        print(f"  请在 config.json 中填写 ble_device_name 或 mqtt_host")
        sys.exit(1)

    if cfg.get("test_ble", True) and ble_name:
        test_ble(cfg)
    if cfg.get("test_mqtt", True) and mqtt_host:
        test_mqtt(cfg)

    total = passed + failed
    print(f"\n{C.BOLD}{'='*50}{C.END}")
    if failed == 0:
        print(f"  {C.G}{C.BOLD}全部通过: {passed}/{total}{C.END}")
    else:
        print(f"  {C.G}通过: {passed}{C.END}  {C.R}失败: {failed}{C.END}  总计: {total}")
    print(f"{'='*50}")
    return 0 if failed == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
