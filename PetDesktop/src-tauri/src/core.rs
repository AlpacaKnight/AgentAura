use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use chrono::{SecondsFormat, Utc};
use parking_lot::{Mutex, RwLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch};

use crate::{
    hardware::HardwareMessage,
    model::{
        built_in_pet, AgentInstance, AgentState, AppSettings, AppSnapshot, HardwareStatus,
        HardwareTransport, LogEntry, LogLevel, AGENT_TIMEOUT_MS, APP_VERSION,
    },
    pets,
};

#[derive(Debug)]
struct RuntimeModel {
    settings: AppSettings,
    agents: HashMap<String, AgentInstance>,
    effective_state: AgentState,
    effective_agent_id: Option<String>,
    locked_agent_id: Option<String>,
    paused: bool,
    hardware: HardwareStatus,
    logs: VecDeque<LogEntry>,
}

#[derive(Clone)]
pub struct AppCore {
    model: Arc<RwLock<RuntimeModel>>,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    hardware_tx: Arc<Mutex<Option<mpsc::Sender<HardwareMessage>>>>,
    http_lan_tx: Arc<Mutex<Option<watch::Sender<bool>>>>,
    data_dir: Arc<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct RegisterAgent {
    pub instance_id: String,
    pub client_id: String,
    pub display_name: String,
    pub version: Option<String>,
    pub state: AgentState,
    pub session_id: Option<String>,
}

impl AppCore {
    pub fn new(data_dir: PathBuf) -> anyhow::Result<Self> {
        fs::create_dir_all(data_dir.join("pets"))?;
        let settings = load_settings(&data_dir).unwrap_or_default();
        Ok(Self {
            model: Arc::new(RwLock::new(RuntimeModel {
                settings,
                agents: HashMap::new(),
                effective_state: AgentState::Idle,
                effective_agent_id: None,
                locked_agent_id: None,
                paused: false,
                hardware: HardwareStatus::default(),
                logs: VecDeque::new(),
            })),
            app_handle: Arc::new(RwLock::new(None)),
            hardware_tx: Arc::new(Mutex::new(None)),
            http_lan_tx: Arc::new(Mutex::new(None)),
            data_dir: Arc::new(data_dir),
        })
    }

    pub fn data_dir(&self) -> &Path {
        self.data_dir.as_path()
    }

    pub fn set_app_handle(&self, app_handle: AppHandle) {
        *self.app_handle.write() = Some(app_handle);
    }

    pub fn set_hardware_sender(&self, sender: mpsc::Sender<HardwareMessage>) {
        *self.hardware_tx.lock() = Some(sender);
    }

    pub fn set_http_lan_sender(&self, sender: watch::Sender<bool>) {
        *self.http_lan_tx.lock() = Some(sender);
    }

    pub fn reload_http_listener(&self) {
        if let Some(sender) = self.http_lan_tx.lock().as_ref() {
            let _ = sender.send(self.settings().lan_enabled);
        }
    }

    pub fn settings(&self) -> AppSettings {
        self.model.read().settings.clone()
    }

    pub fn snapshot(&self) -> AppSnapshot {
        let mut pets = pets::scan_pets(self.data_dir()).unwrap_or_else(|_| vec![built_in_pet()]);
        if pets.is_empty() {
            pets.push(built_in_pet());
        }
        let model = self.model.read();
        let selected_pet = pets
            .iter()
            .find(|pet| pet.id == model.settings.selected_pet_id)
            .cloned()
            .or_else(|| pets.first().cloned());
        let mut agents: Vec<_> = model.agents.values().cloned().collect();
        agents.sort_by(|left, right| {
            right
                .connected
                .cmp(&left.connected)
                .then_with(|| right.state.priority().cmp(&left.state.priority()))
                .then_with(|| right.last_seen_ms.cmp(&left.last_seen_ms))
        });
        AppSnapshot {
            version: APP_VERSION.to_string(),
            effective_state: model.effective_state,
            effective_agent_id: model.effective_agent_id.clone(),
            locked_agent_id: model.locked_agent_id.clone(),
            paused: model.paused,
            agents,
            pets,
            selected_pet,
            settings: model.settings.clone(),
            hardware: model.hardware.clone(),
            logs: model.logs.iter().cloned().collect(),
        }
    }

    pub fn broadcast(&self) {
        if let Some(app) = self.app_handle.read().as_ref() {
            let _ = app.emit("snapshot-changed", self.snapshot());
        }
    }

    pub fn log(&self, level: LogLevel, source: impl Into<String>, message: impl Into<String>) {
        let entry = LogEntry {
            at: now_iso(),
            level,
            source: source.into(),
            message: message.into(),
        };
        let mut model = self.model.write();
        model.logs.push_back(entry);
        while model.logs.len() > 500 {
            model.logs.pop_front();
        }
        drop(model);
        self.broadcast();
    }

    pub fn register_agent(&self, registration: RegisterAgent) {
        let now_ms = Utc::now().timestamp_millis();
        let state = registration.state;
        let instance_id = registration.instance_id.clone();
        let mut model = self.model.write();
        model.agents.insert(
            registration.instance_id.clone(),
            AgentInstance {
                instance_id: registration.instance_id,
                client_id: registration.client_id,
                display_name: registration.display_name,
                version: registration.version,
                state,
                session_id: registration.session_id,
                connected: true,
                last_seen_ms: now_ms,
                last_seen_at: now_iso(),
            },
        );
        let changed = recompute(&mut model);
        drop(model);
        self.log(LogLevel::Info, "agent", format!("registered {instance_id}"));
        self.after_state_change(changed);
    }

    pub fn heartbeat(&self, instance_id: &str) -> Result<(), String> {
        let mut model = self.model.write();
        let agent = model
            .agents
            .get_mut(instance_id)
            .ok_or_else(|| format!("unknown agent instance: {instance_id}"))?;
        agent.connected = true;
        agent.last_seen_ms = Utc::now().timestamp_millis();
        agent.last_seen_at = now_iso();
        let changed = recompute(&mut model);
        drop(model);
        self.after_state_change(changed);
        Ok(())
    }

    pub fn submit_state(
        &self,
        instance_id: &str,
        client_id: &str,
        display_name: &str,
        state: AgentState,
        session_id: Option<String>,
    ) {
        let now_ms = Utc::now().timestamp_millis();
        let mut model = self.model.write();
        let agent = model
            .agents
            .entry(instance_id.to_string())
            .or_insert_with(|| AgentInstance {
                instance_id: instance_id.to_string(),
                client_id: client_id.to_string(),
                display_name: display_name.to_string(),
                version: None,
                state,
                session_id: session_id.clone(),
                connected: true,
                last_seen_ms: now_ms,
                last_seen_at: now_iso(),
            });
        let duplicate = agent.state == state;
        agent.client_id = client_id.to_string();
        agent.display_name = display_name.to_string();
        agent.state = state;
        agent.session_id = session_id;
        agent.connected = state != AgentState::Offline;
        agent.last_seen_ms = now_ms;
        agent.last_seen_at = now_iso();
        let changed = recompute(&mut model);
        drop(model);
        if !duplicate {
            self.log(
                LogLevel::Info,
                "state",
                format!("{instance_id} -> {}", state.as_str()),
            );
        }
        self.after_state_change(changed);
    }

    pub fn disconnect_agent(&self, instance_id: &str) -> Result<(), String> {
        let mut model = self.model.write();
        let agent = model
            .agents
            .get_mut(instance_id)
            .ok_or_else(|| format!("unknown agent instance: {instance_id}"))?;
        agent.connected = false;
        agent.state = AgentState::Offline;
        agent.last_seen_ms = Utc::now().timestamp_millis();
        agent.last_seen_at = now_iso();
        let changed = recompute(&mut model);
        drop(model);
        self.after_state_change(changed);
        Ok(())
    }

    pub fn set_locked_agent(&self, instance_id: Option<String>) -> Result<(), String> {
        let mut model = self.model.write();
        if let Some(id) = &instance_id {
            if !model.agents.contains_key(id) {
                return Err(format!("unknown agent instance: {id}"));
            }
        }
        model.locked_agent_id = instance_id;
        let changed = recompute(&mut model);
        drop(model);
        self.after_state_change(changed);
        Ok(())
    }

    pub fn set_paused(&self, paused: bool) {
        let state = {
            let mut model = self.model.write();
            model.paused = paused;
            model.effective_state
        };
        self.log(
            LogLevel::Info,
            "sync",
            if paused {
                "state synchronization paused"
            } else {
                "state synchronization resumed"
            },
        );
        if !paused && self.settings().hardware.transport != HardwareTransport::Disabled {
            self.queue_hardware(HardwareMessage::State(state));
        }
    }

    pub fn save_settings(&self, mut settings: AppSettings) -> anyhow::Result<()> {
        settings.normalize();
        let lan_changed = self.settings().lan_enabled != settings.lan_enabled;

        persist_settings(self.data_dir(), &settings)?;
        self.model.write().settings = settings;
        if lan_changed {
            self.reload_http_listener();
        }
        self.log(LogLevel::Info, "settings", "settings saved");
        Ok(())
    }

    pub fn select_pet(&self, pet_id: &str) -> anyhow::Result<()> {
        let pets = pets::scan_pets(self.data_dir())?;
        if !pets.iter().any(|pet| pet.id == pet_id) {
            anyhow::bail!("pet not found: {pet_id}");
        }
        let mut settings = self.settings();
        settings.selected_pet_id = pet_id.to_string();
        self.save_settings(settings)
    }

    pub fn update_hardware(&self, status: HardwareStatus) {
        self.model.write().hardware = status;
        self.broadcast();
    }

    pub fn hardware_status(&self) -> HardwareStatus {
        self.model.read().hardware.clone()
    }

    pub fn reap_stale_agents(&self) {
        let now_ms = Utc::now().timestamp_millis();
        let mut expired = Vec::new();
        let mut model = self.model.write();
        for agent in model.agents.values_mut() {
            if agent.connected && now_ms - agent.last_seen_ms > AGENT_TIMEOUT_MS {
                agent.connected = false;
                agent.state = AgentState::Offline;
                expired.push(agent.instance_id.clone());
            }
        }
        if model
            .locked_agent_id
            .as_ref()
            .and_then(|id| model.agents.get(id))
            .is_some_and(|agent| !agent.connected)
        {
            model.locked_agent_id = None;
        }
        let changed = recompute(&mut model);
        drop(model);
        for id in expired {
            self.log(LogLevel::Warn, "agent", format!("heartbeat expired: {id}"));
        }
        self.after_state_change(changed);
    }

    pub async fn forward_command(&self, command: String) -> Result<String, String> {
        let sender = self
            .hardware_tx
            .lock()
            .clone()
            .ok_or_else(|| "hardware worker is unavailable".to_string())?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        sender
            .send(HardwareMessage::Command(command, tx))
            .await
            .map_err(|_| "hardware worker stopped".to_string())?;
        rx.await
            .map_err(|_| "hardware worker dropped response".to_string())?
    }

    pub fn queue_hardware(&self, message: HardwareMessage) {
        let sender = self.hardware_tx.lock().clone();
        if let Some(sender) = sender {
            if sender.try_send(message).is_err() {
                self.log(LogLevel::Warn, "hardware", "hardware queue is full");
            }
        }
    }

    fn after_state_change(&self, changed: Option<AgentState>) {
        if let Some(state) = changed {
            let paused = self.model.read().paused;
            if !paused && self.settings().hardware.transport != HardwareTransport::Disabled {
                self.queue_hardware(HardwareMessage::State(state));
            }
        }
        self.broadcast();
    }
}

fn recompute(model: &mut RuntimeModel) -> Option<AgentState> {
    let selected = model
        .locked_agent_id
        .as_ref()
        .and_then(|id| model.agents.get(id))
        .filter(|agent| agent.connected)
        .or_else(|| {
            model
                .agents
                .values()
                .filter(|agent| agent.connected)
                .max_by_key(|agent| (agent.state.priority(), agent.last_seen_ms))
        })
        .or_else(|| model.agents.values().max_by_key(|agent| agent.last_seen_ms));
    let next_state = selected
        .map(|agent| agent.state)
        .unwrap_or(AgentState::Idle);
    let next_agent_id = selected.map(|agent| agent.instance_id.clone());
    let state_changed = next_state != model.effective_state;
    model.effective_state = next_state;
    model.effective_agent_id = next_agent_id;
    state_changed.then_some(next_state)
}

fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

fn load_settings(data_dir: &Path) -> anyhow::Result<AppSettings> {
    let path = settings_path(data_dir);
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let mut settings: AppSettings = serde_json::from_slice(&fs::read(path)?)?;
    settings.normalize();
    Ok(settings)
}

fn persist_settings(data_dir: &Path, settings: &AppSettings) -> anyhow::Result<()> {
    fs::create_dir_all(data_dir)?;
    let target = settings_path(data_dir);
    let temporary = data_dir.join("settings.json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(settings)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(temporary, target)?;
    Ok(())
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    fn core() -> (AppCore, TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (AppCore::new(dir.path().to_path_buf()).unwrap(), dir)
    }

    #[test]
    fn arbitration_uses_priority_then_recency() {
        let (core, _dir) = core();
        core.submit_state("a", "codex", "Codex", AgentState::Running, None);
        core.submit_state("b", "claude", "Claude", AgentState::Waiting, None);
        assert_eq!(core.snapshot().effective_state, AgentState::Waiting);
        assert_eq!(core.snapshot().effective_agent_id.as_deref(), Some("b"));

        core.submit_state("a", "codex", "Codex", AgentState::Error, None);
        assert_eq!(core.snapshot().effective_state, AgentState::Error);
    }

    #[test]
    fn locked_agent_overrides_priority() {
        let (core, _dir) = core();
        core.submit_state("a", "codex", "Codex", AgentState::Running, None);
        core.submit_state("b", "claude", "Claude", AgentState::Error, None);
        core.set_locked_agent(Some("a".into())).unwrap();
        assert_eq!(core.snapshot().effective_state, AgentState::Running);
    }

    #[test]
    fn duplicate_state_does_not_change_effective_state() {
        let (core, _dir) = core();
        core.submit_state("a", "codex", "Codex", AgentState::Busy, None);
        core.submit_state("a", "codex", "Codex", AgentState::Busy, None);
        assert_eq!(core.snapshot().effective_state, AgentState::Busy);
    }

    #[test]
    fn last_disconnected_agent_produces_offline_state() {
        let (core, _dir) = core();
        core.submit_state("a", "codex", "Codex", AgentState::Running, None);
        core.submit_state("a", "codex", "Codex", AgentState::Offline, None);
        assert_eq!(core.snapshot().effective_state, AgentState::Offline);
        assert_eq!(core.snapshot().effective_agent_id.as_deref(), Some("a"));
    }
}
