use serde::{Deserialize, Serialize};

// Authoritative pet model. The server owns each pet's high-level STATE; clients
// render what the table says and stream real-time details (cursor/grip/bounce)
// peer-to-peer. Coordinates are normalized (0..1 of the sender's screen).

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub character: String,
}

/// Where a pet is and who sees it. `who` = host (roaming) / target (leaping) /
/// screen (bouncing). Idle = owner online but no friend to host it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PetStateWire {
    Idle,
    Roaming { who: String },
    Leaping { who: String },
    Bouncing { who: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetInfo {
    pub owner: String,
    pub name: String,
    pub character: String,
    pub state: PetStateWire,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMsg {
    Hello {
        id: String,
        name: String,
        character: String,
    },
    /// Throw MY pet at `target` (tray action or random leap).
    Leap { target: String },
    /// My hosted pet (owned by `owner`) walked off my screen — reassign it.
    Roamed { owner: String },
    /// The pet on my cursor (owned by `owner`) let go -> it bounces on my screen.
    Dropped { owner: String },
    /// The bouncing pet (owned by `owner`) settled/faded -> back to roaming.
    Gone { owner: String },

    // --- real-time peer relays (server just forwards, stamped with `from`) ---
    Cursor { to: String, x: f64, y: f64 },
    Grip { to: String, strength: f64 },
    Hold { to: String, level: f64 },
    Released { to: String },
    /// Streamed position of a bouncing pet to the other viewer.
    PetPos {
        to: String,
        owner: String,
        x: f64,
        y: f64,
        flip: bool,
        pose: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMsg {
    Presence { users: Vec<UserInfo> },
    /// Full pet table — broadcast whenever any pet's state changes.
    Pets { pets: Vec<PetInfo> },
    PeerCursor { from: String, x: f64, y: f64 },
    PeerGrip { from: String, strength: f64 },
    PeerHold { from: String, level: f64 },
    PeerReleased { from: String },
    #[serde(rename_all = "camelCase")]
    PeerPetPos {
        from: String,
        owner: String,
        x: f64,
        y: f64,
        flip: bool,
        pose: String,
    },
}
