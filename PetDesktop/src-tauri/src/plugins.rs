use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use zip::ZipArchive;
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
    fn package(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some("agent-aura-claude"),
            Self::Codex => Some("agent-aura-codex"),
            Self::KimiCode => Some("agent-aura-kimi-code"),
            Self::Qwencode => Some("agent-aura-qwencode"),
            _ => None,
        }
    }
    fn cli(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some("agent-aura-claude"),
            Self::Codex => Some("agent-aura-codex"),
            Self::KimiCode => Some("agent-aura-kimi-code"),
            Self::Qwencode => Some("agent-aura-qwencode"),
            _ => None,
        }
    }
    fn hooks(self) -> bool {
        matches!(self, Self::Codex | Self::KimiCode | Self::Qwencode)
    }
}
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
}
impl PluginPackageInspection {
    pub fn failure(path: impl Into<String>, error: impl Into<String>) -> Self {
        let path = path.into();
        Self {
            file_name: Path::new(&path)
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
        }
    }
}
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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOperationResult {
    pub provider: PluginProvider,
    pub success: bool,
    pub message: String,
    pub output: String,
}
pub fn inspect_packages(paths: Vec<String>) -> Vec<PluginPackageInspection> {
    paths
        .into_iter()
        .map(|p| inspect(Path::new(&p)).unwrap_or_else(|e| PluginPackageInspection::failure(p, e)))
        .collect()
}
fn inspect(path: &Path) -> Result<PluginPackageInspection, String> {
    let m = fs::metadata(path).map_err(|e| e.to_string())?;
    if !m.is_file() || m.len() > 209715200 {
        return Err("文件无效或超过 200 MB".into());
    }
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    let format = if name.ends_with(".tgz") {
        "tgz"
    } else if name.ends_with(".vsix") {
        "vsix"
    } else if name.ends_with(".zip") {
        "zip"
    } else {
        return Err("仅支持 .tgz、.zip、.vsix".into());
    };
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let v = if format == "tgz" {
        tgz(path)?
    } else {
        zip(path)?
    };
    let p = identify(&v, &name);
    Ok(PluginPackageInspection {
        path: path.display().to_string(),
        file_name: name,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        format: format.into(),
        provider: p,
        version: v.get("version").and_then(Value::as_str).map(str::to_owned),
        valid: p.is_some(),
        error: None,
    })
}
fn safe(s: &str) -> bool {
    let n = s.replace('\\', "/");
    let p = Path::new(&n);
    !p.is_absolute()
        && !p.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
}
fn zip(path: &Path) -> Result<Value, String> {
    let mut z = ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut total = 0_u64;
    for i in 0..z.len() {
        let e = z.by_index(i).map_err(|e| e.to_string())?;
        if !safe(e.name()) {
            return Err("压缩包包含不安全路径".into());
        }
        total = total
            .checked_add(e.size())
            .ok_or_else(|| "压缩包大小溢出".to_string())?;
    }
    if total > 500 * 1024 * 1024 {
        return Err("解压后内容超过 500 MB 安全限制".into());
    }
    for n in [
        "extension/package.json",
        "package/package.json",
        "package.json",
        ".claude-plugin/plugin.json",
        "plugin.json",
        "qwen-extension.json",
    ] {
        if let Ok(mut e) = z.by_name(n) {
            let mut s = String::new();
            e.read_to_string(&mut s).map_err(|e| e.to_string())?;
            return serde_json::from_str(&s).map_err(|e| e.to_string());
        }
    }
    Err("未找到 manifest".into())
}
fn tgz(path: &Path) -> Result<Value, String> {
    let l = run(Command::new("tar").arg("-tzf").arg(path))?;
    let s = String::from_utf8_lossy(&l.stdout);
    if !l.status.success() || s.lines().any(|e| !safe(e)) {
        return Err("无效或不安全的 tgz".into());
    }
    for n in [
        "package/package.json",
        "package/.claude-plugin/plugin.json",
        "package.json",
    ] {
        if s.lines().any(|e| e == n) {
            let o = run(Command::new("tar").arg("-xOzf").arg(path).arg(n))?;
            return serde_json::from_slice(&o.stdout).map_err(|e| e.to_string());
        }
    }
    Err("未找到 manifest".into())
}
fn identify(v: &Value, f: &str) -> Option<PluginProvider> {
    let s = format!(
        "{} {} {}",
        v.get("name").and_then(Value::as_str).unwrap_or(""),
        v.get("publisher").and_then(Value::as_str).unwrap_or(""),
        f
    )
    .to_lowercase();
    if s.contains("copilot") || s.contains("alpacaknight") {
        Some(PluginProvider::Copilot)
    } else if s.contains("kimi") {
        Some(PluginProvider::KimiCode)
    } else if s.contains("qwencode") {
        Some(PluginProvider::Qwencode)
    } else if s.contains("qwenpaw") || s.contains("agentaura") {
        Some(PluginProvider::Qwenpaw)
    } else if s.contains("claude") {
        Some(PluginProvider::Claude)
    } else if s.contains("codex") {
        Some(PluginProvider::Codex)
    } else {
        None
    }
}
pub fn list_plugins(data: &Path) -> Result<Vec<ManagedPluginStatus>, String> {
    Ok([
        PluginProvider::Claude,
        PluginProvider::Codex,
        PluginProvider::Copilot,
        PluginProvider::KimiCode,
        PluginProvider::Qwencode,
        PluginProvider::Qwenpaw,
    ]
    .into_iter()
    .map(|p| {
        let managed_installed = p.package().is_some_and(|n| pkg(data, n).exists());
        let managed_version = managed_version(data, p);
        let global_version = p.package().and_then(global_node_package_version);
        let global_installed = global_version.is_some();
        let (external_installed, external_version) = external_install_info(p);
        let version = managed_version
            .clone()
            .or(global_version.clone())
            .or(external_version.clone());
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
    })
    .collect())
}
pub fn install_package(data: &Path, path: &Path) -> Result<PluginOperationResult, String> {
    let i = inspect(path)?;
    let p = i.provider.ok_or("无法识别插件")?;
    let o = match p {
        PluginProvider::Copilot => run(Command::new("code")
            .arg("--install-extension")
            .arg(path)
            .arg("--force"))?,
        PluginProvider::Qwenpaw => run(Command::new("qwenpaw")
            .arg("plugin")
            .arg("install")
            .arg(path))?,
        PluginProvider::Qwencode if i.format == "zip" => {
            return install_qwen_zip(data, path, p);
        }
        PluginProvider::Claude => {
            return Ok(PluginOperationResult {
                provider: p,
                success: false,
                message: "Claude marketplace 自动安装尚未实现".into(),
                output: "未修改系统".into(),
            })
        }
        _ if i.format == "tgz" => install_node_package(data, path)?,
        _ if i.format == "zip" => install_node_zip(data, path)?,
        _ => return Err("包格式不受支持".into()),
    };
    let success = o.status.success();
    Ok(PluginOperationResult {
        provider: p,
        success,
        message: if success {
            "安装完成"
        } else {
            "安装失败"
        }
        .into(),
        output: out(&o),
    })
}
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
pub fn save_config(p: PluginProvider, s: &str) -> Result<(), String> {
    let _: Value = serde_json::from_str(s).map_err(|e| format!("无效 JSON: {e}"))?;
    let path = config(p).ok_or("无独立配置")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::copy(&path, path.with_extension("json.bak")).map_err(|e| e.to_string())?;
    }
    fs::write(path, s).map_err(|e| e.to_string())
}
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
#[cfg(target_os = "windows")]
fn npm_command() -> Result<Command, String> {
    windows_find_command(&["npm.cmd"], &windows_npm_dirs())
        .map(windows_command_with_path)
        .ok_or_else(|| windows_not_found("npm", &windows_npm_dirs()))
}
#[cfg(target_os = "windows")]
fn qwen_command() -> Result<Command, String> {
    windows_find_command(&["qwen.cmd", "qwen.exe"], &windows_qwen_dirs())
        .map(windows_command_with_path)
        .ok_or_else(|| windows_not_found("qwen", &windows_qwen_dirs()))
}
#[cfg(not(target_os = "windows"))]
fn qwen_command() -> Result<Command, String> {
    resolve_unix_command("qwen")
}
#[cfg(not(target_os = "windows"))]
fn npm_command() -> Result<Command, String> {
    resolve_unix_command("npm")
}
#[cfg(target_os = "windows")]
fn node_command() -> Result<Command, String> {
    windows_find_command(&["node.exe", "node.cmd"], &windows_node_dirs())
        .map(windows_command_with_path)
        .ok_or_else(|| windows_not_found("node", &windows_node_dirs()))
}
#[cfg(not(target_os = "windows"))]
fn node_command() -> Result<Command, String> {
    resolve_unix_command("node")
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
fn validate_qwen_zip(path: &Path) -> Result<(), String> {
    let mut archive = ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut total = 0_u64;
    let mut names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        if !safe(entry.name()) {
            return Err("压缩包包含不安全路径".into());
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| "压缩包大小溢出".to_string())?;
        names.insert(entry.name().replace('\\', "/"));
    }
    if total > 500 * 1024 * 1024 {
        return Err("解压后内容超过 500 MB 安全限制".into());
    }
    for required in ["qwen-extension.json", "package.json", "out/index.js"] {
        if !names.contains(required) {
            return Err(format!("ZIP 根目录缺少 {required}"));
        }
    }
    Ok(())
}
fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
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
fn backup_qwen_extension(data: &Path) -> Result<Option<PathBuf>, String> {
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
fn restore_qwen_extension(backup: &Path) -> Result<(), String> {
    let Some(destination) = qwen_extension_dir() else {
        return Err("无法解析 Qwen Code 扩展目录".into());
    };
    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(|e| e.to_string())?;
    }
    copy_dir_recursive(backup, &destination)
}
fn remove_backup(backup: &Path) {
    let _ = fs::remove_dir_all(backup);
}
fn rollback_qwen_extension(existed_before: bool, backup: Option<&Path>) -> String {
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
fn install_qwen_zip(
    data: &Path,
    path: &Path,
    p: PluginProvider,
) -> Result<PluginOperationResult, String> {
    validate_qwen_zip(path)?;

    let existed_before = external_install_info(PluginProvider::Qwencode).0;
    let backup = if existed_before {
        match backup_qwen_extension(data) {
            Ok(backup) => backup,
            Err(error) => {
                return Ok(PluginOperationResult {
                    provider: p,
                    success: false,
                    message: "备份旧版 Qwen Code 扩展失败".into(),
                    output: error,
                });
            }
        }
    } else {
        None
    };
    if existed_before {
        let mut uninstall = qwen_command()?;
        let uninstall_output = run(uninstall
            .arg("extensions")
            .arg("uninstall")
            .arg("agent-aura-qwencode"))?;
        if !uninstall_output.status.success() {
            if let Some(backup) = backup.as_ref() {
                remove_backup(backup);
            }
            return Ok(PluginOperationResult {
                provider: p,
                success: false,
                message: "卸载旧版 Qwen Code 扩展失败".into(),
                output: format!(
                    "[qwen extension]
{}",
                    out(&uninstall_output)
                ),
            });
        }
    }

    let mut qwen = qwen_command()?;
    let extension_output = run(qwen
        .arg("extensions")
        .arg("install")
        .arg("--consent")
        .arg(path))?;
    let extension_log = format!(
        "[qwen extension]
{}",
        out(&extension_output)
    );
    if !extension_output.status.success() {
        let rollback_detail = rollback_qwen_extension(existed_before, backup.as_deref());
        return Ok(PluginOperationResult {
            provider: p,
            success: false,
            message: "Qwen Code 扩展安装失败，已尝试恢复旧版".into(),
            output: format!(
                "{extension_log}
[rollback]
{rollback_detail}"
            ),
        });
    }

    match install_node_zip(data, path) {
        Ok(output) if output.status.success() => {
            if let Some(backup) = backup.as_ref() {
                remove_backup(backup);
            }
            Ok(PluginOperationResult {
                provider: p,
                success: true,
                message: "安装完成".into(),
                output: format!(
                    "{extension_log}
[managed cli]
{}",
                    out(&output)
                ),
            })
        }
        result => {
            let managed_detail = match &result {
                Ok(output) => out(output),
                Err(error) => error.clone(),
            };
            let rollback_detail = rollback_qwen_extension(existed_before, backup.as_deref());
            Ok(PluginOperationResult {
                provider: p,
                success: false,
                message: "托管 CLI 安装失败，已尝试回滚扩展安装".into(),
                output: format!(
                    "{extension_log}
[managed cli]
{managed_detail}
[rollback]
{rollback_detail}"
                ),
            })
        }
    }
}
fn install_node_package(data: &Path, source: &Path) -> Result<Output, String> {
    let destination = root(data);
    fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    let mut npm = npm_command()?;
    run(npm
        .arg("install")
        .arg("--prefix")
        .arg(destination)
        .arg(source))
}
fn install_node_zip(data: &Path, source: &Path) -> Result<Output, String> {
    let staging = root(data).join(format!("staging-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
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
        return Err(error);
    }
    let result = install_node_package(data, &staging);
    let _ = fs::remove_dir_all(staging);
    result
}
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
fn global_node_package_installed(package: &str) -> bool {
    global_node_package_version(package).is_some()
}
fn external_install_info(p: PluginProvider) -> (bool, Option<String>) {
    match p {
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
fn root(d: &Path) -> PathBuf {
    d.join("managed-plugins/node")
}
fn pkg(d: &Path, n: &str) -> PathBuf {
    root(d).join("node_modules").join(n)
}
fn home() -> Option<PathBuf> {
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
fn qwen_dir_with(get: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(v) = nonempty(get("QWEN_CODE_HOME")) {
        return Some(PathBuf::from(v));
    }
    if let Some(v) = nonempty(get("QWEN_HOME")) {
        return Some(PathBuf::from(v));
    }
    let home = nonempty(get("USERPROFILE")).or_else(|| nonempty(get("HOME")))?;
    Some(PathBuf::from(home).join(".qwen"))
}
fn qwen_settings_path_with(get: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(v) = nonempty(get("QWEN_CODE_SETTINGS")) {
        return Some(PathBuf::from(v));
    }
    if let Some(v) = nonempty(get("QWEN_SETTINGS_PATH")) {
        return Some(PathBuf::from(v));
    }
    Some(qwen_dir_with(get)?.join("settings.json"))
}
fn qwen_extension_dir_with(get: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    Some(
        qwen_dir_with(get)?
            .join("extensions")
            .join("agent-aura-qwencode"),
    )
}
fn qwen_extension_dir() -> Option<PathBuf> {
    qwen_extension_dir_with(&env_lookup)
}
fn qwencode_config_path_with(get: &impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(v) = nonempty(get("AGENTAURA_QWENCODE_CONFIG")) {
        return Some(PathBuf::from(v));
    }
    Some(qwen_dir_with(get)?.join("agent-aura-qwencode.json"))
}
fn qwen_settings_path() -> Option<PathBuf> {
    qwen_settings_path_with(&env_lookup)
}
fn qwencode_config_path() -> Option<PathBuf> {
    qwencode_config_path_with(&env_lookup)
}
fn config(p: PluginProvider) -> Option<PathBuf> {
    if let PluginProvider::Qwencode = p {
        return qwencode_config_path();
    }
    let h = home()?;
    Some(match p {
        PluginProvider::Claude => h.join(".claude/agent-aura-claude.json"),
        PluginProvider::Codex => h.join(".codex/agent-aura-codex.json"),
        PluginProvider::KimiCode => h.join(".kimi-code/agent-aura-kimi-code.json"),
        _ => return None,
    })
}
fn hook_present(p: PluginProvider) -> bool {
    if let PluginProvider::Qwencode = p {
        let Some(path) = qwen_settings_path() else {
            return false;
        };
        return fs::read_to_string(path)
            .ok()
            .is_some_and(|s| has_managed_qwen_hook(&s));
    }
    let Some(h) = home() else { return false };
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
fn run(c: &mut Command) -> Result<Output, String> {
    #[cfg(target_os = "windows")]
    c.creation_flags(0x08000000);

    c.output()
        .map_err(|e| format!("无法启动 {:?}: {e}", c.get_program()))
}
fn out(o: &Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&o.stdout).trim(),
        String::from_utf8_lossy(&o.stderr).trim()
    )
    .trim()
    .into()
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
