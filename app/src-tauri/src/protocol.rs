use serde::{Deserialize, Serialize};

// Mirror of server/src/protocol.rs — the shared "pet world". Everything is
// NORMALIZED (0..1 of the screen). Each pet has a `controller` (the client
// simulating it) that broadcasts snapshots ~20Hz; viewers dead-reckon between.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub character: String,
}

/// Shared group "vibe" config (mirror of server). First client seeds it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldConfig {
    pub walk_time: f64,
    pub sleep_time: f64,
    pub jump_every: f64,
    pub run_speed: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSnap {
    pub owner: String,
    pub name: String,
    pub character: String,
    pub controller: String,
    pub state: String,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub flip: bool,
    pub frame: i64,
    pub grip: f64,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMsg {
    Hello {
        id: String,
        name: String,
        character: String,
        #[serde(default)]
        config: Option<WorldConfig>,
    },
    /// Update the shared group config (re-broadcast to everyone).
    Config { config: WorldConfig },
    /// Take control of the pet owned by `owner` (on grab/leap).
    Claim { owner: String },
    /// Broadcast a pet snapshot (I'm its controller).
    Snap { snap: PetSnap },
    /// My cursor + whether I'm interacting (show my ghost to others).
    Cursor { x: f64, y: f64, active: bool },
    /// Impart velocity to a pet (a collision I detected against it).
    Bump { owner: String, vx: f64, vy: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMsg {
    Presence { users: Vec<UserInfo> },
    Config { config: WorldConfig },
    World { pets: Vec<PetSnap> },
    PeerClaim { owner: String, controller: String },
    PeerSnap { snap: PetSnap },
    PeerCursor { from: String, x: f64, y: f64, active: bool },
    PeerBump { owner: String, vx: f64, vy: f64 },
}
