mod core;
mod hardware;
mod model;
mod pets;
mod plugins;
mod server;
mod workspace;

use std::{
    fs,
    net::UdpSocket,
    path::{Path, PathBuf},
};

use core::AppCore;
use model::{AgentState, AppSettings, AppSnapshot, LogLevel};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::MenuBuilder, tray::TrayIconBuilder, AppHandle, Manager, PhysicalPosition, Position,
    State, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

/// 管理正在进行的可取消插件操作
struct ActiveOperation {
    operation_id: u64,
    cancel_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl ActiveOperation {
    fn cancel(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
    }
}

fn begin_plugin_operation(
    op: &State<'_, Mutex<Option<ActiveOperation>>>,
    operation_id: u64,
) -> tokio::sync::oneshot::Receiver<()> {
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let mut guard = op.lock();
    if let Some(active) = guard.as_mut() {
        active.cancel();
    }
    *guard = Some(ActiveOperation {
        operation_id,
        cancel_tx: Some(cancel_tx),
    });
    cancel_rx
}

fn finish_plugin_operation(op: &State<'_, Mutex<Option<ActiveOperation>>>, operation_id: u64) {
    let mut guard = op.lock();
    if guard
        .as_ref()
        .is_some_and(|active| active.operation_id == operation_id)
    {
        *guard = None;
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredPosition {
    x: i32,
    y: i32,
}

#[tauri::command]
fn get_lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .map(|address| address.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

#[tauri::command]
fn get_snapshot(core: State<'_, AppCore>) -> AppSnapshot {
    core.snapshot()
}

#[tauri::command]
fn set_manual_state(core: State<'_, AppCore>, state: AgentState) {
    core.submit_state(
        "petdesktop-manual",
        "petdesktop",
        "PetDesktop Manual",
        state,
        None,
    );
}

#[tauri::command]
fn set_locked_agent(core: State<'_, AppCore>, instance_id: Option<String>) -> Result<(), String> {
    core.set_locked_agent(instance_id)
}

#[tauri::command]
fn set_paused(core: State<'_, AppCore>, paused: bool) {
    core.set_paused(paused);
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    core: State<'_, AppCore>,
    settings: AppSettings,
) -> Result<AppSnapshot, String> {
    core.save_settings(settings)
        .map_err(|error| error.to_string())?;
    apply_window_settings(&app, &core.settings())?;
    apply_autostart(&app, core.settings().launch_at_startup)?;
    Ok(core.snapshot())
}

#[tauri::command]
async fn install_pet(
    core: State<'_, AppCore>,
    source: String,
    replace: bool,
) -> Result<AppSnapshot, String> {
    let core = core.inner().clone();
    let source = PathBuf::from(source);
    let install_core = core.clone();
    let pet = tauri::async_runtime::spawn_blocking(move || {
        let data_dir = install_core.data_dir()?;
        pets::install_pet(&data_dir, &source, replace)
    })
    .await
    .map_err(|error| format!("pet installer failed: {error}"))?
    .map_err(|error| error.to_string())?;
    core.select_pet(&pet.id)
        .map_err(|error| error.to_string())?;
    core.log(LogLevel::Info, "pets", format!("installed {}", pet.id));
    Ok(core.snapshot())
}

#[tauri::command]
fn delete_pet(core: State<'_, AppCore>, pet_id: String) -> Result<AppSnapshot, String> {
    if core.settings().selected_pet_id == pet_id {
        core.select_pet("builtin-aura")
            .map_err(|error| error.to_string())?;
    }
    let data_dir = core.data_dir().map_err(|error| error.to_string())?;
    pets::delete_pet(&data_dir, &pet_id).map_err(|error| error.to_string())?;
    core.log(LogLevel::Info, "pets", format!("deleted {pet_id}"));
    Ok(core.snapshot())
}

#[tauri::command]
fn select_pet(core: State<'_, AppCore>, pet_id: String) -> Result<AppSnapshot, String> {
    core.select_pet(&pet_id)
        .map_err(|error| error.to_string())?;
    Ok(core.snapshot())
}

#[tauri::command]
fn read_selected_pet_asset(core: State<'_, AppCore>) -> Result<String, String> {
    let data_dir = core.data_dir().map_err(|error| error.to_string())?;
    pets::read_pet_asset(&data_dir, &core.settings().selected_pet_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn discover_hardware() -> Result<Vec<hardware::DiscoveredHardware>, String> {
    hardware::discover().await
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<hardware::SerialPortInfo>, String> {
    hardware::serial_ports()
}

#[tauri::command]
async fn test_hardware(core: State<'_, AppCore>) -> Result<(), String> {
    core.forward_command("state".to_string()).await.map(|_| ())
}

#[tauri::command]
fn show_management(app: AppHandle) -> Result<(), String> {
    show_window(&app, "main")
}

#[tauri::command]
fn show_pet(app: AppHandle, visible: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    if visible {
        window.show()
    } else {
        window.hide()
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn inspect_plugin_packages(paths: Vec<String>) -> Vec<plugins::PluginPackageInspection> {
    tauri::async_runtime::spawn_blocking(move || plugins::inspect_packages(paths))
        .await
        .unwrap_or_else(|error| {
            vec![plugins::PluginPackageInspection::failure(
                "",
                error.to_string(),
            )]
        })
}
#[tauri::command]
async fn list_managed_plugins(
    core: State<'_, AppCore>,
) -> Result<Vec<plugins::ManagedPluginStatus>, String> {
    let data_dir = core.data_dir().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || plugins::list_plugins(&data_dir))
        .await
        .map_err(|error| format!("plugin listing failed: {error}"))?
}
#[tauri::command]
async fn inspect_managed_plugin(
    core: State<'_, AppCore>,
    provider: plugins::PluginProvider,
) -> Result<plugins::ManagedPluginStatus, String> {
    let data_dir = core.data_dir().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || plugins::list_plugin_status(&data_dir, provider))
        .await
        .map_err(|error| format!("plugin inspection failed: {error}"))
}
#[tauri::command]
async fn install_plugin_package(
    app: AppHandle,
    core: State<'_, AppCore>,
    op: State<'_, Mutex<Option<ActiveOperation>>>,
    path: String,
) -> Result<plugins::PluginOperationResult, String> {
    let data_dir = core.data_dir().map_err(|error| error.to_string())?;
    let operation_id = plugins::next_operation_id();

    // 先预检
    let paths = vec![path.clone()];
    let inspections =
        tauri::async_runtime::spawn_blocking(move || plugins::inspect_packages(paths))
            .await
            .map_err(|error| format!("plugin inspector failed: {error}"))?;

    let Some(inspection) = inspections.into_iter().next() else {
        return Err("无法检查插件包".to_string());
    };
    if !inspection.valid {
        return Err(inspection
            .error
            .unwrap_or_else(|| "无效的插件包".to_string()));
    }

    plugins::emit_log(
        &app,
        operation_id,
        "log",
        format!(
            "🔍 已识别插件: {:?} v{}",
            inspection.provider,
            inspection.version.as_deref().unwrap_or("?")
        ),
    );

    let cancel_rx = begin_plugin_operation(&op, operation_id);

    let result = plugins::install_package_streaming(
        &data_dir,
        Path::new(&path),
        inspection,
        &app,
        operation_id,
        cancel_rx,
    )
    .await;
    plugins::emit_log(
        &app,
        operation_id,
        "complete",
        if result.success {
            "✅ 安装完成".into()
        } else {
            format!("❌ {}", result.message)
        },
    );
    finish_plugin_operation(&op, operation_id);
    Ok(result)
}
#[tauri::command]
async fn uninstall_managed_plugin(
    app: AppHandle,
    core: State<'_, AppCore>,
    op: State<'_, Mutex<Option<ActiveOperation>>>,
    provider: plugins::PluginProvider,
) -> Result<plugins::PluginOperationResult, String> {
    let data_dir = core.data_dir().map_err(|error| error.to_string())?;
    let operation_id = plugins::next_operation_id();

    plugins::emit_log(
        &app,
        operation_id,
        "log",
        format!("🗑️ 开始卸载 {:?}...", provider),
    );

    let cancel_rx = begin_plugin_operation(&op, operation_id);

    let result =
        plugins::uninstall_plugin_streaming(&data_dir, provider, &app, operation_id, cancel_rx)
            .await;
    plugins::emit_log(
        &app,
        operation_id,
        "complete",
        if result.success {
            "✅ 卸载完成".into()
        } else {
            format!("❌ {}", result.message)
        },
    );
    finish_plugin_operation(&op, operation_id);
    Ok(result)
}
#[tauri::command]
async fn manage_plugin_hooks(
    app: AppHandle,
    core: State<'_, AppCore>,
    op: State<'_, Mutex<Option<ActiveOperation>>>,
    provider: plugins::PluginProvider,
    install: bool,
) -> Result<plugins::PluginOperationResult, String> {
    let data_dir = core.data_dir().map_err(|error| error.to_string())?;
    let operation_id = plugins::next_operation_id();

    let action_label = if install { "安装" } else { "卸载" };
    plugins::emit_log(
        &app,
        operation_id,
        "log",
        format!("🔧 {} {:?} Hooks...", action_label, provider),
    );

    let cancel_rx = begin_plugin_operation(&op, operation_id);

    let result = plugins::manage_hooks_streaming(
        &data_dir,
        provider,
        install,
        &app,
        operation_id,
        cancel_rx,
    )
    .await;
    plugins::emit_log(
        &app,
        operation_id,
        "complete",
        if result.success {
            "✅ Hooks 操作完成".into()
        } else {
            format!("❌ {}", result.message)
        },
    );
    finish_plugin_operation(&op, operation_id);
    Ok(result)
}
#[tauri::command]
async fn repair_plugin_hooks(
    app: AppHandle,
    core: State<'_, AppCore>,
    op: State<'_, Mutex<Option<ActiveOperation>>>,
    provider: plugins::PluginProvider,
) -> Result<plugins::PluginOperationResult, String> {
    let data_dir = core.data_dir().map_err(|error| error.to_string())?;
    let operation_id = plugins::next_operation_id();

    plugins::emit_log(
        &app,
        operation_id,
        "log",
        format!("🔧 修复 {:?} Hooks...", provider),
    );

    let cancel_rx = begin_plugin_operation(&op, operation_id);

    let result =
        plugins::repair_hooks_streaming(&data_dir, provider, &app, operation_id, cancel_rx).await;
    finish_plugin_operation(&op, operation_id);
    Ok(result)
}
#[tauri::command]
fn cancel_plugin_operation(op: State<'_, Mutex<Option<ActiveOperation>>>) -> bool {
    let mut guard = op.lock();
    if let Some(active) = guard.as_mut() {
        active.cancel();
        true
    } else {
        false
    }
}
#[tauri::command]
fn load_plugin_config(provider: plugins::PluginProvider) -> Result<String, String> {
    plugins::load_config(provider)
}
#[tauri::command]
fn save_plugin_config(provider: plugins::PluginProvider, config: String) -> Result<(), String> {
    plugins::save_config(provider, &config)
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_window(app, "main");
        }))
        .manage(AppCore::new_uninit())
        .manage(Mutex::new(None::<ActiveOperation>))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let core = app.state::<AppCore>().inner().clone();
            core.init(data_dir)?;
            core.set_app_handle(app.handle().clone());
            let sender = hardware::start_worker(core.clone());
            core.set_hardware_sender(sender);

            create_tray(app)?;
            restore_pet_position(app.handle(), &core.data_dir()?);
            apply_window_settings(app.handle(), &core.settings()).map_err(anyhow::Error::msg)?;
            server::start(core.clone());
            core.log(LogLevel::Info, "app", "PetDesktop started");

            let reaper = core;
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
                loop {
                    interval.tick().await;
                    reaper.reap_stale_agents();
                    reaper.reap_expired_messages();
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "pet" {
                if let WindowEvent::Moved(position) = event {
                    if let Ok(data_dir) = window.app_handle().path().app_data_dir() {
                        save_pet_position(&data_dir, position.x, position.y);
                    }
                }
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" || window.label() == "pet" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_lan_ip,
            get_snapshot,
            set_manual_state,
            set_locked_agent,
            set_paused,
            save_settings,
            install_pet,
            delete_pet,
            select_pet,
            read_selected_pet_asset,
            discover_hardware,
            list_serial_ports,
            test_hardware,
            show_management,
            show_pet,
            inspect_plugin_packages,
            list_managed_plugins,
            inspect_managed_plugin,
            install_plugin_package,
            uninstall_managed_plugin,
            manage_plugin_hooks,
            repair_plugin_hooks,
            cancel_plugin_operation,
            load_plugin_config,
            save_plugin_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgentAura PetDesktop");
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show", "打开管理页")
        .text("pet", "显示桌宠")
        .text("pause", "暂停/恢复同步")
        .separator()
        .text("quit", "退出")
        .build()?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("AgentAura PetDesktop")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let _ = show_window(app, "main");
            }
            "pet" => {
                if let Some(window) = app.get_webview_window("pet") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                    }
                }
            }
            "pause" => {
                let core = app.state::<AppCore>();
                core.set_paused(!core.snapshot().paused);
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn show_window(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("window not found: {label}"))?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn apply_window_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let pet = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    pet.set_always_on_top(settings.always_on_top)
        .map_err(|error| error.to_string())?;
    pet.set_ignore_cursor_events(settings.click_through)
        .map_err(|error| error.to_string())?;
    if settings.pet_visible {
        pet.show()
    } else {
        pet.hide()
    }
    .map_err(|error| error.to_string())?;
    workspace::set_show_on_all_workspaces(&pet, settings.show_on_all_workspaces)?;
    clamp_to_monitor(&pet)?;
    Ok(())
}

fn clamp_to_monitor(window: &WebviewWindow) -> Result<(), String> {
    let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let origin = monitor.position();
    let bounds = monitor.size();
    // i32::clamp panics when the window is larger than the monitor (min > max).
    // This can occur briefly during display/RDP changes and used to abort release builds.
    let max_x = origin
        .x
        .saturating_add(bounds.width as i32)
        .saturating_sub(size.width as i32)
        .max(origin.x);
    let max_y = origin
        .y
        .saturating_add(bounds.height as i32)
        .saturating_sub(size.height as i32)
        .max(origin.y);
    let x = position.x.clamp(origin.x, max_x);
    let y = position.y.clamp(origin.y, max_y);
    if x != position.x || y != position.y {
        window
            .set_position(Position::Physical(PhysicalPosition::new(x, y)))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let current = manager
        .is_enabled()
        .map_err(|error| format!("cannot read autostart state: {error}"))?;
    if current == enabled {
        return Ok(());
    }
    if enabled {
        manager.enable()
    } else {
        manager.disable()
    }
    .map_err(|error| format!("cannot update autostart state: {error}"))
}

fn position_path(data_dir: &Path) -> PathBuf {
    data_dir.join("pet-position.json")
}

fn restore_pet_position(app: &AppHandle, data_dir: &Path) {
    let Ok(bytes) = fs::read(position_path(data_dir)) else {
        return;
    };
    let Ok(position) = serde_json::from_slice::<StoredPosition>(&bytes) else {
        return;
    };
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(
            position.x, position.y,
        )));
    }
}

fn save_pet_position(data_dir: &Path, x: i32, y: i32) {
    let _ = fs::create_dir_all(data_dir);
    if let Ok(bytes) = serde_json::to_vec(&StoredPosition { x, y }) {
        let _ = fs::write(position_path(data_dir), bytes);
    }
}
