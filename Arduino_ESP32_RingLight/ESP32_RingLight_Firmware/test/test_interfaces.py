#!/usr/bin/env python3
"""
ESP32 Ring Light 固件真机接口测试
读取同目录 config.json 配置, 连接真实硬件测试所有接口。

用法:
  1. 编辑 test/config.json 填写设备 IP / 串口
  2. python test/test_interfaces.py

未配置或配置无效时直接报错退出。
"""
import json
import os
import socket
import sys
import time
import urllib.request
import urllib.error

# Windows 控制台 UTF-8
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

# ============================================================
#  配色 & 工具
# ============================================================
class C:
    G = "\033[92m"; R = "\033[91m"; Y = "\033[93m"
    B = "\033[94m"; BOLD = "\033[1m"; END = "\033[0m"

passed = 0
failed = 0

def ok(msg):
    global passed; passed += 1
    print(f"  {C.G}[OK]{C.END} {msg}")

def fail(msg, detail=""):
    global failed; failed += 1
    print(f"  {C.R}[FAIL]{C.END} {msg}" + (f" {C.R}({detail}){C.END}" if detail else ""))

def section(title):
    print(f"\n{C.BOLD}{C.B}{'='*3} {title} {'='*3}{C.END}")

def wait(t, label=""):
    if label: print(f"  ... {label} {t}s")
    time.sleep(t)

# ============================================================
#  加载配置
# ============================================================
def load_config():
    if not os.path.exists(CONFIG_PATH):
        print(f"{C.R}{C.BOLD}错误: 配置文件不存在{C.END}")
        print(f"  路径: {CONFIG_PATH}")
        print(f"  请复制 config.json 并填写设备信息")
        sys.exit(1)

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
            cfg = json.load(f)
    except json.JSONDecodeError as e:
        print(f"{C.R}{C.BOLD}错误: config.json 格式无效{C.END}")
        print(f"  {e}")
        sys.exit(1)

    # 过滤注释字段
    cfg = {k: v for k, v in cfg.items() if not k.startswith("_")}

    host = cfg.get("host", "").strip()
    # 自动去除误填的 http:// 或 https:// 前缀
    if host.startswith("http://"):
        host = host[7:]
    elif host.startswith("https://"):
        host = host[8:]
    host = host.rstrip("/")
    cfg["host"] = host
    serial = cfg.get("serial_port", "").strip()

    if not host and not serial:
        print(f"{C.R}{C.BOLD}错误: 未配置任何连接方式{C.END}")
        print(f"  请在 config.json 中至少填写 'host' (IP) 或 'serial_port' 其中一项")
        print(f"  配置文件: {CONFIG_PATH}")
        sys.exit(1)

    return cfg

# ============================================================
#  HTTP
# ============================================================
def http_get(host, port, path):
    try:
        with urllib.request.urlopen(f"http://{host}:{port}{path}", timeout=8) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return 0, str(e)

def http_post(host, port, path, body, ctype="text/plain"):
    try:
        data = body.encode("utf-8") if isinstance(body, str) else body
        req = urllib.request.Request(f"http://{host}:{port}{path}", data=data, method="POST")
        req.add_header("Content-Type", ctype)
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return 0, str(e)

def test_http(host, port):
    section(f"HTTP REST API ({host}:{port})")

    print("\n[1] GET /api/state")
    code, body = http_get(host, port, "/api/state")
    if code == 200:
        try:
            j = json.loads(body)
            ok(f"状态查询: device={j.get('device')}, fw={j.get('firmware')}")
            ok(f"  连接: {j.get('connections')}")
            ok(f"  当前: effect={j['current']['effect']}, color={j['current']['color']}")
        except json.JSONDecodeError:
            fail("JSON 解析失败", body[:80])
    else:
        fail("状态查询失败", f"HTTP {code}")

    print("\n[2] POST /api/cmd - 'rgb 255,0,0'")
    code, body = http_post(host, port, "/api/cmd", "rgb 255,0,0")
    ok("设红色成功") if code == 200 and "OK" in body else fail("设红色失败", f"HTTP {code}")
    wait(1, "观察红灯")

    print('\n[3] POST /api/color - {"r":0,"g":255,"b":0}')
    code, body = http_post(host, port, "/api/color", json.dumps({"r":0,"g":255,"b":0}), "application/json")
    ok("JSON 设绿色成功") if code == 200 else fail("设绿色失败")
    wait(1, "观察绿灯")

    print('\n[4] POST /api/effect - {"effect":"rainbow"}')
    code, body = http_post(host, port, "/api/effect", json.dumps({"effect":"rainbow"}), "application/json")
    ok("切换彩虹成功") if code == 200 else fail("切换彩虹失败")
    wait(2, "观察彩虹")

    print('\n[5] POST /api/effect - {"effect":"breath","r":0,"g":100,"b":255}')
    code, body = http_post(host, port, "/api/effect", json.dumps({"effect":"breath","r":0,"g":100,"b":255}), "application/json")
    ok("切换蓝呼吸成功") if code == 200 else fail("切换呼吸失败")
    wait(2, "观察蓝呼吸")

    print('\n[6] POST /api/brightness - {"value":200}')
    code, body = http_post(host, port, "/api/brightness", json.dumps({"value":200}), "application/json")
    ok("亮度调节成功") if code == 200 else fail("亮度失败")

    print('\n[7] POST /api/speed - {"value":220}')
    code, body = http_post(host, port, "/api/speed", json.dumps({"value":220}), "application/json")
    ok("速度调节成功") if code == 200 else fail("速度失败")
    wait(1, "观察加速")

    print("\n[8] GET /win?R=255&G=165&B=0&A=128&T=200&FX=9 (WLED 兼容)")
    code, body = http_get(host, port, "/win?R=255&G=165&B=0&A=128&T=200&FX=9")
    ok("WLED 兼容成功") if code == 200 else fail("WLED 失败", f"HTTP {code}")
    wait(2, "观察橙色流星")

    print("\n[9] GET /api/state (验证最终状态)")
    code, body = http_get(host, port, "/api/state")
    if code == 200:
        j = json.loads(body)
        ok(f"最终: effect={j['current']['effect']}, brt={j['led']['brightness']}, spd={j['led']['speed']}")
    else:
        fail("最终状态查询失败")

    print("\n[10] GET /reset")
    code, body = http_get(host, port, "/reset")
    ok("恢复默认成功") if code == 200 else fail("恢复失败")

# ============================================================
#  UDP
# ============================================================
def udp_send(host, port, msg, timeout=3):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(msg.encode("utf-8"), (host, port))
        data, _ = sock.recvfrom(1024)
        return data.decode("utf-8", errors="replace")
    except socket.timeout:
        return None
    finally:
        sock.close()

def test_udp(host, port):
    section(f"UDP 指令 ({host}:{port})")

    print("\n[1] 发送 'discover' 设备发现")
    resp = udp_send(host, port, "discover")
    if resp:
        try:
            j = json.loads(resp)
            ok(f"发现设备: device={j.get('device')}, ip={j.get('ip')}, effect={j.get('effect')}")
        except json.JSONDecodeError:
            ok(f"发现响应: {resp[:60]}")
    else:
        fail("设备发现无响应 (超时)")

    print("\n[2] UDP 'rgb 255,0,0'")
    resp = udp_send(host, port, "rgb 255,0,0")
    ok("设红色成功") if resp and "OK" in resp else fail("设红色失败", resp or "无响应")
    wait(1, "观察红灯")

    print("\n[3] UDP 'effect fire'")
    resp = udp_send(host, port, "effect fire")
    ok("切换火焰成功") if resp and "OK" in resp else fail("火焰失败", resp or "无响应")
    wait(2, "观察火焰")

    print("\n[4] UDP 'brightness 50'")
    resp = udp_send(host, port, "brightness 50")
    ok("调暗成功") if resp and "OK" in resp else fail("调暗失败")

    print("\n[5] UDP 'state'")
    resp = udp_send(host, port, "state")
    if resp and resp.strip().startswith("{"):
        j = json.loads(resp)
        ok(f"状态: effect={j['current']['effect']}, brt={j['led']['brightness']}")
    else:
        fail("状态查询失败", (resp or "无响应")[:50])

    print("\n[6] UDP 'help'")
    resp = udp_send(host, port, "help")
    ok("帮助成功") if resp and "cmds" in resp else fail("帮助失败")

# ============================================================
#  智能体状态
# ============================================================
def test_agent(host, http_port):
    section("智能体状态映射 (agent STATE)")

    states = [
        ("running",  "绿色呼吸",   (0,255,0),     "breath"),
        ("busy",     "黄色跑马",   (255,200,0),   "flow"),
        ("waiting",  "黄色闪烁",   (255,200,0),   "blink"),
        ("error",    "红色闪烁",   (255,0,0),     "blink"),
        ("idle",     "蓝色呼吸",   (0,100,255),   "breath"),
        ("init",     "彩虹渐变",   (0,0,0),       "rainbow"),
        ("upgrade",  "橙色流星",   (255,165,0),   "meteor"),
    ]

    for i, (name, desc, (r,g,b), fx_expected) in enumerate(states):
        print(f"\n[{i+1}] agent {name} ({desc})")
        code, body = http_post(host, http_port, "/api/cmd", f"agent {name}")
        if code == 200 and "OK" in body:
            ok(f"指令成功: {body.strip()}")
            sc, sb = http_get(host, http_port, "/api/state")
            if sc == 200:
                j = json.loads(sb)
                cur_fx = j["current"]["effect"]
                col = j["current"]["color"]
                ok(f"  效果: {cur_fx}") if cur_fx == fx_expected else fail(f"  效果不符: 期望 {fx_expected} 实际 {cur_fx}")
                ok(f"  颜色: ({col['r']},{col['g']},{col['b']})") if col["r"]==r and col["g"]==g and col["b"]==b else fail(f"  颜色不符: 期望 ({r},{g},{b})")
        else:
            fail(f"指令失败 HTTP {code}")
        wait(1.5, f"观察 {desc}")

    # offline: 特殊处理 —— 关灯 (power=false), 不验证效果/颜色
    print(f"\n[{len(states)+1}] agent offline (关灯)")
    code, body = http_post(host, http_port, "/api/cmd", "agent offline")
    if code == 200 and "OK" in body:
        ok(f"指令成功: {body.strip()}")
        sc, sb = http_get(host, http_port, "/api/state")
        if sc == 200:
            j = json.loads(sb)
            power = j["led"]["power"]
            ok("  关灯成功") if not power else fail("  关灯失败: power 应为 false")
    else:
        fail(f"指令失败 HTTP {code}")
    wait(1.5, "观察关灯")

    print("\n[9] 别名: agent processing (= busy)")
    code, body = http_post(host, http_port, "/api/cmd", "agent processing")
    ok("别名 processing 成功") if code == 200 and "OK" in body else fail("别名失败")

    print("\n[10] 别名: agent standby (= offline)")
    code, body = http_post(host, http_port, "/api/cmd", "agent standby")
    ok("别名 standby 成功") if code == 200 and "OK" in body else fail("别名失败")

# ============================================================
#  15 灯效遍历
# ============================================================
def test_effects(host, http_port):
    section("15 种灯效遍历")

    effects = ["solid","breath","flow","rainbow","gradient","blink","fire",
               "sparkle","cycle","meteor","bounce","wave","pulse","fade","random"]
    colors = [(255,0,0),(0,255,0),(0,0,255),(255,255,0),(255,0,255),(0,255,255),
              (255,128,0),(128,0,255),(255,255,255),(255,0,128),(128,255,0),
              (0,128,255),(255,64,64),(64,255,64),(64,64,255)]

    for i, fx in enumerate(effects):
        r,g,b = colors[i]
        code, body = http_post(host, http_port, "/api/effect",
                               json.dumps({"effect":fx,"r":r,"g":g,"b":b}), "application/json")
        ok(f"[{i:2d}] {fx:10s} ({r:3d},{g:3d},{b:3d})") if code == 200 else fail(f"[{i:2d}] {fx} 失败")
        wait(1.2, f"观察 {fx}")

# ============================================================
#  串口
# ============================================================
def test_serial(port, baud):
    section(f"串口指令 ({port} @ {baud})")

    try:
        import serial
    except ImportError:
        print(f"  {C.Y}需要 pyserial: pip install pyserial{C.END}")
        print(f"  {C.Y}跳过串口测试{C.END}")
        return

    try:
        ser = serial.Serial(port, baud, timeout=3)
        wait(0.5, "串口就绪")
    except Exception as e:
        fail(f"打开串口失败: {e}")
        return

    def send(cmd):
        ser.write((cmd + "\n").encode("utf-8"))
        ser.flush()
        time.sleep(0.3)
        resp = ""
        while ser.in_waiting > 0:
            resp += ser.read(ser.in_waiting).decode("utf-8", errors="replace")
        return resp.strip()

    tests = [
        ("rgb 255,0,0",         "设红色",     "OK"),
        ("effect rainbow",      "彩虹",       "OK"),
        ("effect breath 0,255,0","绿呼吸",    "OK"),
        ("brightness 200",      "亮度",       "OK"),
        ("speed 220",           "速度",       "OK"),
        ("agent error",         "错误状态",   "OK"),
        ("state",               "查询状态",   "{"),
        ("help",                "帮助",       "cmds"),
        ("power off",           "关灯",       "OK"),
        ("power on",            "开灯",       "OK"),
        ("reset",               "重置",       "OK"),
    ]

    for cmd, desc, expect in tests:
        print(f"\n  [{desc}] {cmd}")
        resp = send(cmd)
        ok(f"{desc}成功") if expect in resp else fail(f"{desc}失败", resp[:50] if resp else "无响应")
        wait(0.8)

    ser.close()

# ============================================================
#  主程序
# ============================================================
def main():
    cfg = load_config()

    host = cfg.get("host", "").strip()
    http_port = cfg.get("http_port", 80)
    udp_port = cfg.get("udp_port", 8888)
    serial_port = cfg.get("serial_port", "").strip()
    serial_baud = cfg.get("serial_baud", 115200)

    print(f"{C.BOLD}{'='*50}{C.END}")
    print(f"{C.BOLD}  ESP32 Ring Light 真机接口测试{C.END}")
    print(f"{C.BOLD}{'='*50}{C.END}")
    print(f"  HTTP:  {host}:{http_port}" if host else "  HTTP:  未配置")
    print(f"  UDP:   {host}:{udp_port}" if host else "  UDP:   未配置")
    print(f"  串口:  {serial_port}@{serial_baud}" if serial_port else "  串口:  未配置")
    print(f"{'='*50}")

    # 连通性预检 (host 配置时)
    if host:
        print(f"\n预检: 连接 {host}...")
        code, body = http_get(host, http_port, "/api/state")
        if code != 200:
            print(f"{C.R}{C.BOLD}无法连接设备 {host}:{http_port}{C.END}")
            print(f"  HTTP 状态: {code}, 详情: {body[:80]}")
            print(f"  请检查:")
            print(f"    1. 设备已上电并连上 WiFi")
            print(f"    2. config.json 的 host 填的是纯 IP (不带 http://)")
            print(f"    3. 电脑和设备在同一局域网")
            print(f"    4. 设备串口打印的 IP 与 config.json 一致")
            sys.exit(1)
        else:
            print(f"  {C.G}设备连接正常{C.END}\n")

    # 按开关执行
    if cfg.get("test_http", True) and host:
        test_http(host, http_port)
    if cfg.get("test_udp", True) and host:
        test_udp(host, udp_port)
    if cfg.get("test_agent", True) and host:
        test_agent(host, http_port)
    if cfg.get("test_effects", True) and host:
        test_effects(host, http_port)
    if cfg.get("test_serial", True) and serial_port:
        test_serial(serial_port, serial_baud)

    # 汇总
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
