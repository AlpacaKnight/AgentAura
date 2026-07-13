use std::{
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageReader;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::model::{built_in_pet, default_animations, InstalledPet};

const MAX_ARCHIVE_FILES: usize = 256;
const MAX_ARCHIVE_BYTES: u64 = 50 * 1024 * 1024;

pub fn scan_pets(data_dir: &Path) -> anyhow::Result<Vec<InstalledPet>> {
    let pets_dir = data_dir.join("pets");
    fs::create_dir_all(&pets_dir)?;
    let mut pets = vec![built_in_pet()];
    for entry in fs::read_dir(pets_dir)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        if let Ok(pet) = validate_pet_dir(&entry.path()) {
            pets.push(pet);
        }
    }
    pets[1..].sort_by(|left, right| left.display_name.cmp(&right.display_name));
    Ok(pets)
}

pub fn install_pet(data_dir: &Path, source: &Path, replace: bool) -> anyhow::Result<InstalledPet> {
    if !source.exists() {
        anyhow::bail!("import source does not exist: {}", source.display());
    }
    fs::create_dir_all(data_dir.join("pets"))?;
    let stage = data_dir.join(format!(".pet-import-{}", Uuid::new_v4().simple()));
    fs::create_dir_all(&stage)?;

    let result = (|| -> anyhow::Result<InstalledPet> {
        if source.is_dir() {
            copy_tree(source, &stage)?;
        } else if source
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
        {
            extract_zip(source, &stage)?;
        } else {
            anyhow::bail!("only a pet directory or .zip archive can be installed");
        }

        let root = find_pet_root(&stage)?;
        let pet = validate_pet_dir(&root)?;
        let target = data_dir.join("pets").join(&pet.id);
        if target.exists() {
            if !replace {
                anyhow::bail!("pet '{}' is already installed", pet.id);
            }
            fs::remove_dir_all(&target)?;
        }
        let install_stage = data_dir
            .join("pets")
            .join(format!(".install-{}", Uuid::new_v4().simple()));
        copy_tree(&root, &install_stage)?;
        fs::rename(install_stage, &target)?;
        validate_pet_dir(&target)
    })();

    let _ = fs::remove_dir_all(&stage);
    result
}

pub fn delete_pet(data_dir: &Path, pet_id: &str) -> anyhow::Result<()> {
    if pet_id == "builtin-aura" {
        anyhow::bail!("the built-in pet cannot be deleted");
    }
    validate_id(pet_id)?;
    let target = data_dir.join("pets").join(pet_id);
    if !target.exists() {
        anyhow::bail!("pet not found: {pet_id}");
    }
    fs::remove_dir_all(target)?;
    Ok(())
}

pub fn read_pet_asset(data_dir: &Path, pet_id: &str) -> anyhow::Result<String> {
    if pet_id == "builtin-aura" {
        return Ok(String::new());
    }
    validate_id(pet_id)?;
    let root = data_dir.join("pets").join(pet_id);
    let pet = validate_pet_dir(&root)?;
    let relative = pet
        .spritesheet_path
        .ok_or_else(|| anyhow::anyhow!("pet has no spritesheet"))?;
    let path = safe_join(&root, Path::new(&relative))?;
    let bytes = fs::read(path)?;
    Ok(format!("data:image/webp;base64,{}", STANDARD.encode(bytes)))
}

fn find_pet_root(stage: &Path) -> anyhow::Result<PathBuf> {
    let candidates: Vec<_> = WalkDir::new(stage)
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "pet.json")
        .map(|entry| entry.path().parent().unwrap_or(stage).to_path_buf())
        .collect();
    match candidates.as_slice() {
        [] => anyhow::bail!("pet.json was not found in the imported source"),
        [root] => Ok(root.clone()),
        _ => anyhow::bail!("the imported source contains more than one pet.json"),
    }
}

fn validate_pet_dir(root: &Path) -> anyhow::Result<InstalledPet> {
    let manifest_path = root.join("pet.json");
    let raw: Value =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(|error| {
            anyhow::anyhow!("cannot read {}: {error}", manifest_path.display())
        })?)?;
    let object = raw
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("pet.json must contain a JSON object"))?;

    let requested_id = string_field(object, &["id", "name"])
        .unwrap_or_else(|| hash_id(&fs::read(&manifest_path).unwrap_or_default()));
    let id = normalize_id(&requested_id)?;
    let display_name = string_field(object, &["displayName", "display_name", "name"])
        .unwrap_or_else(|| id.clone());
    if display_name.trim().is_empty() || display_name.chars().count() > 80 {
        anyhow::bail!("pet displayName must contain 1 to 80 characters");
    }
    let description =
        string_field(object, &["description"]).unwrap_or_else(|| "Imported Codex pet".to_string());
    if description.chars().count() > 500 {
        anyhow::bail!("pet description must not exceed 500 characters");
    }
    let spritesheet_path = string_field(
        object,
        &[
            "spritesheetPath",
            "spritesheet_path",
            "spritesheet",
            "image",
        ],
    )
    .unwrap_or_else(|| "spritesheet.webp".to_string());
    if !spritesheet_path.to_ascii_lowercase().ends_with(".webp") {
        anyhow::bail!("spritesheetPath must reference a WebP file");
    }
    let spritesheet = safe_join(root, Path::new(&spritesheet_path))?;
    if !spritesheet.is_file() {
        anyhow::bail!("spritesheet does not exist: {spritesheet_path}");
    }

    let (width, height) = ImageReader::open(&spritesheet)?
        .with_guessed_format()?
        .into_dimensions()
        .map_err(|error| anyhow::anyhow!("invalid WebP spritesheet: {error}"))?;
    let sprite_version = u32_field(object, &["spriteVersion", "spriteVersionNumber"]).unwrap_or(1);
    let rows = if sprite_version >= 2 { 11 } else { 9 };
    if width % 8 != 0 || height % rows != 0 {
        anyhow::bail!(
            "spritesheet dimensions must be divisible by the Codex 8x{rows} grid; got {width}x{height}"
        );
    }
    let frame_width = width / 8;
    let frame_height = height / rows;
    if frame_width == 0 || frame_height == 0 || frame_width > 1024 || frame_height > 1024 {
        anyhow::bail!("invalid spritesheet frame size: {frame_width}x{frame_height}");
    }

    Ok(InstalledPet {
        id,
        display_name,
        description,
        spritesheet_path: Some(spritesheet_path),
        frame_width,
        frame_height,
        columns: 8,
        rows,
        sprite_version,
        built_in: false,
        animations: default_animations(sprite_version),
    })
}

fn string_field(object: &serde_json::Map<String, Value>, fields: &[&str]) -> Option<String> {
    fields.iter().find_map(|field| {
        object
            .get(*field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn u32_field(object: &serde_json::Map<String, Value>, fields: &[&str]) -> Option<u32> {
    fields.iter().find_map(|field| {
        object.get(*field).and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
                .map(|number| number as u32)
        })
    })
}

fn normalize_id(value: &str) -> anyhow::Result<String> {
    let normalized = sanitize_filename::sanitize(value)
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    validate_id(&normalized)?;
    Ok(normalized)
}

fn validate_id(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > 64
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        anyhow::bail!("pet id must be 1-64 lowercase letters, numbers, '-' or '_'");
    }
    Ok(())
}

fn hash_id(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("pet-{:x}", digest)[..16].to_string()
}

fn safe_join(root: &Path, relative: &Path) -> anyhow::Result<PathBuf> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        anyhow::bail!(
            "resource path must be a safe relative path: {}",
            relative.display()
        );
    }
    Ok(root.join(relative))
}

fn copy_tree(source: &Path, destination: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry?;
        let relative = entry.path().strip_prefix(source)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = destination.join(relative);
        if entry.file_type().is_symlink() {
            anyhow::bail!("symbolic links are not allowed in pet packages");
        }
        if entry.file_type().is_dir() {
            fs::create_dir_all(target)?;
        } else if entry.file_type().is_file() {
            if entry.metadata()?.len() > MAX_ARCHIVE_BYTES {
                anyhow::bail!("pet package contains a file larger than 50 MiB");
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn extract_zip(source: &Path, destination: &Path) -> anyhow::Result<()> {
    let mut archive = ZipArchive::new(File::open(source)?)?;
    if archive.len() > MAX_ARCHIVE_FILES {
        anyhow::bail!("pet archive contains more than {MAX_ARCHIVE_FILES} entries");
    }
    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| anyhow::anyhow!("archive contains an unsafe path: {}", entry.name()))?
            .to_path_buf();
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            anyhow::bail!("symbolic links are not allowed in pet archives");
        }
        extracted_bytes = extracted_bytes.saturating_add(entry.size());
        if extracted_bytes > MAX_ARCHIVE_BYTES {
            anyhow::bail!("expanded pet archive exceeds 50 MiB");
        }
        let output = safe_join(destination, &relative)?;
        if entry.is_dir() {
            fs::create_dir_all(output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(output)?;
        io::copy(&mut entry, &mut file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_resource_paths() {
        let root = Path::new("/tmp/pets");
        assert!(safe_join(root, Path::new("../secret")).is_err());
        assert!(safe_join(root, Path::new("spritesheet.webp")).is_ok());
    }

    #[test]
    fn normalizes_package_ids() {
        assert_eq!(normalize_id("Happy Dog").unwrap(), "happy-dog");
        assert!(normalize_id("../").is_err());
    }
}
