//! Platform-specific window workspace management.
//!
//! On Linux, we use the top-level GTK window and call `stick()` / `unstick()`
//! to make it visible on all workspaces.
//!
//! On macOS, we use `NSWindow::setCollectionBehavior:` with
//! `NSWindowCollectionBehaviorCanJoinAllSpaces`.
//!
//! On Windows, this is a no-op (Windows doesn't have workspaces in the same
//! sense).

use tauri::WebviewWindow;

/// Sets whether the window should be visible on all workspaces.
pub fn set_show_on_all_workspaces(
    window: &WebviewWindow,
    show: bool,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        set_linux(window, show)?;
    }

    #[cfg(target_os = "macos")]
    {
        set_macos(window, show)?;
    }

    #[cfg(target_os = "windows")]
    {
        let _ = (window, show);
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn set_linux(window: &WebviewWindow, show: bool) -> Result<(), String> {
    use gtk::prelude::*;

    let window = window.gtk_window().map_err(|e| e.to_string())?;
    if show {
        window.stick();
    } else {
        window.unstick();
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn set_macos(window: &WebviewWindow, show: bool) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())?;
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };

    let mut behavior = ns_window.collectionBehavior();
    let flag = NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces;
    if show {
        behavior.insert(flag);
    } else {
        behavior.remove(flag);
    }

    ns_window.setCollectionBehavior(behavior);
    Ok(())
}
