use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use futures_util::{SinkExt, StreamExt};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Emitter, Manager,
};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

use crate::protocol::{ClientMsg, PetSnap, ServerMsg, UserInfo};
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
    /// Latest full world (so the overlay can fetch it on load).
    pub world: Mutex<Vec<PetSnap>>,
    /// Whether the WS is currently connected.
    pub connected: AtomicBool,
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
        match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => {
                set_connected(&app, true);
                let (mut write, mut read) = ws.split();

                let hello = ClientMsg::Hello {
                    id: id.clone(),
                    name: name.clone(),
                    character: character.clone(),
                };
                let _ = write
                    .send(Message::Text(serde_json::to_string(&hello).unwrap()))
                    .await;

                loop {
                    tokio::select! {
                        cmd = rx.recv() => match cmd {
                            Some(c) => {
                                let _ = write
                                    .send(Message::Text(serde_json::to_string(&c).unwrap()))
                                    .await;
                            }
                            None => return, // app shutting down
                        },
                        frame = read.next() => match frame {
                            Some(Ok(Message::Text(t))) => handle_server(&app, &t),
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Err(_)) => break,
                            Some(Ok(_)) => {} // ping/pong/binary — ignore
                        },
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

/// A `send:<id>` tray click -> tell the overlay to leap MY pet onto that friend.
pub fn handle_menu(app: &AppHandle, menu_id: &str) -> bool {
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
    let online = state.online.lock().unwrap().clone();

    let header_text = if connected {
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
                format!("🐾 Saltar sobre {}", u.name),
                connected,
                None::<&str>,
            )
        })
        .collect::<Result<_, _>>()?;

    let empty;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<_>> = vec![&header, &sep1];
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
    let prefs = MenuItem::with_id(app, "prefs", "Preferencias", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    items.push(&sep2);
    items.push(&prefs);
    items.push(&quit);

    let menu = Menu::with_items(app, &items)?;
    if let Some(tray) = app.tray_by_id("bichito-tray") {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}
