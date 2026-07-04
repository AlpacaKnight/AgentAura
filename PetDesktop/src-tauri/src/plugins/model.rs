use serde::{Deserialize, Serialize};

/// Supported plugin providers
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginProvider {
    Claude,
    Codex,
    Copilot,
    KimiCode,
    Qwencode,
    Qwenpaw,
}

impl PluginProvider {
    /// npm package name for managed installation (if any)
    pub fn package(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some("agent-aura-claude"),
            Self::Codex => Some("agent-aura-codex"),
            Self::KimiCode => Some("agent-aura-kimi-code"),
            Self::Qwencode => Some("agent-aura-qwencode"),
            _ => None,
        }
    }

    /// CLI binary name for direct invocation (if any)
    pub fn cli(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some("agent-aura-claude"),
            Self::Codex => Some("agent-aura-codex"),
            Self::KimiCode => Some("agent-aura-kimi-code"),
            Self::Qwencode => Some("agent-aura-qwencode"),
            _ => None,
        }
    }

    /// Whether this provider supports Hook lifecycle
    pub fn hooks(self) -> bool {
        matches!(self, Self::Codex | Self::KimiCode | Self::Qwencode)
    }
}

/// Result of inspecting a single plugin package
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackageInspection {
    pub path: String,
    pub file_name: String,
    pub sha256: String,
    pub format: String,
    pub provider: Option<PluginProvider>,
    pub version: Option<String>,
    pub valid: bool,
    pub error: Option<String>,
    pub warnings: Vec<String>,
}

impl PluginPackageInspection {
    pub fn failure(path: impl Into<String>, error: impl Into<String>) -> Self {
        let path = path.into();
        Self {
            file_name: std::path::Path::new(&path)
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .into(),
            path,
            sha256: String::new(),
            format: String::new(),
            provider: None,
            version: None,
            valid: false,
            error: Some(error.into()),
            warnings: Vec::new(),
        }
    }
}

/// Status of a managed plugin on the current system
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPluginStatus {
    pub provider: PluginProvider,
    pub installed: bool,
    pub version: Option<String>,
    pub hooks_installed: bool,
    pub hooks_supported: bool,
    pub config_path: Option<String>,
    pub managed_installed: bool,
    pub global_installed: bool,
    pub external_installed: bool,
    pub preferred_source: Option<String>,
    pub managed_version: Option<String>,
    pub global_version: Option<String>,
    pub external_version: Option<String>,
}

/// Result of a synchronous plugin operation (install / uninstall / hooks)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOperationResult {
    pub provider: PluginProvider,
    pub success: bool,
    pub message: String,
    pub output: String,
}

/// Real-time log entry pushed via Tauri event
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOperationLog {
    pub operation_id: u64,
    pub kind: String, // "log" | "progress" | "complete" | "error" | "cancel"
    pub text: String,
}
