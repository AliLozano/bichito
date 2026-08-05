mod avatars;
mod cursor;
mod presence;
mod protocol;

use presence::PresenceState;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

// macOS: toggle whether the app appears in the Dock / Cmd+Tab. Accessory = hidden
// (tray-only, the default for bichito); Regular = normal, used briefly while a
// settings window is open so it can come to the front. No-op on other platforms.
fn set_dock(app: &tauri::AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

// Show the main (settings) window, focused. Briefly become a Regular app so the
// window comes to the front and is interactable.
fn show_main(app: &tauri::AppHandle) {
    set_dock(app, true);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Hide the settings window and go back to tray-only (out of Cmd+Tab / Dock).
#[tauri::command]
fn hide_main(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    set_dock(&app, false);
}

// Make the overlay cover the primary monitor's WORK AREA (visible frame, excluding
// the Dock / menu bar / taskbar), sit on top, ignore the mouse, and show. Using the
// work area (not the full monitor) keeps pets on the visible floor instead of behind
// the Dock/taskbar, on both macOS and Windows.
fn arm_overlay(win: &WebviewWindow) {
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let wa = monitor.work_area();
        let _ = win.set_position(tauri::PhysicalPosition::new(wa.position.x, wa.position.y));
        let _ = win.set_size(tauri::PhysicalSize::new(wa.size.width, wa.size.height));
    }
    // Click-through: the pet must never steal clicks from what's underneath.
    let _ = win.set_ignore_cursor_events(true);
    let _ = win.set_always_on_top(true);
    let _ = win.show();
}

#[tauri::command]
fn finish_onboarding(app: tauri::AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        arm_overlay(&overlay);
    }
    // Run at login by default (the user can turn it off in Preferencias).
    let _ = app.autolaunch().enable();
    // Onboarding done -> live in the tray only (out of Cmd+Tab / Dock).
    set_dock(&app, false);
    presence::start(&app);
}

pub fn run() {
    // Select a rustls crypto provider up front — required for wss:// (TLS) in the
    // release build; without it rustls panics on the first secure connection.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        // Launch-at-login: LaunchAgent on macOS, Run-key on Windows.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // Auto-update: check a signed manifest on GitHub Releases, download + install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // The settings window must PERSIST: closing it (red button / Cmd+W / JS close)
        // would DESTROY it, and then "Preferencias" could never reopen it (show_main's
        // get_webview_window("main") returns None -> silent no-op — the "ya no vuelve a
        // aparecer" bug). Intercept the close, HIDE instead, and drop back to tray-only.
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    set_dock(window.app_handle(), false);
                }
            }
        })
        .manage(PresenceState::default())
        .manage(cursor::GrabState::default())
        .invoke_handler(tauri::generate_handler![
            finish_onboarding,
            hide_main,
            cursor::cursor_poll_start,
            cursor::set_clickthrough,
            cursor::game_focus,
            cursor::game_arm,
            cursor::dbg,
            presence::get_online,
            presence::get_world,
            presence::net_claim,
            presence::net_snap,
            presence::net_cursor,
            presence::net_bump,
            presence::net_game,
            presence::get_config,
            presence::net_config,
            presence::get_dnd,
            presence::set_dnd,
            presence::net_ping_start,
            presence::net_ping_stop,
            presence::set_character,
            presence::update_available,
            avatars::list_avatars,
            avatars::open_avatars_dir
        ])
        .setup(|app| {
            // First run: create ~/.bichito/avatars/ + SKILL.md + an example pet so
            // custom avatars are discoverable.
            avatars::scaffold(app.handle());

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
                        "prefs" | "update" => show_main(app),
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
                    // Onboarding already done -> don't pop the main window on launch,
                    // and live in the tray only (out of Cmd+Tab / Dock).
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.hide();
                    }
                    set_dock(app.handle(), false);
                }
            }

            // Connect to the presence server (no-op until the user is onboarded).
            presence::start(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running bichito");
}
