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
                // Normalize the cursor against the overlay window's CONTENT rect, not
                // the monitor — otherwise the macOS menu bar (or any window offset)
                // shifts the cursor vs. where the webview renders pets, and clicks
                // land off. This matches the render basis exactly on Win/Mac.
                if let (Ok(pos), Ok(ipos), Ok(isz)) =
                    (win.cursor_position(), win.inner_position(), win.inner_size())
                {
                    let iw = isz.width as f64;
                    let ih = isz.height as f64;
                    if iw > 0.0 && ih > 0.0 {
                        let nx = (pos.x - ipos.x as f64) / iw;
                        let ny = (pos.y - ipos.y as f64) / ih;
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
