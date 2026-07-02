use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const HTTP_PORT: u16 = 47_831;
pub const UDP_PORT: u16 = 8_888;
pub const AGENT_TIMEOUT_MS: i64 = 30_000;

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
    pub built_in: bool,
    pub animations: HashMap<String, AnimationSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum HardwareTransport {
    #[default]
    Disabled,
    Http,
    Udp,
    Serial,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareConfig {
    pub transport: HardwareTransport,
    pub host: String,
    pub port: u16,
    pub serial_port: String,
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
}

pub fn default_animations() -> HashMap<String, AnimationSpec> {
    let mut animations = HashMap::new();
    let rows = [
        ("idle", 0, vec![280, 110, 110, 140, 140, 320]),
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
        built_in: true,
        animations: default_animations(),
    }
}
