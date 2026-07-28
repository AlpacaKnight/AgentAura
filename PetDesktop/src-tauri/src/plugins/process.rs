//! Plugin install, uninstall, hooks, and configuration operations.

use serde_json::Value;
#[cfg(target_os = "windows")]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::AppHandle;
use tokio::io::AsyncBufReadExt;
use tokio::sync::oneshot;
use zip::ZipArchive;

use super::env::{
    backup_qwen_extension, config, emit_log, home, hook_present, node_command, npm_command, out,
    pkg, qwen_command, qwen_extension_dir, remove_backup, rollback_qwen_extension, root, run,
};
use super::inspect::{safe, validate_qwen_zip};
use super::model::{
    ManagedPluginStatus, PluginOperationResult, PluginPackageInspection, PluginProvider,
};

// ── Plugin status ────────────────────────────────────────────

/// Determine the installation status of a single plugin provider.
pub fn list_plugin_status(data: &Path, p: PluginProvider) -> ManagedPluginStatus {
    let managed_installed = p.package().is_some_and(|n| pkg(data, n).exists());
    let managed_version = managed_version(data, p);
    let global_version = p.package().and_then(global_node_package_version);
    let global_installed = global_version.is_some();
    let (external_installed, external_version) = external_install_info(p);
    let version = managed_version
        .clone()
        .or(global_version.clone())
        .or(external_version.clone());
    let import_path = resolve_import_path(data, p, managed_installed, global_installed);
    let preferred_source = if managed_installed {
        Some("managed".to_string())
    } else if global_installed {
        Some("global".to_string())
    } else if external_installed {
        Some("external".to_string())
    } else {
        None
    };
    ManagedPluginStatus {
        provider: p,
        installed: managed_installed || global_installed || external_installed,
        version,
        import_path,
        hooks_installed: hook_present(p),
        hooks_supported: p.hooks(),
        config_path: config(p).map(|v| v.display().to_string()),
        managed_installed,
        global_installed,
        external_installed,
        preferred_source,
        managed_version,
        global_version,
        external_version,
    }
}

fn resolve_import_path(
    data: &Path,
    provider: PluginProvider,
    managed_installed: bool,
    global_installed: bool,
) -> Option<String> {
    if provider != PluginProvider::ZCode {
        return None;
    }

    if managed_installed {
        let package_path = pkg(data, provider.package()?);
        if package_path.join(".zcode-plugin/plugin.json").exists() {
            return Some(package_path.display().to_string());
        }
    }

    if global_installed {
        let package_path = global_node_package_path(provider.package()?)?;
        if package_path.join(".zcode-plugin/plugin.json").exists() {
            return Some(package_path.display().to_string());
        }
    }

    None
}

/// Status for all known plugin providers.
pub fn list_plugins(data: &Path) -> Result<Vec<ManagedPluginStatus>, String> {
    Ok([
        PluginProvider::Claude,
        PluginProvider::Codex,
        PluginProvider::Copilot,
        PluginProvider::KimiCode,
        PluginProvider::Qwencode,
        PluginProvider::Qwenpaw,
        PluginProvider::ZCode,
    ]
    .into_iter()
    .map(|p| list_plugin_status(data, p))
    .collect())
}

// ── Uninstall ────────────────────────────────────────────────

/// Synchronous uninstall of a plugin.
#[allow(dead_code)]
pub fn uninstall_plugin(data: &Path, p: PluginProvider) -> Result<PluginOperationResult, String> {
    let o = match p {
        PluginProvider::Copilot => run(Command::new("code")
            .arg("--uninstall-extension")
            .arg("AlpacaKnight.agent-aura-copilot"))?,
        PluginProvider::Qwenpaw => run(Command::new("qwenpaw")
            .arg("plugin")
            .arg("uninstall")
            .arg("agentaura"))?,
        PluginProvider::Qwencode => {
            let mut outputs = Vec::new();
            if p.hooks() {
                let _ = manage_hooks(data, p, false);
            }
            let (extension_installed, _) = external_install_info(PluginProvider::Qwencode);
            if extension_installed {
                let mut qwen = qwen_command()?;
                outputs.push(run(qwen
                    .arg("extensions")
                    .arg("uninstall")
                    .arg("agent-aura-qwencode"))?);
            }
            if pkg(data, "agent-aura-qwencode").exists() {
                let mut npm = npm_command()?;
                outputs.push(run(npm
                    .arg("uninstall")
                    .arg("--prefix")
                    .arg(root(data))
                    .arg("agent-aura-qwencode"))?);
            }
            if global_node_package_installed("agent-aura-qwencode") {
                let mut npm = npm_command()?;
                outputs.push(run(npm
                    .arg("uninstall")
                    .arg("-g")
                    .arg("agent-aura-qwencode"))?);
            }
            if outputs.is_empty() {
                return Ok(PluginOperationResult {
                    provider: p,
                    success: true,
                    message: "未检测到可卸载的安装来源".into(),
                    output: String::new(),
                });
            }
            let success = outputs.iter().all(|o| o.status.success());
            let output = outputs
                .into_iter()
                .map(|o| out(&o))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(PluginOperationResult {
                provider: p,
                success,
                message: if success {
                    "卸载完成"
                } else {
                    "卸载失败"
                }
                .into(),
                output,
            });
        }
        _ => {
            let package = p.package().ok_or("没有可卸载的托管包")?;
            let mut outputs = Vec::new();
            if p.hooks() {
                let _ = manage_hooks(data, p, false);
            }
            if pkg(data, package).exists() {
                let mut npm = npm_command()?;
                outputs.push(run(npm
                    .arg("uninstall")
                    .arg("--prefix")
                    .arg(root(data))
                    .arg(package))?);
            }
            if global_node_package_installed(package) {
                let mut npm = npm_command()?;
                outputs.push(run(npm.arg("uninstall").arg("-g").arg(package))?);
            }
            if outputs.is_empty() {
                return Ok(PluginOperationResult {
                    provider: p,
                    success: true,
                    message: "未检测到可卸载的安装来源".into(),
                    output: String::new(),
                });
            }
            let success = outputs.iter().all(|o| o.status.success());
            let output = outputs
                .into_iter()
                .map(|o| out(&o))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(PluginOperationResult {
                provider: p,
                success,
                message: if success {
                    "卸载完成"
                } else {
                    "卸载失败"
                }
                .into(),
                output,
            });
        }
    };
    let success = o.status.success();
    Ok(PluginOperationResult {
        provider: p,
        success,
        message: if success {
            "卸载完成"
        } else {
            "卸载失败"
        }
        .into(),
        output: out(&o),
    })
}

// ── Hooks management ─────────────────────────────────────────

/// Install or uninstall hooks for a plugin.
#[allow(dead_code)]
pub fn manage_hooks(
    data: &Path,
    p: PluginProvider,
    install: bool,
) -> Result<PluginOperationResult, String> {
    if !p.hooks() {
        return Err("不支持 Hooks".into());
    }
    let action = if install {
        "install-hooks"
    } else {
        "uninstall-hooks"
    };
    let managed_entry = pkg(data, p.package().unwrap()).join("out/index.js");
    let external_entry = if p == PluginProvider::Qwencode {
        qwen_extension_dir().map(|dir| dir.join("out/index.js"))
    } else {
        None
    };
    let o = if managed_entry.exists() {
        let mut node = node_command()?;
        run(node.arg(managed_entry).arg(action))?
    } else if let Some(entry) = external_entry.filter(|entry| entry.exists()) {
        let mut node = node_command()?;
        run(node.arg(entry).arg(action))?
    } else {
        run(Command::new(p.cli().unwrap()).arg(action))?
    };
    let success = o.status.success();
    Ok(PluginOperationResult {
        provider: p,
        success,
        message: if success {
            "Hooks 操作完成"
        } else {
            "Hooks 操作失败"
        }
        .into(),
        output: out(&o),
    })
}

// ── Hooks repair ─────────────────────────────────────────────

fn print_hooks(data: &Path, p: PluginProvider) -> Result<String, String> {
    if !p.hooks() {
        return Err("不支持 Hooks".into());
    }
    let managed_entry = pkg(data, p.package().unwrap()).join("out/index.js");
    let external_entry = if p == PluginProvider::Qwencode {
        qwen_extension_dir().map(|dir| dir.join("out/index.js"))
    } else {
        None
    };
    let o = if managed_entry.exists() {
        let mut node = node_command()?;
        run(node.arg(managed_entry).arg("hooks").arg("print"))?
    } else if let Some(entry) = external_entry.filter(|entry| entry.exists()) {
        let mut node = node_command()?;
        run(node.arg(entry).arg("hooks").arg("print"))?
    } else {
        run(Command::new(p.cli().unwrap()).arg("hooks").arg("print"))?
    };
    if o.status.success() {
        Ok(out(&o))
    } else {
        Err(out(&o))
    }
}

// ── Config ───────────────────────────────────────────────────

/// Read a plugin's config file as JSON string.
pub fn load_config(p: PluginProvider) -> Result<String, String> {
    let path = config(p).ok_or("无独立配置")?;
    fs::read_to_string(path)
        .or_else(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Ok("{}\n".into())
            } else {
                Err(e)
            }
        })
        .map_err(|e| e.to_string())
}

/// Write a plugin's config file with atomic replacement.
pub fn save_config(p: PluginProvider, s: &str) -> Result<(), String> {
    let _: Value = serde_json::from_str(s).map_err(|e| format!("无效 JSON: {e}"))?;
    let path = config(p).ok_or("无独立配置")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    // 原子写入：先写临时文件，再 rename 替换
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, s).map_err(|e| format!("写入临时文件失败: {e}"))?;
    if path.exists() {
        fs::copy(&path, path.with_extension("json.bak")).map_err(|e| e.to_string())?;
    }
    // 原子替换；失败时清理临时文件避免残留
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("原子替换失败: {e}"));
    }
    Ok(())
}

// ── Helper functions ─────────────────────────────────────────

fn managed_version(data: &Path, p: PluginProvider) -> Option<String> {
    let package = p.package()?;
    let value: Value =
        serde_json::from_slice(&fs::read(pkg(data, package).join("package.json")).ok()?).ok()?;
    value.get("version")?.as_str().map(str::to_owned)
}

fn global_node_package_version(package: &str) -> Option<String> {
    let mut npm = npm_command().ok()?;
    let output = run(npm
        .arg("list")
        .arg("-g")
        .arg("--depth=0")
        .arg("--json")
        .arg(package))
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let value: Value = serde_json::from_slice(&output.stdout).ok()?;
    value
        .get("dependencies")?
        .get(package)?
        .get("version")?
        .as_str()
        .map(str::to_owned)
}

fn global_node_package_path(package: &str) -> Option<PathBuf> {
    let mut npm = npm_command().ok()?;
    let output = run(npm.arg("root").arg("-g")).ok()?;
    if !output.status.success() {
        return None;
    }
    let output_text = String::from_utf8_lossy(&output.stdout);
    let root = output_text
        .lines()
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(PathBuf::from(root).join(package))
}

fn global_node_package_installed(package: &str) -> bool {
    global_node_package_version(package).is_some()
}

fn claude_install_info_from(path: &Path) -> (bool, Option<String>) {
    let value: Value = match fs::read(path)
        .ok()
        .and_then(|content| serde_json::from_slice(&content).ok())
    {
        Some(value) => value,
        None => return (false, None),
    };
    let Some(plugins) = value.get("plugins").and_then(Value::as_object) else {
        return (false, None);
    };
    let Some(installs) = plugins
        .iter()
        .find_map(|(name, installs)| name.starts_with("agent-aura-claude@").then_some(installs))
    else {
        return (false, None);
    };
    let version = installs
        .as_array()
        .and_then(|entries| entries.first())
        .and_then(|entry| entry.get("version"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    (true, version)
}

fn external_install_info(p: PluginProvider) -> (bool, Option<String>) {
    match p {
        PluginProvider::Claude => home()
            .map(|home| {
                claude_install_info_from(&home.join(".claude/plugins/installed_plugins.json"))
            })
            .unwrap_or((false, None)),
        PluginProvider::Copilot => run(Command::new("code")
            .arg("--list-extensions")
            .arg("--show-versions"))
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            let needle = "alpacaknight.agent-aura-copilot@";
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let lowered = line.to_ascii_lowercase();
                if let Some(index) = lowered.find(needle) {
                    return (true, Some(line[index + needle.len()..].trim().to_string()));
                }
            }
            (false, None)
        })
        .unwrap_or((false, None)),
        PluginProvider::Qwenpaw => run(Command::new("qwenpaw").arg("plugin").arg("list"))
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                let installed = String::from_utf8_lossy(&o.stdout)
                    .to_ascii_lowercase()
                    .contains("agentaura");
                (installed, None)
            })
            .unwrap_or((false, None)),
        PluginProvider::Qwencode => qwen_command()
            .ok()
            .and_then(|mut qwen| run(qwen.arg("extensions").arg("list")).ok())
            .filter(|o| o.status.success())
            .map(|o| {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    let lowered = line.to_ascii_lowercase();
                    if lowered.contains("agent-aura-qwencode") {
                        let version = line
                            .rsplit_once('(')
                            .and_then(|(_, tail)| tail.strip_suffix(')'))
                            .map(|value| value.trim().to_string());
                        return (true, version);
                    }
                }
                (false, None)
            })
            .unwrap_or((false, None)),
        _ => (false, None),
    }
}

#[cfg(test)]
mod tests {
    use super::claude_install_info_from;
    use std::fs;

    #[test]
    fn detects_claude_marketplace_installation() {
        let directory = tempfile::tempdir().unwrap();
        let registry = directory.path().join("installed_plugins.json");
        fs::write(
            &registry,
            r#"{
                "version": 2,
                "plugins": {
                    "agent-aura-claude@agentaura": [
                        {"scope": "user", "version": "0.3.0"}
                    ]
                }
            }"#,
        )
        .unwrap();

        assert_eq!(
            claude_install_info_from(&registry),
            (true, Some("0.3.0".to_string()))
        );
    }

    #[test]
    fn ignores_unrelated_claude_plugins() {
        let directory = tempfile::tempdir().unwrap();
        let registry = directory.path().join("installed_plugins.json");
        fs::write(
            &registry,
            r#"{"plugins":{"another-plugin@marketplace":[{"version":"1.0.0"}]}}"#,
        )
        .unwrap();

        assert_eq!(claude_install_info_from(&registry), (false, None));
    }
}

// ── Streaming operations ─────────────────────────────────────

fn cancellation_flag(cancel_rx: oneshot::Receiver<()>) -> Arc<AtomicBool> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_for_monitor = cancelled.clone();
    tokio::spawn(async move {
        let _ = cancel_rx.await;
        cancel_for_monitor.store(true, Ordering::Relaxed);
    });
    cancelled
}

fn cancelled_result(p: PluginProvider) -> PluginOperationResult {
    PluginOperationResult {
        provider: p,
        success: false,
        message: "操作已取消".to_string(),
        output: String::new(),
    }
}

fn command_result(
    p: PluginProvider,
    success_message: &str,
    failure_message: &str,
    output: Output,
) -> PluginOperationResult {
    let success = output.status.success();
    PluginOperationResult {
        provider: p,
        success,
        message: if success {
            success_message
        } else {
            failure_message
        }
        .into(),
        output: out(&output),
    }
}

/// Run a command and push its stdout/stderr in real-time via Tauri events.
/// On cancel, kills the child process and emits a "cancel" event.
/// Returns Ok(Output) with collected stdout/stderr on success, or Err on cancel/error.
async fn run_and_emit(
    cmd: &mut Command,
    app: &AppHandle,
    operation_id: u64,
    cancelled: &Arc<AtomicBool>,
) -> Result<Output, String> {
    let program = cmd.get_program().to_os_string();
    let args: Vec<_> = cmd.get_args().map(|a| a.to_os_string()).collect();
    let mut tokio_cmd = tokio::process::Command::new(&program);
    tokio_cmd.args(&args);
    if let Some(cwd) = cmd.get_current_dir() {
        tokio_cmd.current_dir(cwd);
    }
    for (key, value) in cmd.get_envs() {
        match value {
            Some(value) => {
                tokio_cmd.env(key, value);
            }
            None => {
                tokio_cmd.env_remove(key);
            }
        }
    }
    #[cfg(target_os = "windows")]
    tokio_cmd.creation_flags(0x08000000);
    let mut child = tokio_cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动进程: {e}"))?;

    emit_log(
        app,
        operation_id,
        "log",
        format!(
            "$ {:?} {}",
            program.to_string_lossy(),
            args.iter()
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ")
        ),
    );

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdout_reader = tokio::io::BufReader::new(stdout).lines();
    let stderr_reader = tokio::io::BufReader::new(stderr).lines();

    let cancelled = cancelled.clone();
    let stdout_lines = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let stderr_lines = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));

    // Real-time stdout reader + collector
    let app_for_stdout = app.clone();
    let cancel_for_stdout = cancelled.clone();
    let collector_stdout = stdout_lines.clone();
    let log_stdout = tokio::spawn(async move {
        let mut lines = stdout_reader;
        while let Ok(Some(line)) = lines.next_line().await {
            emit_log(&app_for_stdout, operation_id, "log", line.clone());
            collector_stdout.lock().push(line);
            if cancel_for_stdout.load(Ordering::Relaxed) {
                return;
            }
        }
    });

    // Real-time stderr reader + collector
    let app_for_stderr = app.clone();
    let cancel_for_stderr = cancelled.clone();
    let collector_stderr = stderr_lines.clone();
    let log_stderr = tokio::spawn(async move {
        let mut lines = stderr_reader;
        while let Ok(Some(line)) = lines.next_line().await {
            emit_log(
                &app_for_stderr,
                operation_id,
                "log",
                format!("[stderr] {}", line),
            );
            collector_stderr.lock().push(line);
            if cancel_for_stderr.load(Ordering::Relaxed) {
                return;
            }
        }
    });

    // Wait for process completion or cancel
    let status = loop {
        if cancelled.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            // Wait for log tasks to flush remaining buffered output
            let _ = log_stdout.await;
            let _ = log_stderr.await;
            emit_log(&app, operation_id, "cancel", "操作已取消".into());
            return Err("操作已取消".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => tokio::time::sleep(tokio::time::Duration::from_millis(100)).await,
            Err(e) => {
                let _ = log_stdout.await;
                let _ = log_stderr.await;
                return Err(format!("进程等待失败: {e}"));
            }
        }
    };

    // Wait for log tasks to complete
    let _ = log_stdout.await;
    let _ = log_stderr.await;
    // Collect captured output
    let stdout_buf = stdout_lines.lock().join("\n");
    let stderr_buf = stderr_lines.lock().join("\n");

    Ok(Output {
        status,
        stdout: stdout_buf.into_bytes(),
        stderr: stderr_buf.into_bytes(),
    })
}

async fn install_node_package_streaming(
    data: &Path,
    source: &Path,
    app: &AppHandle,
    operation_id: u64,
    cancelled: &Arc<AtomicBool>,
) -> Result<Output, String> {
    let destination = root(data);
    fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    let mut npm = npm_command()?;
    npm.arg("install")
        .arg("--prefix")
        .arg(destination)
        .arg(source);
    run_and_emit(&mut npm, app, operation_id, cancelled).await
}

async fn install_node_zip_streaming(
    data: &Path,
    source: &Path,
    app: &AppHandle,
    operation_id: u64,
    cancelled: &Arc<AtomicBool>,
) -> Result<Output, String> {
    let staging = root(data).join(format!("staging-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    emit_log(app, operation_id, "log", "📂 解压 ZIP...".into());
    let extracted = (|| -> Result<(), String> {
        let mut archive = ZipArchive::new(fs::File::open(source).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let total = (0..archive.len()).try_fold(0_u64, |sum, index| {
            let entry = archive.by_index(index).map_err(|e| e.to_string())?;
            if !safe(entry.name()) {
                return Err("压缩包包含不安全路径".into());
            }
            sum.checked_add(entry.size())
                .ok_or_else(|| "压缩包大小溢出".to_string())
        })?;
        if total > 500 * 1024 * 1024 {
            return Err("解压后内容超过 500 MB 安全限制".into());
        }
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
            let target = staging.join(entry.name().replace('\\', "/"));
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut output = fs::File::create(target).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
        }
        if !staging.join("package.json").exists() {
            return Err("ZIP 根目录缺少 package.json".into());
        }
        Ok(())
    })();

    if let Err(error) = extracted {
        let _ = fs::remove_dir_all(&staging);
        emit_log(app, operation_id, "error", format!("解压失败: {error}"));
        return Err(error);
    }

    emit_log(
        app,
        operation_id,
        "log",
        "✅ 解压完成，开始 npm 安装...".into(),
    );
    let result = install_node_package_streaming(data, &staging, app, operation_id, cancelled).await;
    let _ = fs::remove_dir_all(staging);
    result
}

async fn install_qwen_zip_streaming(
    data: &Path,
    path: &Path,
    p: PluginProvider,
    app: &AppHandle,
    operation_id: u64,
    cancelled: &Arc<AtomicBool>,
) -> PluginOperationResult {
    emit_log(
        app,
        operation_id,
        "log",
        "验证 Qwen Code 扩展 ZIP...".into(),
    );
    if let Err(error) = validate_qwen_zip(path) {
        return PluginOperationResult {
            provider: p,
            success: false,
            message: "Qwen Code ZIP 验证失败".into(),
            output: error,
        };
    }

    let existed_before = external_install_info(PluginProvider::Qwencode).0;
    let backup_path: Option<PathBuf>;

    if existed_before {
        emit_log(
            app,
            operation_id,
            "log",
            "备份旧版 Qwen Code 扩展...".into(),
        );
        match backup_qwen_extension(data) {
            Ok(backup) => {
                backup_path = backup;
            }
            Err(error) => {
                return PluginOperationResult {
                    provider: p,
                    success: false,
                    message: "备份旧版 Qwen Code 扩展失败".into(),
                    output: error,
                };
            }
        }

        emit_log(
            app,
            operation_id,
            "log",
            "卸载旧版 Qwen Code 扩展...".into(),
        );
        let mut qwen = match qwen_command() {
            Ok(cmd) => cmd,
            Err(error) => {
                return PluginOperationResult {
                    provider: p,
                    success: false,
                    message: "无法找到 qwen CLI".into(),
                    output: error,
                }
            }
        };
        let uninstall_output = run_and_emit(
            qwen.arg("extensions")
                .arg("uninstall")
                .arg("agent-aura-qwencode"),
            app,
            operation_id,
            cancelled,
        )
        .await;
        if let Ok(ref output) = uninstall_output {
            if !output.status.success() {
                let out_str = out(output);
                if let Some(ref backup) = backup_path {
                    remove_backup(backup);
                }
                return PluginOperationResult {
                    provider: p,
                    success: false,
                    message: "卸载旧版 Qwen Code 扩展失败".into(),
                    output: format!("[qwen extension]\n{}", out_str),
                };
            }
            emit_log(app, operation_id, "log", out(output));
        }
    } else {
        backup_path = None;
    }

    emit_log(app, operation_id, "log", "安装 Qwen Code 扩展...".into());
    let mut qwen = match qwen_command() {
        Ok(cmd) => cmd,
        Err(error) => {
            return PluginOperationResult {
                provider: p,
                success: false,
                message: "无法找到 qwen CLI".into(),
                output: error,
            }
        }
    };
    let extension_output = run_and_emit(
        qwen.arg("extensions")
            .arg("install")
            .arg("--consent")
            .arg(path),
        app,
        operation_id,
        cancelled,
    )
    .await;
    let extension_log = match &extension_output {
        Ok(output) => {
            let s = out(output);
            emit_log(app, operation_id, "log", format!("[qwen extension]\n{s}"));
            s
        }
        Err(error) => {
            emit_log(
                app,
                operation_id,
                "error",
                format!("[qwen extension] 失败: {error}"),
            );
            return PluginOperationResult {
                provider: p,
                success: false,
                message: "Qwen Code 扩展安装失败".into(),
                output: error.clone(),
            };
        }
    };

    if let Ok(ref output) = extension_output {
        if !output.status.success() {
            let rollback = rollback_qwen_extension(existed_before, backup_path.as_deref());
            return PluginOperationResult {
                provider: p,
                success: false,
                message: "Qwen Code 扩展安装失败，已尝试恢复旧版".into(),
                output: format!("{extension_log}\n[rollback]\n{rollback}"),
            };
        }
    }

    emit_log(app, operation_id, "log", "安装托管 CLI...".into());
    match install_node_zip_streaming(data, path, app, operation_id, cancelled).await {
        Ok(output) if output.status.success() => {
            if let Some(ref backup) = backup_path {
                remove_backup(backup);
            }
            PluginOperationResult {
                provider: p,
                success: true,
                message: "安装完成".into(),
                output: format!("{extension_log}\n[managed cli]\n{}", out(&output)),
            }
        }
        result => {
            let managed_detail = match &result {
                Ok(output) => out(output),
                Err(error) => error.clone(),
            };
            let rollback = rollback_qwen_extension(existed_before, backup_path.as_deref());
            PluginOperationResult {
                provider: p,
                success: false,
                message: "托管 CLI 安装失败，已尝试回滚扩展安装".into(),
                output: format!(
                    "{extension_log}\n[managed cli]\n{managed_detail}\n[rollback]\n{rollback}"
                ),
            }
        }
    }
}

/// Streaming install entrypoint.
pub async fn install_package_streaming(
    data: &Path,
    path: &Path,
    inspection: PluginPackageInspection,
    app: &AppHandle,
    operation_id: u64,
    cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> PluginOperationResult {
    let p = match inspection.provider {
        Some(provider) => provider,
        None => {
            return PluginOperationResult {
                provider: PluginProvider::Claude,
                success: false,
                message: "无法识别插件".into(),
                output: String::new(),
            }
        }
    };

    let cancelled = cancellation_flag(cancel_rx);

    emit_log(
        app,
        operation_id,
        "log",
        format!("📦 安装包: {}", inspection.file_name),
    );
    emit_log(
        app,
        operation_id,
        "log",
        format!(
            "🏷️  格式: {} | 版本: {}",
            inspection.format,
            inspection.version.as_deref().unwrap_or("?")
        ),
    );

    let result = match p {
        PluginProvider::Copilot => {
            let mut cmd = Command::new("code");
            cmd.arg("--install-extension").arg(path).arg("--force");
            run_and_emit(&mut cmd, app, operation_id, &cancelled).await
        }
        PluginProvider::Qwenpaw => {
            let mut cmd = Command::new("qwenpaw");
            cmd.arg("plugin").arg("install").arg(path);
            run_and_emit(&mut cmd, app, operation_id, &cancelled).await
        }
        PluginProvider::Qwencode if inspection.format == "zip" => {
            return install_qwen_zip_streaming(data, path, p, app, operation_id, &cancelled).await;
        }
        PluginProvider::Claude => {
            return PluginOperationResult {
                provider: p,
                success: false,
                message: "Claude marketplace 自动安装尚未实现".into(),
                output: "未修改系统".into(),
            }
        }
        _ if inspection.format == "tgz" => {
            install_node_package_streaming(data, path, app, operation_id, &cancelled).await
        }
        _ if inspection.format == "zip" => {
            install_node_zip_streaming(data, path, app, operation_id, &cancelled).await
        }
        _ => {
            return PluginOperationResult {
                provider: p,
                success: false,
                message: "包格式不受支持".into(),
                output: String::new(),
            }
        }
    };

    match &result {
        Ok(output) if output.status.success() => {
            emit_log(app, operation_id, "log", "✅ 命令成功完成".into());
            PluginOperationResult {
                provider: p,
                success: true,
                message: "安装完成".into(),
                output: out(output),
            }
        }
        Ok(output) => {
            emit_log(
                app,
                operation_id,
                "error",
                format!("❌ 命令失败 (exit: {:?})", output.status.code()),
            );
            PluginOperationResult {
                provider: p,
                success: false,
                message: "安装失败".into(),
                output: out(output),
            }
        }
        Err(error) => {
            emit_log(app, operation_id, "error", format!("❌ {}", error));
            PluginOperationResult {
                provider: p,
                success: false,
                message: error.to_string(),
                output: String::new(),
            }
        }
    }
}

/// Run a hooks command with the shared cancellation flag.
async fn manage_hooks_with_cancel(
    data: &Path,
    p: PluginProvider,
    install: bool,
    app: &AppHandle,
    operation_id: u64,
    cancelled: &Arc<AtomicBool>,
) -> PluginOperationResult {
    if !p.hooks() {
        return PluginOperationResult {
            provider: p,
            success: false,
            message: "不支持 Hooks".into(),
            output: String::new(),
        };
    }
    if cancelled.load(Ordering::Relaxed) {
        emit_log(app, operation_id, "cancel", "操作已取消".into());
        return cancelled_result(p);
    }

    let action = if install {
        "install-hooks"
    } else {
        "uninstall-hooks"
    };
    let managed_entry = pkg(data, p.package().unwrap()).join("out/index.js");
    let external_entry = if p == PluginProvider::Qwencode {
        qwen_extension_dir().map(|dir| dir.join("out/index.js"))
    } else {
        None
    };

    let result = if managed_entry.exists() {
        let mut node = match node_command() {
            Ok(command) => command,
            Err(error) => {
                return PluginOperationResult {
                    provider: p,
                    success: false,
                    message: error,
                    output: String::new(),
                };
            }
        };
        run_and_emit(
            node.arg(managed_entry).arg(action),
            app,
            operation_id,
            cancelled,
        )
        .await
    } else if let Some(entry) = external_entry.filter(|entry| entry.exists()) {
        let mut node = match node_command() {
            Ok(command) => command,
            Err(error) => {
                return PluginOperationResult {
                    provider: p,
                    success: false,
                    message: error,
                    output: String::new(),
                };
            }
        };
        run_and_emit(node.arg(entry).arg(action), app, operation_id, cancelled).await
    } else {
        let mut cmd = Command::new(p.cli().unwrap());
        run_and_emit(cmd.arg(action), app, operation_id, cancelled).await
    };

    match result {
        Ok(output) => command_result(p, "Hooks 操作完成", "Hooks 操作失败", output),
        Err(_error) if cancelled.load(Ordering::Relaxed) => cancelled_result(p),
        Err(error) => PluginOperationResult {
            provider: p,
            success: false,
            message: error,
            output: String::new(),
        },
    }
}

fn collect_output(outputs: &[String]) -> String {
    outputs
        .iter()
        .filter(|value| !value.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

/// Streaming uninstall entrypoint.
pub async fn uninstall_plugin_streaming(
    data: &Path,
    p: PluginProvider,
    app: &AppHandle,
    operation_id: u64,
    cancel_rx: oneshot::Receiver<()>,
) -> PluginOperationResult {
    let cancelled = cancellation_flag(cancel_rx);
    emit_log(app, operation_id, "log", format!("开始卸载 {:?}...", p));

    if p.hooks() {
        let _ = manage_hooks_with_cancel(data, p, false, app, operation_id, &cancelled).await;
        if cancelled.load(Ordering::Relaxed) {
            return cancelled_result(p);
        }
    }

    let mut outputs = Vec::new();
    let mut success = true;

    let run_step = |result: Result<Output, String>,
                    outputs: &mut Vec<String>,
                    success: &mut bool| {
        match result {
            Ok(output) => {
                *success &= output.status.success();
                outputs.push(out(&output));
            }
            Err(error) => {
                *success = false;
                outputs.push(error);
            }
        }
    };

    match p {
        PluginProvider::Copilot => {
            let mut cmd = Command::new("code");
            let result = run_and_emit(
                cmd.arg("--uninstall-extension")
                    .arg("AlpacaKnight.agent-aura-copilot"),
                app,
                operation_id,
                &cancelled,
            )
            .await;
            run_step(result, &mut outputs, &mut success);
        }
        PluginProvider::Qwenpaw => {
            let mut cmd = Command::new("qwenpaw");
            let result = run_and_emit(
                cmd.arg("plugin").arg("uninstall").arg("agentaura"),
                app,
                operation_id,
                &cancelled,
            )
            .await;
            run_step(result, &mut outputs, &mut success);
        }
        PluginProvider::Qwencode => {
            let (extension_installed, _) = external_install_info(PluginProvider::Qwencode);
            if extension_installed {
                match qwen_command() {
                    Ok(mut qwen) => {
                        let result = run_and_emit(
                            qwen.arg("extensions")
                                .arg("uninstall")
                                .arg("agent-aura-qwencode"),
                            app,
                            operation_id,
                            &cancelled,
                        )
                        .await;
                        run_step(result, &mut outputs, &mut success);
                    }
                    Err(error) => {
                        success = false;
                        outputs.push(error);
                    }
                }
            }
            if pkg(data, "agent-aura-qwencode").exists() {
                match npm_command() {
                    Ok(mut npm) => {
                        let result = run_and_emit(
                            npm.arg("uninstall")
                                .arg("--prefix")
                                .arg(root(data))
                                .arg("agent-aura-qwencode"),
                            app,
                            operation_id,
                            &cancelled,
                        )
                        .await;
                        run_step(result, &mut outputs, &mut success);
                    }
                    Err(error) => {
                        success = false;
                        outputs.push(error);
                    }
                }
            }
            if global_node_package_installed("agent-aura-qwencode") {
                match npm_command() {
                    Ok(mut npm) => {
                        let result = run_and_emit(
                            npm.arg("uninstall").arg("-g").arg("agent-aura-qwencode"),
                            app,
                            operation_id,
                            &cancelled,
                        )
                        .await;
                        run_step(result, &mut outputs, &mut success);
                    }
                    Err(error) => {
                        success = false;
                        outputs.push(error);
                    }
                }
            }
        }
        _ => {
            let Some(package) = p.package() else {
                return PluginOperationResult {
                    provider: p,
                    success: false,
                    message: "没有可卸载的托管包".into(),
                    output: String::new(),
                };
            };
            if pkg(data, package).exists() {
                match npm_command() {
                    Ok(mut npm) => {
                        let result = run_and_emit(
                            npm.arg("uninstall")
                                .arg("--prefix")
                                .arg(root(data))
                                .arg(package),
                            app,
                            operation_id,
                            &cancelled,
                        )
                        .await;
                        run_step(result, &mut outputs, &mut success);
                    }
                    Err(error) => {
                        success = false;
                        outputs.push(error);
                    }
                }
            }
            if global_node_package_installed(package) {
                match npm_command() {
                    Ok(mut npm) => {
                        let result = run_and_emit(
                            npm.arg("uninstall").arg("-g").arg(package),
                            app,
                            operation_id,
                            &cancelled,
                        )
                        .await;
                        run_step(result, &mut outputs, &mut success);
                    }
                    Err(error) => {
                        success = false;
                        outputs.push(error);
                    }
                }
            }
        }
    }

    if cancelled.load(Ordering::Relaxed) {
        return cancelled_result(p);
    }
    if outputs.is_empty() {
        return PluginOperationResult {
            provider: p,
            success: true,
            message: "未检测到可卸载的安装来源".into(),
            output: String::new(),
        };
    }

    PluginOperationResult {
        provider: p,
        success,
        message: if success {
            "卸载完成"
        } else {
            "卸载失败"
        }
        .into(),
        output: collect_output(&outputs),
    }
}

/// Streaming hooks management.
pub async fn manage_hooks_streaming(
    data: &Path,
    p: PluginProvider,
    install: bool,
    app: &AppHandle,
    operation_id: u64,
    cancel_rx: oneshot::Receiver<()>,
) -> PluginOperationResult {
    let cancelled = cancellation_flag(cancel_rx);
    let action = if install { "安装" } else { "卸载" };
    emit_log(
        app,
        operation_id,
        "log",
        format!("{} {:?} Hooks...", action, p),
    );
    manage_hooks_with_cancel(data, p, install, app, operation_id, &cancelled).await
}

/// Streaming hooks repair.
pub async fn repair_hooks_streaming(
    data: &Path,
    p: PluginProvider,
    app: &AppHandle,
    operation_id: u64,
    cancel_rx: oneshot::Receiver<()>,
) -> PluginOperationResult {
    let cancelled = cancellation_flag(cancel_rx);
    emit_log(app, operation_id, "log", format!("修复 {:?} Hooks...", p));

    let before = print_hooks(data, p).ok();
    emit_log(
        app,
        operation_id,
        "log",
        "当前 Hooks 状态（修复前）：".into(),
    );
    if let Some(ref before) = before {
        emit_log(app, operation_id, "log", format!("```\n{}\n```", before));
    } else {
        emit_log(
            app,
            operation_id,
            "log",
            "(无法读取当前 Hooks 状态，将直接重新安装)".into(),
        );
    }

    if cancelled.load(Ordering::Relaxed) {
        emit_log(app, operation_id, "cancel", "操作已取消".into());
        return cancelled_result(p);
    }

    emit_log(app, operation_id, "log", "卸载旧 Hooks...".into());
    let uninstall = manage_hooks_with_cancel(data, p, false, app, operation_id, &cancelled).await;
    if !uninstall.success {
        return uninstall;
    }

    if cancelled.load(Ordering::Relaxed) {
        emit_log(
            app,
            operation_id,
            "cancel",
            "操作已取消（Hooks 已卸载，未重新安装）".into(),
        );
        return cancelled_result(p);
    }

    emit_log(app, operation_id, "log", "安装新 Hooks...".into());
    let result = manage_hooks_with_cancel(data, p, true, app, operation_id, &cancelled).await;

    let after = print_hooks(data, p).ok();
    emit_log(app, operation_id, "log", "Hooks 状态（修复后）：".into());
    if let Some(after) = after {
        emit_log(app, operation_id, "log", format!("```\n{}\n```", after));
    }

    emit_log(
        app,
        operation_id,
        "complete",
        if result.success {
            "Hooks 修复完成".into()
        } else {
            format!("Hooks 修复失败: {}", result.message)
        },
    );

    result
}
