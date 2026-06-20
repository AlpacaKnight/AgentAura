# AgentAura

智能体（AI Agent）状态可视化的多端项目，通过硬件指示灯与 IDE 插件将智能体的实时状态（运行中、忙碌、等待、错误等）映射为直观的光效与界面提示。

---

## 项目结构

```
AgentAura/
├── main.py                              # Python 入口（预留）
├── pyproject.toml                       # uv 依赖管理
├── README.md                            # 本文件
├── Arduino_ESP32_RingLight/             # 硬件：ESP32 环形灯
│   └── ...                              #   详见子目录 README
├── ── 后续扩展（规划中） ──
├── Arduino_XXX_YYY/                     # 更多硬件
├── qwenpaw/                             # QwenPaw 插件
├── codex/                               # Codex 插件
├── copilot-vscode/                      # Copilot vscode 插件
└── ...
```

### 目录命名约定

| 目录模式 | 类别 | 示例 |
|:---------|:-----|:-----|
| `Arduino_{MCU}_{硬件类型}/` | 硬件子项目 | `Arduino_ESP32_RingLight` — 基于 ESP32 的环形灯 |
| `{plugin_name}/` | IDE 插件 | `qwenpaw`、`codex`、`copilot` |

---

## 开发环境

| 依赖 | 版本 | 用途 |
|:-----|:-----|:-----|
| Python | ≥ 3.13 | 主项目运行 |
| [uv](https://docs.astral.sh/uv/) | 最新 | Python 依赖与虚拟环境管理 |

```bash
# 安装 uv 后同步依赖
uv sync

# 编译固件需要同步相关依赖
uv sync --group firmware
```

各子项目可能有额外的依赖与构建工具，请参阅对应目录下的 README。

---

## 许可证

本项目代码可自由用于个人学习和二次开发。
