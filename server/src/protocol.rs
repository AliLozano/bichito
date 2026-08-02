use serde::{Deserialize, Serialize};

// Shared "pet world" protocol. Everything is NORMALIZED (0..1 of the screen) so
// it looks the same on any display. Each pet has a `controller` (the client
// simulating its physics) that broadcasts snapshots ~20Hz; every viewer predicts
// locally between snapshots (dead reckoning) so we can drop transmission frames
// without dropping render frames.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub character: String,
}

/// One pet's authoritative snapshot. `state`: walk | held | thrown | oncursor |
/// flee | gone. `target` = whose cursor it's on (for `oncursor`), else "".
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
    },
    /// Take control of the pet owned by `owner` (on grab/leap).
    Claim {
        owner: String,
    },
    /// Broadcast a pet snapshot (I'm its controller).
    Snap {
        snap: PetSnap,
    },
    /// My cursor + whether I'm interacting (show my ghost cursor to others).
    Cursor {
        x: f64,
        y: f64,
        active: bool,
    },
    /// Impart velocity to a pet (a collision I detected against it).
    Bump {
        owner: String,
        vx: f64,
        vy: f64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMsg {
    Presence { users: Vec<UserInfo> },
    /// Full world (all pets' latest snapshots) — sent on join / big changes.
    World { pets: Vec<PetSnap> },
    PeerClaim { owner: String, controller: String },
    PeerSnap { snap: PetSnap },
    PeerCursor { from: String, x: f64, y: f64, active: bool },
    PeerBump { owner: String, vx: f64, vy: f64 },
}
