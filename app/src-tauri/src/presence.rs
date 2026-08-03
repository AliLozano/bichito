use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};

use futures_util::{SinkExt, StreamExt};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Emitter, Manager,
};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

use crate::protocol::{ClientMsg, PetSnap, ServerMsg, UserInfo, WorldConfig};
use tauri_plugin_store::StoreExt;

/// App-global presence state, managed via `app.manage(...)`.
#[derive(Default)]
pub struct PresenceState {
    /// Channel to the WS task (menu clicks + commands push `ClientMsg` here).
    pub tx: Mutex<Option<UnboundedSender<ClientMsg>>>,
    /// My own user id (to exclude myself from the friends menu).
    pub me: Mutex<Option<String>>,
    /// Latest online snapshot from the server.
    pub online: Mutex<Vec<UserInfo>>,
    /// Latest shared group config (overlay/settings fetch it on load).
    pub config: Mutex<Option<WorldConfig>>,
    /// Latest full world (so the overlay can fetch it on load).
    pub world: Mutex<Vec<PetSnap>>,
    /// Whether the WS is currently connected.
    pub connected: AtomicBool,
    /// Do Not Disturb: while true we stay offline and the overlay is hidden.
    pub dnd: AtomicBool,
    /// Version string of an available update (Some -> shows a tray item), if any.
    pub update: Mutex<Option<String>>,
    /// Bumped each time DND is toggled, so a stale 30-min timer can't un-DND a
    /// freshly re-enabled session.
    dnd_gen: AtomicU64,
    /// Guards against starting the task twice.
    started: AtomicBool,
}

fn server_url() -> String {
    std::env::var("BICHITO_SERVER").unwrap_or_else(|_| {
        if cfg!(debug_assertions) {
            "ws://127.0.0.1:8787/ws".to_string()
        } else {
            "wss://ws-pet.alilozano.com/ws".to_string()
        }
    })
}

/// Read the persisted profile (written by the JS store plugin).
fn read_profile(app: &AppHandle) -> Option<(String, String, String)> {
    let store = app.store("bichito.json").ok()?;
    let p = store.get("profile")?;
    let id = p.get("id")?.as_str()?.to_string();
    if id.is_empty() {
        return None;
    }
    let name = p
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let character = p
        .get("character")
        .and_then(|v| v.as_str())
        .unwrap_or("gato")
        .to_string();
    Some((id, name, character))
}

/// Read the persisted local config (written by the JS store plugin), if any.
fn read_config(app: &AppHandle) -> Option<WorldConfig> {
    let store = app.store("bichito.json").ok()?;
    let c = store.get("config")?;
    serde_json::from_value(c).ok()
}

/// Start the presence client (idempotent). Called once the user is onboarded.
pub fn start(app: &AppHandle) {
    let state = app.state::<PresenceState>();
    if state.started.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some((id, name, character)) = read_profile(app) else {
        state.started.store(false, Ordering::SeqCst);
        return;
    };
    *state.me.lock().unwrap() = Some(id.clone());

    let (tx, rx) = mpsc::unbounded_channel::<ClientMsg>();
    *state.tx.lock().unwrap() = Some(tx);

    let app = app.clone();
    tauri::async_runtime::spawn(run(app, id, name, character, rx));
}

/// Current online users (for the tray friends list).
#[tauri::command]
pub fn get_online(app: AppHandle) -> Vec<UserInfo> {
    app.state::<PresenceState>().online.lock().unwrap().clone()
}

/// Current full world (the overlay fetches this on load).
#[tauri::command]
pub fn get_world(app: AppHandle) -> Vec<PetSnap> {
    app.state::<PresenceState>().world.lock().unwrap().clone()
}

/// Push a message to the WS task (used by commands + menu clicks).
pub fn send(app: &AppHandle, msg: ClientMsg) {
    if let Some(tx) = app.state::<PresenceState>().tx.lock().unwrap().clone() {
        let _ = tx.send(msg);
    }
}

// --- commands the overlay Sim uses to drive the shared world -----------------

/// Take control of the pet owned by `owner`.
#[tauri::command]
pub fn net_claim(app: AppHandle, owner: String) {
    send(&app, ClientMsg::Claim { owner });
}

/// Broadcast a snapshot of a pet I control.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn net_snap(
    app: AppHandle,
    owner: String,
    name: String,
    character: String,
    controller: String,
    state: String,
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    flip: bool,
    frame: i64,
    grip: f64,
    target: String,
) {
    send(
        &app,
        ClientMsg::Snap {
            snap: PetSnap {
                owner,
                name,
                character,
                controller,
                state,
                x,
                y,
                vx,
                vy,
                flip,
                frame,
                grip,
                target,
            },
        },
    );
}

/// Broadcast my cursor + whether I'm interacting.
#[tauri::command]
pub fn net_cursor(app: AppHandle, x: f64, y: f64, active: bool) {
    send(&app, ClientMsg::Cursor { x, y, active });
}

/// Impart a collision velocity to a pet someone else controls.
#[tauri::command]
pub fn net_bump(app: AppHandle, owner: String, vx: f64, vy: f64) {
    send(&app, ClientMsg::Bump { owner, vx, vy });
}

/// Called by the overlay once it finds a newer version -> show a tray item.
#[tauri::command]
pub fn update_available(app: AppHandle, version: String) {
    *app.state::<PresenceState>().update.lock().unwrap() = Some(version);
    rebuild_tray(&app);
}

/// The current shared group config (settings/overlay fetch it on load).
#[tauri::command]
pub fn get_config(app: AppHandle) -> Option<WorldConfig> {
    app.state::<PresenceState>().config.lock().unwrap().clone()
}

/// Update the shared group config -> broadcast to everyone (the echo updates us).
#[tauri::command]
pub fn net_config(app: AppHandle, config: WorldConfig) {
    *app.state::<PresenceState>().config.lock().unwrap() = Some(config.clone());
    send(&app, ClientMsg::Config { config });
}

/// Whether Do Not Disturb is currently on.
#[tauri::command]
pub fn get_dnd(app: AppHandle) -> bool {
    app.state::<PresenceState>().dnd.load(Ordering::Relaxed)
}

/// Toggle Do Not Disturb. On -> go offline + hide the overlay for 30 min (auto-off).
#[tauri::command]
pub fn set_dnd(app: AppHandle, on: bool) {
    let state = app.state::<PresenceState>();
    state.dnd.store(on, Ordering::Relaxed);
    let gen = state.dnd_gen.fetch_add(1, Ordering::SeqCst) + 1;

    if let Some(win) = app.get_webview_window("overlay") {
        let _ = if on { win.hide() } else { win.show() };
    }
    rebuild_tray(&app);

    if on {
        // auto-clear after 30 minutes, unless DND was toggled again since
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(30 * 60)).await;
            let st = app2.state::<PresenceState>();
            if st.dnd_gen.load(Ordering::SeqCst) == gen && st.dnd.load(Ordering::Relaxed) {
                set_dnd(app2.clone(), false);
            }
        });
    }
}

/// Long-lived task: connect, announce, pump messages, reconnect on drop.
async fn run(
    app: AppHandle,
    id: String,
    name: String,
    character: String,
    mut rx: UnboundedReceiver<ClientMsg>,
) {
    let url = server_url();
    loop {
        // While Do Not Disturb is on, stay offline entirely.
        while app.state::<PresenceState>().dnd.load(Ordering::Relaxed) {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => {
                set_connected(&app, true);
                let (mut write, mut read) = ws.split();

                let hello = ClientMsg::Hello {
                    id: id.clone(),
                    name: name.clone(),
                    character: character.clone(),
                    config: read_config(&app), // seeds the shared config if we're first
                };
                let _ = write
                    .send(Message::Text(serde_json::to_string(&hello).unwrap()))
                    .await;

                // Keepalive ping: holds the connection open through Cloudflare's ~100s
                // idle timeout, and surfaces a dead link fast (a failed send -> break ->
                // reconnect) if the network drops without a clean close.
                let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(30));
                keepalive.tick().await; // consume the immediate first tick

                loop {
                    tokio::select! {
                        cmd = rx.recv() => match cmd {
                            Some(c) => {
                                if write
                                    .send(Message::Text(serde_json::to_string(&c).unwrap()))
                                    .await
                                    .is_err()
                                {
                                    break; // link is dead -> reconnect
                                }
                            }
                            None => return, // app shutting down
                        },
                        frame = read.next() => match frame {
                            Some(Ok(Message::Text(t))) => handle_server(&app, &t),
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Err(_)) => break,
                            Some(Ok(_)) => {} // ping/pong/binary — ignore
                        },
                        _ = keepalive.tick() => {
                            if write.send(Message::Ping(Vec::new())).await.is_err() {
                                break; // reconnect
                            }
                        }
                        // periodically re-check DND so toggling it disconnects promptly
                        _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                            if app.state::<PresenceState>().dnd.load(Ordering::Relaxed) {
                                break;
                            }
                        }
                    }
                }
                set_connected(&app, false);
            }
            Err(_) => set_connected(&app, false),
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

fn handle_server(app: &AppHandle, text: &str) {
    let Ok(msg) = serde_json::from_str::<ServerMsg>(text) else {
        return;
    };
    match msg {
        ServerMsg::Presence { users } => {
            *app.state::<PresenceState>().online.lock().unwrap() = users.clone();
            rebuild_tray(app);
            let _ = app.emit("presence", users);
        }
        ServerMsg::Config { config } => {
            *app.state::<PresenceState>().config.lock().unwrap() = Some(config.clone());
            rebuild_tray(app); // reflect allowLeap in the friends menu
            let _ = app.emit_to("overlay", "config", config.clone());
            let _ = app.emit("config", config); // settings window
        }
        ServerMsg::World { pets } => {
            *app.state::<PresenceState>().world.lock().unwrap() = pets.clone();
            let _ = app.emit_to("overlay", "world", pets);
        }
        ServerMsg::PeerClaim { owner, controller } => {
            let _ = app.emit_to(
                "overlay",
                "peer-claim",
                serde_json::json!({ "owner": owner, "controller": controller }),
            );
        }
        ServerMsg::PeerSnap { snap } => {
            let _ = app.emit_to("overlay", "peer-snap", snap);
        }
        ServerMsg::PeerCursor { from, x, y, active } => {
            let _ = app.emit_to(
                "overlay",
                "peer-cursor",
                serde_json::json!({ "from": from, "x": x, "y": y, "active": active }),
            );
        }
        ServerMsg::PeerBump { owner, vx, vy } => {
            let _ = app.emit_to(
                "overlay",
                "peer-bump",
                serde_json::json!({ "owner": owner, "vx": vx, "vy": vy }),
            );
        }
    }
}

fn set_connected(app: &AppHandle, connected: bool) {
    let state = app.state::<PresenceState>();
    state.connected.store(connected, Ordering::Relaxed);
    if !connected {
        state.online.lock().unwrap().clear();
    }
    rebuild_tray(app);
}

/// Handle tray items owned by presence: `send:<id>` (leap) and `dnd` (toggle DND).
pub fn handle_menu(app: &AppHandle, menu_id: &str) -> bool {
    if menu_id == "dnd" {
        let on = app.state::<PresenceState>().dnd.load(Ordering::Relaxed);
        set_dnd(app.clone(), !on);
        return true;
    }
    let Some(to) = menu_id.strip_prefix("send:") else {
        return false;
    };
    let _ = app.emit_to("overlay", "leap", serde_json::json!({ "target": to }));
    true
}

/// Rebuild the tray context menu to reflect who's online. Menu/GUI calls must run
/// on the main thread (hard requirement on macOS), so hop there.
fn rebuild_tray(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Err(e) = rebuild_tray_inner(&app) {
            eprintln!("tray rebuild failed: {e}");
        }
    });
}

fn rebuild_tray_inner(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<PresenceState>();
    let me = state.me.lock().unwrap().clone();
    let connected = state.connected.load(Ordering::Relaxed);
    let dnd_on = state.dnd.load(Ordering::Relaxed);
    let allow_leap = state
        .config
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| c.allow_leap)
        .unwrap_or(true);
    let online = state.online.lock().unwrap().clone();

    let header_text = if dnd_on {
        "🌙 No molestar"
    } else if connected {
        "🟢 En línea"
    } else {
        "🔴 Reconectando…"
    };
    let header = MenuItem::with_id(app, "header", header_text, false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    let friends: Vec<MenuItem<_>> = online
        .iter()
        .filter(|u| Some(&u.id) != me.as_ref())
        .map(|u| {
            MenuItem::with_id(
                app,
                format!("send:{}", u.id),
                if allow_leap {
                    format!("🐾 Saltar sobre {}", u.name)
                } else {
                    format!("💤 {} (saltar desactivado)", u.name)
                },
                connected && allow_leap, // grayed out when leaping is off
                None::<&str>,
            )
        })
        .collect::<Result<_, _>>()?;

    // update-available banner at the very top of the menu, if any
    let update_ver = state.update.lock().unwrap().clone();
    let update_item = match &update_ver {
        Some(v) => Some(MenuItem::with_id(
            app,
            "update",
            format!("⬆️ Actualizar a {v}"),
            true,
            None::<&str>,
        )?),
        None => None,
    };
    let sep_upd = PredefinedMenuItem::separator(app)?;

    let empty;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<_>> = Vec::new();
    if let Some(ref u) = update_item {
        items.push(u);
        items.push(&sep_upd);
    }
    items.push(&header);
    items.push(&sep1);
    if friends.is_empty() {
        let text = if connected {
            "Nadie más en línea"
        } else {
            "Sin conexión"
        };
        empty = MenuItem::with_id(app, "none", text, false, None::<&str>)?;
        items.push(&empty);
    } else {
        for f in &friends {
            items.push(f);
        }
    }

    let sep2 = PredefinedMenuItem::separator(app)?;
    let dnd_label = if dnd_on {
        "🌙 No molestar (activo) — volver"
    } else {
        "🌙 No molestar (30 min)"
    };
    let dnd = MenuItem::with_id(app, "dnd", dnd_label, true, None::<&str>)?;
    let prefs = MenuItem::with_id(app, "prefs", "Preferencias", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    items.push(&sep2);
    items.push(&dnd);
    items.push(&prefs);
    items.push(&quit);

    let menu = Menu::with_items(app, &items)?;
    if let Some(tray) = app.tray_by_id("bichito-tray") {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}
