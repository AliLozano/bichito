mod cursor;
mod presence;
mod protocol;

use presence::PresenceState;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};

// Show the main (settings) window, focused.
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Make the overlay cover the primary monitor, sit on top, ignore the mouse, and show.
fn arm_overlay(win: &WebviewWindow) {
    // Cover the whole primary monitor.
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let size = monitor.size();
        let pos = monitor.position();
        let _ = win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
        let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
    }
    // Click-through: the pet must never steal clicks from what's underneath.
    let _ = win.set_ignore_cursor_events(true);
    let _ = win.set_always_on_top(true);
    let _ = win.show();
}

/// Debug logger for tuning the grip battle. No-op in release builds (dev only).
#[tauri::command]
fn dbg_log(line: String) {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/bichito-battle.log")
        {
            let _ = writeln!(f, "{line}");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = line;
}

#[tauri::command]
fn finish_onboarding(app: tauri::AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        arm_overlay(&overlay);
    }
    presence::start(&app);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(PresenceState::default())
        .manage(cursor::GrabState::default())
        .invoke_handler(tauri::generate_handler![
            finish_onboarding,
            dbg_log,
            cursor::cursor_poll_start,
            cursor::cursor_feed_start,
            cursor::cursor_feed_stop,
            cursor::set_clickthrough,
            cursor::peer_grip,
            cursor::peer_hold,
            cursor::peer_released,
            cursor::pet_pos,
            presence::get_online,
            presence::get_pets,
            presence::leap,
            presence::roamed,
            presence::dropped,
            presence::gone
        ])
        .setup(|app| {
            // --- Tray icon + context menu -------------------------------------
            let prefs = MenuItem::with_id(app, "prefs", "Preferencias", true, None::<&str>)?;
            let friends =
                MenuItem::with_id(app, "friends", "Amigos (próximamente)", false, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&prefs, &friends, &sep, &quit])?;

            TrayIconBuilder::with_id("bichito-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("bichito")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    if presence::handle_menu(app, id) {
                        return;
                    }
                    match id {
                        "prefs" => show_main(app),
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // --- Overlay: if the user is already onboarded, arm it now --------
            // (The store is read on the JS side; here we just make sure the window
            // exists. It becomes visible either via finish_onboarding or below.)
            if let Some(overlay) = app.get_webview_window("overlay") {
                let already = std::path::Path::new(
                    &app.path()
                        .app_data_dir()
                        .map(|d| d.join("bichito.json"))
                        .unwrap_or_default(),
                )
                .exists();
                if already {
                    arm_overlay(&overlay);
                    // Onboarding already done -> don't pop the main window on launch.
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.hide();
                    }
                }
            }

            // Connect to the presence server (no-op until the user is onboarded).
            presence::start(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running bichito");
}
