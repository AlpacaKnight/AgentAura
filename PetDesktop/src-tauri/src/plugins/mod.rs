//! Plugin management module for AgentAura PetDesktop.
//!
//! This module is split into sub-modules by responsibility:
//! - `model` — Data types (PluginProvider, PluginPackageInspection, etc.)
//! - `inspect` — Package inspection & identification
//! - `process` — Install, uninstall, hooks, config operations
//! - `env` — Environment detection, CLI resolution, utilities

mod env;
mod inspect;
mod model;
mod process;

pub use model::{
    ManagedPluginStatus, PluginOperationResult, PluginPackageInspection,
    PluginProvider,
};
pub use env::{emit_log, next_operation_id};
pub use inspect::inspect_packages;
pub use process::{
    install_package_streaming, list_plugin_status, list_plugins, load_config,
    manage_hooks_streaming, repair_hooks_streaming, save_config,
    uninstall_plugin_streaming,
};