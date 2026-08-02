use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// Cursor plumbing. A single always-on poller reads the real OS cursor and emits
/// `local-cursor {nx,ny}` (normalized 0..1) to the overlay. The Sim reads it as
/// `myCursor` — used for grab mechanics, hit-testing pets, and broadcasting my
/// ghost cursor to peers (via the `net_cursor` command).
#[derive(Default)]
pub struct GrabState {
    polling: AtomicBool,
}

/// Start the always-on cursor poller (idempotent). Called once when the overlay loads.
#[tauri::command]
pub fn cursor_poll_start(app: AppHandle) {
    let state = app.state::<GrabState>();
    if state.polling.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Some(win) = app.get_webview_window("overlay") {
                if let (Ok(pos), Ok(Some(mon))) = (win.cursor_position(), win.primary_monitor()) {
                    let sz = mon.size();
                    if sz.width > 0 && sz.height > 0 {
                        let nx = pos.x / sz.width as f64;
                        let ny = pos.y / sz.height as f64;
                        let _ = app.emit_to(
                            "overlay",
                            "local-cursor",
                            serde_json::json!({ "nx": nx, "ny": ny }),
                        );
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(22)).await; // ~45fps
        }
    });
}

/// Toggle overlay click-through. false = the overlay captures the mouse (so a pet
/// can be clicked/grabbed); true = clicks pass through to the desktop.
#[tauri::command]
pub fn set_clickthrough(app: AppHandle, ignore: bool) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}
