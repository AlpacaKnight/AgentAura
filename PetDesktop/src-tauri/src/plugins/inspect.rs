use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path},
    process::Command,
};
use zip::ZipArchive;

use super::env::run;
use super::model::{PluginPackageInspection, PluginProvider};

/// Inspect one or more plugin packages and return their metadata.
/// Also performs Qwen Code dual-package pairing checks.
pub fn inspect_packages(paths: Vec<String>) -> Vec<PluginPackageInspection> {
    let mut results: Vec<PluginPackageInspection> = paths
        .into_iter()
        .map(|p| inspect(Path::new(&p)).unwrap_or_else(|e| PluginPackageInspection::failure(p, e)))
        .collect();
    // 配对逻辑：agent-aura-qwencode 的 tgz（CLI 包）和 zip（扩展包）应版本一致
    let tgz_idx = results
        .iter()
        .position(|r| r.provider == Some(PluginProvider::Qwencode) && r.format == "tgz");
    let zip_idx = results
        .iter()
        .position(|r| r.provider == Some(PluginProvider::Qwencode) && r.format == "zip");
    if let (Some(ti), Some(zi)) = (tgz_idx, zip_idx) {
        let tgz_ver = results[ti].version.clone();
        let zip_ver = results[zi].version.clone();
        if tgz_ver != zip_ver {
            let warn = format!(
                "Qwen Code 的 CLI 包 (tgz) 版本 {} 与扩展包 (zip) 版本 {} 不一致，建议匹配版本后重试",
                tgz_ver.as_deref().unwrap_or("?"),
                zip_ver.as_deref().unwrap_or("?")
            );
            results[ti].warnings.push(warn.clone());
            results[zi].warnings.push(warn);
        }
    }
    results
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
        warnings: Vec::new(),
    })
}

/// Validate that a zip entry path is safe (no parent-dir traversal, no absolute path)
pub(crate) fn safe(s: &str) -> bool {
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
    } else if s.contains("zcode") {
        Some(PluginProvider::ZCode)
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

/// Validate that a Qwen Code extension ZIP contains the required files
pub fn validate_qwen_zip(path: &Path) -> Result<(), String> {
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
