"""
BLE 扫描工具 — 查找 ESP32 Ring Light 设备

依赖: pip install bleak
用法: python scan_ble.py [--timeout 10]

输出: 所有扫描到的 BLE 设备, 高亮匹配目标名称的设备
"""
import asyncio
import sys
import argparse

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# 设备前缀 (与固件 config.h BLE_DEVICE_PREFIX 一致)
TARGET_PREFIX = "ESP32-Ring"
SERVICE_UUID  = "8e7f1a01-2b3c-4d5e-9f01-a1b2c3d4e5f0"

G = "\033[92m"; R = "\033[91m"; Y = "\033[93m"; B = "\033[94m"
BOLD = "\033[1m"; END = "\033[0m"


async def scan(timeout: float = 10.0, active: bool = True):
    """扫描 BLE 设备 (active=True 可获取扫描响应数据)"""
    from bleak import BleakScanner

    print(f"{BOLD}{'='*55}{END}")
    print(f"{BOLD}  BLE 设备扫描器{END}")
    print(f"{'='*55}")
    print(f"  目标前缀:  {B}{TARGET_PREFIX}{END}*")
    print(f"  服务 UUID: {SERVICE_UUID}")
    print(f"  扫描模式:  {'主动 (可获取名称/服务)' if active else '被动'}")
    print(f"  扫描时长:  {timeout}s")
    print(f"{'='*55}\n")

    found_devices = []

    def callback(device, adv_data):
        found_devices.append((device, adv_data))

    async with BleakScanner(callback) as scanner:
        await asyncio.sleep(timeout)

    # 去重 (按地址)
    seen = {}
    for device, adv_data in found_devices:
        if device.address not in seen:
            seen[device.address] = (device, adv_data)
        else:
            # 合并广告数据
            pass

    devices = list(seen.values())

    # 分类: 目标设备 vs 其他
    targets = [(d, a) for d, a in devices
               if d.name and d.name.startswith(TARGET_PREFIX)]
    others = [(d, a) for d, a in devices
              if not (d.name and d.name.startswith(TARGET_PREFIX))]

    if targets:
        print(f"{G}{BOLD}>>> 发现 {len(targets)} 个目标设备 <<<{END}\n")
        for d, a in targets:
            print(f"  {G}★{END} {BOLD}{d.name}{END}")
            print(f"    地址:    {d.address}")
            print(f"    RSSI:    {d.rssi} dBm")
            svc_uuids = a.service_uuids or []
            if svc_uuids:
                for u in svc_uuids:
                    marker = f" {G}← 目标服务{END}" if u.lower() == SERVICE_UUID.lower() else ""
                    print(f"    服务:    {u}{marker}")
            else:
                print(f"    {Y}(未广播服务 UUID, 可能需要主动扫描){END}")
            print()
    else:
        print(f"{R}{BOLD}>>> 未发现目标设备 ({TARGET_PREFIX}*) <<<{END}\n")
        print(f"  提示: 检查设备是否上电、BLE 是否已启用")

    if others:
        print(f"{Y}--- 其他设备 ({len(others)} 个) ---{END}")
        for d, _ in sorted(others, key=lambda x: x[0].rssi or -999, reverse=True):
            name = d.name or "(无名)"
            print(f"  {name:35s} {d.address}  RSSI={d.rssi}")
    else:
        print(f"{Y}(未扫描到其他 BLE 设备){END}")

    print(f"\n{BOLD}扫描完成。{END}")
    return len(targets) > 0


async def scan_passive(timeout: float = 8.0):
    """被动扫描 (仅接收广播包, 不发送扫描请求)"""
    from bleak import BleakScanner

    print(f"{BOLD}{'='*55}{END}")
    print(f"{BOLD}  BLE 被动扫描 (仅广播包){END}")
    print(f"{'='*55}\n")

    devices = await BleakScanner.discover(timeout=timeout)
    print(f"发现 {len(devices)} 个设备:\n")

    targets = [d for d in devices if d.name and d.name.startswith(TARGET_PREFIX)]

    for d in sorted(devices, key=lambda x: x.rssi or -999, reverse=True):
        name = d.name or "(无名)"
        is_target = name.startswith(TARGET_PREFIX)
        prefix = f"{G}★{END} " if is_target else "  "
        print(f"  {prefix}{name:30s} {d.address}  RSSI={d.rssi:4d}")

    if not targets:
        print(f"\n{R}未发现目标设备。{END}")
        print(f"  可能原因:")
        print(f"  1. 设备 BLE 未成功初始化 (查看串口日志)")
        print(f"  2. WiFi 射频占用 (尝试仅 AP 模式测试)")
        print(f"  3. 广播名称不匹配")
    return len(targets) > 0


async def main():
    parser = argparse.ArgumentParser(description="BLE 扫描工具")
    parser.add_argument("--timeout", "-t", type=float, default=10.0, help="扫描时长 (秒)")
    parser.add_argument("--passive", "-p", action="store_true", help="被动扫描模式")
    parser.add_argument("--active", "-a", action="store_true", default=True, help="主动扫描模式 (默认)")
    args = parser.parse_args()

    if args.passive:
        await scan_passive(args.timeout)
    else:
        await scan(args.timeout, active=True)


if __name__ == "__main__":
    asyncio.run(main())
