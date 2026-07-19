# ESP32-C6-Touch-AMOLED-1.8 固件

AgentAura AMOLED 宠物固件，适用于 Waveshare `ESP32-C6-Touch-AMOLED-1.8`，使用 SH8601 QSPI AMOLED、FT3168 触摸和 Arduino-ESP32。

## 一、环境准备

在仓库根目录执行一次：

```powershell
cd C:\workspace\project\AgentAura
uv sync
uv run pio --version
```

本项目使用仓库根目录的 `uv` 环境，不需要单独创建项目级 `pyproject.toml`。首次编译会自动下载 ESP32-C6 平台、编译器和依赖库。

设备应使用支持数据传输的 USB 线，并关闭占用串口的串口工具。

## 二、编译

```powershell
cd C:\workspace\project\AgentAura\Arduino_ESP32_AMOLED_Pet
uv run pio run -e esp32c6
```

成功后生成：

```text
.pio\build\esp32c6\firmware.bin
.pio\build\esp32c6\firmware.factory.bin
```

当前验证结果：RAM 使用率约 23%，应用分区使用率约 78%，编译结果为 `SUCCESS`。

## 三、查找设备串口

```powershell
uv run pio device list
```

记录设备对应的端口，例如 `COM4`。设备重新插拔后端口号可能变化。

## 四、烧录固件

自动选择端口：

```powershell
uv run pio run -e esp32c6 -t upload
```

指定端口：

```powershell
uv run pio run -e esp32c6 -t upload --upload-port COM4
```

如果上传超时或找不到设备：

1. 按住板上的 `BOOT`。
2. 短按一次 `RESET`，或重新插拔 USB。
3. 松开 `BOOT`。
4. 重新执行上传命令。

## 五、查看串口日志

```powershell
uv run pio device monitor -e esp32c6 -p COM4 -b 115200
```

也可以使用：

```powershell
uv run pio run -e esp32c6 -t monitor --upload-port COM4
```

烧录完成后按一次 `RESET`，正常情况下可以看到启动 Banner 和初始化日志。

## 六、硬件配置

本项目已经按 ESP32-C6-Touch-AMOLED-1.8 配置：

| 功能 | 引脚 |
|---|---:|
| AMOLED QSPI SCLK / CS | GPIO0 / GPIO5 |
| AMOLED QSPI SDIO0~3 | GPIO1 / GPIO2 / GPIO3 / GPIO4 |
| 触摸 I2C SDA / SCL | GPIO8 / GPIO7 |
| 触摸中断 | GPIO15 |
| 音频 I2S MCK/BCK/DI/WS/DO | GPIO19 / GPIO20 / GPIO21 / GPIO22 / GPIO23 |
| 屏幕分辨率 | 368 × 448 |

不要使用 RingLight 的 `esp32c3` 配置烧录此设备。

## 七、常见问题

### 连接 PetDesktop

固件兼容 PetDesktop 的 HTTP、UDP 和 USB 串口硬件桥接：

- HTTP 主机填写设备 IP，端口填写 `80`。
- UDP 主机填写设备 IP，端口填写 `8888`；也可以在 PetDesktop 中执行设备发现。
- USB 串口选择设备端口，波特率填写 `115200`。

PetDesktop 的状态会按以下规则映射到宠物动画：

| Agent 状态 | 宠物动画 |
|------------|----------|
| `init` | `waving` |
| `running` | `running` |
| `busy` / `processing` | `review` |
| `waiting` | `waiting` |
| `idle` / `offline` | `idle` |
| `error` | `failed` |
| `upgrade` | `jumping` |

当前有效 Agent 的气泡消息也会通过 `pet speak` 同步到设备。网页或其他通信通道修改亮度、音量后，硬件立即应用，设置页滑块和数字会在 500ms 内同步。

### `UnknownPackageError: pioarduino/tool-esptoolpy`

不要在 `platformio.ini` 中强制指定不存在的 `pioarduino/tool-esptoolpy` 版本。当前配置使用稳定版 pioarduino 平台自动选择烧录工具。

### `Network.h: No such file or directory`

请从仓库根目录同步 uv 环境，并使用本项目的 `uv run pio` 命令，不要混用其他全局 PlatformIO。

### 找不到 COM 口

确认 USB 线支持数据传输，关闭串口监视器，重新执行 `uv run pio device list`。必要时按住 `BOOT` 后短按 `RESET` 进入下载模式。

### 屏幕没有显示

先按 `RESET` 并查看串口日志，确认烧录的是 `esp32c6` 环境和本项目固件。

## 八、项目命令速查

```powershell
# 编译
uv run pio run -e esp32c6

# 烧录
uv run pio run -e esp32c6 -t upload --upload-port COM4

# 监视串口
uv run pio device monitor -e esp32c6 -p COM4 -b 115200
```
## SPIFFS RLE 宠物资源

完整的 11 状态宠物动画从 SPIFFS 分区加载。资源文件已经放在：

```text
data/pets/tiquan-v2/sprites.rle
```

刷入固件后，还需要单独刷入 SPIFFS 文件系统镜像：

```powershell
uv run pio run -e esp32c6 -t uploadfs --upload-port COM4
```

上传前需要关闭占用 COM4 的串口监视器。设备启动时会检查 RLE 文件
大小和单帧缓冲，并使用块读取完成整帧解码；SPIFFS 挂载或资源读取
失败时，会自动回退到固件内置的 idle 动画并进行有限次数重试。
