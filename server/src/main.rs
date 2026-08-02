use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

mod protocol;
use protocol::{ClientMsg, PetSnap, ServerMsg, UserInfo, WorldConfig};

struct Peer {
    name: String,
    character: String,
    tx: mpsc::UnboundedSender<Message>,
}

type Registry = Arc<DashMap<String, Peer>>;
type Pets = Arc<Mutex<HashMap<String, PetSnap>>>; // owner -> latest snapshot

#[derive(Clone)]
struct AppState {
    reg: Registry,
    pets: Pets,
    config: Arc<Mutex<Option<WorldConfig>>>, // shared group config (first client seeds it)
}

#[tokio::main]
async fn main() {
    let state = AppState {
        reg: Arc::new(DashMap::new()),
        pets: Arc::new(Mutex::new(HashMap::new())),
        config: Arc::new(Mutex::new(None)),
    };
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws_handler))
        .with_state(state);
    let port = std::env::var("PORT").unwrap_or_else(|_| "8787".to_string());
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("bichito-server listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let mut writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
    });

    let mut my_id: Option<String> = None;
    loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    if let Ok(msg) = serde_json::from_str::<ClientMsg>(&t) {
                        handle_msg(&state, &mut my_id, &tx, msg);
                    }
                }
                Some(Ok(Message::Ping(p))) => {
                    let _ = tx.send(Message::Pong(p)); // keepalive
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            _ = &mut writer => break,
        }
    }

    if let Some(id) = my_id {
        state.reg.remove(&id);
        // remove this user's pet + hand back any pet they controlled to its owner
        {
            let mut pets = state.pets.lock().unwrap();
            pets.remove(&id);
            for snap in pets.values_mut() {
                if snap.controller == id {
                    snap.controller = snap.owner.clone();
                }
            }
        }
        broadcast_presence(&state.reg);
        broadcast_world(&state);
    }
    writer.abort();
}

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn handle_msg(
    state: &AppState,
    my_id: &mut Option<String>,
    tx: &mpsc::UnboundedSender<Message>,
    msg: ClientMsg,
) {
    match msg {
        ClientMsg::Hello { id, name, character, config } => {
            state.reg.insert(
                id.clone(),
                Peer { name: name.clone(), character: character.clone(), tx: tx.clone() },
            );
            *my_id = Some(id.clone());
            // first client to connect seeds the shared config; everyone adopts it
            {
                let mut cfg = state.config.lock().unwrap();
                if cfg.is_none() {
                    if let Some(c) = config {
                        *cfg = Some(c);
                    }
                }
                if let Some(c) = cfg.clone() {
                    let _ = tx.send(frame(&ServerMsg::Config { config: c }));
                }
            }
            // spawn this user's pet (they control it), walking in from an edge
            let from_left = (nanos() & 1) == 0;
            state.pets.lock().unwrap().entry(id.clone()).or_insert(PetSnap {
                owner: id.clone(),
                name,
                character,
                controller: id.clone(),
                state: "walk".into(),
                x: if from_left { -0.05 } else { 1.05 },
                y: 0.9,
                vx: 0.0,
                vy: 0.0,
                flip: !from_left,
                frame: 0,
                grip: 1.0,
                target: String::new(),
            });
            broadcast_presence(&state.reg);
            broadcast_world(state);
        }
        ClientMsg::Config { config } => {
            *state.config.lock().unwrap() = Some(config.clone());
            broadcast(state, &ServerMsg::Config { config });
        }
        ClientMsg::Claim { owner } => {
            let Some(me) = my_id.clone() else { return };
            let mut changed = false;
            if let Some(snap) = state.pets.lock().unwrap().get_mut(&owner) {
                if snap.controller != me {
                    snap.controller = me.clone();
                    changed = true;
                }
            }
            if changed {
                broadcast(state, &ServerMsg::PeerClaim { owner, controller: me });
            }
        }
        ClientMsg::Snap { snap } => {
            // only the current controller may drive a pet: the sender must both
            // claim to be the controller AND actually hold control server-side
            // (guards against a stale client driving a pet after a handoff).
            let Some(me) = my_id.as_deref() else { return };
            if snap.controller != me {
                return;
            }
            {
                let mut pets = state.pets.lock().unwrap();
                // the pet must already exist AND still be controlled by the sender.
                // (absent = owner disconnected; don't let a non-owner resurrect a
                // zombie pet by continuing to snapshot it.)
                match pets.get(&snap.owner) {
                    Some(cur) if cur.controller == me => {}
                    _ => return,
                }
                pets.insert(snap.owner.clone(), snap.clone());
            }
            relay_others(state, me, &ServerMsg::PeerSnap { snap });
        }
        ClientMsg::Cursor { x, y, active } => {
            let Some(me) = my_id.clone() else { return };
            relay_others(state, &me, &ServerMsg::PeerCursor { from: me.clone(), x, y, active });
        }
        ClientMsg::Bump { owner, vx, vy } => {
            let Some(me) = my_id.as_deref() else { return };
            relay_others(state, me, &ServerMsg::PeerBump { owner, vx, vy });
        }
    }
}

fn frame(msg: &ServerMsg) -> Message {
    Message::Text(serde_json::to_string(msg).unwrap())
}

fn broadcast(state: &AppState, msg: &ServerMsg) {
    let f = frame(msg);
    for e in state.reg.iter() {
        let _ = e.value().tx.send(f.clone());
    }
}

fn relay_others(state: &AppState, from: &str, msg: &ServerMsg) {
    let f = frame(msg);
    for e in state.reg.iter() {
        if e.key() != from {
            let _ = e.value().tx.send(f.clone());
        }
    }
}

fn broadcast_world(state: &AppState) {
    let pets: Vec<PetSnap> = state.pets.lock().unwrap().values().cloned().collect();
    broadcast(state, &ServerMsg::World { pets });
}

fn broadcast_presence(reg: &Registry) {
    let users: Vec<UserInfo> = reg
        .iter()
        .map(|e| UserInfo {
            id: e.key().clone(),
            name: e.value().name.clone(),
            character: e.value().character.clone(),
        })
        .collect();
    let f = frame(&ServerMsg::Presence { users });
    for e in reg.iter() {
        let _ = e.value().tx.send(f.clone());
    }
}
