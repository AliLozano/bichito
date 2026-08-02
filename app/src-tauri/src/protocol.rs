use serde::{Deserialize, Serialize};

// Mirror of server/src/protocol.rs — the authoritative pet model.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub character: String,
}

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
    Leap {
        target: String,
    },
    Roamed {
        owner: String,
    },
    Dropped {
        owner: String,
    },
    Gone {
        owner: String,
    },
    Cursor {
        to: String,
        x: f64,
        y: f64,
    },
    Grip {
        to: String,
        strength: f64,
    },
    Hold {
        to: String,
        level: f64,
    },
    Released {
        to: String,
    },
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
