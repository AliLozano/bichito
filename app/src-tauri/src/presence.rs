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

use crate::protocol::{ClientMsg, PetInfo, ServerMsg, UserInfo};
use tauri_plugin_store::StoreExt;

/// App-global presence state, managed via `app.manage(...)`.
#[derive(Default)]
pub struct PresenceState {
    /// Channel to the WS task (menu clicks push `ClientMsg` here).
    pub tx: Mutex<Option<UnboundedSender<ClientMsg>>>,
    /// My own user id (to exclude myself from the friends menu).
    pub me: Mutex<Option<String>>,
    /// Latest online snapshot from the server.
    pub online: Mutex<Vec<UserInfo>>,
    /// Latest authoritative pet table (so the overlay can fetch it on load).
    pub pets: Mutex<Vec<PetInfo>>,
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
    tauri::async_runtime::spawn(random_leaps(app.clone(), id.clone()));
    tauri::async_runtime::spawn(run(app, id, name, character, rx));
}

/// Current online users (for the tray friends list).
#[tauri::command]
pub fn get_online(app: AppHandle) -> Vec<UserInfo> {
    app.state::<PresenceState>().online.lock().unwrap().clone()
}

/// Current authoritative pet table (the overlay fetches this on load).
#[tauri::command]
pub fn get_pets(app: AppHandle) -> Vec<PetInfo> {
    app.state::<PresenceState>().pets.lock().unwrap().clone()
}

/// Push a message to the WS task (used by menu clicks and the cursor module).
pub fn send(app: &AppHandle, msg: ClientMsg) {
    if let Some(tx) = app.state::<PresenceState>().tx.lock().unwrap().clone() {
        let _ = tx.send(msg);
    }
}

/// Occasionally leap onto a random online friend — "a cualquier hora".
async fn random_leaps(app: AppHandle, me: String) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(45)).await;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        if nanos % 100 >= 18 {
            continue; // ~18% chance per tick
        }
        let online: Vec<String> = {
            let st = app.state::<PresenceState>();
            let list = st.online.lock().unwrap();
            list.iter()
                .filter(|u| u.id != me)
                .map(|u| u.id.clone())
                .collect()
        };
        if online.is_empty() {
            continue;
        }
        let pick = online[(nanos as usize) % online.len()].clone();
        send(&app, ClientMsg::Leap { target: pick });
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
            let _ = app.emit("presence", users); // for a future in-app friends UI
        }
        ServerMsg::Pets { pets } => {
            // authoritative pet table -> the overlay renders from this
            *app.state::<PresenceState>().pets.lock().unwrap() = pets.clone();
            let _ = app.emit_to("overlay", "pets", pets);
        }
        ServerMsg::PeerCursor { from, x, y } => {
            let _ = app.emit_to(
                "overlay",
                "peer-cursor",
                serde_json::json!({ "from": from, "x": x, "y": y }),
            );
        }
        ServerMsg::PeerGrip { from, strength } => {
            let _ = app.emit_to(
                "overlay",
                "peer-grip",
                serde_json::json!({ "from": from, "strength": strength }),
            );
        }
        ServerMsg::PeerHold { from, level } => {
            let _ = app.emit_to(
                "overlay",
                "peer-hold",
                serde_json::json!({ "from": from, "level": level }),
            );
        }
        ServerMsg::PeerReleased { from } => {
            let _ = app.emit_to("overlay", "peer-released", serde_json::json!({ "from": from }));
        }
        ServerMsg::PeerPetPos { from, owner, x, y, flip, pose } => {
            let _ = app.emit_to(
                "overlay",
                "peer-petpos",
                serde_json::json!({ "from": from, "owner": owner, "x": x, "y": y, "flip": flip, "pose": pose }),
            );
        }
    }
}

// --- commands the overlay uses to drive the authoritative model --------------

/// Throw MY pet at a friend (tray action or a UI-driven leap).
#[tauri::command]
pub fn leap(app: AppHandle, target: String) {
    send(&app, ClientMsg::Leap { target });
}

/// My hosted pet (owner) walked off my screen -> ask the server to re-home it.
#[tauri::command]
pub fn roamed(app: AppHandle, owner: String) {
    send(&app, ClientMsg::Roamed { owner });
}

/// A pet on my cursor let go -> it now bounces on my screen.
#[tauri::command]
pub fn dropped(app: AppHandle, owner: String) {
    send(&app, ClientMsg::Dropped { owner });
}

/// A bouncing pet settled/faded -> back to roaming.
#[tauri::command]
pub fn gone(app: AppHandle, owner: String) {
    send(&app, ClientMsg::Gone { owner });
}

fn set_connected(app: &AppHandle, connected: bool) {
    let state = app.state::<PresenceState>();
    state.connected.store(connected, Ordering::Relaxed);
    if !connected {
        state.online.lock().unwrap().clear();
    }
    rebuild_tray(app);
}

/// Send `SendPet` for a `send:<id>` tray menu id. Returns true if handled.
pub fn handle_menu(app: &AppHandle, menu_id: &str) -> bool {
    let Some(to) = menu_id.strip_prefix("send:") else {
        return false;
    };
    if let Some(tx) = app.state::<PresenceState>().tx.lock().unwrap().clone() {
        let _ = tx.send(ClientMsg::Leap { target: to.to_string() });
    }
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

    // Collect friend items (everyone online except me).
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
