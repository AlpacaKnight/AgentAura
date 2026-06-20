#!/usr/bin/env python3
"""
ESP32 Ring Light 串口灯控测试脚本

功能:
  1. 交互模式 —  实时输入指令, 观察灯的响应
  2. 自动遍历模式 —  依次测试所有命令和灯效

用法:
  python test/test_serial_control.py              # 自动模式: 遍历所有命令
  python test/test_serial_control.py interactive  # 交互模式: 手动输入指令
  python test/test_serial_control.py demo         # 演示模式: 循环展示每种灯效
"""

import json
import os
import sys
import time

# ---- Windows UTF-8 ----
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    print("需要 pyserial: pip install pyserial")
    sys.exit(1)

# ---- 路径 & 配置 ----
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")

# ---- ANSI 颜色 ----
class C:
    G = "\033[92m"; R = "\033[91m"; Y = "\033[93m"
    B = "\033[94m"; C = "\033[96m"; M = "\033[95m"
    BOLD = "\033[1m"; DIM = "\033[2m"; END = "\033[0m"


# ============================================================
#  串口连接
# ============================================================
def find_serial_port(config_port: str, baud: int = 115200):
    """如果 config.json 里填了串口就用它, 否则列出可用串口让用户选"""
    if config_port and os.path.exists(config_port):
        return config_port

    if config_port:
        print(f"{C.Y}配置的串口 {config_port} 不存在, 自动扫描...{C.END}")

    ports = serial.tools.list_ports.comports()
    if not ports:
        print(f"{C.R}未找到任何串口设备! 请检查:{C.END}")
        print("  1. USB 线是否已连接 ESP32")
        print("  2. 设备驱动是否正常")
        sys.exit(1)

    print(f"\n{C.BOLD}可用串口:{C.END}")
    for i, p in enumerate(ports):
        desc = p.description or p.manufacturer or ""
        print(f"  [{i}] {p.device}  —  {desc}")

    if len(ports) == 1:
        choice = 0
    else:
        try:
            choice = int(input(f"\n选择串口 [0-{len(ports)-1}]: "))
        except (ValueError, KeyboardInterrupt):
            print("\n已取消")
            sys.exit(0)

    return ports[choice].device


def connect_serial(port: str, baud: int):
    """打开串口并清空缓冲区"""
    print(f"\n{C.DIM}连接 {port} @ {baud} ...{C.END}", end=" ")
    ser = serial.Serial(port, baud, timeout=2.0)
    time.sleep(1.5)  # 等待 ESP32 串口就绪
    ser.reset_input_buffer()
    ser.reset_output_buffer()
    print(f"{C.G}OK{C.END}")

    # 清空欢迎信息
    time.sleep(0.5)
    while ser.in_waiting:
        ser.read(ser.in_waiting)
    return ser


# ============================================================
#  发送指令
# ============================================================
def send_cmd(ser, cmd: str, timeout: float = 1.5):
    """发送一行指令, 返回响应字符串"""
    ser.write((cmd + "\n").encode("utf-8"))
    ser.flush()

    # 等待响应
    t0 = time.time()
    resp = b""
    while time.time() - t0 < timeout:
        if ser.in_waiting:
            resp += ser.read(ser.in_waiting)
        else:
            time.sleep(0.05)

    text = resp.decode("utf-8", errors="replace").strip()
    # 只取最后一行有意义的结果 (过滤回显和日志)
    lines = [l for l in text.split("\n") if l.strip() and not l.startswith("[")]
    return lines[-1] if lines else text


# ============================================================
#  指令列表
# ============================================================
BASIC_TESTS = [
    ("rgb 255,0,0",       "红灯"),
    ("rgb 0,255,0",       "绿灯"),
    ("rgb 0,0,255",       "蓝灯"),
    ("rgb 255,255,0",     "黄灯"),
    ("rgb 255,0,255",     "紫灯"),
    ("rgb 0,255,255",     "青灯"),
    ("rgb 255,255,255",   "白灯 (最亮)"),
    ("brightness 100",    "亮度 100"),
    ("brightness 50",     "亮度 50"),
    ("brightness 200",    "亮度 200"),
    ("speed 128",         "速度 128"),
    ("speed 255",         "速度 255 (最快)"),
    ("speed 30",          "速度 30 (最慢)"),
    ("power off",         "关灯"),
    ("power on",          "开灯"),
]

EFFECT_TESTS = [
    ("solid 255,0,0",    "常亮 红"),
    ("breath 0,255,100", "呼吸 绿"),
    ("flow 255,200,0",   "跑马 黄"),
    ("rainbow",          "彩虹"),
    ("gradient 255,0,0,0,0,255",  "渐变 红→蓝"),
    ("blink 255,0,0",    "闪烁 红"),
    ("fire",             "火焰"),
    ("sparkle 0,255,255","星光 青"),
    ("cycle 128,0,255",  "循环 紫"),
    ("meteor 255,165,0", "流星 橙"),
    ("bounce 255,0,128", "弹跳 粉"),
    ("wave 255,0,0,0,255,0",   "波浪 红蓝"),
    ("pulse 0,100,255",  "脉冲 蓝"),
    ("fade 255,128,0",   "渐变 橙"),
    ("random",           "随机"),
]

AGENT_TESTS = [
    ("running",    "运行中"),
    ("busy",       "忙碌"),
    ("waiting",    "等待"),
    ("error",      "错误"),
    ("idle",       "空闲"),
    ("init",       "初始化"),
    ("upgrade",    "升级"),
    ("offline",    "离线 (关灯)"),
]


def print_result(cmd: str, desc: str, resp: str):
    if resp and "OK" in resp:
        print(f"  {C.G}[√]{C.END} {desc:10s}  →  {C.DIM}{cmd}{C.END}  {C.G}{resp}{C.END}")
    else:
        print(f"  {C.R}[×]{C.END} {desc:10s}  →  {C.DIM}{cmd}{C.END}  {C.R}{resp}{C.END}")


# ============================================================
#  自动测试
# ============================================================
def run_auto_test(ser):
    """运行所有基本命令 + 灯效 + agent 测试"""
    total, ok_count, fail_count = 0, 0, 0

    # ---- 基础颜色/亮度/速度 ----
    print(f"\n{C.BOLD}{C.C}{'='*50}{C.END}")
    print(f"{C.BOLD}{C.C}  基础颜色 & 亮度/速度{C.END}")
    print(f"{C.BOLD}{C.C}{'='*50}{C.END}")
    for cmd, desc in BASIC_TESTS:
        resp = send_cmd(ser, cmd, timeout=0.8)
        total += 1
        if resp and "OK" in resp:
            ok_count += 1
            print_result(cmd, desc, resp)
        else:
            fail_count += 1
            print_result(cmd, desc, resp or "无响应")
        time.sleep(0.5)

    # ---- 15 灯效 ----
    print(f"\n{C.BOLD}{C.M}{'='*50}{C.END}")
    print(f"{C.BOLD}{C.M}  15 种灯效遍历{C.END}")
    print(f"{C.BOLD}{C.M}{'='*50}{C.END}")
    for cmd, desc in EFFECT_TESTS:
        resp = send_cmd(ser, f"effect {cmd}", timeout=1.0)
        total += 1
        if resp and "OK" in resp:
            ok_count += 1
            print(f"  {C.G}[√]{C.END} {desc:12s}  {C.G}{resp}{C.END}")
        else:
            fail_count += 1
            print(f"  {C.R}[×]{C.END} {desc:12s}  {C.R}{resp or '无响应'}{C.END}")
        time.sleep(1.0)  # 多停留观察效果

    # ---- Agent 状态 ----
    print(f"\n{C.BOLD}{C.Y}{'='*50}{C.END}")
    print(f"{C.BOLD}{C.Y}  智能体 (Agent) 状态映射{C.END}")
    print(f"{C.BOLD}{C.Y}{'='*50}{C.END}")
    for state_name, desc in AGENT_TESTS:
        resp = send_cmd(ser, f"agent {state_name}", timeout=1.0)
        total += 1
        if resp and "OK" in resp:
            ok_count += 1
            print(f"  {C.G}[√]{C.END} {desc:8s}  →  agent {state_name}  {C.G}{resp}{C.END}")
        else:
            fail_count += 1
            print(f"  {C.R}[×]{C.END} {desc:8s}  →  agent {state_name}  {C.R}{resp or '无响应'}{C.END}")
        time.sleep(1.0)

    # ---- 状态 & 重置 ----
    print(f"\n{C.BOLD}{'='*50}{C.END}")
    print(f"{C.BOLD}  状态查询 & 重置{C.END}")
    print(f"{C.BOLD}{'='*50}{C.END}")
    for cmd, desc in [("state","状态"), ("help","帮助")]:
        resp = send_cmd(ser, cmd, timeout=1.0)
        total += 1
        if resp:
            ok_count += 1
            print(f"  {C.G}[√]{C.END} {desc}: {resp[:100]}")
        else:
            fail_count += 1
            print(f"  {C.R}[×]{C.END} {desc}: 无响应")

    # 恢复默认
    resp = send_cmd(ser, "reset", timeout=1.0)
    total += 1
    if resp and "OK" in resp:
        ok_count += 1
        print(f"  {C.G}[√]{C.END} 重置默认  {C.G}{resp}{C.END}")
    else:
        fail_count += 1
        print(f"  {C.R}[×]{C.END} 重置  {C.R}{resp or '无响应'}{C.END}")

    # ---- 汇总 ----
    print(f"\n{C.BOLD}{'='*50}{C.END}")
    if fail_count == 0:
        print(f"  {C.G}{C.BOLD}全部通过!  {ok_count}/{total}{C.END}")
    else:
        print(f"  {C.G}通过: {ok_count}{C.END}  {C.R}失败: {fail_count}{C.END}  总计: {total}")
    print(f"{'='*50}")


# ============================================================
#  演示模式
# ============================================================
def run_demo(ser):
    """循环展示所有灯效, 每 5 秒切换"""
    print(f"\n{C.BOLD}{C.M}演示模式 — 循环展示 15 种灯效{C.END}")
    print(f"{C.DIM}按 Ctrl+C 退出{C.END}\n")

    try:
        while True:
            for cmd, desc in EFFECT_TESTS:
                print(f"  {C.C}{desc:12s}{C.END}  →  {C.DIM}effect {cmd}{C.END}")
                resp = send_cmd(ser, f"effect {cmd}", timeout=0.5)
                if resp and "OK" not in resp:
                    print(f"    {C.R}{resp}{C.END}")
                time.sleep(5)
    except KeyboardInterrupt:
        print(f"\n{C.Y}退出演示{C.END}")
        send_cmd(ser, "power off")


# ============================================================
#  交互模式
# ============================================================
HELP_TEXT = f"""
{C.BOLD}串口灯控 — 交互模式{C.END}
{C.DIM}直接输入指令, 按 Enter 发送. Ctrl+C 退出.{C.END}

{C.BOLD}━━━━━━━ 可用指令 ━━━━━━━{C.END}
{C.C}rgb R,G,B{C.END}          设置颜色    例: rgb 255,0,0
{C.C}effect NAME [params]{C.END}  设置灯效    例: effect rainbow
{C.C}brightness N / brt N{C.END} 设置亮度    例: brightness 128
{C.C}speed N / spd N{C.END}      设置速度    例: speed 200
{C.C}power on|off{C.END}         开关灯      例: power off
{C.C}agent STATE{C.END}          智能体状态  例: agent running
{C.C}state{C.END}                查询状态
{C.C}help / ?{C.END}             显示帮助
{C.C}reset{C.END}                恢复默认
{C.C}demo{C.END}                 进入演示模式
{C.C}exit / quit{C.END}          退出

{C.BOLD}━━━━━━ 效果列表 ━━━━━━{C.END}
{C.Y}solid breath flow rainbow gradient blink fire sparkle
cycle meteor bounce wave pulse fade random{C.END}

{C.BOLD}━━━━ 智能体状态 ━━━━━{C.END}
{C.Y}running busy processing waiting error idle
init offline standby upgrade updating{C.END}
"""


def run_interactive(ser):
    print(HELP_TEXT)

    try:
        while True:
            try:
                cmd = input(f"\n{C.BOLD}> {C.END}").strip()
            except EOFError:
                break

            if not cmd:
                continue
            if cmd.lower() in ("exit", "quit", "q"):
                break
            if cmd.lower() == "demo":
                run_demo(ser)
                continue
            if cmd.lower() in ("help", "?"):
                print(HELP_TEXT)
                continue

            resp = send_cmd(ser, cmd, timeout=2.0)
            if resp:
                if resp.startswith("{") and "effect" in resp:
                    # JSON 状态 — 格式化输出关键字段
                    try:
                        j = json.loads(resp)
                        cur = j.get("current", {})
                        led = j.get("led", {})
                        print(f"  {C.C}效果  : {cur.get('effect','?')}{C.END}")
                        col = cur.get("color", {})
                        print(f"  {C.C}颜色  : ({col.get('r',0)},{col.get('g',0)},{col.get('b',0)}){C.END}")
                        print(f"  {C.C}亮度  : {led.get('brightness','?')}{C.END}")
                        print(f"  {C.C}速度  : {led.get('speed','?')}{C.END}")
                        print(f"  {C.C}功率  : {cur.get('power','?')}{C.END}")
                    except json.JSONDecodeError:
                        print(f"  {resp}")
                elif "OK" in resp:
                    print(f"  {C.G}{resp}{C.END}")
                elif "ERR" in resp:
                    print(f"  {C.R}{resp}{C.END}")
                else:
                    print(f"  {resp}")
            else:
                print(f"  {C.R}无响应 (超时){C.END}")

    except KeyboardInterrupt:
        pass
    finally:
        print(f"\n{C.Y}退出交互模式{C.END}")


# ============================================================
#  主入口
# ============================================================
def main():
    mode = sys.argv[1].lower() if len(sys.argv) > 1 else "auto"

    # 加载配置
    config_port = ""
    config_baud = 115200
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
                cfg = json.load(f)
            config_port = cfg.get("serial_port", "").strip()
            config_baud = cfg.get("serial_baud", 115200)
        except (json.JSONDecodeError, OSError):
            pass

    print(f"{C.BOLD}{'='*50}{C.END}")
    print(f"{C.BOLD}  ESP32 Ring Light — 串口灯控测试{C.END}")
    print(f"{C.BOLD}{'='*50}{C.END}")
    print(f"  模式: {'交互' if mode == 'interactive' else '演示' if mode == 'demo' else '自动测试'}")

    # 连接串口
    port = find_serial_port(config_port, config_baud)
    ser = connect_serial(port, config_baud)

    try:
        if mode in ("interactive", "i"):
            run_interactive(ser)
        elif mode == "demo":
            run_demo(ser)
        else:
            run_auto_test(ser)
    finally:
        ser.close()
        print(f"\n{C.DIM}串口已关闭{C.END}")


if __name__ == "__main__":
    main()
