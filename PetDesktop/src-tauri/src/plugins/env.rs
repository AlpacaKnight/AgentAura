//! Environment detection, CLI resolution, and shared utilities.

use serde_json::Value;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Emitter};

use super::model::{PluginOperationLog, PluginProvider};

// ── Command helpers ──────────────────────────────────────────

/// Run a command and return its output.
pub fn run(c: &mut Command) -> Result<Output, String> {
    #[cfg(target_os = "windows")]
    c.creation_flags(0x08000000);

    c.output()
        .map_err(|e| format!("无法启动 {:?}: {e}", c.get_program()))
}

/// Format stdout + stderr from an output.
pub fn out(o: &Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&o.stdout).trim(),
        String::from_utf8_lossy(&o.stderr).trim()
    )
    .trim()
    .into()
}

// ── Operation ID / Event emission ────────────────────────────

static NEXT_OP_ID: AtomicU64 = AtomicU64::new(1);

pub fn next_operation_id() -> u64 {
    NEXT_OP_ID.fetch_add(1, Ordering::Relaxed)
}

pub fn emit_log(app: &AppHandle, operation_id: u64, kind: &str, text: String) {
    let _ = app.emit(
        "plugin-operation-log",
        PluginOperationLog {
            operation_id,
            kind: kind.to_string(),
            text,
        },
    );
}

// ── File-system helpers ──────────────────────────────────────

pub fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn env_lookup(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

pub fn root(d: &Path) -> PathBuf {
    d.join("managed-plugins/node")
}

pub fn pkg(d: &Path, n: &str) -> PathBuf {
    root(d).join("node_modules").join(n)
}

// ── Qwen Code path resolution ────────────────────────────────

pub fn qwen_dir_with(get: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(v) = nonempty(get("QWEN_CODE_HOME")) {
        return Some(PathBuf::from(v));
    }
    if let Some(v) = nonempty(get("QWEN_HOME")) {
        return Some(PathBuf::from(v));
    }
    let home = nonempty(get("USERPROFILE")).or_else(|| nonempty(get("HOME")))?;
    Some(PathBuf::from(home).join(".qwen"))
}

pub fn qwen_settings_path_with(get: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(v) = nonempty(get("QWEN_CODE_SETTINGS")) {
        return Some(PathBuf::from(v));
    }
    if let Some(v) = nonempty(get("QWEN_SETTINGS_PATH")) {
        return Some(PathBuf::from(v));
    }
    Some(qwen_dir_with(get)?.join("settings.json"))
}

pub fn qwen_extension_dir_with(get: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    Some(
        qwen_dir_with(get)?
            .join("extensions")
            .join("agent-aura-qwencode"),
    )
}

pub fn qwen_extension_dir() -> Option<PathBuf> {
    qwen_extension_dir_with(&env_lookup)
}

pub fn qwencode_config_path_with(get: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(v) = nonempty(get("AGENTAURA_QWENCODE_CONFIG")) {
        return Some(PathBuf::from(v));
    }
    Some(qwen_dir_with(get)?.join("agent-aura-qwencode.json"))
}

pub fn qwen_settings_path() -> Option<PathBuf> {
    qwen_settings_path_with(&env_lookup)
}

pub fn qwencode_config_path() -> Option<PathBuf> {
    qwencode_config_path_with(&env_lookup)
}

pub fn zcode_config_path_with(get: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(v) = nonempty(get("AGENTAURA_ZCODE_CONFIG")) {
        return Some(PathBuf::from(v));
    }
    let home = nonempty(get("USERPROFILE")).or_else(|| nonempty(get("HOME")))?;
    Some(PathBuf::from(home).join(".zcode/agent-aura-zcode.json"))
}

pub fn zcode_config_path() -> Option<PathBuf> {
    zcode_config_path_with(&env_lookup)
}

pub fn config(p: PluginProvider) -> Option<PathBuf> {
    if let PluginProvider::Qwencode = p {
        return qwencode_config_path();
    }
    if let PluginProvider::ZCode = p {
        return zcode_config_path();
    }
    let h = home()?;
    Some(match p {
        PluginProvider::Claude => h.join(".claude/agent-aura-claude.json"),
        PluginProvider::Codex => h.join(".codex/agent-aura-codex.json"),
        PluginProvider::KimiCode => h.join(".kimi-code/agent-aura-kimi-code.json"),
        _ => return None,
    })
}

// ── CLI resolution ───────────────────────────────────────────

#[cfg(target_os = "windows")]
fn windows_node_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(program_files).join("nodejs"));
    }
    if let Some(nvm_symlink) = std::env::var_os("NVM_SYMLINK") {
        dirs.push(PathBuf::from(nvm_symlink));
    }
    if let Some(nvm_home) = std::env::var_os("NVM_HOME") {
        dirs.push(PathBuf::from(nvm_home));
    }
    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        dirs.push(PathBuf::from(user_profile).join(".volta").join("bin"));
    }
    dirs
}

#[cfg(target_os = "windows")]
fn windows_npm_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(program_files).join("nodejs"));
    }
    if let Some(app_data) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(app_data).join("npm"));
    }
    dirs
}

#[cfg(target_os = "windows")]
fn windows_qwen_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(app_data).join("npm"));
    }
    dirs
}

#[cfg(target_os = "windows")]
fn windows_find_command(names: &[&str], extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend(extra_dirs.iter().cloned());
    for dir in &dirs {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn windows_resolved_node_dir() -> Option<PathBuf> {
    windows_find_command(&["node.exe", "node.cmd"], &windows_node_dirs())
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

#[cfg(target_os = "windows")]
fn windows_command_with_path(program: PathBuf) -> Command {
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Some(dir) = program.parent() {
        entries.push(dir.to_path_buf());
    }
    if let Some(node_dir) = windows_resolved_node_dir() {
        entries.push(node_dir);
    }
    if let Some(existing) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&existing));
    }
    let mut seen = std::collections::HashSet::new();
    entries.retain(|dir| seen.insert(dir.clone()));
    let mut command = Command::new(&program);
    if let Ok(joined) = std::env::join_paths(entries) {
        command.env("PATH", joined);
    }
    command
}

#[cfg(target_os = "windows")]
fn windows_not_found(name: &str, extra_dirs: &[PathBuf]) -> String {
    let checked: Vec<String> = extra_dirs
        .iter()
        .map(|dir| dir.display().to_string())
        .collect();
    let locations = if checked.is_empty() {
        "known install locations".to_string()
    } else {
        checked.join(", ")
    };
    format!(
        "{name} was not found on PATH or in {locations}. Install it and fully restart PetDesktop so it can read the updated PATH."
    )
}

pub fn npm_command() -> Result<Command, String> {
    #[cfg(target_os = "windows")]
    {
        windows_find_command(&["npm.cmd"], &windows_npm_dirs())
            .map(windows_command_with_path)
            .ok_or_else(|| windows_not_found("npm", &windows_npm_dirs()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        resolve_unix_command("npm")
    }
}

pub fn node_command() -> Result<Command, String> {
    #[cfg(target_os = "windows")]
    {
        windows_find_command(&["node.exe", "node.cmd"], &windows_node_dirs())
            .map(windows_command_with_path)
            .ok_or_else(|| windows_not_found("node", &windows_node_dirs()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        resolve_unix_command("node")
    }
}

pub fn qwen_command() -> Result<Command, String> {
    #[cfg(target_os = "windows")]
    {
        windows_find_command(&["qwen.cmd", "qwen.exe"], &windows_qwen_dirs())
            .map(windows_command_with_path)
            .ok_or_else(|| windows_not_found("qwen", &windows_qwen_dirs()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        resolve_unix_command("qwen")
    }
}

#[cfg(not(target_os = "windows"))]
fn resolve_unix_command(name: &str) -> Result<Command, String> {
    let candidate_names = [name.to_string()];
    let home = home();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for candidate in &candidate_names {
                candidates.push(dir.join(candidate));
            }
        }
    }
    if let Some(home) = &home {
        candidates.push(home.join(".local/bin").join(name));
        candidates.push(home.join(".nvm/current/bin").join(name));
        let nvm_versions = home.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(&nvm_versions) {
            let mut bins: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin").join(name))
                .collect();
            bins.sort();
            bins.reverse();
            candidates.extend(bins);
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(command_with_resolved_unix_path)
        .ok_or_else(|| format!(
            "{name} was not found. Install the CLI and restart PetDesktop so it can read the updated PATH or use a standard install location like ~/.nvm/versions/node/*/bin."
        ))
}

#[cfg(not(target_os = "windows"))]
fn command_with_resolved_unix_path(path: PathBuf) -> Command {
    let mut command = Command::new(&path);
    if let Some(bin_dir) = path.parent() {
        let mut entries = vec![bin_dir.to_path_buf()];
        if let Some(existing) = std::env::var_os("PATH") {
            entries.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(entries) {
            command.env("PATH", joined);
        }
    }
    command
}

// ── Hook detection ───────────────────────────────────────────

fn has_managed_qwen_hook(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    let Some(hooks) = value.get("hooks").and_then(Value::as_object) else {
        return false;
    };
    hooks.values().any(|entries| {
        entries.as_array().is_some_and(|items| {
            items.iter().any(|entry| {
                entry
                    .get("hooks")
                    .and_then(Value::as_array)
                    .is_some_and(|managed| {
                        managed.iter().any(|hook| {
                            hook.get("name")
                                .and_then(Value::as_str)
                                .is_some_and(|name| name.starts_with("agent-aura-qwencode:"))
                        })
                    })
            })
        })
    })
}

pub fn hook_present(p: PluginProvider) -> bool {
    if let PluginProvider::Qwencode = p {
        let Some(path) = qwen_settings_path() else {
            return false;
        };
        return fs::read_to_string(path)
            .ok()
            .is_some_and(|s| has_managed_qwen_hook(&s));
    }
    if let PluginProvider::ZCode = p {
        let Some(h) = home() else {
            return false;
        };
        let a = h.join(".zcode/cli/config.json");
        return fs::read_to_string(a)
            .ok()
            .is_some_and(|s| s.contains("agent-aura-zcode"));
    }
    let Some(h) = home() else {
        return false;
    };
    let (a, b) = match p {
        PluginProvider::Codex => (h.join(".codex/hooks.json"), "agent-aura-codex"),
        PluginProvider::KimiCode => (
            h.join(".kimi-code/config.toml"),
            "AGENTAURA_KIMI_CODE_HOOKS",
        ),
        _ => return false,
    };
    fs::read_to_string(a).ok().is_some_and(|s| s.contains(b))
}

// ── Backup / restore (Qwen extension) ────────────────────────

pub fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let next_source = entry.path();
        let next_destination = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&next_source, &next_destination)?;
        } else if file_type.is_file() {
            if let Some(parent) = next_destination.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&next_source, &next_destination).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn backup_qwen_extension(data: &Path) -> Result<Option<PathBuf>, String> {
    let Some(source) = qwen_extension_dir() else {
        return Ok(None);
    };
    if !source.exists() {
        return Ok(None);
    }
    let backup = root(data)
        .join("backups")
        .join(format!("qwen-extension-{}", uuid::Uuid::new_v4()));
    copy_dir_recursive(&source, &backup)?;
    Ok(Some(backup))
}

pub fn restore_qwen_extension(backup: &Path) -> Result<(), String> {
    let Some(destination) = qwen_extension_dir() else {
        return Err("无法解析 Qwen Code 扩展目录".into());
    };
    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(|e| e.to_string())?;
    }
    copy_dir_recursive(backup, &destination)
}

pub fn remove_backup(backup: &Path) {
    let _ = fs::remove_dir_all(backup);
}

pub fn rollback_qwen_extension(existed_before: bool, backup: Option<&Path>) -> String {
    if let Some(backup) = backup {
        match restore_qwen_extension(backup) {
            Ok(()) => {
                remove_backup(backup);
                return if existed_before {
                    "已恢复此前存在的旧版扩展".into()
                } else {
                    "已回滚：恢复到安装前状态".into()
                };
            }
            Err(error) => return format!("恢复旧版扩展失败：{error}"),
        }
    }
    let mut qwen = match qwen_command() {
        Ok(command) => command,
        Err(error) => return format!("无法回滚扩展安装：{error}"),
    };
    match run(qwen
        .arg("extensions")
        .arg("uninstall")
        .arg("agent-aura-qwencode"))
    {
        Ok(output) if output.status.success() => {
            if existed_before {
                "已卸载本次安装的扩展；此前存在的旧版本需手动重装".into()
            } else {
                "已回滚：卸载本次安装的扩展".into()
            }
        }
        Ok(output) => format!("回滚卸载失败：{}", out(&output)),
        Err(error) => format!("回滚卸载出错：{error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn getter(map: HashMap<&'static str, &'static str>) -> impl Fn(&str) -> Option<String> {
        move |key: &str| map.get(key).map(|value| value.to_string())
    }

    #[test]
    fn qwen_dir_prefers_qwen_code_home() {
        let get = getter(HashMap::from([
            ("QWEN_CODE_HOME", "/a"),
            ("QWEN_HOME", "/b"),
            ("HOME", "/c"),
        ]));
        assert_eq!(qwen_dir_with(&get), Some(PathBuf::from("/a")));
    }

    #[test]
    fn qwen_dir_falls_back_to_qwen_home_then_default() {
        let get = getter(HashMap::from([("QWEN_HOME", "/b"), ("HOME", "/c")]));
        assert_eq!(qwen_dir_with(&get), Some(PathBuf::from("/b")));

        let get = getter(HashMap::from([("HOME", "/c")]));
        assert_eq!(qwen_dir_with(&get), Some(PathBuf::from("/c/.qwen")));
    }

    #[test]
    fn qwen_dir_treats_empty_vars_as_unset() {
        let get = getter(HashMap::from([
            ("QWEN_CODE_HOME", ""),
            ("QWEN_HOME", ""),
            ("USERPROFILE", "/user"),
        ]));
        assert_eq!(qwen_dir_with(&get), Some(PathBuf::from("/user/.qwen")));
    }

    #[test]
    fn qwen_settings_path_priority_and_default() {
        let get = getter(HashMap::from([
            ("QWEN_CODE_SETTINGS", "/s1"),
            ("QWEN_SETTINGS_PATH", "/s2"),
            ("HOME", "/c"),
        ]));
        assert_eq!(qwen_settings_path_with(&get), Some(PathBuf::from("/s1")));

        let get = getter(HashMap::from([
            ("QWEN_SETTINGS_PATH", "/s2"),
            ("HOME", "/c"),
        ]));
        assert_eq!(qwen_settings_path_with(&get), Some(PathBuf::from("/s2")));

        let get = getter(HashMap::from([("HOME", "/c")]));
        assert_eq!(
            qwen_settings_path_with(&get),
            Some(PathBuf::from("/c/.qwen/settings.json"))
        );
    }

    #[test]
    fn qwencode_config_path_priority_and_empty_override() {
        let get = getter(HashMap::from([
            ("AGENTAURA_QWENCODE_CONFIG", "/cfg"),
            ("HOME", "/c"),
        ]));
        assert_eq!(qwencode_config_path_with(&get), Some(PathBuf::from("/cfg")));

        let get = getter(HashMap::from([
            ("AGENTAURA_QWENCODE_CONFIG", ""),
            ("HOME", "/c"),
        ]));
        assert_eq!(
            qwencode_config_path_with(&get),
            Some(PathBuf::from("/c/.qwen/agent-aura-qwencode.json"))
        );
    }

    #[test]
    fn qwen_hook_presence_requires_structured_managed_entry() {
        let text = r#"{
          "hooks": {
            "SessionStart": [
              {
                "hooks": [
                  {
                    "type": "command",
                    "name": "agent-aura-qwencode:SessionStart",
                    "timeout": 15000,
                    "shell": "powershell"
                  }
                ]
              }
            ]
          }
        }"#;
        assert!(has_managed_qwen_hook(text));
        assert!(!has_managed_qwen_hook(
            r#"{"hooks":{"SessionStart":[{"hooks":[{"name":"keep-auth"}]}]}}"#
        ));
        assert!(!has_managed_qwen_hook("not json"));
    }
}
