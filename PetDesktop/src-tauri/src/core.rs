use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use chrono::{Local, SecondsFormat, Utc};

use parking_lot::{Mutex, RwLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch};

use crate::{
    hardware::HardwareMessage,
    model::{
        built_in_pet, message_expired, AgentInstance, AgentState, AppSettings, AppSnapshot,
        HardwareStatus, HardwareTransport, LogEntry, LogLevel, PetMessage, PetMessageKind,
        AGENT_TIMEOUT_MS, APP_VERSION, PET_MESSAGE_MAX_INPUT, PET_MESSAGE_QUEUE_MAX,
        PET_MESSAGE_TTL_MAX_MS, PET_MESSAGE_TTL_MIN_MS,
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
    pet_messages: HashMap<String, VecDeque<PetMessage>>,
}

#[derive(Clone)]
pub struct AppCore {
    model: Arc<RwLock<RuntimeModel>>,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    hardware_tx: Arc<Mutex<Option<mpsc::Sender<HardwareMessage>>>>,
    http_lan_tx: Arc<Mutex<Option<watch::Sender<bool>>>>,
    data_dir: Arc<RwLock<Option<PathBuf>>>,
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

/// `submit_message` 的错误类型，区分"未知实例"(404) 和"输入校验失败"(400)。
#[derive(Debug)]
pub enum SubmitMessageError {
    NotFound(String),
    BadRequest(String),
}

impl SubmitMessageError {
    #[allow(dead_code)]
    pub fn message(&self) -> &str {
        match self {
            Self::NotFound(msg) | Self::BadRequest(msg) => msg,
        }
    }
}

impl AppCore {
    /// Create an uninitialized core (state is registered before setup).
    pub fn new_uninit() -> Self {
        Self {
            model: Arc::new(RwLock::new(RuntimeModel {
                settings: AppSettings::default(),
                agents: HashMap::new(),
                effective_state: AgentState::Idle,
                effective_agent_id: None,
                locked_agent_id: None,
                paused: false,
                hardware: HardwareStatus::default(),
                logs: VecDeque::new(),
                pet_messages: HashMap::new(),
            })),
            app_handle: Arc::new(RwLock::new(None)),
            hardware_tx: Arc::new(Mutex::new(None)),
            http_lan_tx: Arc::new(Mutex::new(None)),
            data_dir: Arc::new(RwLock::new(None)),
        }
    }

    /// Create and immediately initialize with a data directory (for tests).
    #[allow(dead_code)]
    pub fn new(data_dir: PathBuf) -> anyhow::Result<Self> {
        let core = Self::new_uninit();
        core.init(data_dir)?;
        Ok(core)
    }

    /// Initialize with the real data directory (called inside setup).
    pub fn init(&self, data_dir: PathBuf) -> anyhow::Result<()> {
        fs::create_dir_all(data_dir.join("pets"))?;
        let settings = load_settings(&data_dir).unwrap_or_default();
        self.model.write().settings = settings;
        *self.data_dir.write() = Some(data_dir);
        Ok(())
    }

    pub fn data_dir(&self) -> anyhow::Result<PathBuf> {
        self.data_dir
            .read()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("AppCore is still initializing"))
    }

    pub fn set_app_handle(&self, app_handle: AppHandle) {
        *self.app_handle.write() = Some(app_handle);
    }

    pub fn set_hardware_sender(&self, sender: mpsc::Sender<HardwareMessage>) {
        *self.hardware_tx.lock() = Some(sender);
        let initial_state = {
            let model = self.model.read();
            (!model.paused && model.settings.hardware.transport != HardwareTransport::Disabled)
                .then_some(model.effective_state)
        };
        if let Some(state) = initial_state {
            self.queue_hardware(HardwareMessage::State(state));
        }
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
        let mut pets = self
            .data_dir()
            .and_then(|data_dir| pets::scan_pets(&data_dir))
            .unwrap_or_else(|_| vec![built_in_pet()]);
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
        let pet_messages = effective_pet_messages(&model, now_ms());
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
            pet_messages,
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
        let session_id = registration.session_id.clone();
        let mut model = self.model.write();

        // 同一实例重注册时会话发生变化时，清空上一轮的气泡消息，避免旧消息残留。
        let session_changed = model
            .agents
            .get(&instance_id)
            .is_some_and(|existing| existing.session_id != session_id && session_id.is_some());
        if session_changed {
            model.pet_messages.remove(&instance_id);
        }

        model.agents.insert(
            registration.instance_id.clone(),
            AgentInstance {
                instance_id: registration.instance_id,
                client_id: registration.client_id,
                display_name: registration.display_name,
                version: registration.version,
                state,
                session_id,
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

        persist_settings(&self.data_dir()?, &settings)?;
        self.model.write().settings = settings;
        if lan_changed {
            self.reload_http_listener();
        }
        let current_state = {
            let model = self.model.read();
            (!model.paused && model.settings.hardware.transport != HardwareTransport::Disabled)
                .then_some(model.effective_state)
        };
        if let Some(state) = current_state {
            self.queue_hardware(HardwareMessage::State(state));
        }
        self.log(LogLevel::Info, "settings", "settings saved");
        Ok(())
    }

    pub fn select_pet(&self, pet_id: &str) -> anyhow::Result<()> {
        let pets = pets::scan_pets(&self.data_dir()?)?;
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

    /// 接收一条桌宠气泡消息。未注册 Agent 返回 `NotFound`，输入校验失败返回 `BadRequest`。
    pub fn submit_message(
        &self,
        instance_id: &str,
        kind: PetMessageKind,
        text: &str,
        source: &str,
        priority: Option<u16>,
        ttl_ms: Option<u64>,
    ) -> Result<(), SubmitMessageError> {
        let now_ms = Utc::now().timestamp_millis();
        let mut model = self.model.write();
        if !model.agents.contains_key(instance_id) {
            return Err(SubmitMessageError::NotFound(format!(
                "unknown agent instance: {instance_id}"
            )));
        }

        // 拒绝空文本。
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(SubmitMessageError::BadRequest(
                "message text must not be empty".to_string(),
            ));
        }

        // 截断到 500 Unicode 字符。
        let truncated: String = trimmed.chars().take(PET_MESSAGE_MAX_INPUT).collect();
        let priority = priority.unwrap_or_else(|| kind.default_priority());
        let ttl = ttl_ms
            .unwrap_or_else(|| {
                // 默认 TTL 使用气泡设置中的显示时长（秒 → 毫秒），夹取到合法区间。
                (model.settings.pet_bubble.duration_seconds * 1000).max(PET_MESSAGE_TTL_MIN_MS)
            })
            .clamp(PET_MESSAGE_TTL_MIN_MS, PET_MESSAGE_TTL_MAX_MS);

        let forward_to_hardware = model.effective_agent_id.as_deref() == Some(instance_id)
            && model.settings.pet_bubble.enabled
            && !model.paused
            && model.settings.hardware.transport != HardwareTransport::Disabled;

        let queue = model
            .pet_messages
            .entry(instance_id.to_string())
            .or_default();

        // 去重：队尾最新消息文本相同且 1.5s 内 → 跳过。
        let dedup_window_ms = PET_MESSAGE_TTL_MIN_MS as i64;
        if let Some(tail) = queue.back() {
            let tail_ms = chrono::DateTime::parse_from_rfc3339(&tail.created_at)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0);
            if tail.text == truncated && now_ms - tail_ms < dedup_window_ms {
                return Ok(());
            }
            // 高优先级替换：队尾优先级严格低于新消息 → 弹出。
            if tail.priority < priority {
                queue.pop_back();
            }
        }

        let message = PetMessage {
            id: uuid::Uuid::new_v4().to_string(),
            agent_instance_id: Some(instance_id.to_string()),
            kind,
            text: truncated.clone(),
            source: source.to_string(),
            priority,
            created_at: now_iso(),
            ttl_ms: ttl,
        };
        queue.push_back(message);

        // 封顶：每个 Agent 最多 20 条。
        while queue.len() > PET_MESSAGE_QUEUE_MAX {
            queue.pop_front();
        }
        drop(model);

        if forward_to_hardware {
            self.queue_hardware(HardwareMessage::PetMessage(truncated.clone()));
        }

        // 历史进入运行日志（不持久化完整正文，仅内存日志）。
        let kind_label = match kind {
            PetMessageKind::State => "state",
            PetMessageKind::Activity => "activity",
            PetMessageKind::Success => "success",
            PetMessageKind::Warning => "warning",
            PetMessageKind::Error => "error",
        };
        self.log(
            LogLevel::Info,
            "message",
            format!("[{instance_id}] {kind_label}: {truncated}"),
        );
        self.broadcast();
        Ok(())
    }

    /// 清理所有 Agent 的过期气泡消息（在 reaper 循环中调用）。
    pub fn reap_expired_messages(&self) {
        let now_ms = Utc::now().timestamp_millis();
        let mut model = self.model.write();
        let mut changed = false;
        for queue in model.pet_messages.values_mut() {
            let before = queue.len();
            queue.retain(|m| !message_expired(m, now_ms));
            if queue.len() != before {
                changed = true;
            }
        }
        drop(model);
        if changed {
            self.broadcast();
        }
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

    pub async fn disconnect_hardware(&self) -> Result<(), String> {
        let sender = self
            .hardware_tx
            .lock()
            .clone()
            .ok_or_else(|| "hardware worker is unavailable".to_string())?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        sender
            .send(HardwareMessage::Disconnect(tx))
            .await
            .map_err(|_| "hardware worker stopped".to_string())?;
        rx.await
            .map_err(|_| "hardware worker dropped disconnect response".to_string())
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

/// 取生效 Agent 队列中未过期的消息，按 priority 降序、createdAt 降序排序，cap 20。
fn effective_pet_messages(model: &RuntimeModel, now_ms: i64) -> Vec<PetMessage> {
    let Some(agent_id) = model.effective_agent_id.as_ref() else {
        return Vec::new();
    };
    let Some(queue) = model.pet_messages.get(agent_id) else {
        return Vec::new();
    };
    let mut messages: Vec<PetMessage> = queue
        .iter()
        .filter(|m| !message_expired(m, now_ms))
        .cloned()
        .collect();
    messages.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
    messages.truncate(PET_MESSAGE_QUEUE_MAX);
    messages
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
    Local::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
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

    #[test]
    fn submit_message_rejects_unknown_agent() {
        let (core, _dir) = core();
        let result =
            core.submit_message("ghost", PetMessageKind::Activity, "hi", "test", None, None);
        assert!(matches!(result, Err(SubmitMessageError::NotFound(_))));
        assert!(result
            .unwrap_err()
            .message()
            .contains("unknown agent instance"));
    }

    #[test]
    fn submit_message_rejects_empty_text() {
        let (core, _dir) = core();
        core.submit_state("a", "codex", "Codex", AgentState::Running, None);
        let result = core.submit_message("a", PetMessageKind::Activity, "   ", "codex", None, None);
        assert!(matches!(result, Err(SubmitMessageError::BadRequest(_))));
    }

    #[test]
    fn register_agent_clears_stale_messages_on_new_session() {
        let (core, _dir) = core();
        core.register_agent(RegisterAgent {
            instance_id: "codex-test".into(),
            client_id: "codex".into(),
            display_name: "Codex".into(),
            version: None,
            state: AgentState::Running,
            session_id: Some("session-1".into()),
        });
        core.submit_message(
            "codex-test",
            PetMessageKind::Activity,
            "old message",
            "codex",
            None,
            None,
        )
        .unwrap();
        assert_eq!(core.snapshot().pet_messages.len(), 1);

        // 同一实例、不同 session 重新注册 → 旧消息应被清除。
        core.register_agent(RegisterAgent {
            instance_id: "codex-test".into(),
            client_id: "codex".into(),
            display_name: "Codex".into(),
            version: None,
            state: AgentState::Running,
            session_id: Some("session-2".into()),
        });
        assert_eq!(
            core.snapshot().pet_messages.len(),
            0,
            "messages should be cleared on new session"
        );

        // 同一实例、相同 session 重新注册 → 消息应保留。
        core.submit_message(
            "codex-test",
            PetMessageKind::Activity,
            "persist msg",
            "codex",
            None,
            None,
        )
        .unwrap();
        core.register_agent(RegisterAgent {
            instance_id: "codex-test".into(),
            client_id: "codex".into(),
            display_name: "Codex".into(),
            version: None,
            state: AgentState::Running,
            session_id: Some("session-2".into()),
        });
        assert_eq!(
            core.snapshot().pet_messages.len(),
            1,
            "messages should persist on same session"
        );
    }

    #[test]
    fn submit_message_appears_in_snapshot_for_effective_agent() {
        let (core, _dir) = core();
        core.submit_state("a", "codex", "Codex", AgentState::Running, None);
        core.submit_message(
            "a",
            PetMessageKind::Activity,
            "正在运行 cargo test",
            "codex",
            None,
            None,
        )
        .unwrap();
        let snap = core.snapshot();
        assert_eq!(snap.pet_messages.len(), 1);
        assert_eq!(snap.pet_messages[0].text, "正在运行 cargo test");
        assert_eq!(snap.pet_messages[0].agent_instance_id.as_deref(), Some("a"));
    }

    #[test]
    fn submit_message_deduplicates_identical_recent() {
        let (core, _dir) = core();
        core.submit_state("a", "codex", "Codex", AgentState::Running, None);
        core.submit_message("a", PetMessageKind::Activity, "same", "codex", None, None)
            .unwrap();
        core.submit_message("a", PetMessageKind::Activity, "same", "codex", None, None)
            .unwrap();
        let snap = core.snapshot();
        assert_eq!(
            snap.pet_messages.len(),
            1,
            "identical message within dedup window should not duplicate"
        );
    }

    #[test]
    fn submit_message_high_priority_replaces_low_tail() {
        let (core, _dir) = core();
        core.submit_state("a", "codex", "Codex", AgentState::Running, None);
        core.submit_message(
            "a",
            PetMessageKind::Activity,
            "running tool",
            "codex",
            Some(20),
            None,
        )
        .unwrap();
        core.submit_message(
            "a",
            PetMessageKind::Error,
            "error!",
            "codex",
            Some(80),
            None,
        )
        .unwrap();
        let snap = core.snapshot();
        assert_eq!(
            snap.pet_messages.len(),
            1,
            "high priority should replace lower tail"
        );
        assert_eq!(snap.pet_messages[0].text, "error!");
        assert_eq!(snap.pet_messages[0].kind, PetMessageKind::Error);
    }

    #[test]
    fn submit_message_truncates_long_text() {
        let (core, _dir) = core();
        core.submit_state("a", "codex", "Codex", AgentState::Running, None);
        let long = "A".repeat(600);
        core.submit_message("a", PetMessageKind::Activity, &long, "codex", None, None)
            .unwrap();
        let snap = core.snapshot();
        assert_eq!(snap.pet_messages[0].text.chars().count(), 500);
    }

    #[test]
    fn submit_message_queue_capped_at_max() {
        let (core, _dir) = core();
        core.submit_state("a", "codex", "Codex", AgentState::Running, None);
        // 用不同文本绕过去重。
        for i in 0..30 {
            core.submit_message(
                "a",
                PetMessageKind::Activity,
                &format!("msg-{i}"),
                "codex",
                None,
                None,
            )
            .unwrap();
        }
        let snap = core.snapshot();
        assert_eq!(snap.pet_messages.len(), 20);
    }

    #[test]
    fn snapshot_shows_only_effective_agent_messages() {
        let (core, _dir) = core();
        core.submit_state("a", "codex", "Codex", AgentState::Running, None);
        core.submit_state("b", "claude", "Claude", AgentState::Error, None);
        core.submit_message(
            "a",
            PetMessageKind::Activity,
            "agent-a-msg",
            "codex",
            None,
            None,
        )
        .unwrap();
        core.submit_message(
            "b",
            PetMessageKind::Error,
            "agent-b-msg",
            "claude",
            None,
            None,
        )
        .unwrap();
        // Error 优先级高于 Running → effective agent 是 b。
        let snap = core.snapshot();
        assert_eq!(snap.effective_agent_id.as_deref(), Some("b"));
        assert_eq!(snap.pet_messages.len(), 1);
        assert_eq!(snap.pet_messages[0].text, "agent-b-msg");
    }
}
