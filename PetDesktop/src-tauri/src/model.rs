use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const HTTP_PORT: u16 = 47_831;
pub const UDP_PORT: u16 = 8_888;
pub const AGENT_TIMEOUT_MS: i64 = 30_000;
pub const PET_MESSAGE_MAX_INPUT: usize = 500;
pub const PET_MESSAGE_TTL_MIN_MS: u64 = 1_500;
pub const PET_MESSAGE_TTL_MAX_MS: u64 = 30_000;
pub const PET_MESSAGE_QUEUE_MAX: usize = 20;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Init,
    Running,
    Busy,
    Waiting,
    #[default]
    Idle,
    Error,
    Offline,
    Upgrade,
}

impl AgentState {
    pub fn priority(self) -> u16 {
        match self {
            Self::Error => 700,
            Self::Waiting => 600,
            Self::Upgrade => 500,
            Self::Busy => 400,
            Self::Running => 300,
            Self::Init => 200,
            Self::Idle => 100,
            Self::Offline => 0,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Init => "init",
            Self::Running => "running",
            Self::Busy => "busy",
            Self::Waiting => "waiting",
            Self::Idle => "idle",
            Self::Error => "error",
            Self::Offline => "offline",
            Self::Upgrade => "upgrade",
        }
    }
}

impl std::str::FromStr for AgentState {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "init" => Ok(Self::Init),
            "running" => Ok(Self::Running),
            "busy" | "processing" => Ok(Self::Busy),
            "waiting" => Ok(Self::Waiting),
            "idle" => Ok(Self::Idle),
            "error" => Ok(Self::Error),
            "offline" | "standby" => Ok(Self::Offline),
            "upgrade" | "updating" => Ok(Self::Upgrade),
            _ => Err(format!("invalid agent state: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstance {
    pub instance_id: String,
    pub client_id: String,
    pub display_name: String,
    pub version: Option<String>,
    pub state: AgentState,
    pub session_id: Option<String>,
    pub connected: bool,
    pub last_seen_ms: i64,
    pub last_seen_at: String,
}

/// 桌宠气泡消息分类，决定显示样式与默认优先级。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum PetMessageKind {
    #[default]
    State,
    Activity,
    Success,
    Warning,
    Error,
}

impl PetMessageKind {
    /// 默认优先级：错误和等待高于普通活动消息。
    pub fn default_priority(self) -> u16 {
        match self {
            Self::Error => 80,
            Self::Warning => 60,
            Self::Success | Self::State => 40,
            Self::Activity => 20,
        }
    }
}

/// 气泡展示模式：仅状态模板 / 仅事件摘要 / 两者。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum PetBubbleMode {
    State,
    Events,
    #[default]
    Both,
}

/// 单条桌宠气泡消息。历史消息仅进入运行日志，第一版不持久化完整正文。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetMessage {
    pub id: String,
    pub agent_instance_id: Option<String>,
    pub kind: PetMessageKind,
    pub text: String,
    pub source: String,
    pub priority: u16,
    pub created_at: String,
    pub ttl_ms: u64,
}

/// 判断消息是否已过期。`created_at` 采用 RFC3339（与 `now_iso` 一致）。
pub fn message_expired(message: &PetMessage, now_ms: i64) -> bool {
    let created_ms = chrono::DateTime::parse_from_rfc3339(&message.created_at)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0);
    created_ms + (message.ttl_ms as i64) < now_ms
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationSpec {
    pub row: u32,
    pub frames: u32,
    pub durations_ms: Vec<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPet {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub spritesheet_path: Option<String>,
    pub frame_width: u32,
    pub frame_height: u32,
    pub columns: u32,
    pub rows: u32,
    #[serde(default = "default_sprite_version")]
    pub sprite_version: u32,
    pub built_in: bool,
    pub animations: HashMap<String, AnimationSpec>,
}

pub fn default_sprite_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum HardwareTransport {
    #[default]
    Disabled,
    Http,
    Udp,
    Serial,
    Ble,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct HardwareConfig {
    pub transport: HardwareTransport,
    pub host: String,
    pub port: u16,
    pub serial_port: String,
    pub ble_address: String,
    pub baud: u32,
    pub auto_discover: bool,
}

impl Default for HardwareConfig {
    fn default() -> Self {
        Self {
            transport: HardwareTransport::Disabled,
            host: String::new(),
            port: 80,
            serial_port: String::new(),
            ble_address: String::new(),
            baud: 115_200,
            auto_discover: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareStatus {
    pub connected: bool,
    pub syncing: bool,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
    pub device: Option<serde_json::Value>,
}

impl Default for HardwareStatus {
    fn default() -> Self {
        Self {
            connected: false,
            syncing: false,
            last_success_at: None,
            last_error: None,
            device: None,
        }
    }
}

/// 桌宠文字气泡设置，决定是否显示、显示内容、时长与样式。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PetBubbleSettings {
    pub enabled: bool,
    pub mode: PetBubbleMode,
    pub duration_seconds: u64,
    pub max_characters: usize,
    pub font_scale: f64,
    pub show_source: bool,
}

impl Default for PetBubbleSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: PetBubbleMode::Both,
            duration_seconds: 5,
            max_characters: 140,
            font_scale: 1.0,
            show_source: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub selected_pet_id: String,
    pub pet_scale: f64,
    pub always_on_top: bool,
    pub roam_enabled: bool,
    pub roam_interval_seconds: u64,
    pub roam_speed: u32,
    pub click_through: bool,
    pub pet_visible: bool,
    pub show_on_all_workspaces: bool,
    pub launch_at_startup: bool,
    pub lan_enabled: bool,
    pub lan_token: String,
    pub hardware: HardwareConfig,
    pub pet_bubble: PetBubbleSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            selected_pet_id: "builtin-aura".to_string(),
            pet_scale: 1.0,
            always_on_top: true,
            roam_enabled: false,
            roam_interval_seconds: 30,
            roam_speed: 80,
            click_through: false,
            pet_visible: true,
            show_on_all_workspaces: false,
            launch_at_startup: false,
            lan_enabled: false,
            lan_token: String::new(),
            hardware: HardwareConfig::default(),
            pet_bubble: PetBubbleSettings::default(),
        }
    }
}

impl AppSettings {
    pub fn normalize(&mut self) {
        self.pet_scale = self.pet_scale.clamp(0.5, 2.0);
        self.roam_interval_seconds = self.roam_interval_seconds.clamp(10, 600);
        self.roam_speed = self.roam_speed.clamp(20, 300);
        if self.hardware.port == 0 {
            self.hardware.port = match self.hardware.transport {
                HardwareTransport::Udp => UDP_PORT,
                _ => 80,
            };
        }
        self.hardware.baud = self.hardware.baud.clamp(1_200, 4_000_000);
        self.pet_bubble.duration_seconds = self.pet_bubble.duration_seconds.clamp(1, 30);
        self.pet_bubble.max_characters = self.pet_bubble.max_characters.clamp(40, 500);
        self.pet_bubble.font_scale = self.pet_bubble.font_scale.clamp(0.75, 2.0);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub at: String,
    pub level: LogLevel,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub version: String,
    pub effective_state: AgentState,
    pub effective_agent_id: Option<String>,
    pub locked_agent_id: Option<String>,
    pub paused: bool,
    pub agents: Vec<AgentInstance>,
    pub pets: Vec<InstalledPet>,
    pub selected_pet: Option<InstalledPet>,
    pub settings: AppSettings,
    pub hardware: HardwareStatus,
    pub logs: Vec<LogEntry>,
    pub pet_messages: Vec<PetMessage>,
}

pub fn default_animations(sprite_version: u32) -> HashMap<String, AnimationSpec> {
    let mut animations = HashMap::new();
    let idle_durations = if sprite_version >= 2 {
        vec![280, 110, 110, 140, 140, 140, 320]
    } else {
        vec![280, 110, 110, 140, 140, 320]
    };
    let mut rows: Vec<(&str, u32, Vec<u64>)> = vec![
        ("idle", 0, idle_durations),
        (
            "running-right",
            1,
            vec![120, 120, 120, 120, 120, 120, 120, 220],
        ),
        (
            "running-left",
            2,
            vec![120, 120, 120, 120, 120, 120, 120, 220],
        ),
        ("waving", 3, vec![140, 140, 140, 280]),
        ("jumping", 4, vec![140, 140, 140, 140, 280]),
        ("failed", 5, vec![140, 140, 140, 140, 140, 140, 140, 240]),
        ("waiting", 6, vec![150, 150, 150, 150, 150, 260]),
        ("running", 7, vec![120, 120, 120, 120, 120, 220]),
        ("review", 8, vec![150, 150, 150, 150, 150, 280]),
    ];
    if sprite_version >= 2 {
        rows.push((
            "look-directions-a",
            9,
            vec![200, 200, 200, 200, 200, 200, 200, 300],
        ));
        rows.push((
            "look-directions-b",
            10,
            vec![180, 180, 180, 180, 180, 180, 180, 260],
        ));
    }
    for (name, row, durations_ms) in rows {
        animations.insert(
            name.to_string(),
            AnimationSpec {
                row,
                frames: durations_ms.len() as u32,
                durations_ms,
            },
        );
    }
    animations
}

pub fn built_in_pet() -> InstalledPet {
    InstalledPet {
        id: "builtin-aura".to_string(),
        display_name: "Aura".to_string(),
        description: "PetDesktop 内置的状态光灵，用于首次启动和资源回退。".to_string(),
        spritesheet_path: None,
        frame_width: 192,
        frame_height: 208,
        columns: 8,
        rows: 9,
        sprite_version: 1,
        built_in: true,
        animations: default_animations(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bubble_settings_defaults() {
        let settings = PetBubbleSettings::default();
        assert!(settings.enabled);
        assert_eq!(settings.mode, PetBubbleMode::Both);
        assert_eq!(settings.duration_seconds, 5);
        assert_eq!(settings.max_characters, 140);
        assert_eq!(settings.font_scale, 1.0);
        assert!(!settings.show_source);
    }

    #[test]
    fn bubble_settings_normalize_clamps_values() {
        let mut settings = AppSettings::default();
        settings.pet_bubble.duration_seconds = 0;
        settings.pet_bubble.max_characters = 5;
        settings.pet_bubble.font_scale = 3.0;
        settings.normalize();
        assert_eq!(settings.pet_bubble.duration_seconds, 1);
        assert_eq!(settings.pet_bubble.max_characters, 40);
        assert_eq!(settings.pet_bubble.font_scale, 2.0);

        settings.pet_bubble.duration_seconds = 100;
        settings.pet_bubble.max_characters = 9999;
        settings.pet_bubble.font_scale = 0.1;
        settings.normalize();
        assert_eq!(settings.pet_bubble.duration_seconds, 30);
        assert_eq!(settings.pet_bubble.max_characters, 500);
        assert_eq!(settings.pet_bubble.font_scale, 0.75);
    }

    #[test]
    fn message_kind_default_priority_ordering() {
        assert!(
            PetMessageKind::Error.default_priority() > PetMessageKind::Warning.default_priority()
        );
        assert!(
            PetMessageKind::Warning.default_priority()
                > PetMessageKind::Activity.default_priority()
        );
        assert!(
            PetMessageKind::Success.default_priority()
                > PetMessageKind::Activity.default_priority()
        );
    }

    fn make_message(created_at: &str, ttl_ms: u64) -> PetMessage {
        PetMessage {
            id: "test".into(),
            agent_instance_id: None,
            kind: PetMessageKind::Activity,
            text: "hi".into(),
            source: "test".into(),
            priority: 20,
            created_at: created_at.into(),
            ttl_ms,
        }
    }

    #[test]
    fn message_expired_detects_past_ttl() {
        let old = make_message("2026-01-01T00:00:00+00:00", 1_000);
        assert!(message_expired(&old, chrono::Utc::now().timestamp_millis()));

        let future = make_message(&chrono::Utc::now().to_rfc3339(), 10_000);
        assert!(!message_expired(
            &future,
            chrono::Utc::now().timestamp_millis()
        ));
    }

    #[test]
    fn message_expired_handles_invalid_created_at() {
        let bad = make_message("not-a-date", 1_000);
        // 无效时间戳按 0 处理 → 恒过期
        assert!(message_expired(&bad, chrono::Utc::now().timestamp_millis()));
    }
}
