use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
};
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
        let managed = p.package().is_some_and(|n| pkg(data, n).exists());
        let external = external_installed(p);
        let version = managed_version(data, p);
        let installed = managed || external;
        ManagedPluginStatus {
            provider: p,
            installed,
            version,
            hooks_installed: hook_present(p),
            hooks_supported: p.hooks(),
            config_path: config(p).map(|v| v.display().to_string()),
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
            if external_installed(PluginProvider::Qwencode) {
                let mut uninstall = qwen_command()?;
                let uninstall_output = run(uninstall
                    .arg("extensions")
                    .arg("uninstall")
                    .arg("agent-aura-qwencode"))?;
                if !uninstall_output.status.success() {
                    return Ok(PluginOperationResult {
                        provider: p,
                        success: false,
                        message: "卸载旧版 Qwen Code 扩展失败".into(),
                        output: out(&uninstall_output),
                    });
                }
            }
            let mut qwen = qwen_command()?;
            run(qwen
                .arg("extensions")
                .arg("install")
                .arg("--consent")
                .arg(path))?
        },
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
            if external_installed(PluginProvider::Qwencode) {
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
            let success = outputs.iter().all(|o| o.status.success());
            let output = outputs.into_iter().map(|o| out(&o)).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("
");
            return Ok(PluginOperationResult {
                provider: p,
                success,
                message: if success { "卸载完成" } else { "卸载失败" }.into(),
                output,
            });
        }
        _ => {
            let package = p.package().ok_or("没有可卸载的托管包")?;
            if p.hooks() {
                let _ = manage_hooks(data, p, false);
            }
            let mut npm = npm_command()?;
            run(npm
                .arg("uninstall")
                .arg("--prefix")
                .arg(root(data))
                .arg(package))?
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
    let entry = pkg(data, p.package().unwrap()).join("out/index.js");
    let o = if entry.exists() {
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
fn npm_command() -> Result<Command, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("npm.cmd")));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("nodejs").join("npm.cmd"));
    }
    if let Some(app_data) = std::env::var_os("APPDATA") {
        candidates.push(PathBuf::from(app_data).join("npm").join("npm.cmd"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(Command::new)
        .ok_or_else(|| "npm.cmd was not found. Install Node.js 18+ and restart PetDesktop so it can read the updated PATH.".to_string())
}
#[cfg(target_os = "windows")]
fn qwen_command() -> Result<Command, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("qwen.cmd")));
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("qwen.exe")));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(Command::new)
        .ok_or_else(|| "qwen was not found. Install Qwen Code CLI and restart PetDesktop so it can read the updated PATH.".to_string())
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
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("node.exe")));
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("node.cmd")));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("nodejs").join("node.exe"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(Command::new)
        .ok_or_else(|| "node was not found. Install Node.js 18+ and restart PetDesktop so it can read the updated PATH.".to_string())
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
fn global_node_package_installed(package: &str) -> bool {
    let mut npm = match npm_command() {
        Ok(command) => command,
        Err(_) => return false,
    };
    run(npm
        .arg("list")
        .arg("-g")
        .arg("--depth=0")
        .arg(package))
        .ok()
        .filter(|o| o.status.success())
        .is_some_and(|o| {
            String::from_utf8_lossy(&o.stdout)
                .to_ascii_lowercase()
                .contains(package)
        })
}
fn external_installed(p: PluginProvider) -> bool {
    match p {
        PluginProvider::Copilot => run(Command::new("code").arg("--list-extensions"))
            .ok()
            .filter(|o| o.status.success())
            .is_some_and(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .to_ascii_lowercase()
                    .contains("alpacaknight.agent-aura-copilot")
            }),
        PluginProvider::Qwenpaw => run(Command::new("qwenpaw").arg("plugin").arg("list"))
            .ok()
            .filter(|o| o.status.success())
            .is_some_and(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .to_ascii_lowercase()
                    .contains("agentaura")
            }),
        PluginProvider::Qwencode => qwen_command()
            .ok()
            .and_then(|mut qwen| run(qwen.arg("extensions").arg("list")).ok())
            .filter(|o| o.status.success())
            .is_some_and(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .to_ascii_lowercase()
                    .contains("agent-aura-qwencode")
            }),
        _ => false,
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
fn config(p: PluginProvider) -> Option<PathBuf> {
    let h = home()?;
    Some(match p {
        PluginProvider::Claude => h.join(".claude/agent-aura-claude.json"),
        PluginProvider::Codex => h.join(".codex/agent-aura-codex.json"),
        PluginProvider::KimiCode => h.join(".kimi-code/agent-aura-kimi-code.json"),
        PluginProvider::Qwencode => h.join(".qwen/agent-aura-qwencode.json"),
        _ => return None,
    })
}
fn hook_present(p: PluginProvider) -> bool {
    let Some(h) = home() else { return false };
    let (a, b) = match p {
        PluginProvider::Codex => (h.join(".codex/hooks.json"), "agent-aura-codex"),
        PluginProvider::KimiCode => (
            h.join(".kimi-code/config.toml"),
            "AGENTAURA_KIMI_CODE_HOOKS",
        ),
        PluginProvider::Qwencode => (h.join(".qwen/settings.json"), "agent-aura-qwencode"),
        _ => return false,
    };
    fs::read_to_string(a).ok().is_some_and(|s| s.contains(b))
}
fn run(c: &mut Command) -> Result<Output, String> {
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
