use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::presence;
use crate::protocol::ClientMsg;

/// Cursor plumbing. A single always-on poller reads the real OS cursor and emits
/// `local-cursor {nx,ny}` (normalized 0..1) to the overlay — used both for the
/// grab mechanics AND for hit-testing the ambient pet (so it can be clicked even
/// though the overlay is otherwise click-through). While `stream_to` is set (we're
/// being grabbed), it also forwards the cursor to that peer for their ghost.
#[derive(Default)]
pub struct GrabState {
    polling: AtomicBool,
    stream_to: Mutex<Option<String>>,
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
                        let peer = app.state::<GrabState>().stream_to.lock().unwrap().clone();
                        if let Some(to) = peer {
                            presence::send(&app, ClientMsg::Cursor { to, x: nx, y: ny });
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(22)).await; // ~45fps
        }
    });
}

/// Begin forwarding my cursor to `peer` (I'm being grabbed). Ensures the poller runs.
#[tauri::command]
pub fn cursor_feed_start(app: AppHandle, peer: Option<String>) {
    *app.state::<GrabState>().stream_to.lock().unwrap() = peer;
    cursor_poll_start(app);
}

/// Stop forwarding my cursor (the poller keeps running for hit-testing).
#[tauri::command]
pub fn cursor_feed_stop(app: AppHandle) {
    *app.state::<GrabState>().stream_to.lock().unwrap() = None;
}

/// Toggle overlay click-through. false = the overlay captures the mouse (so the
/// ambient pet can be clicked/dragged); true = clicks pass through to the desktop.
#[tauri::command]
pub fn set_clickthrough(app: AppHandle, ignore: bool) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

/// Grabber → target: reinforce the grip (sent while hovering over the ghost).
#[tauri::command]
pub fn peer_grip(app: AppHandle, to: String, strength: f64) {
    presence::send(&app, ClientMsg::Grip { to, strength });
}

/// Target → grabber: my current grip level 0..1 (drives the grabber's meter).
#[tauri::command]
pub fn peer_hold(app: AppHandle, to: String, level: f64) {
    presence::send(&app, ClientMsg::Hold { to, level });
}

/// Either side: the grab ended.
#[tauri::command]
pub fn peer_released(app: AppHandle, to: String) {
    presence::send(&app, ClientMsg::Released { to });
}

/// Stream a bouncing pet's position to the other viewer (owner ↔ host).
#[tauri::command]
pub fn pet_pos(app: AppHandle, to: String, owner: String, x: f64, y: f64, flip: bool, pose: String) {
    presence::send(&app, ClientMsg::PetPos { to, owner, x, y, flip, pose });
}
