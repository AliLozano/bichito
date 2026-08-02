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
use protocol::{ClientMsg, PetInfo, PetStateWire, ServerMsg, UserInfo};

struct Peer {
    name: String,
    character: String,
    tx: mpsc::UnboundedSender<Message>,
}

type Registry = Arc<DashMap<String, Peer>>;
type Pets = Arc<Mutex<HashMap<String, PetStateWire>>>;

#[derive(Clone)]
struct AppState {
    reg: Registry,
    pets: Pets,
}

#[tokio::main]
async fn main() {
    let state = AppState {
        reg: Arc::new(DashMap::new()),
        pets: Arc::new(Mutex::new(HashMap::new())),
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
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut my_id: Option<String> = None;

    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(msg) = serde_json::from_str::<ClientMsg>(&text) {
                            handle_msg(&state, &mut my_id, &tx, msg);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
            _ = &mut writer => break,
        }
    }

    if let Some(id) = my_id {
        state.reg.remove(&id);
        // drop this pet + re-home any pet that referenced the leaver
        let affected: Vec<String> = {
            let mut pets = state.pets.lock().unwrap();
            pets.remove(&id);
            pets.iter()
                .filter(|(_, s)| refers_to(s, &id))
                .map(|(o, _)| o.clone())
                .collect()
        };
        for o in affected {
            reassign(&state, &o, None);
        }
        broadcast_presence(&state.reg);
        broadcast_pets(&state);
    }
    writer.abort();
}

fn handle_msg(
    state: &AppState,
    my_id: &mut Option<String>,
    tx: &mpsc::UnboundedSender<Message>,
    msg: ClientMsg,
) {
    match msg {
        ClientMsg::Hello { id, name, character } => {
            state.reg.insert(
                id.clone(),
                Peer { name, character, tx: tx.clone() },
            );
            *my_id = Some(id.clone());
            reassign(state, &id, None); // home this new pet on a friend
            // now that a new host exists, re-home anyone who was Idle (alone)
            let idle: Vec<String> = {
                let pets = state.pets.lock().unwrap();
                pets.iter()
                    .filter(|(o, s)| **s == PetStateWire::Idle && *o != &id)
                    .map(|(o, _)| o.clone())
                    .collect()
            };
            for o in idle {
                reassign(state, &o, None);
            }
            broadcast_presence(&state.reg);
            broadcast_pets(state);
        }
        ClientMsg::Leap { target } => {
            let Some(me) = my_id.clone() else { return };
            if target != me && state.reg.contains_key(&target) {
                state
                    .pets
                    .lock()
                    .unwrap()
                    .insert(me, PetStateWire::Leaping { who: target });
                broadcast_pets(state);
            }
        }
        ClientMsg::Roamed { owner } => {
            let Some(me) = my_id.clone() else { return };
            let is_host = matches!(
                state.pets.lock().unwrap().get(&owner),
                Some(PetStateWire::Roaming { who }) if *who == me
            );
            if is_host {
                reassign(state, &owner, Some(&me)); // move it to a DIFFERENT friend
                broadcast_pets(state);
            }
        }
        ClientMsg::Dropped { owner } => {
            let Some(me) = my_id.clone() else { return };
            let is_target = matches!(
                state.pets.lock().unwrap().get(&owner),
                Some(PetStateWire::Leaping { who }) if *who == me
            );
            if is_target {
                state
                    .pets
                    .lock()
                    .unwrap()
                    .insert(owner, PetStateWire::Bouncing { who: me });
                broadcast_pets(state);
            }
        }
        ClientMsg::Gone { owner } => {
            let involved = matches!(
                state.pets.lock().unwrap().get(&owner),
                Some(PetStateWire::Bouncing { .. })
            );
            if involved {
                reassign(state, &owner, None);
                broadcast_pets(state);
            }
        }
        // --- real-time relays ---
        ClientMsg::Cursor { to, x, y } => {
            relay(state, my_id, &to, |from| ServerMsg::PeerCursor { from, x, y })
        }
        ClientMsg::Grip { to, strength } => {
            relay(state, my_id, &to, |from| ServerMsg::PeerGrip { from, strength })
        }
        ClientMsg::Hold { to, level } => {
            relay(state, my_id, &to, |from| ServerMsg::PeerHold { from, level })
        }
        ClientMsg::Released { to } => {
            relay(state, my_id, &to, |from| ServerMsg::PeerReleased { from })
        }
        ClientMsg::PetPos { to, owner, x, y, flip, pose } => relay(state, my_id, &to, |from| {
            ServerMsg::PeerPetPos { from, owner, x, y, flip, pose }
        }),
    }
}

fn refers_to(s: &PetStateWire, id: &str) -> bool {
    matches!(
        s,
        PetStateWire::Roaming { who }
            | PetStateWire::Leaping { who }
            | PetStateWire::Bouncing { who } if who == id
    )
}

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Put `owner`'s pet on a random online friend (Roaming), or Idle if alone.
/// `exclude` forces a move to a different friend (used when it roams onward).
fn reassign(state: &AppState, owner: &str, exclude: Option<&str>) {
    let mut candidates: Vec<String> = state
        .reg
        .iter()
        .map(|e| e.key().clone())
        .filter(|id| id != owner)
        .collect();
    if let Some(ex) = exclude {
        if candidates.len() > 1 {
            candidates.retain(|id| id != ex);
        }
    }
    let next = if candidates.is_empty() {
        PetStateWire::Idle
    } else {
        PetStateWire::Roaming {
            who: candidates[(nanos() as usize) % candidates.len()].clone(),
        }
    };
    state.pets.lock().unwrap().insert(owner.to_string(), next);
}

fn broadcast_pets(state: &AppState) {
    let list: Vec<PetInfo> = {
        let pets = state.pets.lock().unwrap();
        pets.iter()
            .filter_map(|(owner, st)| {
                state.reg.get(owner).map(|p| PetInfo {
                    owner: owner.clone(),
                    name: p.name.clone(),
                    character: p.character.clone(),
                    state: st.clone(),
                })
            })
            .collect()
    };
    let frame = Message::Text(serde_json::to_string(&ServerMsg::Pets { pets: list }).unwrap());
    for e in state.reg.iter() {
        let _ = e.value().tx.send(frame.clone());
    }
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
    let frame = Message::Text(serde_json::to_string(&ServerMsg::Presence { users }).unwrap());
    for e in reg.iter() {
        let _ = e.value().tx.send(frame.clone());
    }
}

fn relay(
    state: &AppState,
    from: &Option<String>,
    to: &str,
    make: impl FnOnce(String) -> ServerMsg,
) {
    let Some(from) = from else { return };
    if let Some(target) = state.reg.get(to) {
        let msg = make(from.clone());
        let _ = target
            .tx
            .send(Message::Text(serde_json::to_string(&msg).unwrap()));
    }
}
