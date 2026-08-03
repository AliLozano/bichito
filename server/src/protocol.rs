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

/// Shared "vibe" config for the whole friend group. The first client to connect
/// seeds it (via Hello); everyone then adopts it and stays in sync. Anyone can
/// update it later (Config message) and it re-broadcasts to all.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldConfig {
    pub walk_time: f64,  // seconds wandering before getting sleepy
    pub sleep_time: f64, // seconds asleep at the edge
    pub jump_every: f64, // avg seconds between random leaps (0 = never)
    pub run_speed: f64,  // flee/leap run speed (normalized/s)
    // When false, pets never leap onto cursors (tray/auto), a released pet just
    // falls straight down, and a held pet lifted too high auto-drops. Less intrusive.
    #[serde(default = "default_true")]
    pub allow_leap: bool,
}

fn default_true() -> bool {
    true
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
        /// this client's local config — seeds the shared one if none exists yet
        #[serde(default)]
        config: Option<WorldConfig>,
    },
    /// Update the shared group config (re-broadcast to everyone).
    Config {
        config: WorldConfig,
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
    /// The current shared group config (sent on join, and on any change).
    Config { config: WorldConfig },
    /// Full world (all pets' latest snapshots) — sent on join / big changes.
    World { pets: Vec<PetSnap> },
    PeerClaim { owner: String, controller: String },
    PeerSnap { snap: PetSnap },
    PeerCursor { from: String, x: f64, y: f64, active: bool },
    PeerBump { owner: String, vx: f64, vy: f64 },
}
